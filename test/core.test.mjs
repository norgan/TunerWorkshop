import test from 'node:test';
import assert from 'node:assert/strict';
import { CalibrationProject, createDemoProject, TYPES, LIMITS, sha256 } from '../core.mjs';

const map = (extra = {}) => ({ id: 'test', name: 'Test map', address: 0, rows: 1, cols: 2, type: 'uint16', endian: 'little', factor: 1, offset: 0, ...extra });
const project = (definition = map(), size = 32) => new CalibrationProject(new Uint8Array(size), { maps: [definition] });

test('every storage type and byte order writes expected bytes and values', () => {
  const examples = { uint8: [0, 255], int8: [-128, 127], uint16: [1000, 65535], int16: [-32768, 32767], uint32: [4294967295, 123456789], int32: [-2147483648, 2147483647], float32: [-12.5, 0.125] };
  for (const [type, values] of Object.entries(examples)) for (const endian of ['little', 'big']) {
    const p = project(map({ type, endian, address: 3 }));
    p.editCells('test', values.map((value, index) => ({ index, value })));
    assert.deepEqual(p.readMap('test'), values);
    const expected = new Uint8Array(32), view = new DataView(expected.buffer);
    values.forEach((value, index) => view[TYPES[type].set](3 + index * TYPES[type].bytes, value, endian === 'little'));
    assert.deepEqual(p.bytes, expected, `${type}/${endian}`);
    assert.deepEqual(p.original, new Uint8Array(32));
  }
});

test('factor, offset and quantization use stored representation', () => {
  const p = project(map({ factor: 0.25, offset: -20 }));
  p.editCells('test', [{ index: 0, value: 10.1 }, { index: 1, value: -19.5 }]);
  assert.deepEqual(p.readMap('test'), [10, -19.5]);
  const negative = project(map({ factor: -2, offset: 100 }));
  negative.editCells('test', [{ index: 0, value: 24 }]);
  assert.equal(negative.readMap('test')[0], 24);
});

test('exact engineering storage boundaries survive inverse-scaling arithmetic noise', () => {
  for (const definition of [
    map({ type: 'uint8', factor: 0.7 }),
    map({ type: 'uint8', factor: 0.001, offset: -40 }),
    map({ type: 'uint8', factor: -0.7 }),
    map({ type: 'int8', factor: 0.001, offset: -40 }),
    map({ type: 'int16', factor: 0.7, offset: 0.13 }),
    map({ type: 'float32', factor: 0.7, offset: 0.13 }),
  ]) {
    const p = project(definition), type = TYPES[definition.type];
    const high = type.max * definition.factor + definition.offset;
    const low = type.min * definition.factor + definition.offset;
    p.editCells('test', [{ index: 0, value: high }, { index: 1, value: low }]);
    const data = new DataView(p.bytes.buffer);
    assert.equal(data[type.get](0, true), type.max);
    assert.equal(data[type.get](type.bytes, true), type.min);
    assert.deepEqual(p.readMap('test'), [high, low]);
  }
});

test('boundary correction does not clamp genuinely out-of-range engineering inputs', () => {
  for (const [definition, badValue] of [
    [map({ type: 'uint8', factor: 0.7 }), 178.5001],
    [map({ type: 'uint8', factor: -0.7 }), -178.5001],
    [map({ type: 'uint8', factor: 0.001, offset: -40 }), -39.744999],
    [map({ type: 'int8', factor: 0.001, offset: -40 }), -40.128001],
  ]) {
    const p = project(definition);
    assert.throws(() => p.editCells('test', [{ index: 0, value: badValue }]), /storage range/);
    assert.deepEqual(p.bytes, p.original);
  }
});

test('source, exports, metadata and getter copies cannot mutate the project', () => {
  const original = new Uint8Array(32), definition = map({ xAxis: [1, 2], yAxis: [3] });
  const p = new CalibrationProject(original, { maps: [definition] });
  original[0] = 100;
  definition.xAxis[0] = 100;
  p.original[0] = 100;
  p.bytes[0] = 100;
  p.exportBinary()[0] = 100;
  p.maps[0].xAxis[0] = 100;
  p.maps[0].factor = 100;
  assert.equal(p.original[0], 0);
  assert.equal(p.bytes[0], 0);
  assert.equal(p.maps[0].xAxis[0], 1);
  assert.equal(p.maps[0].factor, 1);
});

