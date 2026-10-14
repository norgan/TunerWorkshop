import test from 'node:test';
import assert from 'node:assert/strict';
import {CalibrationProject} from '../core.mjs';
import {requestedBoostFactorChange,selectionEditPreview} from '../map-workbench-model.mjs';

test('requested absolute-pressure percentage changes the divisor in the inverse direction',()=>{
  const bytes=new Uint8Array(4);new DataView(bytes.buffer).setUint16(0,16384,false);new DataView(bytes.buffer).setUint16(2,24576,false);
  const project=new CalibrationProject(bytes,{maps:[{id:'request',address:0,rows:1,cols:2,type:'uint16',endian:'big',factor:1/16384,unit:'factor'}]});
  const map=project.maps[0];
  for(const percent of [-50,-10,0,5,10,50,100]){
    const preview=selectionEditPreview(project,map,new Set([0,1]),'percent',requestedBoostFactorChange(percent));
    for(let i=0;i<2;i++){
      const expected=preview.before[i]/(1+percent/100);
      assert.ok(Math.abs(preview.after[i]-expected)<=1/32768,`Q14 quantization for ${percent}%`);
      if(percent>0)assert.ok(preview.after[i]<preview.before[i]);
      if(percent<0)assert.ok(preview.after[i]>preview.before[i]);
    }
    assert.equal(project.changedByteCount,0);
  }
});

test('invalid, singular or overflowing requested-pressure changes reject before applying',()=>{
  for(const value of ['',NaN,Infinity,-Infinity,-100,-101,'not a number'])assert.throws(()=>requestedBoostFactorChange(value));
  const bytes=new Uint8Array([0x40,0]);
  const project=new CalibrationProject(bytes,{maps:[{id:'request',address:0,rows:1,cols:1,type:'uint16',endian:'big',factor:1/16384}]});
  assert.throws(()=>selectionEditPreview(project,project.maps[0],new Set([0]),'percent',requestedBoostFactorChange(-99)),/representable|range|65535|large/i);
  assert.equal(project.changedByteCount,0);
});
