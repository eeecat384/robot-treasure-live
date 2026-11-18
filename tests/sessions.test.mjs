import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { defaultSessionName, sanitizeName, createSession, SessionStore, buildSessionFiles, buildZip, exportSession } from '../dist/sessions.js';

const W4 = 'W4,53680,IDLE,-1,245,-113,29,205,-5,-36,-366,-113,29,124,-5,-43,-417,0';
const ENM = 'ENM,54000,self=(7.01,2.23),n=0,v=3/5,yaw10=-885,F=0,L=0,B=0,R=0,T=0,q=0,h=0,age=0,src=0,rej=0,d=1714/0/2402/0';
const NODE = 'N,53700,31,1,426,0,45,1,0,7,-25,0,0,24,0,114,00,1C,0,0,1,-5,0,00,-1,300';
const fixedDate = '2026-10-18T14:24:00.000Z';

test('measurement names use Shanghai time including UTC day crossover, and are safe on Windows', () => {
  assert.equal(defaultSessionName(new Date(fixedDate)), '测试数据10182224');
  assert.equal(defaultSessionName(new Date('2026-10-18T16:00:00Z')), '测试数据10190000');
  assert.equal(sanitizeName('  小车/测试\\:A?*.  '), '小车_测试__A__');
  assert.equal(sanitizeName('CON.txt'), '_CON.txt');
  assert.equal(sanitizeName('..'), '未命名测试');
  assert.equal(sanitizeName('a\u0000b\nc'), 'a_b_c');
  assert.equal([...sanitizeName('车'.repeat(150))].length, 96);
});

test('sessions retain unknown raw content, stable identity, firmware and monotonic receipt times', () => {
  const session = createSession([
    { line: '  unknown,原始数据  ', at: 0 },
    { line: 'FW BUILD=nav-42', at: 120 },
    { line: W4, at: 80 },
    { line: ENM, at: 500 }
  ], '', { createdAt: fixedDate, id: 'record-1', source: 'import' });
  assert.equal(session.id, 'record-1');
  assert.equal(session.name, '测试数据10182224');
  assert.equal(session.firmware, 'nav-42');
  assert.equal(session.lines[0].line, '  unknown,原始数据  ');
  assert.deepEqual(session.lines.map(entry => entry.at), [0, 120, 120, 500]);
  assert.equal(session.durationMs, 500);
  assert.equal(session.source, 'import');
});

test('memory fallback explicitly warns, stores independent snapshots, serializes collisions, renames and deletes', async () => {
  const warnings = [];
  const store = new SessionStore({ indexedDB: null, onWarning: warning => warnings.push(warning) });
  assert.equal(store.persistent, false);
  assert.match(store.warning, /刷新页面前请导出/);
  assert.equal(warnings.length, 1);
  const a = createSession([{ line: 'raw a', at: 10 }], '测试', { id: 'a', createdAt: fixedDate });
  const b = createSession([{ line: 'raw b', at: 20 }], '测试', { id: 'b', createdAt: '2026-10-18T14:25:00Z' });
  const [savedA, savedB] = await Promise.all([store.save(a), store.save(b)]);
  assert.equal(savedA.name, '测试');
  assert.equal(savedB.name, '测试 (2)');
  a.lines[0].line = 'mutated input';
  savedA.lines[0].line = 'mutated return';
  assert.equal((await store.get('a')).lines[0].line, 'raw a');
  const listed = await store.list();
  assert.deepEqual(listed.map(record => record.id), ['b', 'a']);
  assert.equal(listed[0].lineCount, 1);
  assert.equal('lines' in listed[0], false);
  assert.equal((await store.rename('b', '测试')).name, '测试 (2)');
  await store.delete('a');
  assert.equal(await store.get('a'), null);
  assert.equal((await store.rename('b', '测试')).name, '测试');
  await assert.rejects(store.rename('missing', 'lost'), /找不到/);
  assert.equal(warnings.length, 1);
});

test('queued saves snapshot input immediately while a measurement continues recording', async () => {
  const store = new SessionStore({ indexedDB: null });
  const live = createSession([{ line: 'first', at: 0 }], '录制快照', { createdAt: fixedDate });
  const pending = store.save(live);
  live.lines.push({ line: 'arrived after save', at: 100 });
  live.lines[0].line = 'mutated after save';
  assert.deepEqual((await pending).lines, [{ line: 'first', at: 0 }]);
  assert.deepEqual((await store.get(live.id)).lines, [{ line: 'first', at: 0 }]);
});

