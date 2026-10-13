import test from 'node:test';
import assert from 'node:assert/strict';
import {obdCode,obdReply,decodeObdFaults,decodeReadiness,decodeObdVin,decodeObdFreeze} from '../obd-diagnostics.mjs';
test('CAN fault replies honour item count, source and service',()=>{
  const result=obdReply('7E9 04 43 01 01 23\r7E8 06 43 02 01 33 D0 16\r>','03','7E8');
  assert.deepEqual(decodeObdFaults(result.payload,3),['P0133','U1016']);
  assert.equal(obdCode(0x81,0x23),'B0123');
  assert.deepEqual(decodeObdFaults([0x43,0],3),[]);
  assert.throws(()=>decodeObdFaults([0x43,2,1,0x33],3));
  assert.throws(()=>decodeObdFaults([0x47,1,1,0x33],3));
  assert.throws(()=>obdReply('7E8 03 7F 22 31\r>','03','7E8'));
  assert.equal(obdReply('NO DATA\r>','07','7E8').status,'unavailable');
  assert.equal(obdReply('7E8 03 7F 03 78\r>','03','7E8').status,'unavailable');
});
test('readiness separates unsupported monitors from incomplete tests',()=>{
  const r=decodeReadiness([0x41,1,0x81,7,0x65,4]);
  assert.equal(r.mil,true);assert.equal(r.reportedDtcCount,1);
  assert.equal(r.monitors.find(m=>m.name==='Evaporative system').complete,false);
  assert.equal(r.monitors.find(m=>m.name==='Heated catalyst').supported,false);
  assert.equal(decodeReadiness([0x41,1,0,8,8,0]).monitors.find(m=>m.name==='Boost pressure').supported,true);
});
test('identity and freeze frames reject partial or mismatched data',()=>{
  assert.equal(decodeObdVin([0x49,2,1,...Buffer.from('TEST1234567890123')]),'TEST1234567890123');
  assert.throws(()=>decodeObdVin([0x49,2,1,...Buffer.from('TOOSHORT')]));
  assert.equal(decodeObdFreeze([0x42,0x0c,0,0x0c,0x80],'0C').value,800);
  assert.throws(()=>decodeObdFreeze([0x42,0x0c,1,0x0c,0x80],'0C'));
});
