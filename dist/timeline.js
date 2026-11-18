import {parseLine} from './protocol.js';
// Playback follows device clock deltas. Short out-of-order events never rewind.
// A clock restart begins a new epoch; corrupt/unknown lines keep their place.
export function makeTimeline(lines) {
 let lastDevice=null,epoch=0,at=0;let firmware='';
 const parsed=lines.map(entry=>parseLine(typeof entry==='string'?entry:entry.line));
 return lines.map((entry,index)=>{
   const line=typeof entry==='string'?entry:entry.line;const p=parsed[index];let ignore=false;
   const previousAt=at;
   if(p?.type==='FIRMWARE')firmware=p.firmware;
   const t=p?.type==='INVALID'?NaN:p?.time;
   if(Number.isFinite(t)&&t>=0){
     if(lastDevice!==null&&(t<lastDevice-5000||t>lastDevice+30000)){
       const ahead=parsed.slice(index+1,index+18).filter(x=>x?.type!=='INVALID'&&Number.isFinite(x?.time)).map(x=>x.time);
       const old=ahead.findIndex(v=>Math.abs(v-lastDevice)<3000),next=ahead.findIndex(v=>v>t&&v-t<3000);
       if(old>=0&&(next<0||old<next))ignore=true;
     }
     if(!ignore){if(lastDevice===null){epoch=-t;}else if(t<lastDevice-5000){epoch=at+200-t;}at=Math.max(at,epoch+t);lastDevice=lastDevice===null||t<lastDevice-5000?t:Math.max(lastDevice,t);}
   }
   if(typeof entry==='object'&&Number.isFinite(entry.at))at=Math.max(previousAt,entry.at);
   return {line,at,index,firmware,ignore};
 });
}
