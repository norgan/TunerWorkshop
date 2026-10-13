import test from 'node:test';
import assert from 'node:assert/strict';
import { FIAT_8GMK_DEFINITIONS, DIAGNOSTIC_PROFILES, decodeFiatParameter, selectProfileChannels } from '../fiat-8gmk.mjs';
import { decodeReadDataEnvelope } from '../can-diagnostics.mjs';

test('8GMK6 catalog preserves the original 105 definitions and adds 47 reconciled readings', () => {
  const observed = ['Battery voltage', 'IBS Battery charge status', 'Odometer', 'Odometer at last programming', 'Engine over-rev count', 'Max. engine speed time', 'Maximum engine over-rev RPM', 'Number of programmings', 'Vehicle speed', 'Engine speed', 'Engine temperature', 'Engine temperature signal', 'Air temperature', 'Air temperature signal', 'Engine oil temperature', 'UniAir oil temperature', 'Rev sensor (phonic wheel)', 'Spark advance', 'Spark advance (calculated)', 'Spark advance reduction (Cyl. 1)', 'Spark advance reduction (Cyl. 2)', 'Spark advance reduction (Cyl. 3)', 'Spark advance reduction (Cyl. 4)', 'Exhaust gas temperature', 'Injection time', 'Injection time correction'];
  assert.equal(FIAT_8GMK_DEFINITIONS.length, 152);
  assert.deepEqual(FIAT_8GMK_DEFINITIONS.slice(0, 26).map(d => d.label), observed);
  assert.equal(new Set(FIAT_8GMK_DEFINITIONS.map(d => d.key)).size, 152);
  assert.ok(FIAT_8GMK_DEFINITIONS.slice(0, 105).every(d => d.key.startsWith('mes-')));
  assert.equal(new Set(FIAT_8GMK_DEFINITIONS.slice(105).map(d => d.request)).size, 35);
  assert.ok(FIAT_8GMK_DEFINITIONS.slice(105).every(d => !FIAT_8GMK_DEFINITIONS.slice(0, 105).some(old => old.did === d.did)));
  assert.ok(FIAT_8GMK_DEFINITIONS.every(d => !['221205', '221999'].includes(d.request)));
  assert.ok(FIAT_8GMK_DEFINITIONS.every(d => /^22[0-9A-F]{4}$/.test(d.request)));
  assert.equal(DIAGNOSTIC_PROFILES[0].channels.length, 6);
  assert.equal(DIAGNOSTIC_PROFILES[1].channels.length, 152);
  assert.ok(Object.isFrozen(FIAT_8GMK_DEFINITIONS[0].decoder));
});

const extra = (did, data, offset = 0) => decodeFiatParameter(`8gmk-${did.toLowerCase()}-${offset}`, data);
const word = raw => [raw >> 8 & 255, raw & 255];

test('boost, mixture and supply readings use direct physical scaling independent of precision', () => {
  assert.equal(extra('1819', word(65535)), 100);
  assert.equal(extra('1819', word(32768)), 50);
  assert.equal(extra('1822', word(0)), 0);
  assert.equal(extra('1001', [255]), 100);
  assert.equal(extra('1006', [123]), 12.3);
  assert.equal(extra('1204', word(12345)), 12.345);
  assert.equal(extra('1865', word(640)), 2500);
  assert.equal(extra('1866', word(320)), 1250);
  assert.equal(extra('1938', word(4321)), 4.321);
  assert.equal(extra('1A25', word(1250)), 1.25);
  assert.equal(extra('18AC', word(750)), 750);
  assert.equal(extra('1837', [0]), -50);
  assert.equal(extra('1837', [255]), 205);
  assert.equal(extra('1858', word(512)), 2.5);
});

test('signed lambda current and torque distinguish zero, negative and signed boundaries', () => {
  for (const did of ['182B', '18E0']) {
    assert.equal(extra(did, word(1024)), 1);
    assert.equal(extra(did, word(0xfc00)), -1);
    assert.equal(extra(did, word(0x7fff)), 31.999);
    assert.equal(extra(did, word(0x8000)), -32);
  }
  assert.equal(extra('18CC', word(0xff9c)), -10);
  assert.equal(extra('183A', word(0xfff0)), -1);
  assert.equal(extra('183B', word(160)), 10);
  assert.equal(extra('183C', word(0xffe0)), -1);
});

test('MultiAir angles preserve the recovered piecewise boundary and signed second actuation', () => {
  for (const [raw, expected] of [[0, 0], [11199, 699.938], [11200, -100], [11201, -99.938], [12800, 0], [12816, 1], [65535, 3295.938]]) {
    assert.equal(extra('1986', word(raw)), expected, `Late-opening raw ${raw}`);
  }
  assert.equal(extra('1987', word(1600)), 100);
  assert.equal(extra('199A', word(0xfff0)), -1);
  assert.equal(extra('199B', word(160)), 10);
  assert.equal(extra('198D', word(2048)), 2500);
  assert.equal(extra('198F', word(800)), 100);
});

test('four-cylinder timing records retain distinct offsets, signedness and complete fields', () => {
  const data = [0xff, 0xfb, 0, 10, 0x80, 0, 0x7f, 0xff];
  for (const did of ['1996', '1997']) assert.deepEqual([0, 2, 4, 6].map(offset => extra(did, data, offset)), [-1, 2, -6553.6, 6553.4]);
  for (const did of ['199E', '199F']) assert.deepEqual([0, 2, 4, 6].map(offset => extra(did, data, offset)), [13106.2, 2, 6553.6, 6553.4]);
  for (const d of FIAT_8GMK_DEFINITIONS.slice(105)) {
    assert.throws(() => decodeFiatParameter(d.key, new Uint8Array(d.startByte + d.bytes - 1)), /truncated/);
  }
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
