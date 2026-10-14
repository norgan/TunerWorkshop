import test from 'node:test';
import assert from 'node:assert/strict';
import { SENSOR_DEFINITIONS } from '../elm-protocol.mjs';
import { DIAGNOSTIC_LIMITS, validateDiagnosticCatalog, createGenericObdCatalog, validateDiagnosticSession, validateSubscriptions, validateMeasurement, measurementState, formatMeasurement } from '../diagnostic-catalog.mjs';

const NOW = Date.parse('2026-10-11T00:00:10.000Z');
function fixtureCatalog() {
  return { format: 'tuneworkshop-diagnostic-catalog', schemaVersion: 1, id: 'synthetic-catalog', version: '1', profiles: [
    { id: 'module-a-profile', moduleId: 'module-a', label: 'Synthetic module A', kind: 'manufacturer', channels: [
      { id: 'pressure', label: 'Pressure', valueType: 'number', unit: 'kPa', digits: 1, staleAfterMs: 1000 },
      { id: 'switch', label: 'Switch', valueType: 'boolean', trueLabel: 'On', falseLabel: 'Off', staleAfterMs: 10000 },
      { id: 'state', label: 'Operating state', valueType: 'enum', enumValues: [{ code: 0, label: 'Inactive' }, { code: 1, label: 'Active' }], staleAfterMs: 5000 },
      { id: 'label', label: 'Display status', valueType: 'text', maxTextLength: 20, staleAfterMs: 5000 },
    ] },
    { id: 'module-b-profile', moduleId: 'module-b', label: 'Synthetic module B', kind: 'manufacturer', channels: [
      { id: 'pressure', label: 'Pressure', valueType: 'number', unit: 'bar', staleAfterMs: 30000 },
    ] },
  ] };
}
function fixtureSession(catalog, changes = {}) {
  return validateDiagnosticSession(catalog, { catalogId: catalog.id, catalogVersion: catalog.version, profileId: 'module-a-profile', moduleId: 'module-a', ecuId: 'synthetic-ecu-a', connectionId: 'connection-1', sessionId: 'session-1', sourceKind: 'live-manufacturer', ...changes });
}
function sample(session, channelId = 'pressure', value = 100, changes = {}) {
  return { ...session, channelId, value, quality: 'valid', sequence: 1, observedAt: new Date(NOW).toISOString(), ...changes };
}

test('generic catalog derives exactly the existing six mode 01 channels without commands', () => {
  const catalog = createGenericObdCatalog(), profile = catalog.profiles[0];
  assert.equal(profile.kind, 'generic-obd');
  assert.equal(profile.channels.length, 6);
  assert.deepEqual(profile.channels.map(channel => [channel.id, channel.label, channel.unit]), SENSOR_DEFINITIONS.map(sensor => [sensor.key, sensor.label, sensor.unit]));
  assert.deepEqual(profile.channels.map(channel => channel.digits), [0, 0, 0, 0, 1, 2]);
  assert.ok(profile.channels.every(channel => channel.valueType === 'number' && channel.staleAfterMs === 5000));
  assert.equal(JSON.stringify(catalog).includes('request'), false);
  const session = validateDiagnosticSession(catalog, { catalogId: catalog.id, catalogVersion: catalog.version, profileId: profile.id, moduleId: profile.moduleId, ecuId: '7E8', connectionId: 'adapter-1', sessionId: 'obd-session-1', sourceKind: 'live-obd' });
  assert.deepEqual(validateSubscriptions(catalog, session, ['rpm', 'ecuVoltage']), ['rpm', 'ecuVoltage']);
});

