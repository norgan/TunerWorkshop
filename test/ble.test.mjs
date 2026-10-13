import test from 'node:test';
import assert from 'node:assert/strict';
import {BleSensorSession,bluetoothUuid,BLE_PROFILES} from '../ble.mjs';
const tick=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fakeBle({profile=BLE_PROFILES[1],withoutResponse=false,unsupported=false,reply,choose,connecting,notifyError=false,writeDelay=0}={}){
  const writes=[],requests=[];
  let writing=0,maxWriting=0;
  const notify=new EventTarget();Object.assign(notify,{uuid:profile.notify,properties:{notify:true},startNotifications:async()=>{if(notifyError)throw Error('Notifications failed');return notify;}});
  function emit(text){const bytes=new TextEncoder().encode(text);notify.value=new DataView(bytes.buffer);notify.dispatchEvent(new Event('characteristicvaluechanged'));}
  const write=profile.write===profile.notify?notify:{uuid:profile.write,properties:{}};
  Object.assign(write.properties,withoutResponse?{writeWithoutResponse:true}:{write:true});
  const send=async bytes=>{
    writing++;maxWriting=Math.max(writing,maxWriting);
    const command=new TextDecoder().decode(bytes).trim();writes.push(command);
    const response=reply?.(command)??(command==='ATZ'?'ELM327 v2.3\r>':command==='ATDPN'?'A6\r>':command.startsWith('AT')?'OK\r>':command==='0100'?'7E8 06 41 00 00 10 00 00\r>':'7E8 04 41 0C 1A F8\r>');
    if(response===false){writing--;return;}
    queueMicrotask(()=>{const at=Math.floor(response.length/2);emit(response.slice(0,at));emit(response.slice(at));});
    if(writeDelay)await tick(writeDelay);writing--;
  };
  write.writeValueWithResponse=send;write.writeValueWithoutResponse=send;
  const device=new EventTarget();device.name='Synthetic BLE ELM';let connects=0,disconnects=0;
  const gatt={connected:false,async connect(){connects++;await connecting?.();gatt.connected=true;return gatt;},disconnect(){disconnects++;gatt.connected=false;device.dispatchEvent(new Event('gattserverdisconnected'));},async getPrimaryService(id){if(unsupported||id!==profile.service)throw new DOMException('Missing service','NotFoundError');return {getCharacteristics:async()=>[...new Set([write,notify])]};}};
  device.gatt=gatt;
  const bluetooth={async requestDevice(options){requests.push(options);await choose?.();return device;}};
  const session=new BleSensorSession({bluetooth,commandTimeoutMs:40,searchTimeoutMs:40,pollIntervalMs:100,bleOpenTimeoutMs:250});
  return {session,device,gatt,writes,requests,emit,get connects(){return connects;},get disconnects(){return disconnects;},get maxWriting(){return maxWriting;}};
}
test('BLE detects a UART profile, joins notification fragments and reads only supported sensors',async()=>{
  const f=fakeBle();const sample=new Promise(resolve=>f.session.once('sample',resolve));
  const state=await f.session.connect({transport:'ble'});
  assert.equal(state.transport,'ble');assert.equal(state.path,null);assert.equal(state.deviceName,'Synthetic BLE ELM');assert.equal(state.readOnly,true);
  assert.deepEqual(state.supportedSensors,['rpm']);assert.deepEqual((await sample).values,{rpm:1726});
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].optionalServices.length,3);
  assert(f.writes.every(command=>command.startsWith('AT')||['0100','010C'].includes(command)));
  await f.session.disconnect();const count=f.writes.length;f.emit('7E8 04 41 0C FF FF\r>');await tick(120);
  assert.equal(f.writes.length,count);assert.equal(f.gatt.connected,false);assert.equal(f.session.snapshot().status,'disconnected');
});
test('BLE supports a shared notify/write characteristic and write-without-response',async()=>{
  const f=fakeBle({profile:BLE_PROFILES[0],withoutResponse:true});
  await f.session.connect({transport:'ble'});assert(f.writes.includes('0100'));await f.session.disconnect();
});
test('early BLE notifications cannot overlap pending GATT writes',async()=>{
  const f=fakeBle({writeDelay:10});await f.session.connect({transport:'ble'});assert.equal(f.maxWriting,1);await f.session.disconnect();
});
test('custom BLE services are explicitly scoped and malformed UUIDs never open a picker',async()=>{
  const profile={service:bluetoothUuid('ab00'),write:bluetoothUuid('ab01'),notify:bluetoothUuid('ab02')},f=fakeBle({profile});
  await assert.rejects(f.session.connect({transport:'ble',profile:'custom',service:'bad',write:'ab01',notify:'ab02'}),/UUID/);assert.equal(f.requests.length,0);
  await f.session.connect({transport:'ble',profile:'custom',...profile});assert.deepEqual(f.requests[0].optionalServices,[profile.service]);await f.session.disconnect();
  assert.throws(()=>bluetoothUuid('http://adapter'));assert.throws(()=>bluetoothUuid(null));
});
test('unsupported BLE services and notification failures disconnect without sending commands',async()=>{
  for(const options of [{unsupported:true},{notifyError:true}]){const f=fakeBle(options);await assert.rejects(f.session.connect({transport:'ble'}));assert.equal(f.writes.length,0);assert.equal(f.gatt.connected,false);assert.equal(f.session.snapshot().status,'error');}
});
test('cancelling a BLE picker prevents a late selection from connecting',async()=>{
  let choose;const f=fakeBle({choose:()=>new Promise(resolve=>{choose=resolve;})});
  const connecting=f.session.connect({transport:'ble'}),rejected=assert.rejects(connecting,/cancelled/);
  await f.session.disconnect();await rejected;choose();await tick(10);assert.equal(f.connects,0);assert.equal(f.writes.length,0);
});
test('cancelling while GATT opens disconnects its late connection without ELM writes',async()=>{
  let connected;const f=fakeBle({connecting:()=>new Promise(resolve=>{connected=resolve;})});
  const connecting=f.session.connect({transport:'ble'}),rejected=assert.rejects(connecting,/cancelled/);await tick(5);
  await f.session.disconnect();await rejected;connected();await tick(10);assert.equal(f.gatt.connected,false);assert.equal(f.writes.length,0);
});
test('BLE command timeouts and dropped links stop the session',async()=>{
  const stalled=fakeBle({reply:command=>command==='ATE0'?false:undefined});
  await assert.rejects(stalled.session.connect({transport:'ble'}),/timed out/);assert.equal(stalled.gatt.connected,false);
  const f=fakeBle();await f.session.connect({transport:'ble'});f.gatt.disconnect();const count=f.writes.length;await tick(120);assert.equal(f.session.snapshot().status,'error');assert.equal(f.writes.length,count);
});
test('BLE requires its own transport and an available browser Bluetooth API',async()=>{
  const session=new BleSensorSession({bluetooth:{}});await assert.rejects(session.connect({transport:'ble'}),/unavailable/);await assert.rejects(session.connect({transport:'wifi'}),/Low Energy/);
});
