import test from 'node:test';
import assert from 'node:assert/strict';
import {CalibrationProject, sha256} from '../core.mjs';
import {inspectFiatCalibration, attachFiatCalibration, FIAT_CALIBRATION_PROFILES} from '../fiat-calibration-profile.mjs';

async function fixture(container = false) {
  const base = container ? 351 : 0, bytes = new Uint8Array(4194304 + base).fill(255), view = new DataView(bytes.buffer);
  if (container) { bytes.set(new TextEncoder().encode('GEN_FILE')); view.setUint32(8, 0x03010020, true); view.setUint32(12, 327, true); }
  const source = {id:'synthetic-layout',name:'Synthetic pressure candidate',category:'boost',address:0x1000,rows:3,cols:4,type:'uint16',endian:'big',factor:1,unit:'mbar',xAddress:0x100,xFactor:1/16384,yAddress:0x200,yFactor:1,call:'synthetic',interpolator:'synthetic',scalingNote:'Synthetic proposed units.'};
  for(let i=0;i<4;i++)view.setUint16(base+0x100+i*2, (i+1)*4096, false);
  for(let i=0;i<3;i++)view.setUint16(base+0x200+i*2, 1000+i*1000, false);
  for(let i=0;i<12;i++)view.setUint16(base+0x1000+i*2, 1000+i, false);
  const profile={id:'synthetic',label:'Synthetic test profile',software:'SYNTHETIC',hardware:'SYNTHETIC',imageBytes:4194304,imageSha256:await sha256(bytes.subarray(base)),...(container?{containerSha256:await sha256(bytes)}:{}),maps:[source]};
  return {bytes,base,profile,project:new CalibrationProject(bytes,{name:'untrusted-name.ORI'})};
}

test('exact-image profile yields row-major tables and original image-backed axes', async()=>{
  for(const container of [false,true]){
    const f=await fixture(container), result=await inspectFiatCalibration(f.project,[f.profile]);
    assert.equal(result.status,'matched');assert.equal(result.geometryVerified,true);assert.equal(result.physicalMeaningVerified,false);assert.equal(result.checksumVerified,false);
    assert.equal(result.maps[0].address,f.base+0x1000);
    assert.deepEqual(result.maps[0].xAxis,[.25,.5,.75,1]);assert.deepEqual(result.maps[0].yAxis,[1000,2000,3000]);
    assert.equal(result.maps[0].definitionStatus,'candidate');assert.equal(result.maps[0].role,'unknown');
    attachFiatCalibration(f.project,result);
    assert.deepEqual(f.project.readMap('synthetic-layout'),Array.from({length:12},(_,i)=>1000+i));
    assert.equal(f.project.changedByteCount,0);assert.deepEqual(f.project.original,f.bytes);
  }
});

test('a one-byte image change or misleading filename does not apply another image profile',async()=>{
  const f=await fixture();f.bytes[0x1000]^=1;
  const project=new CalibrationProject(f.bytes,{name:'Fiat 500X Nathan.ORI V862MH97'});
  assert.equal((await inspectFiatCalibration(project,[f.profile])).status,'unmatched');assert.deepEqual(project.maps,[]);
  assert.equal((await inspectFiatCalibration(f.project)).status,'unmatched');
});

test('known payload with changed wrapper is kept separate from the inspected container',async()=>{
  const f=await fixture(true);f.bytes[100]^=1;
  assert.equal((await inspectFiatCalibration(new CalibrationProject(f.bytes),[f.profile])).status,'unmatched');
});

test('saved workspace recognition uses preserved original and does not overwrite offline edits',async()=>{
  const f=await fixture(true), result=await inspectFiatCalibration(f.project,[f.profile]);attachFiatCalibration(f.project,result);
  f.project.editCells('synthetic-layout',[{index:0,value:1100}]);
  const reopened=await CalibrationProject.fromJSON(await f.project.serialize());
  const again=await inspectFiatCalibration(reopened,[f.profile]);assert.equal(again.status,'matched');
  assert.deepEqual(attachFiatCalibration(reopened,again),[]);assert.equal(reopened.readMap('synthetic-layout')[0],1100);
  assert.equal(reopened.readOriginalMap('synthetic-layout')[0],1000);assert.deepEqual(reopened.original,f.bytes);
  assert.ok(reopened.diff().every(change=>change.offset>=f.base+0x1000&&change.offset<f.base+0x1002));
});

test('automatic definitions preserve existing overlapping user maps',async()=>{
  const f=await fixture(), result=await inspectFiatCalibration(f.project,[f.profile]);
  f.project.addMap({...result.maps[0],id:'user-owned',name:'User-owned definition'});
  assert.deepEqual(attachFiatCalibration(f.project,result),[]);assert.equal(f.project.maps[0].id,'user-owned');assert.equal(f.project.maps.length,1);
});

test('invalid axes reject the complete generated definition set without changing bytes',async()=>{
  const f=await fixture();new DataView(f.bytes.buffer).setUint16(0x102,4096,false);
  const profile={...f.profile,imageSha256:await sha256(f.bytes)};
  const project=new CalibrationProject(f.bytes);
  await assert.rejects(inspectFiatCalibration(project,[profile]),/increasing layout/);assert.deepEqual(project.maps,[]);assert.equal(project.changedByteCount,0);
});

test('synthetic examples and other file containers cannot be described as known car calibrations',async()=>{
  const project=new CalibrationProject(new Uint8Array(20),{synthetic:true});
  assert.equal((await inspectFiatCalibration(project)).status,'synthetic');
  assert.equal((await inspectFiatCalibration(new CalibrationProject(new Uint8Array(30)))).status,'unmatched');
  assert.ok(FIAT_CALIBRATION_PROFILES.every(profile=>Object.isFrozen(profile.maps)&&profile.maps.every(Object.isFrozen)));
});

test('changed calibration values retain identification only with matching code and axis fingerprints',async()=>{
  const f=await fixture(), profile={...f.profile,codeBytes:0x80,codeSha256:await sha256(f.bytes.subarray(0,0x80)),axisSignatures:[{address:0x100,count:4,sha256:await sha256(f.bytes.subarray(0x100,0x108))},{address:0x200,count:3,sha256:await sha256(f.bytes.subarray(0x200,0x206))}]};
  const edited=f.bytes.slice();edited[0x1001]^=1;
  const result=await inspectFiatCalibration(new CalibrationProject(edited),[profile]);
  assert.equal(result.status,'matched');assert.equal(result.matchKind,'same-code-layout');
  for(const offset of [0x20,0x101]){
    const changed=edited.slice();changed[offset]^=1;
    assert.equal((await inspectFiatCalibration(new CalibrationProject(changed),[profile])).status,'unmatched');
  }
});