function fakeIndexedDB() {
  const rows = new Map();
  const backend = { rows, failWrites: false, opens: 0 };
  const database = {
    objectStoreNames: { contains: () => true },
    close() {},
    transaction(_name, mode) {
      if (mode === 'readwrite' && backend.failWrites) throw new Error('Quota exceeded');
      const transaction = {};
      transaction.objectStore = () => {
        const request = operation => {
          const result = {};
          queueMicrotask(() => {
            result.result = operation();
            result.onsuccess?.();
            queueMicrotask(() => transaction.oncomplete?.());
          });
          return result;
        };
        return {
          getAll: () => request(() => [...rows.values()].map(value => structuredClone(value))),
          get: id => request(() => rows.has(id) ? structuredClone(rows.get(id)) : undefined),
          put: record => request(() => { rows.set(record.id, structuredClone(record)); return record.id; }),
          delete: id => request(() => { rows.delete(id); })
        };
      };
      return transaction;
    }
  };
  backend.open = () => {
    backend.opens++;
    const request = {};
    queueMicrotask(() => { request.result = database; request.onsuccess?.(); });
    return request;
  };
  return backend;
}

test('IndexedDB history survives store instances and storage failure preserves loaded records with a warning', async () => {
  const indexedDB = fakeIndexedDB();
  const first = new SessionStore({ indexedDB });
  const session = createSession([{ line: W4, at: 50 }], '持久化', { id: 'persisted', createdAt: fixedDate });
  await first.save(session);
  const warnings = [];
  const second = new SessionStore({ indexedDB, onWarning: message => warnings.push(message) });
  assert.equal((await second.get('persisted')).name, '持久化');
  assert.equal(second.persistent, true);
  indexedDB.failWrites = true;
  const renamed = await second.rename('persisted', '内存保留');
  assert.equal(renamed.name, '内存保留');
  assert.equal(second.persistent, false);
  assert.equal((await second.get('persisted')).lines[0].line, W4);
  assert.equal((await second.list())[0].name, '内存保留');
  assert.equal(warnings.length, 1);
});

test('database open failure falls back without losing the new measurement', async () => {
  const store = new SessionStore({ indexedDB: { open() { throw new Error('blocked'); } } });
  await store.save(createSession(['raw'], '打开失败', { id: 'blocked', createdAt: fixedDate }));
  assert.equal(store.persistent, false);
  assert.equal((await store.get('blocked')).lines[0].line, 'raw');
  assert.match(store.warning, /仅保存在内存/);
});

test('export extracts wheel/FLBR laser samples while preserving every raw unknown and invalid line', () => {
  const raw = ['noise,保留我', W4, ENM, 'LSR,F=11,B=33,L=22,R=44', NODE, 'W4,corrupt'];
  const session = createSession(raw.map((line, index) => ({ line, at: index * 40 })), '原始测试', { createdAt: fixedDate, firmware: 'v7' });
  const files = buildSessionFiles(session);
  assert.equal(files.length, 7);
  assert.equal(files[0].content, raw.join('\n') + '\n');
  const wheelCsv = files.find(file => file.path.endsWith('processed-wheels.csv')).content;
  assert.match(wheelCsv, /A_target,A_actual,A_pwm,B_target,B_actual,B_pwm/);
  assert.match(wheelCsv, /40,53680,W4,-1,,-113,29,205,-5,-36,-366,-113,29,124,-5,-43,-417/);
  const laserCsv = files.find(file => file.path.endsWith('processed-lasers.csv')).content;
  assert.match(laserCsv, /front,left,back,right/);
  assert.match(laserCsv, /80,54000,ENM,1714,0,2402,0/);
  assert.match(laserCsv, /120,,LSR,11,22,33,44/);
  const metadata = JSON.parse(files.find(file => file.path.endsWith('metadata.json')).content);
  assert.equal(metadata.firmware, 'v7');
  assert.deepEqual(metadata.receiptTimesMs, [0, 40, 80, 120, 160, 200]);
  assert.deepEqual(metadata.counts, { wheelSamples: 1, laserSamples: 2, poseSamples: 2, targetSamples: 1, orientationSamples: 2, unknownLines: 1, invalidLines: 1, ignoredLines: 0 });
  assert.equal(metadata.units.wheelSpeed, 'mm/s');
  assert.equal(metadata.units.laserRange, 'mm');
  assert.match(wheelCsv, /raw_imu_yaw_deg/);
  assert.match(files.find(file => file.path.endsWith('processed-poses.csv')).content, /map_body_yaw_deg/);
  assert.match(files.find(file => file.path.endsWith('processed-targets.csv')).content, /160,53700,N,9,3,45/);
});

