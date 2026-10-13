import test from 'node:test';
import assert from 'node:assert/strict';
import { CalibrationProject, createDemoProject, LIMITS } from '../core.mjs';

const definition = (extra = {}) => ({ id: 'table', name: 'Raw table', address: 4, rows: 1, cols: 4, type: 'uint16', endian: 'little', ...extra });
const project = (extra = {}) => new CalibrationProject(new Uint8Array(64), { maps: [definition(extra)] });

test('definition metadata validates its vocabulary and size without a verified status', async () => {
  const p = project(), map = p.maps[0];
  assert.deepEqual([map.category, map.role, map.definitionStatus, map.notes, map.evidence], ['other', 'unknown', 'user-defined', '', '']);
  for (const category of ['boost', 'ignition', 'fuel', 'other']) p.updateMap('table', { ...p.maps[0], category });
  for (const role of ['target', 'limiter', 'correction', 'unknown']) p.updateMap('table', { ...p.maps[0], role });
  for (const definitionStatus of ['candidate', 'user-defined', 'reference']) p.updateMap('table', { ...p.maps[0], definitionStatus });
  p.updateMap('table', { ...p.maps[0], notes: 'n'.repeat(2000), evidence: 'e'.repeat(1000) });
  assert.deepEqual((await CalibrationProject.fromJSON(await p.serialize())).maps, p.maps);
  for (const invalid of [{ category: 'Boost' }, { category: null }, { role: 'verified' }, { definitionStatus: 'verified' }, { definitionStatus: null }, { notes: 'x'.repeat(2001) }, { notes: null }, { notes: 12 }, { evidence: 'x'.repeat(1001) }, { evidence: {} }]) {
    assert.throws(() => project(invalid));
    const before = p.maps;
    assert.throws(() => p.updateMap('table', { ...p.maps[0], ...invalid }));
    assert.deepEqual(p.maps, before);
  }
  const legacy = await p.serialize();
  for (const key of ['category', 'role', 'definitionStatus', 'notes', 'evidence']) delete legacy.maps[0][key];
  assert.deepEqual((await CalibrationProject.fromJSON(legacy)).maps[0], map);
});

test('reshape, rename and metadata updates conserve original/working bytes and byte history', async () => {
  const p = project({ cols: 6 });
  p.editCells('table', [{ index: 0, value: 1200 }, { index: 5, value: 6000 }], 'Tune two cells');
  const original = p.original, bytes = p.bytes, diff = p.diff(), history = p.history;
  const updated = p.updateMap('table', { ...p.maps[0], name: 'Boost candidate', rows: 2, cols: 3, xAxis: [1000, 2000, 3000], yAxis: [20, 40], category: 'boost', role: 'target', definitionStatus: 'candidate', notes: 'Inspect before assigning meaning.', evidence: 'Manually supplied reference.' });
  assert.equal(updated.id, 'table');
  assert.equal(updated.category, 'boost');
  assert.deepEqual(p.readMap('table'), [1200, 0, 0, 0, 0, 6000]);
  assert.deepEqual(p.original, original); assert.deepEqual(p.bytes, bytes);
  assert.deepEqual(p.diff(), diff); assert.deepEqual(p.history, history);
  const saved = await p.serialize(), restored = await CalibrationProject.fromJSON(saved);
  assert.equal(saved.rawByteEdits, false);
  assert.deepEqual(restored.maps, p.maps); assert.deepEqual(restored.bytes, bytes);
  p.undo(); assert.deepEqual(p.bytes, original);
  p.redo(); assert.deepEqual(p.bytes, bytes);
  assert.equal(p.maps[0].name, 'Boost candidate');
});