test('catalogs clone and deeply freeze definitions, labels and enum entries', () => {
  const input = fixtureCatalog(), catalog = validateDiagnosticCatalog(input);
  input.profiles[0].channels[0].label = 'Changed';
  input.profiles[0].channels[2].enumValues[0].label = 'Changed';
  assert.equal(catalog.profiles[0].channels[0].label, 'Pressure');
  assert.equal(catalog.profiles[0].channels[2].enumValues[0].label, 'Inactive');
  for (const object of [catalog, catalog.profiles, catalog.profiles[0], catalog.profiles[0].channels, catalog.profiles[0].channels[2].enumValues[0]]) assert.equal(Object.isFrozen(object), true);
  assert.throws(() => { catalog.profiles[0].channels[0].label = 'Mutated'; }, TypeError);
});

test('catalog rejects schema ambiguity, duplicate IDs, unsupported fields and sparse arrays', () => {
  for (const change of [
    input => { input.schemaVersion = 2; },
    input => { input.id = '../catalog'; },
    input => { input.protocolCommand = 'arbitrary'; },
    input => { input.profiles[0].requestBytes = [1, 2]; },
    input => { input.profiles[1].id = input.profiles[0].id; },
    input => { input.profiles[0].channels[1].id = 'pressure'; },
    input => { input.profiles[0].channels[0].decoder = 'eval()'; },
    input => { input.profiles = new Array(1); },
    input => { input.profiles[0].channels = new Array(1); },
    input => { input.profiles[0].channels[2].enumValues = new Array(1); },
    input => { input.profiles[0].channels[2].enumValues.push({ code: 1, label: 'Other' }); },
  ]) {
    const input = fixtureCatalog(); change(input);
    assert.throws(() => validateDiagnosticCatalog(input), TypeError);
  }
});

test('channel metadata validates display, scalar type, text and enum bounds', () => {
  for (const changes of [
    { valueType: 'binary' }, { label: '' }, { label: 'x'.repeat(161) }, { label: 'Name\nInjected' }, { unit: 'x'.repeat(41) },
    { digits: -1 }, { digits: 9 }, { digits: 1.5 }, { staleAfterMs: 0 }, { staleAfterMs: Infinity }, { staleAfterMs: 3600001 },
    { valueType: 'boolean', digits: 1 }, { trueLabel: 'Yes' }, { enumValues: [] }, { maxTextLength: 30 },
  ]) {
    const input = fixtureCatalog(); Object.assign(input.profiles[0].channels[0], changes);
    assert.throws(() => validateDiagnosticCatalog(input), TypeError);
  }
  for (const changes of [{ enumValues: [] }, { enumValues: [{ code: NaN, label: 'Invalid' }] }, { enumValues: [{ code: 1.5, label: 'Invalid' }] }, { enumValues: Array.from({ length: 129 }, (_, code) => ({ code, label: 'State' })) }]) {
    const input = fixtureCatalog(); Object.assign(input.profiles[0].channels[2], changes);
    assert.throws(() => validateDiagnosticCatalog(input), TypeError);
  }
});

test('a full 512-channel catalog can be subscribed without permitting unknown or repeated IDs', () => {
  const input = fixtureCatalog(); input.profiles.length = 1;
  input.profiles[0].channels = Array.from({ length: 512 }, (_, index) => ({ id: `channel-${index}`, label: `Channel ${index}`, valueType: 'number', staleAfterMs: 30000 }));
  const catalog = validateDiagnosticCatalog(input), session = fixtureSession(catalog);
  assert.equal(catalog.profiles[0].channels.length, DIAGNOSTIC_LIMITS.channels);
  const ids = input.profiles[0].channels.map(channel => channel.id);
  assert.deepEqual(validateSubscriptions(catalog, session, ids), ids);
  assert.deepEqual(validateSubscriptions(catalog, session, []), []);
  for (const invalid of [[...ids,'channel-512'], ['channel-0', 'channel-0'], ['missing'], new Array(1), 'channel-0']) assert.throws(() => validateSubscriptions(catalog, session, invalid), TypeError);
  input.profiles[0].channels.push({ id: 'channel-512', label: 'Extra', valueType: 'number', staleAfterMs: 5000 });
  assert.throws(() => validateDiagnosticCatalog(input), /512/);
  input.profiles[0].channels.pop(); input.profiles.push(fixtureCatalog().profiles[1]);
  assert.throws(() => validateDiagnosticCatalog(input), /512/);
});

