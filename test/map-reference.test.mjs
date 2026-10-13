import test from 'node:test';
import assert from 'node:assert/strict';
import { referenceCatalogue } from '../map-reference-data.mjs';
import { referenceDefinitionSeed } from '../map-references.mjs';
import { definitionFromFields } from '../map-workbench-model.mjs';
import { createDemoProject } from '../core.mjs';

test('reference workflow never transfers MiTo locations or inferred conversion into a Fiat definition', () => {
  const project = createDemoProject();
  assert.equal(referenceCatalogue.readyToApply, false);
  assert.equal(referenceCatalogue.targetFiat8gmkMatchVerified, false);
  assert.equal(referenceCatalogue.rawImageRecovered, false);
  for (const reference of referenceCatalogue.candidates) {
    const seed = referenceDefinitionSeed(reference.symbol);
    for (const key of ['address','rows','cols','type','endian','unit','factor','offset','xAxis','yAxis']) assert.equal(seed[key], '', `${reference.symbol} ${key}`);
    assert.equal(seed.definitionStatus, 'candidate');
    assert.match(seed.evidence, /No match to this image established/);
    assert.throws(() => definitionFromFields(project, {...seed,addressSpace:'file'}), /address/);
  }
  assert.throws(() => referenceDefinitionSeed('unknown'), /Unknown/);
  assert.equal(project.changedByteCount, 0);
});