test('invalid complete replacements are atomic across bytes, maps, history and provenance', async () => {
  const p = project({ min: 0, max: 500 });
  p.addMap({ id: 'other', address: 32, rows: 1, cols: 2, type: 'uint16' });
  p.editCells('table', [{ index: 0, value: 200 }], 'First edit');
  p.editCells('table', [{ index: 1, value: 300 }], 'Second edit'); p.undo();
  const before = { json: await p.serialize(), history: p.history, diff: p.diff(), count: p.changedByteCount };
  for (const invalid of [{ id: 'renamed' }, { id: 'other' }, { address: 31 }, { address: 63 }, { address: -1 }, { rows: 0 }, { cols: 65 }, { factor: 0 }, { endian: 'middle' }, { max: 100 }, { min: 600, max: 500 }, { xAxis: [0] }, { category: 'verified' }, { notes: 'x'.repeat(2001) }]) {
    assert.throws(() => p.updateMap('table', { ...p.maps[0], ...invalid }));
    assert.deepEqual(await p.serialize(), before.json);
    assert.deepEqual(p.history, before.history); assert.deepEqual(p.diff(), before.diff);
    assert.equal(p.changedByteCount, before.count);
  }
  assert.throws(() => p.updateMap('missing', definition()));
  assert.throws(() => p.updateMap('table', { name: 'Incomplete' }));
  assert.equal(p.canRedo, true);
});

test('definition updates validate both original and working interpretations', () => {
  const original = new Uint8Array(32); new DataView(original.buffer).setFloat32(16, NaN, true);
  const p = new CalibrationProject(original, { maps: [definition()] });
  assert.throws(() => p.updateMap('table', { ...p.maps[0], address: 16, cols: 1, type: 'float32' }), /non-finite/);
  const q = project(); q.editBytes(16, [0, 0, 192, 127]);
  const before = { bytes: q.bytes, maps: q.maps, history: q.history };
  assert.throws(() => q.updateMap('table', { ...q.maps[0], address: 16, cols: 1, type: 'float32' }), /non-finite/);
  assert.deepEqual(q.bytes, before.bytes); assert.deepEqual(q.maps, before.maps); assert.deepEqual(q.history, before.history);
  const r = new CalibrationProject(Uint8Array.from([255, 1]), { maps: [{ id: 'byte', address: 0, rows: 1, cols: 1, type: 'uint8' }] });
  assert.throws(() => r.updateMap('byte', { ...r.maps[0], factor: Number.MAX_VALUE }), /non-finite/);
});

test('replacement preview and save share edited-cell range checks without mutation', async () => {
  const p = project({ type: 'uint8', max: 100 });
  p.editCells('table', [{ index: 0, value: 60 }], 'Existing tune edit');
  const before = await p.serialize(), history = p.history;
  const invalid = { ...p.maps[0], factor: 2 };
  assert.throws(() => p.previewMapDefinition(invalid, 'table'), /at most 100/);
  assert.throws(() => p.updateMap('table', invalid), /at most 100/);
  assert.deepEqual(await p.serialize(), before); assert.deepEqual(p.history, history);
  const valid = { ...p.maps[0], factor: 1.5, notes: 'Reviewed scaling', xAxis: [1, 2, 3, 4] };
  const preview = p.previewMapDefinition(valid, 'table');
  assert.equal(preview.factor, 1.5); assert.equal(preview.notes, 'Reviewed scaling');
  assert.deepEqual(await p.serialize(), before); assert.deepEqual(p.history, history);
  preview.xAxis[0] = 99; valid.xAxis[1] = 99;
  assert.equal(p.maps[0].xAxis, undefined);
  const committed = p.updateMap('table', { ...preview, xAxis: [1, 2, 3, 4] });
  assert.equal(committed.factor, 1.5); assert.equal(p.readMap('table')[0], 90);
  assert.deepEqual(p.history, history);
});

test('replacement previews retain raw metadata allowance but validate changed interpretations', async () => {
  const p = project({ type: 'uint8', max: 100 }); p.editBytes(4, [180]);
  const metadata = { ...p.maps[0], notes: 'Preserve explicit raw value', evidence: 'Manual note' };
  const before = await p.serialize(), history = p.history;
  const preview = p.previewMapDefinition(metadata, 'table');
  assert.deepEqual(await p.serialize(), before); assert.deepEqual(p.history, history);
  assert.deepEqual(p.updateMap('table', metadata), preview);
  assert.equal(p.bytes[4], 180);
  const reinterpretation = { ...p.maps[0], factor: 2 };
  assert.throws(() => p.previewMapDefinition(reinterpretation, 'table'), /at most 100/);
  assert.throws(() => p.updateMap('table', reinterpretation), /at most 100/);
  assert.equal(p.bytes[4], 180); assert.deepEqual(p.history, history);
});