test('session binds exact catalog, version, module and source without inferring compatibility', () => {
  const catalog = validateDiagnosticCatalog(fixtureCatalog()), session = fixtureSession(catalog);
  assert.equal(Object.isFrozen(session), true);
  for (const changes of [
    { catalogId: 'other' }, { catalogVersion: '2' }, { profileId: 'unknown' }, { moduleId: 'module-b' },
    { sourceKind: 'live-obd' }, { sourceKind: 'simulation' }, { connectionId: null }, { ecuId: null }, { sessionId: '' },
    { sourceKind: 'mes-log', connectionId: 'live-connection' }, { verified: true },
  ]) assert.throws(() => fixtureSession(catalog, changes), TypeError);
  assert.throws(() => validateDiagnosticSession(fixtureCatalog(), session), /Validate the catalog/);
  assert.throws(() => validateSubscriptions(catalog, { ...session }, ['pressure']), /validated session/);
  const separatelyValidated = validateDiagnosticCatalog(fixtureCatalog());
  assert.throws(() => validateSubscriptions(separatelyValidated, session, ['pressure']), /bound to this catalog/);
});

test('numeric, boolean, enum and text readings retain distinct typed values', () => {
  const catalog = validateDiagnosticCatalog(fixtureCatalog()), session = fixtureSession(catalog);
  for (const [channelId, value, expectedText] of [['pressure', 100.25, '100.3'], ['switch', false, 'Off'], ['switch', true, 'On'], ['state', 1, 'Active'], ['label', 'Gear 1', 'Gear 1']]) {
    const input = sample(session, channelId, value), validated = validateMeasurement(catalog, session, input);
    assert.equal(validated.value, value);
    assert.equal(formatMeasurement(catalog, session, validated).text, expectedText);
    assert.equal(Object.isFrozen(validated), true);
  }
  for (const [channelId, value] of [['pressure', '100'], ['pressure', NaN], ['pressure', Infinity], ['pressure', 1e12 + 1], ['switch', 1], ['switch', 'On'], ['state', 'Active'], ['state', 0.5], ['label', 1], ['label', 'x'.repeat(21)], ['label', 'bad\ntext']]) assert.throws(() => validateMeasurement(catalog, session, sample(session, channelId, value)), TypeError);
});

test('unknown enum codes remain distinguishable from known states and missing values', () => {
  const catalog = validateDiagnosticCatalog(fixtureCatalog()), session = fixtureSession(catalog);
  const unknown = validateMeasurement(catalog, session, sample(session, 'state', 255));
  assert.equal(unknown.value, 255);
  assert.deepEqual(formatMeasurement(catalog, session, unknown), { text: 'Unknown (255)', unit: '', known: false });
  assert.deepEqual(formatMeasurement(catalog, session, sample(session, 'state', 0)), { text: 'Inactive', unit: '', known: true });
  const missing = sample(session, 'state', null, { quality: 'unavailable' });
  assert.deepEqual(formatMeasurement(catalog, session, missing), { text: '—', unit: '', known: false });
  assert.equal(measurementState(catalog, session, missing, NOW).quality, 'unavailable');
});

