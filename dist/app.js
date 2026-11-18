import {parseLine,LineFramer,nodePoint} from './protocol.js';
import {makeTimeline} from './timeline.js';
import {SessionStore,createSession,defaultSessionName,exportSession} from './sessions.js';
import {WaveformPanel} from './charts.js';
import {BodyOrientation} from './motion.js';
const $=id=>document.getElementById(id), NS='http://www.w3.org/2000/svg';
const fmt=(n,d=0)=>Number.isFinite(n)?n.toFixed(d):'—';
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function svg(tag,attrs={},text){const e=document.createElementNS(NS,tag);for(const[k,v]of Object.entries(attrs))e.setAttribute(k,v);if(text!==undefined)e.textContent=text;return e;}
function notify(s,warn=false){$('notice').textContent=s;$('notice').classList.toggle('warning',warn);}
function installControls(){
 const measurement=document.createElement('div');measurement.className='panel measurement';measurement.innerHTML='<div class="panel-heading"><h2>本次测量</h2><span class="small-label">RECORD</span></div><label for="sessionName">数据名称</label><input id="sessionName" maxlength="80" aria-label="数据名称"><button id="restartBtn" class="primary full">↺ 重新开始</button><p class="micro">自动保存上次测量，串口连接保持。</p>';
 document.querySelector('.sidebar').insertBefore(measurement,document.querySelector('.layers'));
 const history=document.createElement('div');history.className='panel history';history.innerHTML='<div class="panel-heading"><h2>历史测量</h2><span id="historyCount" class="badge">0</span></div><p id="storeWarning" class="micro"></p><div id="historyList"></div>';
 measurement.after(history);
 const follow=document.createElement('button');follow.id='followBtn';follow.textContent='◎ 跟随';follow.title='将小车固定在地图视角中心';document.querySelector('.map-actions').prepend(follow);
 const fw=document.createElement('div');fw.id='firmwareTag';fw.textContent='FW · 未知版本';document.querySelector('.map-wrap').append(fw);
 const motion=document.createElement('div');motion.id='motionNote';motion.className='motion-note';motion.textContent='按串口采样显示 · 不吸附赛道 · 不自动补转弯';document.querySelector('.map-panel').append(motion);
 const flow=document.createElement('div');flow.className='direction-row';flow.innerHTML='<span>行驶方向</span><b id="travelDirection">未知</b>';document.querySelector('.telemetry').append(flow);
 const leftDock=document.createElement('div');leftDock.id='chartsLeft';leftDock.className='chart-dock';history.after(leftDock);
 const middleDock=document.createElement('div');middleDock.id='chartsMiddle';middleDock.className='chart-dock';document.querySelector('.center-column').insertBefore(middleDock,document.querySelector('.console'));
 const rightDock=document.createElement('div');rightDock.id='chartsRight';rightDock.className='chart-dock';document.querySelector('.rightbar').prepend(rightDock);
 for(const id of ['wheelCharts','laserCharts']){const panel=document.createElement('section');panel.id=id;rightDock.append(panel);}
 const overlay=document.createElement('dialog');overlay.id='exportDialog';overlay.innerHTML='<div class="dialog-heading"><h2>导出测量数据</h2><button id="closeExport" aria-label="关闭导出">×</button></div><label for="exportName">数据名称</label><input id="exportName" maxlength="80"><p>导出 <b>名称.txt</b> 原始串口数据，以及 <b>名称/</b> 中的轮速、激光、位置 CSV 与元数据。</p><p class="micro">Chrome / Edge 可选择目标文件夹。也可下载 ZIP 后解压到任意位置；同名输出自动加后缀。</p><div class="export-actions"><button id="zipExport" class="secondary">下载 ZIP</button><button id="directoryExport" class="primary">选择文件夹并导出</button></div>';
 document.body.append(overlay);
 $('sessionName').value=defaultSessionName();
}
installControls();
const wheelCharts=new WaveformPanel($('wheelCharts'),{kind:'wheel'});
const laserCharts=new WaveformPanel($('laserCharts'),{kind:'laser'});
const charts={reset(){wheelCharts.reset();laserCharts.reset();},render(now){wheelCharts.render(now);laserCharts.render(now);},ingestWheel(time,values){wheelCharts.ingestWheel(time,values);},ingestLaser(time,values){laserCharts.ingestLaser(time,values);}};
const orientation=new BodyOrientation();
const store=new SessionStore({onWarning:s=>{$('storeWarning').textContent=s;}});
let model,history=[],active=[],activeId,activeStarted=Date.now(),source='live',bytes=0,totalLines=0,invalid=0,consoleRows=[],logPaused=false,consoleDirty=true;
let port=null,reader=null,readPromise=null,closing=false,transitioning=false,framer=new LineFramer(),decoder=new TextDecoder();
let mode='idle',firmware='',latestTime=0,latestDevice=null,clockEpoch=0,relative=0,lastReceive=0,sessionPerf=performance.now(),enmtime=-Infinity,navtime=-Infinity,dirTime=-Infinity,targetTime=-Infinity,rangeTime=-Infinity,yawTime=-Infinity;
let trail=[],view={x:-65,y:-65,w:790,h:670},zoom=1,follow=false,pan=null,layer={robot:true,beams:true,enemy:true,target:true,trail:true,nodes:false};
let playback=null,playStart=0,lastStats=0,statsLines=0,exportPending=null,exportBusy=false,lastRender=0;
function resetModel(){model={pose:null,poseSource:'等待 ENM',node:null,heading:NaN,dir:NaN,target:null,targetSource:'N / MAT',enemy:null,candidates:{},ranges:[],drop:NaN,confidence:NaN,enemyAge:NaN,stable:false,wheels:null,laserTest:null};trail=[];charts.reset();orientation.reset();latestTime=0;latestDevice=null;clockEpoch=0;relative=0;enmtime=navtime=dirTime=targetTime=rangeTime=yawTime=-Infinity;lastReceive=0;firmware='';}
resetModel();
const rawMap=await fetch('map.json').then(r=>{if(!r.ok)throw Error('地图读取失败');return r.json();}).catch(e=>{notify(e.message,true);return {edges:[]};});
const xy=p=>({x:p.x*60,y:(9-p.y)*60});
for(let x=0;x<12;x++){$('axes').append(svg('text',{x:x*60,y:570,'text-anchor':'middle',fill:'#9baa9e','font-size':10},x));}
for(let y=0;y<10;y++){$('axes').append(svg('text',{x:-23,y:(9-y)*60+4,'text-anchor':'middle',fill:'#9baa9e','font-size':10},y));}
$('axes').append(svg('text',{x:690,y:570,fill:'#7d9786','font-size':10},'X →'));
for(const [x1,y1,x2,y2]of rawMap.edges)$('track').append(svg('line',{x1:x1*60,y1:(9-y1)*60,x2:x2*60,y2:(9-y2)*60,stroke:'#9fb5a8','stroke-width':5,'stroke-linecap':'round'}));
for(let n=0;n<120;n++){const p=xy(nodePoint(n));$('track').append(svg('circle',{cx:p.x,cy:p.y,r:2.7,fill:'#748f7f'}));$('nodeLabels').append(svg('text',{x:p.x+5,y:p.y-7,fill:'#9cab9e','font-size':8},n));}
function clockFor(p){if(!Number.isFinite(p?.time))return relative;if(latestDevice===null)clockEpoch=-p.time;else if(p.time<latestDevice-5000){clockEpoch=relative+200-p.time;trail.push(null);}relative=Math.max(relative,clockEpoch+p.time);latestDevice=p.time;return relative;}
function recordLine(line,at){active.push({line,at});if(active.length>=200000&&!transitioning){transitioning=true;queueMicrotask(async()=>{const completed=snapshot();newMeasurement(false);try{await store.save(completed);await refreshHistory();notify('已自动归档上一段测量，新测量继续接收。');}catch(e){notify('自动归档失败：'+e.message,true);}finally{transitioning=false;}});}}
function consume(line,at,{record=false,quiet=false,ignore=false}={}){
 const p=parseLine(line);totalLines++;if(!quiet){consoleRows.push(line);if(consoleRows.length>500)consoleRows.shift();consoleDirty=true;}
 if(p?.type==='INVALID'||ignore)invalid++;
 if(p?.type==='FIRMWARE'){firmware=p.firmware;}
 const t=Number.isFinite(at)?at:performance.now()-sessionPerf;latestTime=Math.max(latestTime,t);lastReceive=performance.now();
 if(record)recordLine(line,t);
 if(!p||p.type==='INVALID'||ignore)return;
 if(Number.isFinite(p.time)){if(latestDevice!==null&&p.time<latestDevice-5000){orientation.reset();model.pose=null;model.target=null;model.enemy=null;model.candidates={};model.dir=NaN;model.node=null;model.laserTest=null;enmtime=-Infinity;trail.push(null);}latestDevice=p.time;}
 orientation.apply(p,t);
 if(p.type==='ENM'){
  enmtime=t;model.pose=p.pose;model.poseSource=p.pose?'ENM 连续位姿':'ENM 位姿无效';model.stable=p.stable;model.enemy=p.enemy;model.candidates=p.candidates;model.confidence=p.confidence;model.enemyAge=p.age;model.ranges=p.ranges;rangeTime=t;
  if(p.pose){const last=trail.at(-1);if(!last||Math.hypot(last.x-p.pose.x,last.y-p.pose.y)>.004)trail.push({...p.pose});if(trail.length>6000)trail.splice(0,trail.length-6000);}
  charts.ingestLaser(t,p.ranges);
 }else if(p.type==='N'){
  model.node=p.node;model.heading=p.heading;navtime=t;model.drop=p.drop;model.target=p.target;model.targetSource='N';targetTime=t;if([1,-1].includes(p.dir)){model.dir=p.dir;dirTime=t;}
 }else if(p.type==='MAT'){model.target=p.target;model.targetSource='MAT';targetTime=t;
 }else if(p.type==='WHEEL'){model.wheels=p.wheels;model.dir=p.dir;dirTime=t;model.drop=p.drop;charts.ingestWheel(t,p.wheels);
 }else if(p.type==='LSR'){// LSR labels are authoritative even if printed F,B,L,R.
  model.ranges=p.ranges;rangeTime=t;charts.ingestLaser(t,p.ranges);
 }else if(p.type==='PLAN'){model.dir=p.dir;dirTime=t;
 }else if(p.type==='LTEST'){model.laserTest={...p,stamp:t};}
}
function currentPose(now){const yaw=now-orientation.stamp<=2000?orientation.yaw:NaN;if(model.pose)return {...model.pose,yaw,source:model.poseSource+(Number.isFinite(yaw)?'':' / 朝向未知'),stamp:enmtime};if(model.node!==null&&enmtime===-Infinity){const p=nodePoint(model.node);return {...p,yaw,source:'N 节点位置 / '+(Number.isFinite(yaw)?'实测朝向':'朝向未知'),stamp:navtime};}return null;}
function viewNow(){return playback?playback.position:mode==='live'?latestTime+(lastReceive?performance.now()-lastReceive:0):latestTime;}
function drawMap(now){
 const g=$('dynamic');g.replaceChildren();const pose=currentPose(now),stale=pose&&now-pose.stamp>2000;
 $('nodeLabels').style.display=layer.nodes?'':'none';
 if(layer.trail&&trail.length>1){let d='';for(const p of trail){if(!p){d+=' ';continue;}const q=xy(p);d+=(d&&!d.endsWith(' ')?'L':'M')+q.x+','+q.y;}g.append(svg('path',{d,fill:'none',stroke:'#55a98b','stroke-width':3,opacity:.55}));}
 if(model.target&&layer.target){const q=xy(model.target),expired=now-targetTime>2000;g.append(svg('path',{d:`M${q.x} ${q.y-13}l13 13 -13 13 -13 -13Z`,fill:'#fff4de',stroke:'#df9653','stroke-width':2,opacity:expired?.35:1}));g.append(svg('text',{x:q.x+17,y:q.y-12,fill:'#ba7d46','font-size':10},'目标 '+model.target.node));}
 if(layer.beams&&now-enmtime<=2000)for(const[k,p]of Object.entries(model.candidates)){if(!p)continue;const q=xy(p);if(pose){const a=xy(pose);g.append(svg('line',{x1:a.x,y1:a.y,x2:q.x,y2:q.y,stroke:p.trusted?'#d0a46c':'#dfb77a','stroke-width':1.5,'stroke-dasharray':p.trusted?'':'4 5',opacity:.6}));}g.append(svg('circle',{cx:q.x,cy:q.y,r:7,fill:p.trusted?'#e8b16b':'none',stroke:'#d7a35e','stroke-width':1.5,'stroke-dasharray':p.trusted?'':'2 2'}));g.append(svg('text',{x:q.x+10,y:q.y+4,fill:'#b18a54','font-size':9},k+(p.trusted?' OK':' LOW')));}
 if(model.enemy&&layer.enemy){const q=xy(model.enemy),expired=now-enmtime>2000;g.append(svg('circle',{cx:q.x,cy:q.y,r:17,fill:'#e58c7b',opacity:expired?.08:.13}));g.append(svg('circle',{cx:q.x,cy:q.y,r:8,fill:'#d86a59',opacity:expired?.3:1}));g.append(svg('text',{x:q.x+15,y:q.y+5,fill:'#bd6b5a','font-size':10},expired?'敌人 · 过期':'敌人位置'));}
 if(pose&&layer.robot){const q=xy(pose),body=svg('g',{transform:`translate(${q.x} ${q.y}) rotate(${- (Number.isFinite(pose.yaw)?pose.yaw:0)})`,opacity:stale?.38:1});body.append(svg('circle',{r:25,fill:'#327f68',opacity:.09}));body.append(svg('rect',{x:-15,y:-11,width:30,height:22,rx:6,fill:'#267969',stroke:'#fff','stroke-width':2,filter:'url(#shadow)'}));body.append(svg('rect',{x:5,y:-6,width:5,height:12,rx:2,fill:'#d6edc3'}));
 if(Number.isFinite(pose.yaw)){body.append(svg('path',{d:'M23 -6L33 0 23 6Z',fill:'#267969',opacity:model.dir===-1?.28:1}));body.append(svg('path',{d:'M-23 -6L-33 0 -23 6Z',fill:'#267969',opacity:model.dir===-1?1:.28}));}
 if(Number.isFinite(pose.yaw)){const rad=pose.yaw*Math.PI/180;for(const[side,label]of [[1,'车头'],[-1,'车尾']])g.append(svg('text',{x:q.x+side*Math.cos(rad)*47,y:q.y-side*Math.sin(rad)*47+3,'text-anchor':'middle',fill:'#4b8068','font-size':8},label));}else body.append(svg('text',{'text-anchor':'middle',y:4,fill:'#fff','font-size':11},'?'));
 g.append(body);}
 if(follow&&pose){const q=xy(pose);view.x=q.x-view.w/2;view.y=q.y-view.h/2;}
 $('map').setAttribute('viewBox',`${view.x} ${view.y} ${view.w} ${view.h}`);
}
function render(){const now=viewNow(),pose=currentPose(now),stale=pose&&now-pose.stamp>2000;
 $('posX').textContent=fmt(pose?.x*300);$('posY').textContent=fmt(pose?.y*300);$('yaw').textContent=Number.isFinite(pose?.yaw)?fmt(pose.yaw,1)+' °':'—';$('headingNeedle').style.transform=`rotate(${90-(pose?.yaw||0)}deg)`;$('poseSource').textContent=pose?.source||model.poseSource;$('node').textContent=model.node??'—';$('deviceTime').textContent=latestDevice===null?'—':fmt(latestDevice/1000,2)+' s';
 $('drop').textContent=fmt(model.drop);$('travelDirection').textContent=now-dirTime>2000?'未知 / 过期':model.dir===1?'前进 · 车头侧':model.dir===-1?'倒行 · 车尾侧':'未知';
 $('freshness').textContent=pose?(stale?'位姿过期':mode==='replay'?'回放':'已更新'):'无位姿';$('freshness').className='badge '+(stale?'stale':pose?'active':'');
 $('targetSource').textContent=model.targetSource;$('targetValue').textContent=model.target?`N${model.target.node} · (${model.target.x}, ${model.target.y})`:'未收到有效目标';$('targetDetail').textContent=model.target?`${model.target.x*300}, ${model.target.y*300} mm${now-targetTime>2000?' · 数据过期':''}`:'N / MAT.tgt · 255 表示无目标';
 $('enemyValue').textContent=model.enemy?`(${fmt(model.enemy.x,2)}, ${fmt(model.enemy.y,2)})`:'未检测到敌人';$('enemyDetail').textContent=model.enemy?`${fmt(model.enemy.x*300)}, ${fmt(model.enemy.y*300)} mm · age ${fmt(model.enemyAge)} ms`:'ENM.T · 与导航目标独立';$('enemyStatus').textContent=now-enmtime>2000&&enmtime!==-Infinity?'过期':model.enemy?(model.enemy.trusted?'已检测':'旧日志 LOW'):'未检测';
 const test=model.laserTest,testStale=test&&now-test.stamp>2000;
 $('laserTest').hidden=!test&&!firmware.includes('LASER-POSITION');
 $('laserTestTitle').textContent='激光测试'+(test?.motorsDisabled===true?' · 电机禁用':test?.motorsDisabled===false?' · 电机状态异常':'');
 $('laserTestState').textContent=!test?'等待 LTEST':testStale?'状态过期':test.ready?'定位就绪':'等待定位';$('laserTestState').className='badge '+(testStale?'stale':test?.ready?'active':'');
 $('laserTestStart').textContent=test?`初始 (${test.start.x}, ${test.start.y}) · ${test.start.x*300}, ${test.start.y*300} mm · 北为 0°，顺时针为正 · 手动移动观测`:'等待 LTEST 测试状态；连续位姿以 ENM 为准';
 $('laserNorthYaw').textContent=test&&!testStale?fmt(test.northYaw,1)+' °':'—';$('laserImu').textContent=!test?'—':testStale?'过期':test.imuValid?'有效':'未就绪';$('laserEncoder').textContent=!test?'—':testStale?'过期':test.encoderValid?'参与定位':'未就绪';
 for(let i=0;i<4;i++)$('range'+['F','L','B','R'][i]).textContent=now-rangeTime>2000?'—':model.ranges[i]>0?fmt(model.ranges[i]):'无效';
 $('firmwareTag').textContent='FW · '+(firmware||'日志未提供版本');$('modeTag').textContent=mode==='demo'?'● 演示数据 · 非实车':mode==='replay'?'▷ 离线回放':mode==='live'?'● 串口实时观测':'○ 等待串口数据';$('modeTag').className='map-mode '+(mode==='demo'?'demo':'');
 if(consoleDirty&&!logPaused){const filter=$('logFilter').value.toLowerCase();const lines=consoleRows.filter(x=>!filter||x.toLowerCase().includes(filter));$('terminal').textContent=lines.join('\n')||'等待接收数据…';$('terminal').scrollTop=$('terminal').scrollHeight;consoleDirty=false;}
 $('lineCount').textContent=totalLines+' 行';drawMap(now);charts.render(now);
 if(playback){$('seek').value=playback.duration?Math.round(playback.position/playback.duration*1000):0;$('replayTime').textContent=(playback.position/1000).toFixed(1)+' / '+(playback.duration/1000).toFixed(1)+' s';}
}
function clearView(){resetModel();totalLines=invalid=bytes=0;consoleRows=[];consoleDirty=true;}
function newMeasurement(updateNotice=true,preserveFirmware=!!port){const knownFirmware=firmware,offset=orientation.offset;clearView();if(preserveFirmware){firmware=knownFirmware;orientation.offset=offset;}active=[];activeId=undefined;source='live';activeStarted=Date.now();sessionPerf=performance.now();$('sessionName').value=defaultSessionName();if(updateNotice)notify('已重新开始。上次测量已保存在历史记录中。');}
function snapshot(){return createSession(active,$('sessionName').value,{id:activeId,createdAt:new Date(activeStarted).toISOString(),firmware,source});}
async function saveActive(){if(!active.length||mode==='replay')return;const s=snapshot();activeId=s.id;const saved=await store.save(s);if(activeId===saved.id)$('sessionName').value=saved.name;await refreshHistory();}
async function refreshHistory(){history=await store.list();$('historyCount').textContent=history.length;$('historyList').replaceChildren();for(const s of history){const row=document.createElement('div');row.className='history-row';const title=document.createElement('strong');title.textContent=s.name;const info=document.createElement('p');info.className='micro';info.textContent=`${(s.durationMs/1000).toFixed(1)} s · ${s.source==='demo'?'演示':s.source==='import'?'导入':'实测'} · ${s.firmware||'未知固件'}`;const actions=document.createElement('div');for(const[label,action]of [['▷ 回放',async()=>{if(port){notify('请先断开串口，再打开历史回放。',true);return;}await saveActive();const data=await store.get(s.id);if(data)startReplay(data);}],['命名',async()=>{const name=prompt('新的数据名称',s.name);if(name?.trim()){const renamed=await store.rename(s.id,name.trim());if(activeId===s.id)$('sessionName').value=renamed.name;await refreshHistory();}}],['导出',async()=>openExport(await store.get(s.id))],['删除',async()=>{if(confirm('删除本机保存的「'+s.name+'」？删除后无法恢复。')){await store.delete(s.id);if(activeId===s.id){active=[];activeId=undefined;}await refreshHistory();}}]]){const b=document.createElement('button');b.className='textbutton';b.textContent=label;b.onclick=()=>Promise.resolve(action()).catch(e=>notify(e.message,true));actions.append(b);}row.append(title,info,actions);$('historyList').append(row);}if(!history.length){const p=document.createElement('p');p.className='micro';p.textContent='点击重新开始，上一次测量会保存在这里。';$('historyList').append(p);}}
function openExport(s){if(exportBusy){notify('正在导出，请等待当前导出完成。');return;}if(!s?.lines?.length){notify('还没有可导出的数据。',true);return;}exportPending=s;$('exportName').value=s.name;if(!$('exportDialog').open)$('exportDialog').showModal();}
async function doExport(preferZip){
 if(exportBusy||!exportPending)return;
 exportBusy=true;
 const dialog=$('exportDialog'),session={...exportPending,name:$('exportName').value.trim()||exportPending.name};
 const controls=['directoryExport','zipExport','exportName','closeExport'];
 for(const id of controls)$(id).disabled=true;
 dialog.setAttribute('aria-busy','true');
 const button=$(preferZip?'zipExport':'directoryExport'),label=button.textContent;
 button.textContent=preferZip?'正在生成 ZIP…':'正在选择文件夹并导出…';
 notify(preferZip?'正在生成 ZIP…':'请选择导出文件夹，完成前请勿重复操作。');
 try{
  const result=await exportSession(session,{preferZip});
  dialog.close();
  notify('导出完成：'+(result?.name||session.name)+(result?.method==='zip'?'（ZIP）':'')+(result?.warning?'。'+result.warning:''));
 }catch(e){
  notify(e.name==='AbortError'?'已取消导出，可重新选择文件夹或下载 ZIP。':'导出失败：'+e.message,e.name!=='AbortError');
 }finally{
  exportBusy=false;
  for(const id of controls)$(id).disabled=false;
  dialog.removeAttribute('aria-busy');
  button.textContent=label;
 }
}
function startReplay(s){mode='replay';source=s.source||'import';clearView();active=s.lines||[];activeId=s.id;activeStarted=new Date(s.createdAt).getTime()||Date.now();$('sessionName').value=s.name;const rows=makeTimeline(active);playback={rows,index:0,position:0,duration:rows.at(-1)?.at||0,playing:true,speed:+$('speed').value,firmware:s.firmware||''};firmware=s.firmware||'';playStart=performance.now();$('replayBar').hidden=false;$('playBtn').textContent='Ⅱ 暂停';$('demoBtn').textContent='▷ 体验演示';notify('离线回放：'+s.name+'。按原始采样显示，不补全缺失动作。');}
function seekPlayback(at){if(!playback)return;const pb=playback;clearView();firmware=pb.firmware;pb.position=at;pb.index=0;while(pb.index<pb.rows.length&&pb.rows[pb.index].at<=at){const row=pb.rows[pb.index++];consume(row.line,row.at,{quiet:true,ignore:row.ignore});}consoleRows=pb.rows.slice(Math.max(0,pb.index-500),pb.index).map(x=>x.line);consoleDirty=true;playStart=performance.now()-pb.position/pb.speed;}
function stopPlayback(){playback=null;$('replayBar').hidden=true;mode=port?'live':'idle';}
async function restart(){if(transitioning)return;transitioning=true;const completed=active.length?snapshot():null;stopPlayback();newMeasurement();mode=port?'live':'idle';try{if(completed){await store.save(completed);await refreshHistory();}}catch(e){notify('保存上次测量失败：'+e.message,true);}finally{transitioning=false;}}
async function disconnect(){closing=true;const p=readPromise;try{await reader?.cancel();await p;await port?.close();}catch(e){notify('断开串口：'+e.message,true);}finally{port=null;reader=null;closing=false;readPromise=null;mode='idle';$('connectBtn').textContent='＋ 连接串口';$('connectionState').textContent='未连接';$('connectionState').className='badge';$('baud').disabled=false;await saveActive();}}
async function connect(){if(port){await disconnect();return;}if(!navigator.serial){notify('此浏览器无法访问串口。请用桌面 Chrome / Edge，在 HTTPS 网站或 localhost 打开。',true);return;}let chosen;try{chosen=await navigator.serial.requestPort();await saveActive();stopPlayback();await chosen.open({baudRate:+$('baud').value,dataBits:8,stopBits:1,parity:'none',flowControl:'none'});port=chosen;newMeasurement(false,false);source='live';mode='live';framer=new LineFramer();decoder=new TextDecoder();$('connectBtn').textContent='断开串口';$('connectionState').textContent='已连接';$('connectionState').className='badge active';$('baud').disabled=true;notify('串口已连接，等待小车输出。115200 / 8N1；仅接收数据。');readPromise=readSerial();}catch(e){if(e.name!=='NotFoundError'&&e.name!=='AbortError')notify('连接失败：'+e.message+'。请检查端口是否被占用。',true);}}
async function readSerial(){try{while(port?.readable&&!closing){reader=port.readable.getReader();try{while(!closing){const{value,done}=await reader.read();if(done)break;bytes+=value.byteLength;for(const line of framer.push(decoder.decode(value,{stream:true})))consume(line,undefined,{record:true});}}finally{reader.releaseLock();reader=null;}if(!closing)break;}}catch(e){if(!closing)notify('串口读取中断：'+e.message,true);}finally{for(const line of framer.push(decoder.decode()))consume(line,undefined,{record:true});for(const line of framer.flush())consume(line,undefined,{record:true});if(!closing&&port){try{await port.close();}catch{}port=null;mode='idle';$('connectBtn').textContent='＋ 连接串口';$('connectionState').textContent='已断开';$('connectionState').className='badge stale';$('baud').disabled=false;await saveActive();}}}
function startDemo(){const lines=['FW BUILD=DEMO-SIMULATED'];let t=0;const add=(x,y,yaw,dir)=>{const wheels=[dir*450,dir*445,dir*450,dir*445];lines.push(`N,${t},${Math.round(y)*12+Math.round(x)},0,200,0,45,0,0,450,450,0,0,0,0,0,00,00,0,0,0,0,0,00,${dir},300`);lines.push(`ENM,${t},self=(${x.toFixed(2)},${y.toFixed(2)}),n=1,v=3/F,yaw10=${Math.round(yaw*10)},F=(7.00,4.00):LOW,L=0,B=0,R=0,T=(7.00,4.00):OK,q=80,h=4,age=0,src=1,rej=0,d=850/1100/1600/500`);lines.push(`W4,${t},DEMO,${dir},0,${wheels.map(v=>`${v},${v+Math.round(Math.sin(t/700)*25)},500`).join(',')},0`);t+=100;};for(let i=0;i<80;i++)add(6,2+i/80*2,90,1);for(let i=0;i<12;i++)add(6,4,90,1);for(let i=0;i<20;i++)add(6,4,90-i/20*90,1);for(let i=0;i<80;i++)add(6+i/80*2,4,0,1);for(let i=0;i<45;i++)add(8-i/45,4,0,-1);const rows=makeTimeline(lines);const s=createSession(rows,'演示 · 停车转弯与倒行',{firmware:'DEMO-SIMULATED',source:'demo'});startReplay(s);mode='demo';source='demo';notify('演示数据：包含停车、原地转弯、倒行。演示不代表实车记录。');}
function zoomMap(factor){const pose=follow?currentPose(viewNow()):null;const cx=pose?xy(pose).x:view.x+view.w/2,cy=pose?xy(pose).y:view.y+view.h/2;zoom=Math.max(.65,Math.min(8,zoom*factor));view.w=790/zoom;view.h=670/zoom;view.x=cx-view.w/2;view.y=cy-view.h/2;}
$('connectBtn').onclick=()=>connect();$('restartBtn').onclick=restart;
$('demoBtn').onclick=async()=>{if(port){notify('请先断开串口，再体验演示。',true);return;}await saveActive();startDemo();};
$('importBtn').onclick=()=>{if(port){notify('请先断开串口，再导入日志。',true);return;}$('fileInput').click();};
$('fileInput').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{if(file.size>50*1024*1024)throw Error('单次日志上限 50 MB，请拆分文件。');await saveActive();const buffer=await file.arrayBuffer();let text=new TextDecoder('utf-8').decode(buffer);if(text.includes('\ufffd'))text=new TextDecoder('gb18030').decode(buffer);const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/).filter(x=>x.length);const rows=makeTimeline(lines);const fw=rows.find(x=>parseLine(x.line)?.type==='FIRMWARE')?.firmware||'';const session=createSession(rows,file.name.replace(/\.[^.]+$/,''),{firmware:fw,source:'import'});await store.save(session);await refreshHistory();startReplay(session);notify(`已导入 ${lines.length} 行。损坏或不支持的数据仍保留在原始日志中。`);}catch(err){notify('导入失败：'+err.message,true);}finally{e.target.value='';}};
$('exportBtn').onclick=()=>openExport(snapshot());$('directoryExport').onclick=()=>doExport(false);$('zipExport').onclick=()=>doExport(true);$('closeExport').onclick=()=>$('exportDialog').close();
$('helpBtn').onclick=()=>$('help').showModal();$('closeHelp').onclick=()=>$('help').close();
$('clearTrail').onclick=()=>trail=[];$('fitBtn').onclick=()=>{zoom=1;view={x:-65,y:-65,w:790,h:670};};$('zoomIn').onclick=()=>zoomMap(1.35);$('zoomOut').onclick=()=>zoomMap(1/1.35);
$('followBtn').onclick=()=>{follow=!follow;$('followBtn').classList.toggle('selected',follow);$('followBtn').textContent=follow?'◎ 跟随中':'◎ 跟随';};
document.querySelectorAll('[data-layer]').forEach(e=>e.onchange=()=>layer[e.dataset.layer]=e.checked);
$('pauseLog').onclick=()=>{logPaused=!logPaused;$('pauseLog').textContent=logPaused?'继续滚动':'暂停滚动';consoleDirty=true;};$('logFilter').oninput=()=>consoleDirty=true;$('clearLog').onclick=()=>{consoleRows=[];consoleDirty=true;notify('已清空终端显示，原始测量数据仍完整保留。');};
$('playBtn').onclick=()=>{if(!playback)return;playback.playing=!playback.playing;playStart=performance.now()-playback.position/playback.speed;$('playBtn').textContent=playback.playing?'Ⅱ 暂停':'▷ 播放';};$('seek').oninput=()=>seekPlayback(+$('seek').value/1000*playback.duration);$('speed').onchange=()=>{if(playback){playback.speed=+$('speed').value;playStart=performance.now()-playback.position/playback.speed;}};$('stopReplay').onclick=()=>{stopPlayback();newMeasurement(false);notify('已退出回放。记录保留在历史测量中。');};
$('map').addEventListener('wheel',e=>{e.preventDefault();zoomMap(e.deltaY<0?1.12:1/1.12);},{passive:false});
$('map').onpointerdown=e=>{if(follow)return;pan={x:e.clientX,y:e.clientY,vx:view.x,vy:view.y};$('map').setPointerCapture(e.pointerId);};$('map').onpointermove=e=>{if(pan){const rect=$('map').getBoundingClientRect();view.x=pan.vx-(e.clientX-pan.x)*view.w/rect.width;view.y=pan.vy-(e.clientY-pan.y)*view.h/rect.height;}const point=$('map').createSVGPoint();point.x=e.clientX;point.y=e.clientY;const p=point.matrixTransform($('map').getScreenCTM().inverse());$('cursorCoord').textContent=`(${(p.x/60).toFixed(2)}, ${(9-p.y/60).toFixed(2)}) 格`;};$('map').onpointerup=$('map').onpointercancel=()=>pan=null;
function placeCharts(panel,placement){const target=['left','middle','right'].includes(placement)?placement:'right';panel.container.dataset.placement=target;panel.setPlacement(target);const dock=$({left:'chartsLeft',middle:'chartsMiddle',right:'chartsRight'}[target]);for(const candidate of [wheelCharts,laserCharts])if(candidate.container.dataset.placement===target)dock.append(candidate.container);charts.render(viewNow());}
for(const panel of [wheelCharts,laserCharts]){const key=panel.kind+'ChartPlacement';let saved;try{saved=localStorage.getItem(key);}catch{}placeCharts(panel,saved||'right');panel.container.addEventListener('chart-placement',e=>{placeCharts(panel,e.detail.placement);try{localStorage.setItem(key,e.detail.placement);}catch{}});}
document.addEventListener('visibilitychange',()=>{if(document.hidden&&active.length)saveActive().catch(()=>{});});window.addEventListener('beforeunload',e=>{if(port){e.preventDefault();e.returnValue='';}});
function frame(now){if(playback?.playing){playback.position=Math.min(playback.duration,(now-playStart)*playback.speed);while(playback.index<playback.rows.length&&playback.rows[playback.index].at<=playback.position){const row=playback.rows[playback.index++];consume(row.line,row.at,{ignore:row.ignore});}if(playback.position>=playback.duration){playback.playing=false;$('playBtn').textContent='▷ 播放';}}
 if(now-lastRender>80){render();lastRender=now;}if(now-lastStats>1000){$('stats').textContent=`${bytes.toLocaleString()} B · ${totalLines-statsLines} 行/s · ${invalid} 损坏行`;statsLines=totalLines;lastStats=now;}requestAnimationFrame(frame);}
await refreshHistory();if(store.warning)$('storeWarning').textContent=store.warning;
if(!navigator.serial)$('portInfo').textContent='当前环境不支持串口，请用 Chrome / Edge 打开';
render();requestAnimationFrame(frame);
