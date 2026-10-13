import test from 'node:test';
import assert from 'node:assert/strict';
import {pressureDisplay,pressureToDisplay,pressureFromDisplay,pressureEditAmount} from '../pressure-units.mjs';
import {CalibrationProject} from '../core.mjs';
import {selectionEditPreview} from '../map-workbench-model.mjs';
import {normalizeSettings,validateSettings} from '../settings-schema.mjs';

test('pressure display preserves reference and uses reciprocal bar/psi conversion',()=>{
  assert.equal(pressureToDisplay(1000,'mBar','bar'),1);
  assert.equal(pressureToDisplay(100,'kPa absolute','bar'),1);
  assert.ok(Math.abs(pressureToDisplay(1000,'mbar','psi')-14.503773773020923)<1e-12);
  assert.equal(pressureDisplay('kPa absolute','psi').unit,'psi absolute');
  assert.equal(pressureDisplay('bar gauge','psi').unit,'psi gauge');
  for(const unit of ['Pa','hPa','mBar','kPa','MPa','bar','psi'])for(const value of [-5,0,100,2678]){
    assert.ok(Math.abs(pressureFromDisplay(pressureToDisplay(value,unit,'psi'),unit,'psi')-value)<1e-9);
  }
  for(const unit of ['lambda','deg','%','kPa/s','raw',''])assert.deepEqual(pressureDisplay(unit,'psi'),{converted:false,factor:1,unit});
});

test('pressure editing converts set/add, preserves percent and original encoded bytes',async()=>{
  const bytes=Uint8Array.from([0x03,0xe8,0x07,0xd0]);
  const project=new CalibrationProject(bytes,{maps:[{id:'boost',name:'Pressure',address:0,rows:1,cols:2,type:'uint16',endian:'big',factor:1,unit:'mbar',category:'boost'}]});
  const map=project.maps[0],before=await project.serialize();
  for(let i=0;i<20;i++)for(const unit of ['psi','bar'])pressureToDisplay(project.readMap(map.id)[0],map.unit,unit);
  assert.deepEqual(await project.serialize(),before);
  const target=pressureToDisplay(1500,'mbar','psi');
  const preview=selectionEditPreview(project,map,new Set([0]),'set',pressureEditAmount(target,'set',map.unit,'psi'));
  assert.equal(preview.after[0],1500);assert.equal(project.changedByteCount,0);
  project.editCells(map.id,preview.edits);assert.equal(project.readMap(map.id)[0],1500);
  project.undo();assert.deepEqual(project.bytes,bytes);
  assert.equal(pressureEditAmount(.1,'add','mbar','bar'),100);
  assert.equal(pressureEditAmount(10,'percent','mbar','psi'),10);
  assert.throws(()=>pressureEditAmount('','set','mbar','psi'));
  assert.throws(()=>pressureEditAmount(Infinity,'add','mbar','psi'));
});

test('pressure preference migrates existing settings and rejects unknown units',()=>{
  assert.equal(normalizeSettings({sendOnEnter:false}).pressureUnit,'bar');
  assert.equal(validateSettings({...normalizeSettings(),pressureUnit:'psi'}).pressureUnit,'psi');
  assert.throws(()=>validateSettings({...normalizeSettings(),pressureUnit:'kPa'}));
});