test('same-named signals, historical imports and old connection callbacks cannot cross active sources', () => {
  const catalog = validateDiagnosticCatalog(fixtureCatalog()), sessionA = fixtureSession(catalog);
  const sessionB = fixtureSession(catalog, { profileId: 'module-b-profile', moduleId: 'module-b', ecuId: 'synthetic-ecu-b', sessionId: 'session-b' });
  const historical = fixtureSession(catalog, { sourceKind: 'mes-log', connectionId: null, sessionId: 'import-1', ecuId: null });
  const nextConnection = fixtureSession(catalog, { connectionId: 'connection-2', sessionId: 'session-2' });
  const measurementA = sample(sessionA), measurementB = sample(sessionB), historicalMeasurement = sample(historical, 'pressure', 100, { observedAt: null });
  assert.equal(measurementA.channelId, measurementB.channelId);
  assert.throws(() => validateMeasurement(catalog, sessionA, measurementB), /does not match/);
  assert.throws(() => validateMeasurement(catalog, sessionA, historicalMeasurement), /does not match/);
  assert.throws(() => validateMeasurement(catalog, nextConnection, measurementA), /does not match/);
  for (const changes of [{ ecuId: 'other' }, { sourceKind: 'mes-log' }, { catalogVersion: '2' }, { connectionId: 'other' }, { sessionId: 'other' }, { moduleId: 'other' }, { profileId: 'other' }, { catalogId: 'other' }]) assert.throws(() => validateMeasurement(catalog, sessionA, { ...measurementA, ...changes }), /does not match/);
  assert.equal(measurementState(catalog, historical, historicalMeasurement, NOW).quality, 'historical');
});

test('freshness uses each channel period and reports clock skew instead of treating future data as fresh', () => {
  const catalog = validateDiagnosticCatalog(fixtureCatalog()), session = fixtureSession(catalog);
  const pressure = sample(session), slowSwitch = sample(session, 'switch', true);
  assert.deepEqual(measurementState(catalog, session, pressure, NOW + 1000), { quality: 'fresh', ageMs: 1000 });
  assert.deepEqual(measurementState(catalog, session, pressure, NOW + 1001), { quality: 'stale', ageMs: 1001 });
  assert.deepEqual(measurementState(catalog, session, slowSwitch, NOW + 5000), { quality: 'fresh', ageMs: 5000 });
  assert.deepEqual(measurementState(catalog, session, pressure, NOW - 1), { quality: 'clock-skew', ageMs: -1 });
  for (const invalidTime of [NaN, Infinity, -1, 'now', NOW + 0.5]) assert.throws(() => measurementState(catalog, session, pressure, invalidTime), TypeError);
});

test('historical samples remain historical even when a recorded timestamp happens to be recent', () => {
  const catalog = validateDiagnosticCatalog(fixtureCatalog()), historical = fixtureSession(catalog, { sourceKind: 'mes-log', connectionId: null, sessionId: 'historical-1' });
  assert.deepEqual(measurementState(catalog, historical, sample(historical), NOW), { quality: 'historical', ageMs: null });
  assert.deepEqual(measurementState(catalog, historical, sample(historical, 'pressure', 100, { observedAt: null }), NOW), { quality: 'historical', ageMs: null });
});

test('invalid or missing readings have null values and observations reject excess payload and malformed timing', () => {
  const catalog = validateDiagnosticCatalog(fixtureCatalog()), session = fixtureSession(catalog);
  for (const quality of ['unavailable', 'decode-error']) {
    const input = sample(session, 'pressure', null, { quality });
    assert.equal(validateMeasurement(catalog, session, input).value, null);
    assert.deepEqual(measurementState(catalog, session, input, NOW), { quality, ageMs: null });
    assert.throws(() => validateMeasurement(catalog, session, { ...input, value: 0 }), /null value/);
  }
  for (const change of [
    { channelId: 'unknown' }, { quality: 'verified' }, { quality: 'stale' }, { value: null }, { sequence: -1 }, { sequence: 0.5 }, { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { observedAt: null }, { observedAt: '2026-02-31T00:00:00.000Z' }, { observedAt: '2026-10-11 00:00:10' },
    { observedAt: '2026-10-11T00:00:10.000+00:00' }, { rawBytes: [1, 2, 3] }, { originalFile: 'private path' },
  ]) assert.throws(() => validateMeasurement(catalog, session, sample(session, 'pressure', 100, change)), TypeError);
});
