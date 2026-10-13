import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectWinolsProject } from '../winols-project.mjs';
import { createOlsSmokeFixture } from '../desktop/ols-smoke-fixture.mjs';
import { CalibrationProject } from '../core.mjs';

test('OLS source-labelled definitions are grouped automatically, separate from ECU bytes', () => {
  const bytes = createOlsSmokeFixture(), before = bytes.slice();
  const result = inspectWinolsProject(bytes);
  assert.equal(result.supported, true);
  assert.equal(result.version, 597);
  assert.equal(result.counts.total, 115);
  assert.equal(result.records[0].category, 'boost');
  assert.equal(result.records[1].category, 'ignition');
  assert.equal(result.records[2].category, 'fuel');
  assert.equal(result.records[3].category, 'other');
  assert.equal(result.records[0].address, 0x100);
  assert.deepEqual(result.records[0].axes.map(a => a.count), [2, 3]);
  assert.equal(result.records[1].factor, 0.0625);
  assert.equal(result.records[2].factor, 1 / 1024);
  assert.equal(result.records[0].addressSpace, 'project-image');
  assert.equal(result.imageStatus, 'unresolved');
  assert.ok(result.records.every(r => r.valuesAvailable === false && !Object.hasOwn(r, 'values')));
  const aliases = result.records.filter(r => r.symbol === 'PQAV');
  assert.equal(aliases.length, 2);
  assert.notEqual(aliases[0].id, aliases[1].id);
  assert.deepEqual(bytes, before);
});

test('saved OLS workspace preserves original catalogue despite raw byte edits', async () => {
  const project = new CalibrationProject(createOlsSmokeFixture(0), { name: 'synthetic.ols' });
  const before = inspectWinolsProject(project.original);
  project.editBytes(16, new Uint8Array([0, 0, 0, 0]));
  const restored = await CalibrationProject.fromJSON(await project.serialize());
  assert.deepEqual(inspectWinolsProject(restored.original), before);
  assert.equal(inspectWinolsProject(restored.bytes).supported, false);
  assert.equal(restored.maps.length, 0, 'Source addresses must not become editable container offsets');
});

test('raw data and unsupported/truncated OLS layouts do not acquire guessed definitions', () => {
  assert.equal(inspectWinolsProject(new Uint8Array(128)), null);
  const fixture = createOlsSmokeFixture(0);
  const unsupported = fixture.slice();
  new DataView(unsupported.buffer).setUint32(16, 598, true);
  assert.equal(inspectWinolsProject(unsupported).supported, false);
  assert.equal(inspectWinolsProject(unsupported).records.length, 0);
  assert.equal(inspectWinolsProject(fixture.subarray(0, 200)).records.length, 0);
  // Buffer views must respect their offsets rather than reading surrounding data.
  const wrapped = new Uint8Array(fixture.length + 100);
  wrapped.set(fixture, 50);
  assert.deepEqual(inspectWinolsProject(wrapped.subarray(50, 50 + fixture.length)), inspectWinolsProject(fixture));
});

test('malformed record dimensions and truncated axis blocks are rejected independently', () => {
  const fixture = createOlsSmokeFixture(0);
  const parsed = inspectWinolsProject(fixture);
  const first = parsed.records[0];
  const damaged = fixture.slice(), d = new DataView(damaged.buffer);
  const nameEnd = first.sourceRecordOffset + 4 + first.name.length;
  const symbolEnd = nameEnd + 40 + first.symbol.length;
  d.setUint32(symbolEnd + 117, 0xffffffff, true);
  const result = inspectWinolsProject(damaged);
  assert.equal(result.records.length, 4);
  assert.ok(!result.records.some(r => r.symbol === first.symbol));
  assert.equal(result.rejected, 1);
  const prefix = fixture.subarray(0, parsed.records[1].sourceRecordOffset - 35);
  assert.equal(inspectWinolsProject(prefix).records.length, 0);
});
