import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {BaseSensorSession} from '../sensor-session.mjs';
import {FIAT_MODULE_PROFILES,decodeFiatModuleParameter} from '../fiat-modules.mjs';
import {getModuleServiceTools,MODULE_SERVICE_PREFLIGHT} from '../module-service.mjs';
import {getModuleDiagnostics} from '../module-diagnostics.mjs';
import {buildModuleTransport} from '../module-transport.mjs';

const bytes=hex=>Array.from(Buffer.from(hex,'hex'));
const hex=byte=>byte.toString(16).padStart(2,'0').toUpperCase();
function reply(payload,address){
  const frames=[];
  if(payload.length<=7)frames.push([payload.length,...payload]);
  else{frames.push([0x10|(payload.length>>8),payload.length&255,...payload.slice(0,6)]);for(let i=6,seq=1;i<payload.length;i+=7,seq=(seq+1)&15)frames.push([0x20|seq,...payload.slice(i,i+7)]);}
  return frames.map(frame=>`${address} ${frame.map(hex).join(' ')}`).join('\r')+'\r>';
}
function fixture(t,id='fiat-body',custom=()=>undefined){
  const profile=FIAT_MODULE_PROFILES.find(p=>p.id===id),address=profile.connection.responseId;
  class Port extends EventEmitter{
    isOpen=false;writes=[];
    open(cb){this.isOpen=true;cb();}
    close(cb){this.isOpen=false;this.emit('close');cb?.();}
    write(text,cb){
      const request=text.trim();this.writes.push(request);cb?.();
      let response=custom(request,this);
      if(response===undefined){
        if(request==='ATZ')response='ELM327 v2.3\r>';
        else if(request.startsWith('AT'))response='OK\r>';
        else if(request==='1003')response=reply([0x50,3],address);
        else if(request==='1092')response=reply([0x50,0x92],address);
        else if(request==='3E00')response=reply([0x7e,0],address);
        else if(request==='22F1A5')response=reply([0x62,0xf1,0xa5,...bytes(profile.connection.isoCodes[0])],address);
        else if(request.startsWith('22')){
          const channels=profile.channels.filter(c=>c.request===request),guard=MODULE_SERVICE_PREFLIGHT[id]?.find(c=>c.request===request),identity=getModuleDiagnostics(id).identification.find(d=>d.request===request);
          const width=Math.max(guard?.bytes||0,identity?.bytes||0,...channels.map(c=>c.startByte+c.bytes));assert.ok(width>0,`Unexpected read ${request}`);
          response=reply([0x62,...bytes(request.slice(2)),...Array(width).fill(0)],address);
        }else if(request==='19020D')response=reply([0x59,2,255,0x40,0x11,0,9],address);
        else if(request==='14FFFFFF')response=reply([0x54],address);
        else if(request.startsWith('2F'))response=reply([0x6f,...bytes(request.slice(2,8))],address);
        else assert.fail(`Unexpected vehicle request ${request}`);
      }
      setImmediate(()=>{if(this.isOpen)this.emit('data',Buffer.from(response));});
    }
  }
  const port=new Port(),session=new BaseSensorSession({createPort:()=>port,validateConnection:()=>{},commandTimeoutMs:500,pollIntervalMs:100});
  t.after(()=>session.disconnect());
  const first=profile.channels.find(c=>c.available);
  return {profile,port,session,address,connect:()=>session.connect({profileId:id,path:'SYNTHETIC',channels:first?[first.key]:[]}),first};
}
const until=async predicate=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}assert.fail('Fixture did not progress');};