test('edits are atomic across overflow, invalid indexes, duplicate indexes and ranges', () => {
  const p = project(map({ type: 'uint8', min: 0, max: 100 }));
  for (const invalid of [{ index: 1, value: 256 }, { index: 1, value: 101 }, { index: 1, value: -1 }, { index: 2, value: 10 }, { index: 1, value: NaN }, { index: 1, value: Infinity }, { index: 0, value: 20 }]) {
    assert.throws(() => p.editCells('test', [{ index: 0, value: 12 }, invalid]));
    assert.deepEqual(p.bytes, p.original);
    assert.equal(p.canUndo, false);
  }
  assert.throws(() => p.editCells('test', [{ index: 1, value: '1' }]));
  assert.throws(() => project(map({ type: 'float32' })).editCells('test', [{ index: 0, value: 3.5e38 }]));
  assert.throws(() => project(map({ type: 'uint8' })).editCells('test', [{ index: 0, value: 255.1 }]));
});

test('engineering range also applies to rounded storage value', () => {
  const p = project(map({ factor: 0.5, min: 0, max: 0.9 }));
  assert.throws(() => p.editCells('test', [{ index: 0, value: 0.8 }]), /at most/);
  assert.deepEqual(p.bytes, p.original);
  const boundary = project(map({ factor: 0.1, min: 0, max: 0.3 }));
  boundary.editCells('test', [{ index: 0, value: 0.3 }]);
  assert.ok(Math.abs(boundary.readMap('test')[0] - 0.3) < 1e-15);
});

test('invalid map dimensions, encoding, scaling, bounds and axis lengths fail', () => {
  for (const extra of [{ address: -1 }, { address: 31 }, { rows: 0 }, { cols: 65 }, { rows: 1.5 }, { type: '__proto__' }, { endian: 'middle' }, { factor: 0 }, { factor: NaN }, { offset: Infinity }, { xAxis: [1] }, { xAxis: new Array(2) }, { yAxis: [Infinity] }, { min: 5, max: 2 }, { id: '<script>' }]) assert.throws(() => project(map(extra)));
  const p = project();
  assert.throws(() => p.addMap(map({ id: 'other', address: 1 })), /overlap/);
  assert.throws(() => p.addMap(map({ address: 8 })), /already in use/);
  assert.equal(p.maps.length, 1);
});

test('non-finite raw float and scaled overflow cannot become usable map definitions', () => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat32(0, NaN, true);
  assert.throws(() => new CalibrationProject(bytes, { maps: [map({ type: 'float32' })] }), /non-finite/);
  assert.throws(() => new CalibrationProject(Uint8Array.from([255, 255]), { maps: [map({ type: 'uint8', factor: Number.MAX_VALUE })] }), /non-finite/);
});

test('undo and redo group edits, preserve history bounds and clear redo on new edit', () => {
  const p = project();
  p.editCells('test', [{ index: 0, value: 10 }, { index: 1, value: 20 }], 'First');
  assert.deepEqual(p.history.undo, ['First']);
  assert.equal(p.undo(), true);
  assert.deepEqual(p.bytes, p.original);
  assert.equal(p.redo(), true);
  assert.deepEqual(p.readMap('test'), [10, 20]);
  p.undo();
  p.editCells('test', [{ index: 0, value: 30 }]);
  assert.equal(p.canRedo, false);
  for (let i = 1; i <= 150; i++) p.editCells('test', [{ index: 0, value: i }]);
  assert.equal(p.history.undo.length, LIMITS.history);
  for (let i = 0; i < LIMITS.history; i++) assert.equal(p.undo(), true);
  assert.equal(p.undo(), false);
});

test('diff contains only changed addresses; no-op edit does not add history', () => {
  const p = project(map({ address: 4 }));
  assert.equal(p.editCells('test', [{ index: 0, value: 0 }]), false);
  assert.equal(p.canUndo, false);
  p.editCells('test', [{ index: 0, value: 257 }]);
  assert.deepEqual(p.diff(), [{ offset: 4, original: 0, modified: 1 }, { offset: 5, original: 0, modified: 1 }]);
  assert.equal(p.changedByteCount, 2);
  assert.deepEqual(p.diff(1), [{ offset: 4, original: 0, modified: 1 }]);
  assert.deepEqual(p.diff(0), []);
  assert.throws(() => p.diff(-1));
  assert.throws(() => p.diff(1.5));
  p.undo();
  assert.equal(p.changedByteCount, 0);
  p.redo();
  assert.equal(p.changedByteCount, 2);
});