test('orientation export distinguishes raw IMU and calibrated map yaw, preserves unknowns and resets after MCU restart', () => {
  const lines = [
    'IMU,t=20000,v=1,y10=1000',
    'PLAN,20010,node=31,in=1,out=1,lead=F,dir=1,turn=RIGHT,bodyYaw10=200,targetYaw10=100',
    'IMU,t=20020,v=1,y10=300',
    'WF,20030,IDLE,1,400,400,1,1,2,3,4,5,6,7,8,9,10,11,12,0',
    'IMU,t=1000,v=1,y10=500',
    'IMU,t=1100,v=1,y10=600',
    ENM.replace('54000', '4000'),
    'IMU,t=8000,v=1,y10=700'
  ];
  const receiptTimes = [0, 10, 20, 30, 40, 50, 1000, 3500];
  const files = buildSessionFiles(createSession(lines.map((line, index) => ({ line, at: receiptTimes[index] })), '朝向', { createdAt: fixedDate }));
  const csv = files.find(file => file.path.endsWith('processed-orientation.csv')).content.replace(/^\ufeff/, '').trim().split('\r\n').map(row => row.split(','));
  const header = csv.shift();
  const column = name => header.indexOf(name);
  assert.deepEqual(csv.map(row => Number(row[column('receipt_ms')])), receiptTimes, 'recorded receipt times must not be stretched to MCU clock spacing');
  assert.deepEqual(csv.map(row => row[column('map_body_yaw_deg')]), ['', '100', '110', '120', '', '', '-88.5', '']);
  assert.deepEqual(csv.map(row => row[column('raw_imu_yaw_deg')]), ['100', '20', '30', '40', '50', '60', '', '70']);
  assert.equal(csv[1][column('map_yaw_source')], 'PLAN 标定 + 实测角度');
  assert.equal(csv[3][column('map_yaw_source')], '实测 IMU / PLAN 标定');
  assert.equal(csv[4][column('map_yaw_source')], '无可靠朝向');
  assert.equal(csv[6][column('map_yaw_source')], 'ENM 地图朝向');
  const metadata = JSON.parse(files.find(file => file.path.endsWith('metadata.json')).content);
  assert.equal(metadata.counts.orientationSamples, 8);
  assert.deepEqual(metadata.receiptTimesMs, receiptTimes);
});

test('outlier device-time rows remain in raw data but are excluded from all processed samples', () => {
  const raw = [W4.replace('53680', '1000'), W4.replace('53680', '99999999'), W4.replace('53680', '1040'), W4.replace('53680', '1080')];
  const files = buildSessionFiles(createSession(raw.map((line, index) => ({ line, at: index * 5 })), '时钟异常', { createdAt: fixedDate }));
  assert.equal(files[0].content, raw.join('\n') + '\n');
  assert.doesNotMatch(files.find(file => file.path.endsWith('processed-wheels.csv')).content, /99999999/);
  assert.doesNotMatch(files.find(file => file.path.endsWith('processed-orientation.csv')).content, /99999999/);
  const metadata = JSON.parse(files.find(file => file.path.endsWith('metadata.json')).content);
  assert.equal(metadata.counts.wheelSamples, 3);
  assert.equal(metadata.counts.ignoredLines, 1);
  assert.deepEqual(metadata.receiptTimesMs, [0, 5, 10, 15]);
});

function unzipStored(bytes) {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const entries = [];
  let cursor = 0;
  while (data.getUint32(cursor, true) === 0x04034b50) {
    assert.equal(data.getUint16(cursor + 6, true), 0x0800, 'UTF-8 filename flag');
    assert.equal(data.getUint16(cursor + 8, true), 0, 'stored compression method');
    const checksum = data.getUint32(cursor + 14, true);
    const length = data.getUint32(cursor + 18, true);
    const nameLength = data.getUint16(cursor + 26, true);
    const extraLength = data.getUint16(cursor + 28, true);
    const start = cursor + 30 + nameLength + extraLength;
    const content = bytes.subarray(start, start + length);
    assert.equal(crc32(content), checksum, 'CRC verified independently by Node zlib');
    entries.push({ path: decoder.decode(bytes.subarray(cursor + 30, cursor + 30 + nameLength)), content: decoder.decode(content), offset: cursor });
    cursor = start + length;
  }
  const directoryStart = cursor;
  for (const entry of entries) {
    assert.equal(data.getUint32(cursor, true), 0x02014b50);
    assert.equal(data.getUint32(cursor + 42, true), entry.offset);
    cursor += 46 + data.getUint16(cursor + 28, true) + data.getUint16(cursor + 30, true) + data.getUint16(cursor + 32, true);
  }
  assert.equal(data.getUint32(cursor, true), 0x06054b50);
  assert.equal(data.getUint16(cursor + 10, true), entries.length);
  assert.equal(data.getUint32(cursor + 12, true), cursor - directoryStart);
  assert.equal(data.getUint32(cursor + 16, true), directoryStart);
  assert.equal(cursor + 22, bytes.length);
  return entries.map(({ path, content }) => ({ path, content }));
}