test('every available new module establishes its own address, network and identity before polling',async t=>{
  for(const profile of FIAT_MODULE_PROFILES.filter(p=>p.available)){
    const f=fixture(t,profile.id),sample=once(f.session,'sample');
    const state=await f.connect(),[value]=await sample;
    assert.equal(state.ecu,profile.connection.responseId);assert.equal(state.identity.profileId,profile.id);
    assert.equal(value.values[f.first.key],decodeFiatModuleParameter(profile.id,f.first.key,f.first.request==='22F1A5'?bytes(profile.connection.isoCodes[0]):Array(f.first.startByte+f.first.bytes).fill(0)));
    assert.ok(f.port.writes.indexOf('22F1A5')<f.port.writes.lastIndexOf(f.first.request));
    assert.ok(f.port.writes.includes(`ATCRA${profile.connection.responseId}`));assert.ok(f.port.writes.includes(`ATSH${profile.connection.requestId.slice(2)}`));
    assert.equal(f.port.writes.includes('ATPB0104'),profile.connection.protocol==='BHCAN29');
    assert.equal(state.protocol,profile.connection.protocol==='BHCAN29'?'B':'7');
    assert.equal(f.port.writes.some(r=>r.startsWith('ATPP')),false);await f.session.disconnect();
  }
});

test('PROXI, unavailable channels, wrong ISO and wrong response address never begin polling',async t=>{
  const unavailable=fixture(t,'fiat-proxi');await assert.rejects(unavailable.connect(),/PROXI|configuration/);assert.equal(unavailable.port.writes.length,0);
  for(const [id,custom]of [
    ['fiat-body',r=>r==='22F1A5'?reply([0x62,0xf1,0xa5,0,1,0x50,0xa8,0x15],'18DAF140'):undefined],
    ['fiat-body',r=>r==='22F1A5'?reply([0x62,0xf1,0xa5,0,0,0x60,0x3a,0x15],'18DAF110'):undefined],
  ]){const f=fixture(t,id,custom);await assert.rejects(f.connect());assert.equal(f.port.writes.includes(f.first.request),false);}
  const radar=fixture(t,'fiat-radar'),channel=radar.profile.channels.find(c=>!c.available);
  await assert.rejects(radar.session.connect({profileId:'fiat-radar',channels:[channel.key]}),/not available/);assert.equal(radar.port.writes.length,0);
});

test('125k setup failure is actionable, and body-network sessions never borrow CCAN fallback',async t=>{
  const bad=fixture(t,'fiat-comfort',r=>r==='ATPB0104'?'?\r>':undefined);
  await assert.rejects(bad.connect(),/125 kbit\/s/);assert.equal(bad.port.writes.includes('1003'),false);
  const refused=fixture(t,'fiat-comfort',r=>r==='1003'?reply([0x7f,0x10,0x12],'18DAF1C2'):undefined);
  await assert.rejects(refused.connect(),/did not start/);assert.equal(refused.port.writes.includes('1092'),false);
  let starts=0;const fallback=fixture(t,'fiat-comfort',r=>r==='1003'&&++starts===1?'NO DATA\r>':undefined);
  await fallback.connect();assert.ok(fallback.port.writes.includes('ATV0'));assert.equal(starts,2);
  assert.throws(()=>buildModuleTransport({...fallback.profile.connection,requestId:'7DF'},[]),/Invalid controller/);
});

test('module diagnostics read faults and clear only after fresh module conditions',async t=>{
  const f=fixture(t),s=await f.connect(),base={sessionId:s.sessionId};
  const faults=await f.session.diagnose({...base,action:'read-faults'});assert.equal(faults.profileId,'fiat-body');assert.equal(faults.groups[0].faults[0].code,'C0011-00');
  const before=f.port.writes.length;
  await assert.rejects(f.session.diagnose({...base,action:'clear-faults',confirmation:'clear-faults'}),/engine is switched off/);
  assert.equal(f.port.writes.includes('14FFFFFF'),false);
  const result=await f.session.diagnose({...base,action:'clear-faults',confirmation:'clear-faults',engineStoppedConfirmed:true,stationaryConfirmed:true});
  assert.equal(result.acknowledged,true);assert.equal(result.preflight.conditions.engineStopped.evidence,'user-confirmed');assert.equal(result.preflight.conditions.stationary.evidence,'measured');
  assert.deepEqual(f.port.writes.slice(before),['22F1A5','221002','14FFFFFF']);
});