test('exact restore preserves out-of-range original values and is grouped and undoable', async () => {
  const bytes = Uint8Array.from([255, 200, 99, 12]);
  const p = new CalibrationProject(bytes, { maps: [map({ type: 'uint8', min: 0, max: 100 })] });
  p.editCells('test', [{ index: 0, value: 50 }, { index: 1, value: 60 }]);
  const edited = p.bytes;
  assert.equal(p.changedByteCount, 2);
  assert.equal(p.restoreCells('test', [0, 1], 'Restore exact bytes'), true);
  assert.deepEqual(p.bytes, bytes);
  assert.equal(p.changedByteCount, 0);
  assert.equal(p.history.undo.at(-1), 'Restore exact bytes');
  p.undo();
  assert.deepEqual(p.bytes, edited);
  assert.equal(p.changedByteCount, 2);
  p.redo();
  assert.deepEqual(p.bytes, bytes);
  assert.equal(p.changedByteCount, 0);
  assert.equal(p.restoreCells('test', [0, 1]), false);
  const restored = await CalibrationProject.fromJSON(await p.serialize());
  assert.deepEqual(restored.bytes, bytes);
});

test('exact restore keeps float bit patterns, including negative zero and tiny values', () => {
  const bytes = new Uint8Array(8), view = new DataView(bytes.buffer);
  view.setUint32(0, 0x80000000, true);
  view.setUint32(4, 0x00000001, true);
  const p = new CalibrationProject(bytes, { maps: [map({ type: 'float32', factor: 0.01, offset: 100 })] });
  p.editCells('test', [{ index: 0, value: 102 }, { index: 1, value: 103 }]);
  p.restoreCells('test', [0, 1]);
  assert.deepEqual(p.bytes, bytes);
});

test('no-op engineering edits preserve raw float bits hidden by offset precision', () => {
  const bytes = new Uint8Array(8), view = new DataView(bytes.buffer);
  view.setUint32(0, 0x80000000, true);
  view.setUint32(4, 0x00000001, true);
  const p = new CalibrationProject(bytes, { maps: [map({ type: 'float32', factor: 0.01, offset: 100 })] });
  const values = p.readMap('test');
  assert.deepEqual(values, [100, 100]);
  assert.equal(p.editCells('test', values.map((value, index) => ({ index, value }))), false);
  assert.deepEqual(p.bytes, bytes);
  assert.equal(p.canUndo, false);
});

test('restore validates every index before touching modified bytes', () => {
  const p = project();
  p.editCells('test', [{ index: 0, value: 12 }, { index: 1, value: 13 }]);
  const edited = p.bytes, history = p.history;
  for (const indices of [[0, 2], [0, -1], [0, 0], [0, NaN], [0, '1'], []]) {
    assert.throws(() => p.restoreCells('test', indices));
    assert.deepEqual(p.bytes, edited);
    assert.deepEqual(p.history, history);
    assert.equal(p.changedByteCount, 2);
  }
});

test('byte window reads are bounded, independent copies of original or modified bytes', () => {
  const p = project(map({ address: 4 }));
  p.editCells('test', [{ index: 0, value: 257 }]);
  assert.deepEqual(p.readBytes(4, 2), Uint8Array.from([1, 1]));
  assert.deepEqual(p.readBytes(4, 2, { original: true }), Uint8Array.from([0, 0]));
  p.readBytes(4, 2)[0] = 255;
  assert.equal(p.readMap('test')[0], 257);
  assert.deepEqual(p.readBytes(32, 0), new Uint8Array(0));
  assert.throws(() => p.readBytes(31, 2));
  assert.throws(() => p.readBytes(-1, 2));
});

test('changed count remains exact after workspace import and subsequent edits', async () => {
  const p = project(map({ type: 'uint8' }));
  p.editCells('test', [{ index: 0, value: 1 }, { index: 1, value: 2 }]);
  const imported = await CalibrationProject.fromJSON(await p.serialize());
  assert.equal(imported.changedByteCount, 2);
  imported.editCells('test', [{ index: 0, value: 3 }]);
  assert.equal(imported.changedByteCount, 2);
  imported.restoreCells('test', [0]);
  assert.equal(imported.changedByteCount, 1);
  imported.undo();
  assert.equal(imported.changedByteCount, 2);
  assert.equal(imported.diff().length, 2);
});