test('addition and replacement previews share identity, overlap and both-buffer validation', async () => {
  const p = project();
  const next = { id: 'next', address: 24, rows: 1, cols: 2, type: 'uint8', xAxis: [1, 2] };
  const before = await p.serialize(), preview = p.previewMapDefinition(next);
  assert.deepEqual(await p.serialize(), before);
  preview.xAxis[0] = 99; assert.deepEqual(p.addMap(next).xAxis, [1, 2]);
  for (const invalid of [next, { ...next, id: 'overlap', address: 4 }, { ...next, id: 'bounds', address: 63 }]) {
    assert.throws(() => p.previewMapDefinition(invalid)); assert.throws(() => p.addMap(invalid));
  }
  assert.throws(() => p.previewMapDefinition({ ...p.maps[0], id: 'renamed' }, 'table'), /existing id/);
  assert.throws(() => p.previewMapDefinition(p.maps[0], 'unknown'), /Unknown map/);
  p.editBytes(40, [0, 0, 192, 127]);
  const nan = { id: 'float', address: 40, rows: 1, cols: 1, type: 'float32' };
  assert.throws(() => p.previewMapDefinition(nan), /non-finite/); assert.throws(() => p.addMap(nan), /non-finite/);
  assert.throws(() => p.previewMapDefinition({ ...nan, id: 'table' }, 'table'), /non-finite/);
  assert.throws(() => p.updateMap('table', { ...nan, id: 'table' }), /non-finite/);
});

test('moving and shrinking edited definitions preserve orphaned bytes through diff, save and undo/redo', async () => {
  for (const change of [{ address: 24 }, { cols: 1 }]) {
    const p = project();
    p.editCells('table', [{ index: 0, value: 257 }, { index: 3, value: 514 }], 'Keep exact edit');
    const bytes = p.bytes, original = p.original, diff = p.diff(), history = p.history;
    p.updateMap('table', { ...p.maps[0], ...change });
    assert.deepEqual(p.bytes, bytes); assert.deepEqual(p.original, original);
    assert.deepEqual(p.history, history); assert.deepEqual(p.diff(), diff);
    assert.deepEqual(p.diff(1), diff.slice(0, 1)); assert.equal(p.changedByteCount, diff.length);
    const saved = await p.serialize(); assert.equal(saved.rawByteEdits, true);
    const reopened = await CalibrationProject.fromJSON(saved);
    assert.deepEqual(reopened.bytes, bytes); assert.deepEqual(reopened.diff(), diff); assert.deepEqual(reopened.maps, p.maps);
    p.undo(); assert.deepEqual(p.bytes, original); assert.equal(p.changedByteCount, 0);
    p.redo(); assert.deepEqual(p.bytes, bytes); assert.deepEqual(p.diff(), diff);
    assert.deepEqual((await CalibrationProject.fromJSON(await p.serialize())).bytes, bytes);
  }
});

test('moving a currently clean map cannot conceal future redo or a restored edit in undo history', async () => {
  for (const leaveRedo of [true, false]) {
    const p = project(); p.editCells('table', [{ index: 3, value: 1234 }], 'Historic cell edit');
    const edited = p.bytes;
    if (leaveRedo) p.undo(); else p.restoreCells('table', [3], 'Restore bytes');
    assert.equal(p.changedByteCount, 0);
    const history = p.history;
    p.updateMap('table', { ...p.maps[0], address: 24 });
    assert.deepEqual(p.history, history);
    if (leaveRedo) p.redo(); else p.undo();
    assert.deepEqual(p.bytes, edited); assert.ok(p.diff().length > 0);
    assert.equal((await p.serialize()).rawByteEdits, true);
    assert.deepEqual((await CalibrationProject.fromJSON(await p.serialize())).bytes, edited);
  }
});