test('nonzero one-byte speed and changed identity block module writes; unconfirmed clear is not repeated',async t=>{
  const moving=fixture(t,'fiat-body',r=>r==='221002'?reply([0x62,0x10,2,1],'18DAF140'):undefined),s=await moving.connect();
  await assert.rejects(moving.session.diagnose({sessionId:s.sessionId,action:'clear-faults',confirmation:'clear-faults',engineStoppedConfirmed:true,stationaryConfirmed:true}),/stationary/);
  assert.equal(moving.port.writes.includes('14FFFFFF'),false);
  let isoReads=0;const changed=fixture(t,'fiat-body',r=>r==='22F1A5'&&++isoReads>1?reply([0x62,0xf1,0xa5,0,1,0x50,0xa8,0x15],'18DAF140'):undefined),c=await changed.connect();
  await assert.rejects(changed.session.diagnose({sessionId:c.sessionId,action:'clear-faults',confirmation:'clear-faults',engineStoppedConfirmed:true,stationaryConfirmed:true}),/not identified/);
  assert.equal(changed.port.writes.includes('14FFFFFF'),false);
  const uncertain=fixture(t,'fiat-body',r=>r==='14FFFFFF'?reply([0x54,0],'18DAF140'):undefined),u=await uncertain.connect();
  await assert.rejects(uncertain.session.diagnose({sessionId:u.sessionId,action:'clear-faults',confirmation:'clear-faults',engineStoppedConfirmed:true,stationaryConfirmed:true}),e=>e.code==='outcome_unknown');
  assert.equal(uncertain.port.writes.filter(r=>r==='14FFFFFF').length,1);
});

test('ZF variant identity fallback is limited to the recovered trigger and exact variant allowlist',async t=>{
  for(const primary of [[0x7f,0x22,0x31],[0x62,0xf1,0xa5,0,0,0,0,0]]){
    const f=fixture(t,'fiat-gearbox-zf',r=>r==='22F1A5'?reply(primary,'18DAF118'):r==='22F100'?reply([0x62,0xf1,0,0,0x62,2],'18DAF118'):undefined);
    const state=await f.connect();assert.equal(state.identity.ecuIsoCode,'TCM6202');assert.equal(state.identity.identityMethod,'variant-version');await f.session.disconnect();
  }
  for(const primary of [[0x7f,0x22,0x78],[0x62,0xf1,0xa5,1,2,3,4,5]]){
    const f=fixture(t,'fiat-gearbox-zf',r=>r==='22F1A5'?reply(primary,'18DAF118'):undefined);
    await assert.rejects(f.connect());assert.equal(f.port.writes.includes('22F100'),false);
  }
});

test('actuator cancellation returns control and rejects a different controller procedure',async t=>{
  const f=fixture(t),state=await f.connect(),tool=getModuleServiceTools('fiat-body').find(t=>t.available),foreign=getModuleServiceTools('fiat-climate-auto').find(t=>t.available);
  const options={sessionId:state.sessionId,action:'run-service',confirmation:'run-service',acknowledged:true,engineStoppedConfirmed:true,stationaryConfirmed:true};
  await assert.rejects(f.session.diagnose({...options,toolId:foreign.id}),/does not belong/);
  const action=f.session.diagnose({...options,toolId:tool.id});await until(()=>f.port.writes.some(r=>r.startsWith('2F')));
  f.session.stopService({sessionId:state.sessionId});const result=await action;
  assert.equal(result.result.status,'cancelled');assert.equal(result.result.stopStatus,'acknowledged');
  assert.ok(f.port.writes.some(r=>tool.releaseRequests.includes(r)));assert.equal(f.session.snapshot().status,'streaming');
});
