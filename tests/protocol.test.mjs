import test from 'node:test';
test('stored receipt timing overrides firmware spacing for an existing recording',()=>{
 const result=makeTimeline([{line:'N,1000,0,1,300,0,45,0,0,0,0,0,0,0',at:0},{line:'N,2000,0,1,300,0,45,0,0,0,0,0,0,0',at:10}]);
 assert.deepEqual(result.map(row=>row.at),[0,10]);
});
import assert from 'node:assert/strict';
import {parseLine, nodePoint, LineFramer} from '../dist/protocol.js';
import {makeTimeline} from '../dist/timeline.js';
import {BodyOrientation} from '../dist/motion.js';

// Synthetic fixtures follow the published firmware formats. No private log
// recordings are bundled with the website or this regression suite.
const enm = (time=1000, yaw=-885) => `ENM,${time},self=(7.01,2.23),n=1,v=3/F,yaw10=${yaw},F=0,L=0,B=0,R=(6.25,3.98):LOW,T=(6.38,3.65):OK,q=26,h=3,age=162,src=8,rej=0,d=1714/200/2402/657`;
const n26 = (time=1000, dir=1) => `N,${time},31,1,426,0,45,1,0,7,-25,0,0,24,0,114,00,1C,0,0,1,-5,0,00,${dir},300`;
const plan = (time=1000, dir=-1) => `PLAN,${time},node=43,in=1,out=0,lead=${dir<0?'R':'F'},dir=${dir},turn=RIGHT,bodyYaw10=-1782,targetYaw10=903`;
const wf = 'WF,1000,FOLLOW,-1,-1782,903,1,-100,-90,-500,-101,-91,-501,-102,-92,-502,-103,-93,-503,0';
const w4 = 'W4,1000,YAW,-1,-22,-100,-90,-500,-101,-91,-501,-102,-92,-502,-103,-93,-503,0';
const close = (actual, expected) => assert.ok(Math.abs(actual-expected)<1e-8, `${actual} differs from ${expected}`);

test('laser test north-zero status is distinct from ENM map heading and detects immediately', () => {
  const status=parseLine('LTEST,1000,mode=LASER,start=6/4,north10=0,imu=1,enc=1,ready=1,motors=0,armed=1,pose=1');
  assert.deepEqual(status,{type:'LTEST',time:1000,start:{x:6,y:4},northYaw:0,imuValid:true,encoderValid:true,ready:true,motorsDisabled:true});
  const b=new BodyOrientation();
  b.apply(status,0);
  assert.equal(Number.isFinite(b.yaw),false);
  assert.equal(status.pose,undefined);
  const detection=parseLine('ENM,1000,self=(6.00,4.00),n=1,v=3/1,yaw10=900,F=(6.00,5.00):OK,L=0,B=0,R=0,T=(6.00,5.00):OK,q=100,h=1,age=0,src=1,rej=0,d=300/0/0/0');
  assert.equal(detection.type,'ENM');
  assert.deepEqual(detection.pose,{x:6,y:4,trusted:false,yaw:90});
  assert.deepEqual(detection.candidates.F,{x:6,y:5,trusted:true});
  assert.deepEqual(detection.enemy,{x:6,y:5,trusted:true});
  b.apply(detection,0);
  close(b.yaw,90);
  b.apply(parseLine('LTEST,1200,mode=LASER,start=6/4,north10=900,imu=1,enc=1,ready=1,motors=0'),200);
  close(b.yaw,90); // Status never invents a continuous pose or turns the map body.
});

test('laser status supports unready state and rejects malformed settings or sensor flags', () => {
  const line='LTEST,1000,mode=LASER,start=6/4,north10=-100,imu=0,enc=1,ready=0';
  const status=parseLine(line);
  assert.equal(status.type,'LTEST');
  assert.equal(status.ready,false);
  assert.equal(status.northYaw,-10);
  assert.equal(status.imuValid,false);
  assert.equal(status.motorsDisabled,null);
  for(const bad of [line.replace('1000,','-1,'),line.replace('mode=LASER','mode=OTHER'),line.replace('6/4','12/4'),line.replace('6/4','6/10'),line.replace('6/4','broken'),line.replace('north10=-100','north10=NaN'),line.replace('imu=0','imu=2'),line.replace('enc=1','enc=bad'),line.replace('ready=0','ready=3'),line+',imu=1',line+',motors=2']) {
    assert.equal(parseLine(bad).type,'INVALID',bad);
  }
});

test('continuous body coordinates, enemy confidence and FLBR ranges remain distinct', () => {
  const p=parseLine(enm());
  assert.equal(p.type,'ENM');
  assert.deepEqual([p.pose.x,p.pose.y,p.pose.yaw],[7.01,2.23,-88.5]);
  assert.equal(p.stable,true);
  assert.equal(p.candidates.R.trusted,false);
  assert.equal(p.enemy.trusted,true);
  assert.equal(p.confidence,26);
  assert.deepEqual(p.ranges,[1714,200,2402,657]);
  assert.equal(parseLine('LSR,F=1714,B=2402,L=200,R=657').ranges.join('/'),'1714/200/2402/657');
});