test('ZIP is readable with UTF-8 names, independent CRC validation and correct central offsets', () => {
  const files = [{ path: '测试数据.txt', content: '中文🙂\n' + 'sensor'.repeat(20000) }, { path: '测试数据/laser.csv', content: '\ufefffront,left,back,right\r\n1,2,3,4\r\n' }];
  assert.deepEqual(unzipStored(buildZip(files, new Date(fixedDate))), files);
});

function fakeDirectory() {
  const children = new Map();
  const missing = () => { const error = new Error('Missing'); error.name = 'NotFoundError'; return error; };
  const mismatch = () => { const error = new Error('Wrong type'); error.name = 'TypeMismatchError'; return error; };
  return {
    kind: 'directory', children,
    async getDirectoryHandle(name, options = {}) {
      if (!children.has(name) && options.create) children.set(name, fakeDirectory());
      if (!children.has(name)) throw missing();
      const handle = children.get(name);
      if (handle.kind !== 'directory') throw mismatch();
      return handle;
    },
    async getFileHandle(name, options = {}) {
      if (!children.has(name) && options.create) {
        const handle = { kind: 'file', content: '', async createWritable() { return { write: async content => { handle.content = content; }, close: async () => {}, abort: async () => {} }; } };
        children.set(name, handle);
      }
      if (!children.has(name)) throw missing();
      const handle = children.get(name);
      if (handle.kind !== 'file') throw mismatch();
      return handle;
    }
  };
}

test('directory export avoids both file and folder collisions without overwriting earlier measurements', async () => {
  const directory = fakeDirectory();
  const earlier = await directory.getFileHandle('同名.txt', { create: true });
  earlier.content = 'do not overwrite';
  await directory.getDirectoryHandle('同名 (2)', { create: true });
  const session = createSession([{ line: W4, at: 20 }], '同名', { createdAt: fixedDate });
  const result = await exportSession(session, { directoryHandle: directory });
  assert.deepEqual(result, { method: 'directory', name: '同名 (3)', fileCount: 7, renamed: true });
  assert.equal(earlier.content, 'do not overwrite');
  assert.equal(directory.children.get('同名 (3).txt').content, W4 + '\n');
  const folder = directory.children.get('同名 (3)');
  assert.equal(folder.children.size, 6);
  assert.equal(JSON.parse(folder.children.get('metadata.json').content).exportName, '同名 (3)');
});

test('ZIP fallback downloads the same complete export and picker cancellation does not download', async () => {
  const session = createSession(['original'], 'ZIP测试', { createdAt: fixedDate });
  let download;
  const result = await exportSession(session, { preferZip: true, download: value => { download = value; } });
  assert.equal(result.method, 'zip');
  assert.equal(download.name, 'ZIP测试.zip');
  assert.equal(download.blob.type, 'application/zip');
  assert.equal(unzipStored(download.bytes)[0].content, 'original\n');
  const old = globalThis.showDirectoryPicker;
  let pickerCalled = false;
  globalThis.showDirectoryPicker = () => {
    pickerCalled = true;
    return Promise.reject(Object.assign(new Error('cancel'), { name: 'AbortError' }));
  };
  try {
    const pending = exportSession(session, { download: () => assert.fail('must not download after cancellation') });
    assert.equal(pickerCalled, true, 'picker is invoked synchronously during the click gesture');
    await assert.rejects(pending, { name: 'AbortError' });
  } finally {
    if (old) globalThis.showDirectoryPicker = old;
    else delete globalThis.showDirectoryPicker;
  }
});

test('busy native picker falls back to a complete ZIP, including busy AbortError', async () => {
  const session = createSession(['Ubuntu original'], 'Ubuntu测试', { createdAt: fixedDate });
  const old = globalThis.showDirectoryPicker;
  try {
    for (const name of ['InvalidStateError', 'AbortError', 'Error']) {
      let calls = 0, download;
      globalThis.showDirectoryPicker = () => {
        calls++;
        throw Object.assign(new Error("Failed to execute 'showDirectoryPicker' on 'Window': File picker already active."), { name });
      };
      const result = await exportSession(session, { download: value => { download = value; } });
      assert.equal(calls, 1, 'never retry the native picker automatically');
      assert.equal(result.method, 'zip');
      assert.match(result.warning, /文件选择器正忙/);
      assert.equal(download.name, 'Ubuntu测试.zip');
      assert.deepEqual(unzipStored(download.bytes), buildSessionFiles(session));
    }
  } finally {
    if (old) globalThis.showDirectoryPicker = old;
    else delete globalThis.showDirectoryPicker;
  }
});

