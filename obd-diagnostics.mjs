// Independent J1979 CAN diagnostics. Wire framing and DTC count/clear semantics:
// https://www.elmelectronics.com/wp-content/uploads/2020/05/ELM327DSL.pdf pp.36-37.
import {cleanLines,SENSOR_DEFINITIONS,decodeSensor} from './elm-protocol.mjs';
import {decodeElmCanReplies} from './can-diagnostics.mjs';
const requireValue=(v,m)=>{if(!v)throw new Error(m);};
export const OBD_DIAGNOSTIC_REQUESTS=Object.freeze(['0101','010C','010D','03','07','0A','0902','020200',...SENSOR_DEFINITIONS.map(s=>`02${s.pid}00`)]);
export function obdCode(a,b){
  requireValue([a,b].every(n=>Number.isInteger(n)&&n>=0&&n<=255),'Invalid fault code bytes.');
  return 'PCBU'[a>>6]+((a>>4)&3).toString()+(a&15).toString(16).toUpperCase()+b.toString(16).toUpperCase().padStart(2,'0');
}
export function obdReply(response,request,responseId){
  requireValue(OBD_DIAGNOSTIC_REQUESTS.includes(request),'Diagnostic request is not supported.');
  const lines=cleanLines(response,request);
  if(lines.length===1&&lines[0]==='NO DATA')return {status:'unavailable',message:'Not reported by this ECU'};
  const replies=decodeElmCanReplies(response,{request,responseId,maxPayloadBytes:4095});
  let result=null;
  const service=parseInt(request.slice(0,2),16);
  for(const {payload}of replies){
    requireValue(!result,'Conflicting diagnostic replies from the selected ECU.');
    if(payload[0]===0x7f){
      requireValue(payload.length===3&&payload[1]===service,'Negative reply belongs to another request.');
      if(payload[2]===0x78)continue;
      result={status:'unavailable',code:payload[2],message:`ECU response 0x${payload[2].toString(16).toUpperCase()}`};
    }else{
      requireValue(payload[0]===(service+0x40),'Diagnostic reply belongs to another request.');
      if(service===1||service===2||service===9)requireValue(payload[1]===parseInt(request.slice(2,4),16),'Diagnostic reply has the wrong parameter.');
      if(service===2)requireValue(payload[2]===0,'Freeze-frame reply has the wrong frame number.');
      result={status:'positive',payload};
    }
  }
  return result||{status:'unavailable',message:'The ECU has not completed this request'};
}
export function decodeObdFaults(payload,service){
  requireValue([3,7,10].includes(service)&&payload?.[0]===service+0x40&&payload.length>=2,'Invalid fault-code response.');
  const count=payload[1],end=2+count*2;
  requireValue(payload.length>=end&&Array.from(payload.slice(end)).every(n=>n===0),'Fault-code count does not match the response.');
  const codes=[];
  for(let i=2;i<end;i+=2){requireValue(payload[i]||payload[i+1],'A counted fault code is empty.');codes.push(obdCode(payload[i],payload[i+1]));}
  return codes;
}
export function decodeReadiness(payload){
  requireValue(payload?.length===6&&payload[0]===0x41&&payload[1]===1,'Invalid readiness reply.');
  const [, ,a,b,c,d]=payload,compression=!!(b&8);
  const monitors=['Misfire','Fuel system','Comprehensive components'].map((name,i)=>({name,supported:!!(b&(1<<i)),complete:!(b&(1<<(i+4)))}));
  const names=compression?['NMHC catalyst','NOx/SCR',null,'Boost pressure',null,'Exhaust gas sensor','Particulate filter','EGR/VVT']:['Catalyst','Heated catalyst','Evaporative system','Secondary air','Air conditioning refrigerant','Oxygen sensor','Oxygen sensor heater','EGR/VVT'];
  names.forEach((name,i)=>{if(name)monitors.push({name,supported:!!(c&(1<<i)),complete:!(d&(1<<i))});});
  return {mil:!!(a&128),reportedDtcCount:a&127,ignitionType:compression?'Compression':'Spark',monitors};
}
export function decodeObdVin(payload){
  requireValue(payload?.length===20&&payload[0]===0x49&&payload[1]===2&&payload[2]===1,'Invalid VIN reply.');
  const vin=String.fromCharCode(...payload.slice(3));requireValue(/^[A-HJ-NPR-Z0-9]{17}$/.test(vin),'The ECU returned an invalid VIN.');return vin;
}
export function decodeObdFreeze(payload,pid){
  const sensor=SENSOR_DEFINITIONS.find(s=>s.pid===pid);
  requireValue(sensor&&payload?.length===sensor.bytes+3&&payload[0]===0x42&&payload[1]===parseInt(pid,16)&&payload[2]===0,'Invalid freeze-frame parameter.');
  return {key:sensor.key,label:sensor.label,unit:sensor.unit,value:decodeSensor(pid,Array.from(payload.slice(3)))};
}