test('legacy ENM retains continuous position without inventing map yaw', () => {
  const legacy=enm().replace(',v=3/F,yaw10=-885','');
  const p=parseLine(legacy);
  assert.equal(p.type,'ENM');
  assert.equal(p.legacy,true);
  assert.deepEqual([p.pose.x,p.pose.y],[7.01,2.23]);
  assert.equal(Number.isFinite(p.pose.yaw),false);
  assert.equal(p.enemy.trusted,true);
});

test('invalid or partial ENM never supplies a pose or range sample', () => {
  for(const line of [enm().replace('v=3/F','v=7/FF'),enm().replace('self=(7.01,2.23)','self=(7.01,broken)'),enm().replace('d=1714/200/2402/657','d=1714/200/broken/657'),enm().replace('d=1714/200/2402/657','d=1714/200/2402'),enm().replace(',yaw10=-885','')]) {
    assert.equal(parseLine(line).type,'INVALID',line);
  }
  const p=parseLine(enm().replace('self=(7.01,2.23)','self=0').replace('v=3/F','v=0/0'));
  assert.equal(p.pose,null);
});

test('WF 20 columns and W4 18 columns expose actual individual wheel values', () => {
  for(const line of [wf,w4]) {
    const p=parseLine(line);
    assert.equal(p.type,'WHEEL');
    assert.equal(p.dir,-1);
    assert.deepEqual(p.wheels,[{target:-100,actual:-90,pwm:-500},{target:-101,actual:-91,pwm:-501},{target:-102,actual:-92,pwm:-502},{target:-103,actual:-93,pwm:-503}]);
  }
  close(parseLine(wf).yaw,-178.2);
  close(parseLine(wf).travelYaw,90.3);
  assert.equal(Number.isFinite(parseLine(w4).yaw),false);
});

test('truncated, merged, or invalid-direction wheel rows are rejected', () => {
  for(const line of ['W4,1000,9,50,43,484,-50,-51,-540,0',w4+',0',w4.split(',').slice(0,-1).join(','),w4.replace('YAW,-1,','YAW,0,'),wf.replace('-93,-503','broken,-503')]) {
    assert.equal(parseLine(line).type,'INVALID',line);
  }
});

test('all supported N schemas work and unknown fields remain unknown', () => {
  const variants=[n26().split(',').slice(0,14).join(','),n26().split(',').slice(0,16).join(','),n26()];
  for(const line of variants) {
    const p=parseLine(line);
    assert.equal(p.type,'N');
    assert.equal(p.node,31);
    assert.equal(p.heading,1);
    assert.equal(p.target.node,45);
  }
  assert.equal(Number.isFinite(parseLine(variants[0]).dir),false);
  assert.equal(parseLine(variants[2]).dir,1);
  assert.equal(parseLine(n26().replace(',426,',',-426,')).remain,-426);
  assert.equal(parseLine(n26().replace(',45,',',255,')).target,null);
});

test('corrupted N rows cannot alter logical travel direction or map state', () => {
  for(const line of [n26(1000,0),n26(1000,723),n26(1000,-89),n26()+',-14,-671',n26().replace(',00,1C,',',GG,1C,'),n26().replace(',31,1,',',120,1,'),n26().replace(',31,1,',',31,4,'),n26().replace(',426,0,',',426,role=0,')]) {
    assert.equal(parseLine(line).type,'INVALID',line);
  }
});

test('boot and delayed fault markers both expose firmware identity', () => {
  for(const line of ['FW BUILD=20261018-TEST','IMH,t=1000,reason=26,D=5,rx=64,ht=32,drop=0,FW=20261018-TEST']) {
    assert.deepEqual(parseLine(line),{type:'FIRMWARE',firmware:'20261018-TEST'});
  }
  assert.equal(parseLine('unrelated private console text'),null);
});

test('broken IMU and MAT headers cannot inject invented timestamps', () => {
  for(const line of [
    'IMU,t=12,878,-224,-484,-1307,0',
    'IMU,t=137440433,rx=13866,rej=111,ce=0,ue=0,v433,rx=13866,v=1,y10=12',
    'MAT,11,phase=1,tactic=0,own=0,pb=0,cro,phase=1,tgt=72',
  ]) assert.equal(parseLine(line).type,'INVALID',line);
});

test('device timing preserves pauses, short reordering and reset epochs', () => {
  const lines=[n26(10000),enm(10400),n26(10380),'unrecognized',enm(11000),n26(100),enm(500)];
  const timeline=makeTimeline(lines);
  assert.equal(timeline.length,lines.length);
  assert.deepEqual(timeline.slice(0,5).map(x=>x.at),[0,400,400,400,1000]);
  assert.ok(timeline.every((x,i)=>Number.isFinite(x.at)&&x.at>=0&&(!i||x.at>=timeline[i-1].at)));
  assert.ok(timeline.at(-1).at>=1400 && timeline.at(-1).at<=1800);
  assert.deepEqual(timeline.map(x=>x.line),lines);
});