test('new interpretation limits do not discard older byte history or reject a later exact snapshot', async () => {
  const p = project({ type: 'uint8', min: 0, max: 255 });
  p.editCells('table', [{ index: 0, value: 200 }], 'Older value'); p.undo();
  const history = p.history;
  p.updateMap('table', { ...p.maps[0], max: 100, category: 'ignition' });
  assert.deepEqual(p.history, history); p.redo();
  assert.equal(p.bytes[4], 200); assert.equal(p.changedByteCount, 1);
  const saved = await p.serialize(); assert.equal(saved.rawByteEdits, true);
  assert.deepEqual((await CalibrationProject.fromJSON(saved)).bytes, p.bytes);
  assert.throws(() => p.editCells('table', [{ index: 1, value: 200 }]), /at most/);
});

test('metadata-only updates retain edited values and the existing out-of-range original allowance', async () => {
  const p = new CalibrationProject(Uint8Array.from([200, 0, 0, 0]), { maps: [{ id: 'byte', address: 0, rows: 1, cols: 1, type: 'uint8', min: 0, max: 100 }] });
  p.updateMap('byte', { ...p.maps[0], notes: 'Original value exceeds the proposed bound.' });
  p.editCells('byte', [{ index: 0, value: 50 }]);
  p.updateMap('byte', { ...p.maps[0], evidence: 'User note', role: 'correction' });
  assert.equal(p.bytes[0], 50); assert.equal((await p.serialize()).rawByteEdits, false);
  p.editBytes(0, [180]);
  p.updateMap('byte', { ...p.maps[0], notes: 'Explicit raw edit retained.' });
  assert.equal(p.bytes[0], 180);
  assert.deepEqual((await CalibrationProject.fromJSON(await p.serialize())).bytes, p.bytes);
});

test('updated definitions and captured workspace metadata are defensive copies', async () => {
  const p = project();
  const input = { ...p.maps[0], rows: 2, cols: 2, xAxis: [10, 20], yAxis: [30, 40], notes: 'Saved note', evidence: 'Saved evidence', category: 'fuel' };
  const returned = p.updateMap('table', input);
  input.xAxis[0] = 999; input.yAxis[0] = 999; input.notes = 'Changed input';
  returned.xAxis[1] = 999; returned.yAxis[1] = 999; returned.category = 'boost';
  p.maps[0].xAxis[0] = 999;
  assert.deepEqual(p.maps[0].xAxis, [10, 20]); assert.deepEqual(p.maps[0].yAxis, [30, 40]);
  assert.equal(p.maps[0].notes, 'Saved note'); assert.equal(p.maps[0].category, 'fuel');
  const saving = p.serialize();
  p.updateMap('table', { ...p.maps[0], notes: 'Later note' });
  const saved = await saving;
  assert.equal(saved.maps[0].notes, 'Saved note');
  const reopening = CalibrationProject.fromJSON(saved);
  saved.maps[0].notes = 'Mutated during hash'; saved.maps[0].xAxis[0] = 777;
  const restored = await reopening;
  assert.equal(restored.maps[0].notes, 'Saved note'); assert.deepEqual(restored.maps[0].xAxis, [10, 20]);
});

test('replacement at the map-count limit preserves order, and demos have sensible categories', async () => {
  const p = new CalibrationProject(new Uint8Array(LIMITS.maps), { maps: Array.from({ length: LIMITS.maps }, (_, i) => ({ id: `map-${i}`, address: i, rows: 1, cols: 1, type: 'uint8' })) });
  p.updateMap('map-0', { ...p.maps[0], name: 'Renamed first map' });
  assert.equal(p.maps.length, LIMITS.maps); assert.equal(p.maps[0].id, 'map-0');
  assert.equal((await p.serialize()).rawByteEdits, false);
  const demo = createDemoProject();
  assert.deepEqual(demo.maps.map(map => [map.id, map.category]), [['demo-ve', 'fuel'], ['demo-ignition', 'ignition'], ['demo-lambda', 'fuel']]);
  assert.equal(demo.readOriginalMap('demo-ve')[0], 42);
  assert.equal(demo.readOriginalMap('demo-ignition')[0], 11);
  assert.equal(demo.readOriginalMap('demo-lambda')[0], 1.02);
});
