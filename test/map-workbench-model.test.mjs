import test from 'node:test';
import assert from 'node:assert/strict';
import { CalibrationProject, createDemoProject } from '../core.mjs';
import { definitionFromFields, previewDefinition, readOriginalAxis, selectionEditPreview } from '../map-workbench-model.mjs';
import { validateAssistantRequest } from '../assistant.mjs';

test('image offsets and original binary axes resolve without modifying a GEN_FILE wrapper', () => {
  const bytes = new Uint8Array(351 + 0x400000); bytes.set(new TextEncoder().encode('GEN_FILE'));
  const view = new DataView(bytes.buffer); view.setUint32(8, 0x03010020, true); view.setUint32(12, 327, true);
  [800, 1600, 3200, 6400].forEach((value, i) => view.setUint16(351 + 16 + i * 2, value, false));
  const project = new CalibrationProject(bytes);
  project.editBytes(351 + 16, new Uint8Array([0, 1]));
  const axis = readOriginalAxis(project, { address: 16, addressSpace: 'payload', count: 4, type: 'uint16', endian: 'big', factor: 0.5, offset: 10 });
  assert.deepEqual(axis, [410, 810, 1610, 3210]);
  const map = definitionFromFields(project, { address: '0x20', addressSpace: 'payload', rows: '1', cols: '4', type: 'uint16', endian: 'big', factor: '1', offset: '0', xAxis: axis.join(','), yAxis: '', name: 'Unverified target', category: 'boost', definitionStatus: 'candidate' });
  const before = project.bytes, diff = project.diff(); const result = previewDefinition(project, map);
  assert.equal(result.map.address, 351 + 32); assert.equal(result.values.length, 4);
  assert.deepEqual(project.bytes, before); assert.deepEqual(project.diff(), diff);
  assert.deepEqual(project.readBytes(0, 351), bytes.slice(0, 351));
  assert.throws(() => readOriginalAxis(project, { address: 0x3ffffe, addressSpace: 'payload', count: 2, type: 'uint16', endian: 'big', factor: 1, offset: 0 }), /length/);
});

test('preview rejects overlap, invalid axes and incomplete numerics without changing maps', () => {
  const project = createDemoProject(), original = project.maps[0], snapshot = project.maps;
  assert.throws(() => previewDefinition(project, { ...original, id: 'collision' }), /overlap/);
  assert.doesNotThrow(() => previewDefinition(project, original, original.id));
  assert.throws(() => previewDefinition(project, { ...original, xAxis: [0] }, original.id), /exactly/);
  assert.throws(() => definitionFromFields(project, { address: '', rows: 1, cols: 1, factor: 1, offset: 0 }), /address/);
  assert.deepEqual(project.maps, snapshot); assert.equal(project.changedByteCount, 0);
});

test('adjustment preview uses stored precision and enforces limits before applying', () => {
  const project = new CalibrationProject(new Uint8Array([100]), { maps: [{ id: 'one', name: 'Test', address: 0, rows: 1, cols: 1, type: 'uint8', factor: 0.1, max: 20 }] });
  const map = project.maps[0];
  const preview = selectionEditPreview(project, map, new Set([0]), 'add', 0.16);
  assert.deepEqual(preview.before, [10]); assert.equal(preview.after[0], 10.200000000000001); assert.equal(preview.changedBytes, 1);
  assert.equal(project.changedByteCount, 0); assert.deepEqual(project.readMap('one'), [10]);
  assert.throws(() => selectionEditPreview(project, map, new Set([0]), 'set', 25), /at most/);
  assert.throws(() => selectionEditPreview(project, map, new Set([0]), 'multiply', 1), /supported/);
  assert.throws(() => selectionEditPreview(project, map, new Set(), 'add', 1), /1–4096/);
});

test('assistant context retains bounded definition evidence without claiming verification', () => {
  const request = { messages: [{ role: 'user', content: 'Review this candidate.' }], context: { tuning: { vehicle: 'Test', map: { name: 'Candidate', rows: 1, cols: 1, selectionTotal: 0, selectionTruncated: false, cells: [], category: 'boost', role: 'target', definitionStatus: 'reference', evidence: 'MiTo reference; Fiat location not established', notes: 'Do not assume target map correspondence.' } } } };
  assert.deepEqual(validateAssistantRequest(request), request);
  assert.throws(() => validateAssistantRequest({ ...request, context: { tuning: { ...request.context.tuning, map: { ...request.context.tuning.map, definitionStatus: 'verified' } } } }), /definitionStatus/);
  assert.throws(() => validateAssistantRequest({ ...request, context: { tuning: { ...request.context.tuning, map: { ...request.context.tuning.map, evidence: 'x'.repeat(1001) } } } }), /1000/);
});
