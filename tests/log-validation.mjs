import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {parseLine} from '../dist/protocol.js';
import {makeTimeline} from '../dist/timeline.js';
import {BodyOrientation} from '../dist/motion.js';

// Read-only against the corpus. The summary contains metadata and counts only;
// raw serial data and local recordings never become published site assets.
const source=process.argv[2];
if(!source) {
  console.error('Usage: node tests/log-validation.mjs <log-directory>');
  process.exit(1);
}
const summaryPath=path.join(path.dirname(fileURLToPath(import.meta.url)),'latest-log-validation.json');
const files=fs.readdirSync(source).map(name=>({name,stat:fs.statSync(path.join(source,name))})).filter(x=>x.stat.isFile()&&/\.txt$/i.test(x.name)).sort((a,b)=>b.stat.mtimeMs-a.stat.mtimeMs).slice(0,6);
assert.ok(files.length>0,'No .txt recordings found');

const summary={generatedAt:new Date().toISOString(),corpusDirectory:source,privacy:'Metadata only. Raw logs are read locally and are not published.',files:[]};
for(const file of files) {
  const lines=fs.readFileSync(path.join(source,file.name),'utf8').split(/\r?\n/).filter(Boolean);
  const timeline=makeTimeline(lines), orientation=new BodyOrientation();
  const counts={},rawRecognized={},devicesByType={},firmware=new Set(),directions=new Set();
  const report={name:file.name,bytes:file.stat.size,lineCount:lines.length,counts,rawRecognized,legacyPoseCount:0,currentPoseCount:0,confirmedEnemyCount:0,wheelCount:0,invalidByPrefix:{},ignoredTimestampRows:0,smallClockReorders:0,deviceClockRestarts:0,mapOrientationSamples:0,timelineDurationMs:timeline.at(-1)?.at||0,timing:{},firmware:[],directions:[]};
  let previousTime=null,epoch=0,lastAt=-Infinity;
  for(let i=0;i<lines.length;i++) {
    const line=lines[i],p=parseLine(line),type=p?.type||'UNKNOWN',prefix=/^[A-Z][A-Z0-9]*/.exec(line)?.[0]||'OTHER';
    counts[type]=(counts[type]||0)+1;
    if(['ENM','N','MAT','LSR','STP','WF','W4','PLAN','IMU','IMH'].includes(prefix))rawRecognized[prefix]=(rawRecognized[prefix]||0)+1;
    assert.equal(timeline[i].line,line,'Timeline changed raw content');
    assert.ok(Number.isFinite(timeline[i].at)&&timeline[i].at>=lastAt,'Playback time must be finite and monotonic');
    lastAt=timeline[i].at;
    if(type==='INVALID') {report.invalidByPrefix[prefix]=(report.invalidByPrefix[prefix]||0)+1;continue;}
    if(!p)continue;
    if(timeline[i].ignore) {report.ignoredTimestampRows++;continue;}
    if(type==='FIRMWARE')firmware.add(p.firmware);
    if(type==='ENM') {
      assert.equal(p.ranges.length,4);
      if(p.pose) {if(p.legacy)report.legacyPoseCount++;else report.currentPoseCount++;}
      if(p.enemy)report.confirmedEnemyCount++;
    }
    if(type==='WHEEL') {report.wheelCount++;assert.equal(p.wheels.length,4);assert.ok(p.wheels.every(w=>Number.isFinite(w.actual)&&Number.isFinite(w.target)));}
    if(Number.isFinite(p.dir)) {assert.ok([-1,1].includes(p.dir),'Corrupt travel direction escaped parser');directions.add(p.dir);}
    if(Number.isFinite(p.time)) {
      assert.ok(p.time>=0,'Negative device timestamp escaped parser');
      if(previousTime!==null&&p.time<previousTime) {if(previousTime-p.time>5000){report.deviceClockRestarts++;epoch++;orientation.reset();}else report.smallClockReorders++;}
      previousTime=p.time;
      (devicesByType[type]??=[]).push({time:p.time,epoch});
    }
    orientation.apply(p,timeline[i].at);
    if(Number.isFinite(orientation.yaw)){assert.ok(orientation.yaw>=-180&&orientation.yaw<=180);report.mapOrientationSamples++;}
  }
  for(const [type,ts] of Object.entries(devicesByType)) {
    const deltas=[];for(let i=1;i<ts.length;i++){const d=ts[i].time-ts[i-1].time;if(ts[i].epoch===ts[i-1].epoch&&d>0)deltas.push(d);}
    deltas.sort((a,b)=>a-b);
    report.timing[type]={firstDeviceMs:ts[0]?.time,lastDeviceMs:ts.at(-1)?.time,medianPositiveIntervalMs:deltas.length?deltas[Math.floor(deltas.length/2)]:null,maxPositiveIntervalMs:deltas.at(-1)??null};
  }
  report.firmware=[...firmware];report.directions=[...directions].sort();
  assert.equal(Object.values(counts).reduce((a,b)=>a+b,0),lines.length);
  assert.ok(report.wheelCount>0,'Expected actual per-wheel turn telemetry in the latest recordings');
  assert.ok(report.legacyPoseCount+report.currentPoseCount>0,'Expected ENM body positions');
  summary.files.push(report);
}
summary.totals=summary.files.reduce((t,f)=>({lines:t.lines+f.lineCount,parsed:t.parsed+f.lineCount-(f.counts.UNKNOWN||0)-(f.counts.INVALID||0),invalid:t.invalid+(f.counts.INVALID||0),poses:t.poses+f.currentPoseCount+f.legacyPoseCount,wheelSamples:t.wheelSamples+f.wheelCount}),{lines:0,parsed:0,invalid:0,poses:0,wheelSamples:0});
fs.writeFileSync(summaryPath,JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({summaryPath,totals:summary.totals,files:summary.files.map(({name,lineCount,counts,currentPoseCount,legacyPoseCount,wheelCount,ignoredTimestampRows,deviceClockRestarts,smallClockReorders,timelineDurationMs,firmware})=>({name,lineCount,counts,currentPoseCount,legacyPoseCount,wheelCount,ignoredTimestampRows,deviceClockRestarts,smallClockReorders,timelineDurationMs,firmware}))},null,2));
