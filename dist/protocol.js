const num = v => typeof v==='string' && /^-?\d+(?:\.\d+)?$/.test(v) ? Number(v) : NaN;
export const nodePoint = n => Number.isInteger(n)&&n>=0&&n<120 ? {x:n%12,y:Math.floor(n/12),node:n} : null;
function point(v) { const m=/^\((-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\)(?::(OK|LOW))?$/.exec(v||''); return m?{x:+m[1],y:+m[2],trusted:m[3]==='OK'}:null; }
export function parseLine(text) {
 const line=text.trim(), type=line.split(',')[0];
 const fw=/^FW BUILD=([^,\s]+)/.exec(line)||/^(?:IMH|IMU),.*\bFW=([^,\s]+)/.exec(line);
 if(fw)return {type:'FIRMWARE',firmware:fw[1]};
 if(!['ENM','N','MAT','LSR','STP','WF','W4','PLAN','IMU','LTEST'].includes(type)) return null;
 const f={}; for(const m of line.matchAll(/(?:^|,)([A-Za-z][\w]*)=(\([^)]*\)(?::(?:OK|LOW))?|[^,]*)/g)) f[m[1]]=m[2];
 const cols=line.split(','); const time=num(cols[1]);
 if(!['N','WF','W4','LSR'].includes(type)){
   const start=type==='IMU'?line.indexOf(','):line.indexOf(',',line.indexOf(',')+1);
   const rest=line.slice(start);const field= /,([A-Za-z][\w]*)=(\([^)]*\)(?::(?:OK|LOW))?|[^,]*)/gy;const seen=new Set();let pos=0,m;
   while((m=field.exec(rest))){if(seen.has(m[1]))return {type:'INVALID'};seen.add(m[1]);pos=field.lastIndex;}
   if(pos!==rest.length)return {type:'INVALID'};
 }
 if(type==='LTEST') {
   const start=/^(\d+)\/(\d+)$/.exec(f.start||'');
   if(!Number.isFinite(time)||time<0||f.mode!=='LASER'||!start||+start[1]>11||+start[2]>9||!Number.isFinite(num(f.north10))||!['imu','enc','ready'].every(k=>['0','1'].includes(f[k]))||('motors'in f&&!['0','1'].includes(f.motors))) return {type:'INVALID'};
   return {type,time,start:{x:+start[1],y:+start[2]},northYaw:num(f.north10)/10,imuValid:f.imu==='1',encoderValid:f.enc==='1',ready:f.ready==='1',motorsDisabled:'motors'in f?f.motors==='0':null};
 }
 if(type==='ENM') {
   const legacy=!('v'in f)&&!('yaw10'in f);
   if(!Number.isFinite(time)|| (!legacy&&(!/^[0-3]\/[0-9a-f]$/i.test(f.v||'')||!Number.isFinite(num(f.yaw10))))|| !('self'in f)||!('T'in f)||!['F','L','B','R'].every(k=>k in f)) return {type:'INVALID'};
   const [flags,mask]=legacy?[point(f.self)?'1':'0','0']:f.v.split('/');
   const pose=(+flags&1)?point(f.self):null;
   const candidates=Object.fromEntries(['F','L','B','R'].map(k=>[k,point(f[k])]));
   if((+flags&1)&&!pose) return {type:'INVALID'};
   for(const k of ['F','L','B','R','T']) if(f[k]!=='0'&&!point(f[k])) return {type:'INVALID'};
   const ranges=(f.d||'').split('/').map(num);if(ranges.length!==4||!ranges.every(n=>Number.isFinite(n)&&n>=0&&n<=65535))return {type:'INVALID'};
   return {type,time,legacy,pose:pose?{...pose,yaw:legacy?NaN:num(f.yaw10)/10}:null,stable:!!(+flags&2),mask:parseInt(mask,16),candidates,enemy:point(f.T),confidence:num(f.q),age:num(f.age),ranges};
 }
 if(type==='N') { const node=num(cols[2]),heading=num(cols[3]),long=cols.length===26;const numeric=cols.slice(1,long?16:cols.length);if(long)numeric.push(...[18,19,20,21,22,24,25].map(i=>cols[i]));if(![14,16,26].includes(cols.length)||!numeric.every(v=>Number.isFinite(num(v)))||!Number.isFinite(time)||!nodePoint(node)||![0,1,2,3].includes(heading)||(long&&(![1,-1].includes(num(cols[24]))||![16,17,23].every(i=>/^[0-9a-f]{2}$/i.test(cols[i]))))) return {type:'INVALID'}; return {type,time,node,heading,remain:num(cols[4]),state:num(cols[5]),target:nodePoint(num(cols[6])),drop:num(cols[11]),dir:long?num(cols[24]):NaN}; }
 if(type==='MAT') return Number.isFinite(time)&&['role','phase','tactic','tgt','req','foe','age','q','rng'].every(k=>Number.isFinite(num(f[k])))?{type,time,target:nodePoint(num(f.tgt)),role:num(f.role),phase:num(f.phase),tactic:num(f.tactic),fields:f}:{type:'INVALID'};
 if(type==='LSR') return ['F','L','B','R'].every(k=>Number.isFinite(num(f[k])))?{type,ranges:['F','L','B','R'].map(k=>num(f[k]))}:{type:'INVALID'};
 if(type==='WF'||type==='W4') {
   const offset=type==='WF'?7:5, expected=type==='WF'?20:18;
   if(cols.length!==expected||!Number.isFinite(time)||![1,-1].includes(num(cols[3]))||!cols.slice(offset).every(v=>Number.isFinite(num(v)))) return {type:'INVALID'};
   const wheels=Array.from({length:4},(_,i)=>({target:num(cols[offset+i*3]),actual:num(cols[offset+i*3+1]),pwm:num(cols[offset+i*3+2])}));
   return {type:'WHEEL',source:type,time,wheels,dir:num(cols[3]),yaw:type==='WF'?num(cols[4])/10:NaN,travelYaw:type==='WF'?num(cols[5])/10:NaN,imuValid:type==='WF'?num(cols[6]):0,phase:cols[2],drop:num(cols.at(-1))};
 }
 if(type==='PLAN') return Number.isFinite(time)&&[1,-1].includes(num(f.dir))&&[0,1,2,3].includes(num(f.out))&&Number.isFinite(num(f.targetYaw10))&&Number.isFinite(num(f.bodyYaw10))?{type,time,dir:num(f.dir),out:num(f.out),targetYaw:num(f.targetYaw10)/10,rawYaw:num(f.bodyYaw10)/10,fields:f}:{type:'INVALID'};
 if(type==='IMU') return Number.isFinite(num(f.t))&&Number.isFinite(num(f.y10))&&['0','1'].includes(f.v)?{type,time:num(f.t),rawYaw:num(f.y10)/10,valid:f.v==='1',fields:f}:{type:'INVALID'};
 return {type,time,fields:f};
}
export class LineFramer {
 constructor(limit=8192){this.buffer='';this.limit=limit;this.dropping=false;this.overflows=0;}
 push(chunk){const lines=[];for(const c of chunk){if(c==='\n'){if(!this.dropping&&this.buffer.trim())lines.push(this.buffer.replace(/\r$/,''));this.buffer='';this.dropping=false;}else if(!this.dropping){this.buffer+=c;if(this.buffer.length>this.limit){this.buffer='';this.dropping=true;this.overflows++;}}}return lines;}
 flush(){const r=this.dropping?[]:this.buffer.trim()?[this.buffer.replace(/\r$/,'')]:[];this.buffer='';this.dropping=false;return r;}
}
