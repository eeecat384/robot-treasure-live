import { parseLine } from './protocol.js';
import { makeTimeline } from './timeline.js';
import { BodyOrientation } from './motion.js';
import { WHEEL_POSITIONS } from './wheel-layout.js';

const encoder = new TextEncoder();
const clone = value => typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
const finite = value => Number.isFinite(value) ? value : '';
const PERSISTENCE_WARNING = '浏览器历史存储不可用，目前仅保存在内存中。关闭或刷新页面前请导出数据。';

/** User-visible names always use the team's Asia/Shanghai timezone. */
export function defaultSessionName(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `测试数据${parts.month}${parts.day}${parts.hour}${parts.minute}`;
}

export function sanitizeName(value) {
  let name = String(value ?? '').normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').trim().replace(/[. ]+$/g, '');
  name = [...name].slice(0, 96).join('').replace(/[. ]+$/g, '');
  if (!name || /^\.+$/.test(name)) return '未命名测试';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return name;
}

function makeId() {
  return globalThis.crypto?.randomUUID?.() ?? `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** at is relative monotonic receipt time in milliseconds, not MCU time. */
export function createSession(lines = [], name, options = {}) {
  if (typeof options === 'string') options = { firmware: options };
  const createdAt = new Date(options.createdAt ?? Date.now()).toISOString();
  let lastAt = 0;
  const normalized = Array.from(lines, entry => {
    const at = typeof entry === 'object' && entry !== null ? Number(entry.at) : lastAt;
    lastAt = Math.max(lastAt, Number.isFinite(at) ? at : lastAt, 0);
    return { line: String(typeof entry === 'object' && entry !== null ? entry.line ?? '' : entry), at: lastAt };
  });
  let firmware = options.firmware || '';
  if (!firmware) {
    for (const { line } of normalized) {
      const parsed = parseLine(line);
      if (parsed?.type === 'FIRMWARE') { firmware = parsed.firmware; break; }
    }
  }
  return {
    id: options.id || makeId(), name: sanitizeName(name || defaultSessionName(new Date(createdAt))),
    createdAt, firmware: String(firmware), source: String(options.source || 'serial'),
    durationMs: normalized.at(-1)?.at ?? 0, lines: normalized
  };
}

const summarize = session => ({
  id: session.id, name: session.name, createdAt: session.createdAt,
  firmware: session.firmware, source: session.source,
  durationMs: session.durationMs, lineCount: session.lines.length
});
const uniqueName = (wanted, names) => {
  if (!names.has(wanted.toLocaleLowerCase())) return wanted;
  for (let suffix = 2; suffix < 100000; suffix++) {
    const candidate = `${wanted} (${suffix})`;
    if (!names.has(candidate.toLocaleLowerCase())) return candidate;
  }
  throw new Error('同名测试过多，请换一个名称。');
};

/** IndexedDB stores structured data entirely in this browser; it is never uploaded. */
export class SessionStore {
  constructor({ indexedDB = globalThis.indexedDB, onWarning = () => {} } = {}) {
    this.indexedDB = indexedDB;
    this.onWarning = onWarning;
    this.memory = new Map();
    this.persistent = Boolean(indexedDB);
    this.warning = '';
    this.dbPromise = null;
    this.queue = Promise.resolve();
    if (!indexedDB) this.fallback();
  }

  fallback() {
    this.persistent = false;
    if (!this.warning) {
      this.warning = PERSISTENCE_WARNING;
      this.onWarning(this.warning);
    }
  }

  async database() {
    if (!this.persistent) return null;
    if (!this.dbPromise) this.dbPromise = new Promise((resolve, reject) => {
      const request = this.indexedDB.open('robot-treasure-measurements', 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('sessions')) request.result.createObjectStore('sessions', { keyPath: 'id' });
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); this.dbPromise = null; this.fallback(); };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('历史数据库升级被其他页面阻止。'));
    }).catch(() => { this.fallback(); return null; });
    return this.dbPromise;
  }

  async operation(mode, action) {
    const db = await this.database();
    if (!db) return { fallback: true };
    try {
      const value = await new Promise((resolve, reject) => {
        const transaction = db.transaction('sessions', mode);
        const request = action(transaction.objectStore('sessions'));
        let result;
        request.onsuccess = () => { result = request.result; };
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error('历史存储事务被取消。'));
      });
      return { value };
    } catch {
      this.fallback();
      return { fallback: true };
    }
  }

  async all() {
    const result = await this.operation('readonly', store => store.getAll());
    if (!result.fallback) {
      // Keep a recoverable copy of records already read if storage later fails.
      this.memory = new Map(result.value.map(session => [session.id, clone(session)]));
      return result.value;
    }
    return Array.from(this.memory.values(), clone);
  }

  async list() {
    await this.queue;
    return (await this.all()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(summarize);
  }

  async get(id) {
    await this.queue;
    const result = await this.operation('readonly', store => store.get(id));
    const value = result.fallback ? this.memory.get(id) : result.value;
    if (value) this.memory.set(id, clone(value));
    return value ? clone(value) : null;
  }

  mutate(work) {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }

  save(session) {
    // Snapshot at invocation: a queued save must not absorb later serial input.
    const normalized = createSession(session.lines, session.name, session);
    return this.mutate(async () => {
      const records = await this.all();
      normalized.name = uniqueName(normalized.name, new Set(records.filter(item => item.id !== normalized.id).map(item => item.name.toLocaleLowerCase())));
      this.memory.set(normalized.id, clone(normalized));
      await this.operation('readwrite', store => store.put(normalized));
      return clone(normalized);
    });
  }

  rename(id, name) {
    return this.mutate(async () => {
      const records = await this.all();
      const session = records.find(item => item.id === id);
      if (!session) throw new Error('找不到这条测试记录。');
      session.name = uniqueName(sanitizeName(name), new Set(records.filter(item => item.id !== id).map(item => item.name.toLocaleLowerCase())));
      this.memory.set(id, clone(session));
      await this.operation('readwrite', store => store.put(session));
      return clone(session);
    });
  }

  delete(id) {
    return this.mutate(async () => {
      this.memory.delete(id);
      await this.operation('readwrite', store => store.delete(id));
    });
  }
}

function csv(rows) {
  return '\ufeff' + rows.map(row => row.map(cell => {
    const value = String(cell ?? '');
    return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  }).join(',')).join('\r\n') + '\r\n';
}

export function buildSessionFiles(input, outputName = input.name) {
  const session = createSession(input.lines, input.name, input);
  const name = sanitizeName(outputName);
  const wheels = [['receipt_ms', 'device_time_ms', 'source', 'direction', 'raw_imu_yaw_deg', ...'ABCD'.split('').flatMap(label => [`${label}_target`, `${label}_actual`, `${label}_pwm`])]];
  const lasers = [['receipt_ms', 'device_time_ms', 'source', 'front', 'left', 'back', 'right']];
  const poses = [['receipt_ms', 'device_time_ms', 'source', 'x', 'y', 'map_body_yaw_deg', 'node', 'heading', 'direction', 'stable']];
  const targets = [['receipt_ms', 'device_time_ms', 'source', 'x', 'y', 'node']];
  const orientations = [['receipt_ms', 'device_time_ms', 'source', 'raw_imu_yaw_deg', 'raw_imu_valid', 'map_body_yaw_deg', 'map_yaw_source', 'map_yaw_age_ms']];
  const counts = { wheelSamples: 0, laserSamples: 0, poseSamples: 0, targetSamples: 0, orientationSamples: 0, unknownLines: 0, invalidLines: 0, ignoredLines: 0 };
  const orientation = new BodyOrientation();
  let latestDevice = null;
  for (const { line, index, ignore } of makeTimeline(session.lines)) {
    const at = session.lines[index].at;
    const value = parseLine(line);
    if (!value) { counts.unknownLines++; continue; }
    if (value.type === 'INVALID') { counts.invalidLines++; continue; }
    if (ignore) { counts.ignoredLines++; continue; }
    if (Number.isFinite(value.time)) {
      if (latestDevice !== null && value.time < latestDevice - 5000) orientation.reset();
      latestDevice = value.time;
    }
    orientation.apply(value, at);
    const deviceTime = finite(value.time);
    if (['PLAN', 'IMU', 'WHEEL', 'ENM'].includes(value.type)) {
      const raw = value.type === 'WHEEL' ? value.yaw : value.rawYaw;
      const rawValid = value.type === 'IMU' ? Number(value.valid) : value.type === 'WHEEL' && value.source === 'WF' ? Number(Boolean(value.imuValid)) : value.type === 'PLAN' ? Number(Number.isFinite(raw)) : '';
      const fresh = Number.isFinite(orientation.yaw) && at - orientation.stamp <= 2000;
      orientations.push([at, deviceTime, value.source || value.type, finite(raw), rawValid,
        fresh ? orientation.yaw : '', fresh ? orientation.source : '无可靠朝向', fresh ? at - orientation.stamp : '']);
      counts.orientationSamples++;
    }
    if (value.type === 'WHEEL') {
      wheels.push([at, deviceTime, value.source, finite(value.dir), finite(value.yaw), ...value.wheels.flatMap(wheel => [finite(wheel.target), finite(wheel.actual), finite(wheel.pwm)])]);
      counts.wheelSamples++;
    }
    if (['ENM', 'LSR'].includes(value.type) && value.ranges?.length === 4 && value.ranges.every(Number.isFinite)) {
      lasers.push([at, deviceTime, value.type, ...value.ranges]);
      counts.laserSamples++;
    }
    if (value.type === 'ENM' && value.pose) {
      poses.push([at, deviceTime, value.type, value.pose.x, value.pose.y, finite(value.pose.yaw), '', '', '', value.stable ? 1 : 0]);
      counts.poseSamples++;
    }
    if (value.type === 'N') {
      poses.push([at, deviceTime, value.type, value.node % 12, Math.floor(value.node / 12), '', value.node, value.heading, finite(value.dir), '']);
      counts.poseSamples++;
    }
    if (value.target) {
      targets.push([at, deviceTime, value.type, value.target.x, value.target.y, value.target.node ?? '']);
      counts.targetSamples++;
    }
  }
  const metadata = {
    formatVersion: 2, id: session.id, name: session.name, exportName: name,
    createdAt: session.createdAt, timeZone: 'Asia/Shanghai', firmware: session.firmware,
    source: session.source, durationMs: session.durationMs, lineCount: session.lines.length,
    counts, receiptTimesMs: session.lines.map(entry => entry.at),
    laserOrder: ['front', 'left', 'back', 'right'], wheelPositions: WHEEL_POSITIONS,
    units: { receiptTime: 'ms', deviceTime: 'ms', rawImuYaw: 'degree in raw IMU reference', mapBodyYaw: 'degree in map reference', wheelSpeed: 'mm/s', laserRange: 'mm', position: 'grid coordinate (300 mm per grid)' },
    notes: ['原始串口逐行保留，未知行也保留。', 'receiptTimesMs 与原始文件的行一一对应。', '损坏行与时间异常忽略行仅保留在原始文件，不混入处理数据。', '节点数据只描述已上报节点；未补造两节点间运动。', '地图朝向采用与界面相同的 ENM / PLAN 标定和实测 IMU；未标定、重启或过期时留空。', 'raw_imu_yaw_deg 与 map_body_yaw_deg 使用不同参考系，不能直接混用。', '四轮位置：A 左上、B 右上、C 左下、D 右下；串口通道顺序仍为 A/B/C/D。']
  };
  return [
    { path: `${name}.txt`, content: session.lines.map(entry => entry.line).join('\n') + (session.lines.length ? '\n' : '') },
    { path: `${name}/processed-wheels.csv`, content: csv(wheels) },
    { path: `${name}/processed-lasers.csv`, content: csv(lasers) },
    { path: `${name}/processed-poses.csv`, content: csv(poses) },
    { path: `${name}/processed-targets.csv`, content: csv(targets) },
    { path: `${name}/processed-orientation.csv`, content: csv(orientations) },
    { path: `${name}/metadata.json`, content: JSON.stringify(metadata, null, 2) + '\n' }
  ];
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/** A standards-compliant, UTF-8, uncompressed ZIP; no upload or dependencies. */
export function buildZip(files, date = new Date()) {
  if (files.length > 65535) throw new Error('导出文件过多。');
  const chunks = [], directory = [];
  let offset = 0, directorySize = 0;
  const year = Math.max(1980, Math.min(2107, date.getUTCFullYear()));
  const dosDate = ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  const dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
  for (const file of files) {
    const filename = encoder.encode(file.path);
    const bytes = file.content instanceof Uint8Array ? file.content : encoder.encode(file.content);
    if (filename.length > 65535 || bytes.length > 0xffffffff || offset + bytes.length > 0xffffffff) throw new Error('导出大小超过 ZIP 格式限制。');
    const checksum = crc32(bytes);
    const local = new Uint8Array(30 + filename.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x0800, true);
    view.setUint16(10, dosTime, true); view.setUint16(12, dosDate, true); view.setUint32(14, checksum, true);
    view.setUint32(18, bytes.length, true); view.setUint32(22, bytes.length, true); view.setUint16(26, filename.length, true);
    local.set(filename, 30);
    chunks.push(local, bytes);
    const central = new Uint8Array(46 + filename.length);
    const entry = new DataView(central.buffer);
    entry.setUint32(0, 0x02014b50, true); entry.setUint16(4, 20, true); entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true); entry.setUint16(12, dosTime, true); entry.setUint16(14, dosDate, true);
    entry.setUint32(16, checksum, true); entry.setUint32(20, bytes.length, true); entry.setUint32(24, bytes.length, true);
    entry.setUint16(28, filename.length, true); entry.setUint32(42, offset, true); central.set(filename, 46);
    directory.push(central); directorySize += central.length; offset += local.length + bytes.length;
  }
  const footer = new Uint8Array(22);
  const view = new DataView(footer.buffer);
  view.setUint32(0, 0x06054b50, true); view.setUint16(8, files.length, true); view.setUint16(10, files.length, true);
  view.setUint32(12, directorySize, true); view.setUint32(16, offset, true);
  const output = new Uint8Array(offset + directorySize + footer.length);
  let cursor = 0;
  for (const chunk of [...chunks, ...directory, footer]) { output.set(chunk, cursor); cursor += chunk.length; }
  return output;
}

async function exists(directory, name, kind) {
  try {
    if (kind === 'file') await directory.getFileHandle(name);
    else await directory.getDirectoryHandle(name);
    return true;
  } catch (error) {
    if (error.name === 'NotFoundError') return false;
    // TypeMismatch also means the name exists and must never be overwritten.
    if (error.name === 'TypeMismatchError') return true;
    throw error;
  }
}

function downloadZip({ blob, name }) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.style.display = 'none';
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

let exportInProgress = false;

/** Invoke directly from a click handler so the directory picker retains user activation. */
export async function exportSession(session, options = {}) {
  if (exportInProgress) throw new DOMException('正在导出，请等待当前导出完成。', 'InvalidStateError');
  exportInProgress = true;
  try {
    return await writeSessionExport(session, options);
  } finally {
    exportInProgress = false;
  }
}

async function writeSessionExport(session, options) {
  let directory = options.directoryHandle, fallbackReason = '';
  if (!directory && !options.preferZip && typeof globalThis.showDirectoryPicker === 'function') {
    try {
      directory = await globalThis.showDirectoryPicker({ mode: 'readwrite', id: 'robot-treasure-export' });
    } catch (error) {
      const pickerBusy = /file picker already active/i.test(error.message || '');
      // A busy Linux/native picker may surface as AbortError; an ordinary
      // user cancellation must still stop the export without downloading.
      if (!pickerBusy && !['SecurityError', 'TypeError', 'InvalidStateError', 'NotSupportedError'].includes(error.name)) throw error;
      fallbackReason = pickerBusy
        ? '文件选择器正忙，已改为 ZIP 下载；解压后可得到原始文件和处理数据文件夹。'
        : '当前页面无法选择本地目录，已改为 ZIP 下载；解压后可得到原始文件和处理数据文件夹。';
    }
  }
  const requestedName = sanitizeName(session.name);
  if (directory) {
    let name = requestedName, suffix = 2;
    while (await exists(directory, `${name}.txt`, 'file') || await exists(directory, name, 'directory')) {
      name = `${requestedName} (${suffix++})`;
      if (suffix > 10000) throw new Error('导出目录中同名文件过多，请选择其他目录。');
    }
    const files = buildSessionFiles(session, name);
    const folder = await directory.getDirectoryHandle(name, { create: true });
    for (const file of files) {
      const insideFolder = file.path.includes('/');
      const handle = await (insideFolder ? folder : directory).getFileHandle(insideFolder ? file.path.split('/')[1] : file.path, { create: true });
      const writer = await handle.createWritable();
      try { await writer.write(file.content); await writer.close(); }
      catch (error) { try { await writer.abort(); } catch {} throw error; }
    }
    return { method: 'directory', name, fileCount: files.length, renamed: name !== requestedName };
  }
  const files = buildSessionFiles(session);
  const bytes = buildZip(files, new Date(session.createdAt));
  const name = `${requestedName}.zip`;
  await (options.download || downloadZip)({ blob: new Blob([bytes], { type: 'application/zip' }), bytes, name });
  return { method: 'zip', name: requestedName, fileCount: files.length, warning: fallbackReason || (options.preferZip ? '' : '浏览器不支持选择导出目录，已下载 ZIP；解压后可得到原始文件和处理数据文件夹。') };
}
