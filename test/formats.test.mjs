import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectBinaryFormat, parseHexBytes, formatEngineeringNumber } from '../formats.mjs';
import { CalibrationProject } from '../core.mjs';
test('GEN_FILE is editable and retains unverified-container identity',()=>{
  const bytes=new TextEncoder().encode('GEN_FILE\0\0example metadata\0V862MH97\0MM8GMKHW670\0');
  const info=inspectBinaryFormat(bytes);assert.equal(info.readOnly,false);assert.equal(info.requiresValidation,true);assert.equal(info.identifiers.software[0].value,'V862MH97');assert.equal(info.identifiers.hardware[0].value,'MM8GMKHW670');
  assert.equal(JSON.stringify(info).includes('example metadata'),false);
  const p=new CalibrationProject(bytes);p.addMap({id:'test',address:0,rows:1,cols:1,type:'uint8'});p.editCells('test',[{index:0,value:0x44}]);assert.equal(p.exportBinary()[0],0x44);assert.deepEqual(p.original,bytes);
});
test('all recognised containers support byte edits while preserving source and length',async()=>{
  for(const bytes of [new TextEncoder().encode('GEN_FILE\0example'),new TextEncoder().encode('MZ1234'),new Uint8Array([80,75,3,4,0,0]),new TextEncoder().encode('\x0b\0\0\0WinOLS File\0')]){
    const p=new CalibrationProject(bytes);assert.equal(p.fileInfo.readOnly,false);assert.equal(p.fileInfo.requiresValidation,true);
    p.editBytes(0,[0xA5,0x5A]);const saved=await p.serialize(),restored=await CalibrationProject.fromJSON(saved);
    assert.deepEqual(restored.original,bytes);assert.deepEqual(restored.exportBinary().slice(0,2),new Uint8Array([0xA5,0x5A]));assert.equal(restored.byteLength,bytes.length);
  }
});
test('hex parser accepts full bytes and rejects partial or malformed edits',()=>{
  assert.deepEqual(parseHexBytes('de AD\nBE\tEF'),new Uint8Array([222,173,190,239]));assert.deepEqual(parseHexBytes('00FF'),new Uint8Array([0,255]));
  for(const s of ['', 'A', 'GG', '00 1','0xFF','FF'.repeat(65537)])assert.throws(()=>parseHexBytes(s));
});
test('marker scanning is bounded for repeated identifiers',()=>{
  const info=inspectBinaryFormat(new TextEncoder().encode('MM8GMKHW670 '.repeat(100000)));assert.equal(info.identifiers.hardware.length,16);
});
test('number display retains uint32 precision without exposing scaling noise',()=>{
  assert.equal(formatEngineeringNumber(123456789),'123456789');assert.equal(formatEngineeringNumber(4294967295),'4294967295');assert.equal(formatEngineeringNumber(464*.1),'46.4');assert.notEqual(formatEngineeringNumber(1.4e-44),'0');
});
