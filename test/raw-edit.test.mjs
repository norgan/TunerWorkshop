import test from 'node:test';
import assert from 'node:assert/strict';
import {CalibrationProject} from '../core.mjs';
test('raw edits outside maps are atomic, diffable and reversible',()=>{
  const p=new CalibrationProject(new Uint8Array(32));p.addMap({id:'a',address:8,rows:1,cols:2,type:'uint16'});
  p.editBytes(1,[1,2,3]);p.editCells('a',[{index:0,value:99}]);assert.equal(p.changedByteCount,4);assert.deepEqual(p.diff().map(d=>d.offset),[1,2,3,8]);
  p.undo();assert.equal(p.changedByteCount,3);p.undo();assert.equal(p.changedByteCount,0);p.redo();assert.equal(p.changedByteCount,3);
  assert.throws(()=>p.editBytes(0,[7,256]));assert.equal(p.bytes[0],0);assert.throws(()=>p.editBytes(31,[1,2]));assert.throws(()=>p.editBytes(-1,[1]));assert.throws(()=>p.editBytes(0,[1.5]));
  p.restoreBytes(1,3);assert.equal(p.changedByteCount,0);p.undo();assert.equal(p.changedByteCount,3);assert.equal(p.diff(1).length,1);
});
test('raw workspace captures arbitrary stored bits and marks their editing provenance',async()=>{
  const p=new CalibrationProject(new Uint8Array(16));p.addMap({id:'float',address:0,rows:1,cols:1,type:'float32',endian:'little'});
  p.editBytes(0,[0,0,192,127]);p.editBytes(10,[255]);const saved=await p.serialize();assert.equal(saved.rawByteEdits,true);
  const restored=await CalibrationProject.fromJSON(saved);assert.deepEqual(restored.bytes,p.bytes);assert.equal(restored.changedByteCount,3);assert.throws(()=>restored.readMap('float'),/non-finite/);
  const invalid=structuredClone(saved);invalid.rawByteEdits='true';await assert.rejects(()=>CalibrationProject.fromJSON(invalid),/marker/);
});
test('raw edit marker is captured before asynchronous project hashing',async()=>{
  const p=new CalibrationProject(new Uint8Array(8));const saving=p.serialize();p.editBytes(0,[1]);const saved=await saving;assert.equal(saved.rawByteEdits,false);assert.deepEqual((await CalibrationProject.fromJSON(saved)).bytes,new Uint8Array(8));
});