test('only one export runs until directory writing finishes, then the lock is released', async () => {
  const session = createSession(['original'], '重复点击', { createdAt: fixedDate });
  const old = globalThis.showDirectoryPicker;
  let choose, finishWrite, calls = 0;
  const directory = fakeDirectory();
  const originalGetFile = directory.getFileHandle.bind(directory);
  directory.getFileHandle = async (name, options) => {
    const handle = await originalGetFile(name, options);
    if (name.endsWith('.txt') && options?.create) {
      handle.createWritable = async () => ({ write: () => new Promise(resolve => { finishWrite = resolve; }), close: async () => {} });
    }
    return handle;
  };
  globalThis.showDirectoryPicker = () => { calls++; return new Promise(resolve => { choose = resolve; }); };
  try {
    const pending = exportSession(session);
    assert.equal(calls, 1, 'picker starts during the click gesture');
    await assert.rejects(exportSession(session), { name: 'InvalidStateError' });
    await assert.rejects(exportSession(session, { preferZip: true, download: () => assert.fail('duplicate download') }), { name: 'InvalidStateError' });
    assert.equal(calls, 1);
    choose(directory);
    while (!finishWrite) await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(exportSession(session), { name: 'InvalidStateError' });
    finishWrite();
    assert.equal((await pending).method, 'directory');
    assert.equal((await exportSession(session, { preferZip: true, download: () => {} })).method, 'zip');
  } finally {
    if (old) globalThis.showDirectoryPicker = old;
    else delete globalThis.showDirectoryPicker;
  }
});

test('picker failures release the export lock and writing failures do not download a second copy', async () => {
  const session = createSession(['original'], '重试', { createdAt: fixedDate });
  const old = globalThis.showDirectoryPicker;
  try {
    for (const name of ['AbortError', 'NotAllowedError']) {
      globalThis.showDirectoryPicker = () => Promise.reject(Object.assign(new Error('stop'), { name }));
      await assert.rejects(exportSession(session, { download: () => assert.fail('must not download') }), { name });
      assert.equal((await exportSession(session, { preferZip: true, download: () => {} })).method, 'zip');
    }
    const directory = fakeDirectory();
    directory.getDirectoryHandle = async (name, options) => {
      if (!options?.create) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
      throw Object.assign(new Error('disk full'), { name: 'QuotaExceededError' });
    };
    await assert.rejects(exportSession(session, { directoryHandle: directory, download: () => assert.fail('must not download after write failure') }), { name: 'QuotaExceededError' });
    assert.equal((await exportSession(session, { preferZip: true, download: () => {} })).method, 'zip');
  } finally {
    if (old) globalThis.showDirectoryPicker = old;
    else delete globalThis.showDirectoryPicker;
  }
});

const logFiles = process.env.ROBOT_TEST_LOG_FILES;
test('real logs export all raw lines and contain usable processed samples', { skip: !logFiles && 'ROBOT_TEST_LOG_FILES is not set' }, async () => {
  const paths = JSON.parse(logFiles);
  assert.ok(Array.isArray(paths) && paths.length > 0, 'ROBOT_TEST_LOG_FILES must be a nonempty JSON array of log paths');
  for (const path of paths) {
    const raw = (await readFile(path, 'utf8')).split(/\r?\n/);
    if (raw.at(-1) === '') raw.pop();
    const session = createSession(raw.map((line, index) => ({ line, at: index * 10 })), '检查', { createdAt: fixedDate });
    const files = buildSessionFiles(session);
    assert.equal(files[0].content, raw.join('\n') + '\n');
    const metadata = JSON.parse(files.find(file => file.path.endsWith('metadata.json')).content);
    assert.equal(metadata.lineCount, raw.length);
    assert.ok(metadata.counts.wheelSamples > 0, `${path}: wheel samples`);
    assert.ok(metadata.counts.laserSamples > 0, `${path}: laser samples`);
    assert.ok(metadata.counts.poseSamples > 0, `${path}: pose samples`);
    assert.deepEqual(unzipStored(buildZip(files, new Date(fixedDate))), files);
  }
});