test('recorded wall-clock offsets and firmware markers survive timeline creation', () => {
  const rows=makeTimeline([{line:n26(1000),at:0},{line:'FW BUILD=synthetic',at:45},{line:enm(1400),at:410}]);
  assert.deepEqual(rows.map(x=>x.at),[0,45,410]);
  assert.equal(rows[2].firmware,'synthetic');
});

test('one isolated corrupt device timestamp cannot create a false reset or long pause', () => {
  for(const middle of [n26(1160),n26(116800000)]) {
    const lines=[n26(116800),middle,n26(116820),n26(117000)];
    const timeline=makeTimeline(lines);
    assert.deepEqual(timeline.map(x=>x.line),lines);
    assert.equal(timeline.at(-1).at,200);
  }
  // A repeated, coherent new clock is an actual recording epoch boundary.
  const restarted=makeTimeline([n26(116800),n26(1160),n26(1360),n26(1560)]);
  assert.ok(restarted.at(-1).at>=400&&restarted.at(-1).at<=1000);
});

test('duplicated corrupt timestamps do not corroborate a new clock epoch', () => {
  const bad=n26(6710).split(',').slice(0,14).join(',');
  const lines=[n26(671600),bad,bad,n26(671620),n26(671800)];
  const timeline=makeTimeline(lines);
  assert.equal(timeline.at(-1).at,200);
  assert.equal(timeline[1].ignore,true);
  assert.equal(timeline[2].ignore,true);
  // Repeated timestamp rows are normal inside a real reboot, provided a
  // subsequent advancing timestamp corroborates the reset clock.
  const genuine=makeTimeline([n26(671600),n26(6710),n26(6710),n26(6910),n26(7110)]);
  assert.ok(genuine.at(-1).at>=400&&genuine.at(-1).at<=1000);
});

test('line framing supports arbitrary UTF-8 decoded chunk boundaries and overflow recovery', () => {
  const f=new LineFramer(100);
  assert.deepEqual(f.push('FW BUILD=测试\r'),[]);
  assert.deepEqual(f.push('\nLSR,F=1,B='),['FW BUILD=测试']);
  assert.deepEqual(f.push('3,L=2,R=4\n\n'),['LSR,F=1,B=3,L=2,R=4']);
  assert.deepEqual(f.push('x'.repeat(101)+'\nOK\n'),['OK']);
  assert.equal(f.overflows,1);
  f.push('last partial line');
  assert.deepEqual(f.flush(),['last partial line']);
  assert.deepEqual(f.flush(),[]);
});

test('body orientation stays unknown until an actual map heading or calibration exists', () => {
  const b=new BodyOrientation();
  b.apply(parseLine(n26()),0);
  b.apply(parseLine('IMU,t=1000,v=1,y10=-1782'),0);
  assert.equal(Number.isFinite(b.yaw),false);
  b.apply(parseLine(enm()),10);
  close(b.yaw,-88.5);
  const stamp=b.stamp;
  b.apply(parseLine(n26(1200,-1).replace(',31,1,',',31,3,')),20);
  close(b.yaw,-88.5);
  assert.equal(b.stamp,stamp);
});

test('PLAN calibrates raw IMU to physical map body yaw, including reverse travel', () => {
  const b=new BodyOrientation();
  const p=parseLine(plan());
  assert.equal(p.type,'PLAN');
  b.apply(p,0);
  close(b.yaw,-88.5);
  b.apply(parseLine('IMU,t=1200,v=1,y10=-1500'),200);
  close(b.yaw,-60.3);
  b.apply(parseLine('IMU,t=1400,v=0,y10=0'),400);
  close(b.yaw,-60.3);
  b.apply(parseLine(wf),500);
  close(b.yaw,-88.5);
});

test('logical reversal never synthesizes a 180 degree body rotation', () => {
  const b=new BodyOrientation();
  b.apply(parseLine(plan()),0);
  const before=b.yaw;
  b.apply(parseLine(n26(1200,1)),200);
  b.apply(parseLine(w4.replace('YAW,-1,','YAW,1,')),240);
  close(b.yaw,before);
  // A genuine measured 180-degree anomaly remains visible instead of being
  // snapped back to the intended cardinal heading.
  b.apply(parseLine('IMU,t=1400,v=1,y10=18'),400);
  close(b.yaw,91.5);
  b.reset();
  assert.equal(Number.isFinite(b.yaw),false);
  assert.equal(b.offset,null);
});

test('node indices map to the actual 12 by 10 grid', () => {
  assert.deepEqual(nodePoint(119),{x:11,y:9,node:119});
  for(const n of [-1,120,1.5,NaN]) assert.equal(nodePoint(n),null);
});