test('map removal cannot orphan edits or replay removed-map history', () => {
  const p = project();
  p.editCells('test', [{ index: 0, value: 42 }]);
  assert.throws(() => p.removeMap('test'), /Revert/);
  p.undo();
  p.removeMap('test');
  assert.equal(p.maps.length, 0);
  assert.equal(p.canRedo, false);
});

test('workspace byte-exact roundtrip including odd sizes and SHA binding', async () => {
  for (const length of [1, 2, 3, 4, 31, 4096]) {
    const bytes = Uint8Array.from({ length }, (_, i) => i % 256);
    const p = new CalibrationProject(bytes, { name: 'Roundtrip', maps: [map({ type: 'uint8', cols: 1 })] });
    p.editCells('test', [{ index: 0, value: 255 }]);
    const json = await p.serialize();
    assert.equal(json.originalSha256, await sha256(bytes));
    const restored = await CalibrationProject.fromJSON(JSON.stringify(json));
    assert.deepEqual(restored.original, bytes);
    assert.deepEqual(restored.bytes, p.bytes);
    assert.deepEqual(restored.maps, p.maps);
    assert.equal(restored.name, 'Roundtrip');
    assert.equal(restored.canUndo, false);
  }
});

test('workspace rejects hash mismatch, unknown format, inconsistent size and malformed encoding', async () => {
  const original = await project().serialize();
  for (const change of [{ originalSha256: '0'.repeat(64) }, { version: 2 }, { format: 'other' }, { byteLength: 31 }, { byteLength: -1 }, { originalBase64: '***' }, { modifiedBase64: 'A'.repeat(original.modifiedBase64.length) }, { synthetic: 'yes' }]) await assert.rejects(CalibrationProject.fromJSON({ ...original, ...change }));
});

test('large workspace imports without regular-expression stack exhaustion', async () => {
  const p = new CalibrationProject(new Uint8Array(8 * 1024 * 1024));
  const restored = await CalibrationProject.fromJSON(await p.serialize());
  assert.deepEqual(restored.original, p.original);
  assert.equal(restored.byteLength, 8 * 1024 * 1024);
});

test('workspace rejects modified bytes outside maps and changed values outside ranges', async () => {
  const p = project(map({ type: 'uint8', min: 0, max: 50 }));
  const json = await p.serialize();
  const outside = p.bytes;
  outside[5] = 1;
  await assert.rejects(CalibrationProject.fromJSON({ ...json, modifiedBase64: Buffer.from(outside).toString('base64') }), /outside defined maps/);
  const invalid = p.bytes;
  invalid[0] = 51;
  await assert.rejects(CalibrationProject.fromJSON({ ...json, modifiedBase64: Buffer.from(invalid).toString('base64') }), /at most/);
  await assert.rejects(CalibrationProject.fromJSON({ ...json, maps: [map(), map({ id: 'duplicate' })] }), /overlap/);
});

test('workspace rejects NaN edits in float maps while retaining original bytes', async () => {
  const p = project(map({ type: 'float32' }));
  const json = await p.serialize(), invalid = p.bytes;
  new DataView(invalid.buffer).setFloat32(0, NaN, true);
  await assert.rejects(CalibrationProject.fromJSON({ ...json, modifiedBase64: Buffer.from(invalid).toString('base64') }), /non-finite/);
  assert.deepEqual(p.original, new Uint8Array(32));
});

test('serialize captures a consistent snapshot before concurrent edit', async () => {
  const p = project();
  const pending = p.serialize();
  p.editCells('test', [{ index: 0, value: 10 }]);
  const restored = await CalibrationProject.fromJSON(await pending);
  assert.deepEqual(restored.bytes, p.original);
});

test('synthetic demo has independent, editable example maps and survives workspace roundtrip', async () => {
  const p = createDemoProject();
  assert.equal(p.synthetic, true);
  assert.equal(p.maps.length, 3);
  assert.ok(p.maps.every(definition => definition.synthetic && definition.name.includes('Synthetic')));
  assert.equal(p.diff().length, 0);
  p.editCells('demo-ve', [{ index: 0, value: 55 }], 'Example edit');
  assert.equal(p.readMap('demo-ve')[0], 55);
  assert.equal(p.readOriginalMap('demo-ve')[0], 42);
  const restored = await CalibrationProject.fromJSON(await p.serialize());
  assert.deepEqual(restored.bytes, p.bytes);
  assert.deepEqual(restored.original, p.original);
});
