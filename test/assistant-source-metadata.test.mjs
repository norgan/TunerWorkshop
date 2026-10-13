import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAssistantRequest } from '../assistant.mjs';
import { inspectWinolsProject } from '../winols-project.mjs';
import { createOlsSmokeFixture } from '../desktop/ols-smoke-fixture.mjs';

function request() {
  const record = inspectWinolsProject(createOlsSmokeFixture(0)).records[0];
  const keys = ['name', 'symbol', 'category', 'role', 'confidence', 'reason', 'dimension1', 'dimension2', 'unit', 'address', 'factor', 'offset'];
  const sourceMetadata = Object.fromEntries(keys.map(key => [key, record[key]]));
  Object.assign(sourceMetadata, { format: 'winols-project', addressSpace: 'project-image-unresolved', valuesAvailable: false,
    axes: record.axes.map(({ unresolvedText, ...axis }) => axis) });
  return { messages: [{ role: 'user', content: 'Explain this definition.' }], context: { tuning: { vehicle: 'Imported reference; ECU match unverified', map: null, sourceMetadata } } };
}

test('assistant accepts one unresolved saved definition without numeric values', () => {
  const input = request(), result = validateAssistantRequest(input);
  assert.deepEqual(result, input);
  assert.notEqual(result.context.tuning.sourceMetadata.axes[0], input.context.tuning.sourceMetadata.axes[0]);
  assert.equal(result.context.tuning.map, null);
  assert.equal(result.context.tuning.sourceMetadata.valuesAvailable, false);
});

test('assistant rejects invented source values, ECU address claims and oversized metadata', () => {
  for (const patch of [ { valuesAvailable: true }, { addressSpace: 'ecu' }, { confidence: 'verified' }, { format: 'raw' },
    { bytes: [0, 1] }, { values: [10, 20] }, { name: 'x'.repeat(513) }, { dimension1: 0 }, { dimension1: 4097 },
    { factor: NaN }, { address: -1 } ]) {
    const input = request(); Object.assign(input.context.tuning.sourceMetadata, patch);
    assert.throws(() => validateAssistantRequest(input));
  }
  const wrongAxis = request(); wrongAxis.context.tuning.sourceMetadata.axes[0].count = 3;
  assert.throws(() => validateAssistantRequest(wrongAxis));
  const extraAxis = request(); extraAxis.context.tuning.sourceMetadata.axes.push(extraAxis.context.tuning.sourceMetadata.axes[0]);
  assert.throws(() => validateAssistantRequest(extraAxis));
  const rawAxis = request(); rawAxis.context.tuning.sourceMetadata.axes[0].values = [1, 2];
  assert.throws(() => validateAssistantRequest(rawAxis));
  const mixed = request(); mixed.context.tuning.map = { name: 'Editable map', rows: 1, cols: 1, selectionTotal: 0, selectionTruncated: false, cells: [] };
  assert.throws(() => validateAssistantRequest(mixed), /must be separate/);
});
