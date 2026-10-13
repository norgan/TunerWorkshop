import test from 'node:test';
import assert from 'node:assert/strict';
import { FIAT_8GMK_DEFINITIONS, DIAGNOSTIC_PROFILES, decodeFiatParameter, selectProfileChannels } from '../fiat-8gmk.mjs';
import { decodeReadDataEnvelope } from '../can-diagnostics.mjs';

test('8GMK6 catalog matches the 26 observed UI rows and preserves all 105 definitions', () => {
  const observed = ['Battery voltage', 'IBS Battery charge status', 'Odometer', 'Odometer at last programming', 'Engine over-rev count', 'Max. engine speed time', 'Maximum engine over-rev RPM', 'Number of programmings', 'Vehicle speed', 'Engine speed', 'Engine temperature', 'Engine temperature signal', 'Air temperature', 'Air temperature signal', 'Engine oil temperature', 'UniAir oil temperature', 'Rev sensor (phonic wheel)', 'Spark advance', 'Spark advance (calculated)', 'Spark advance reduction (Cyl. 1)', 'Spark advance reduction (Cyl. 2)', 'Spark advance reduction (Cyl. 3)', 'Spark advance reduction (Cyl. 4)', 'Exhaust gas temperature', 'Injection time', 'Injection time correction'];
  assert.equal(FIAT_8GMK_DEFINITIONS.length, 105);
  assert.deepEqual(FIAT_8GMK_DEFINITIONS.slice(0, 26).map(d => d.label), observed);
  assert.equal(new Set(FIAT_8GMK_DEFINITIONS.map(d => d.key)).size, 105);
  assert.ok(FIAT_8GMK_DEFINITIONS.every(d => /^22[0-9A-F]{4}$/.test(d.request)));
  assert.equal(DIAGNOSTIC_PROFILES[0].channels.length, 6);
  assert.equal(DIAGNOSTIC_PROFILES[1].channels.length, 105);
  assert.ok(Object.isFrozen(FIAT_8GMK_DEFINITIONS[0].decoder));
});

test('numeric decoder applies big-endian, signed values, precision, multiplier and offset', () => {
  assert.equal(decodeFiatParameter('mes-10500', [0x0c, 0x80]), 800); // RPM
  assert.equal(decodeFiatParameter('mes-10144', [0, 123]), 12.3); // Battery voltage
  assert.equal(decodeFiatParameter('mes-10510', [0, 66]), 26); // Engine temperature
  assert.equal(decodeFiatParameter('mes-10494', [0xff, 0xfb]), -5); // Signed oil temperature
  assert.equal(decodeFiatParameter('mes-11688', [0x03, 0x20]), 10); // UniAir: (800*6.25-4000)/100
  assert.equal(decodeFiatParameter('mes-11517', [0xff, 0x90]), -7); // Signed spark advance
  assert.equal(decodeFiatParameter('mes-10533', [100]), 450); // EGT
  assert.equal(decodeFiatParameter('mes-10853', [0x04, 0xe2]), 2.5); // Injection time
  assert.equal(decodeFiatParameter('mes-10155', [0x05, 0xdc]), 1500); // Boost pressure mbar
  assert.equal(decodeFiatParameter('mes-11095', [1, 0, 0]), 6553.6); // 24-bit odometer
});

test('status rules decode actual masks, word order, first matches and defined fallback', () => {
  assert.equal(decodeFiatParameter('mes-11672', [1]), 'Active');
  assert.equal(decodeFiatParameter('mes-11672', [0]), 'Not active');
  assert.equal(decodeFiatParameter('mes-11791', [0x02, 0]), 'Clutch pedal not pressed');
  assert.equal(decodeFiatParameter('mes-11791', [0, 1]), 'Engine temperature');
  assert.equal(decodeFiatParameter('mes-11791', [0, 0]), 'Not present');
  assert.equal(decodeFiatParameter('mes-10696', [0x10]), 'R');
  assert.equal(decodeFiatParameter('mes-10696', [3]), '3');
  assert.equal(decodeFiatParameter('mes-11686', [99, 99, 99, 0]), 'OK');
  assert.equal(decodeFiatParameter('mes-10549', [0, 8]), '1');
  assert.equal(decodeFiatParameter('mes-10549', [0, 0]), 'Not active');
});

test('all channels decode bounded zero/max records without undefined or nonfinite values', () => {
  for (const definition of FIAT_8GMK_DEFINITIONS) for (const value of [0, 255]) {
    const result = decodeFiatParameter(definition.key, new Uint8Array(definition.startByte + definition.bytes).fill(value));
    assert.ok(definition.valueType === 'number' ? Number.isFinite(result) : typeof result === 'string' && result.length > 0, definition.key);
  }
});

test('selection is profile-scoped, bounded and independent from request strings', () => {
  assert.equal(selectProfileChannels('fiat-8gmk').length, 8);
  assert.equal(selectProfileChannels('generic-obd').length, 6);
  for (const ids of [[], ['mes-10500', 'mes-10500'], ['rpm'], ['221000'], FIAT_8GMK_DEFINITIONS.slice(0, 33).map(d => d.key)]) assert.throws(() => selectProfileChannels('fiat-8gmk', ids));
  assert.throws(() => selectProfileChannels('guessed-module'));
});

test('truncated and invalid data cannot turn into plausible measurements', () => {
  for (const data of [[1], [256, 1], [-1, 0], [1, NaN], '1234', new Uint8Array(513)]) assert.throws(() => decodeFiatParameter('mes-10500', data));
  assert.throws(() => decodeFiatParameter('mes-10549', [8]));
  assert.throws(() => decodeFiatParameter('mes-11686', [0, 0, 0]));
  assert.throws(() => decodeFiatParameter('other-module', [0, 0]));
  assert.deepEqual([...decodeReadDataEnvelope([0x62, 0x38, 0x50, 0, 0, 0, 1, 99], 0x3850, { minimum: 4, maximum: 32 }).data], [0, 0, 0, 1, 99]);
  assert.throws(() => decodeReadDataEnvelope([0x62, 0x38, 0x50, 0, 0, 0], 0x3850, { minimum: 4, maximum: 32 }));
});
