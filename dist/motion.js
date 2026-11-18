const wrap=v=>((v+180)%360+360)%360-180;
// Firmware reports ENM map yaw directly. PLAN explicitly supplies the raw-IMU
// reference for a cardinal body target, independent of when/where a turn occurs.
export class BodyOrientation {
 constructor(){this.reset();}
 reset(){this.offset=null;this.yaw=NaN;this.stamp=-Infinity;this.source='无可靠朝向';}
 apply(p,at){
  if(p.type==='PLAN') {this.offset=wrap(90*((p.out+(p.dir<0?2:0))&3)-p.targetYaw);this.yaw=wrap(p.rawYaw+this.offset);this.stamp=at;this.source='PLAN 标定 + 实测角度';}
  if(p.type==='ENM'&&Number.isFinite(p.pose?.yaw)){this.yaw=p.pose.yaw;this.stamp=at;this.source='ENM 地图朝向';}
  if(this.offset!==null&&((p.type==='IMU'&&p.valid)||(p.type==='WHEEL'&&p.imuValid))){const raw=p.type==='IMU'?p.rawYaw:p.yaw;if(Number.isFinite(raw)){this.yaw=wrap(raw+this.offset);this.stamp=at;this.source='实测 IMU / PLAN 标定';}}
 }
}
