import test from 'node:test';
import assert from 'node:assert/strict';
import { FIAT_DIAGNOSTIC_REQUESTS, FIAT_DIAGNOSTIC_PROFILE, FIAT_IDENTIFICATION_DEFINITIONS, FIAT_SNAPSHOT_DEFINITIONS,
  isFiatDiagnosticRequest, buildFiatSnapshotRequest, decodeFiatDtcStatus, decodeFiatDtcResponse, decodeFiatClearResponse,
  decodeFiatSnapshotResponse, decodeFiatIdentificationResponse } from '../fiat-diagnostics.mjs';

const bytes = text => Uint8Array.from(text.replaceAll(' ', '').match(/../g).map(byte => Number.parseInt(byte, 16)));
const snapshot = (records, count = records.length, id = '003313', status = 0x89) => [0x59, 4, ...bytes(id), status, 0, count, ...records.flatMap(record => [...bytes(record)])];

test('engine diagnostic allowlist admits recovered requests only', () => {
  assert.deepEqual(FIAT_DIAGNOSTIC_REQUESTS, { readDtc: '19020D', clearDtc: '14FFFFFF' });
  assert.equal(FIAT_DIAGNOSTIC_PROFILE.vehicleValidated, false);
  assert.equal(FIAT_IDENTIFICATION_DEFINITIONS.length, 10);
  assert.equal(FIAT_SNAPSHOT_DEFINITIONS.length, 40);
  assert.equal(new Set(FIAT_SNAPSHOT_DEFINITIONS.map(row => row.did)).size, 36);
  for (const request of ['19020D', '14FFFFFF', '190400331300', ...FIAT_IDENTIFICATION_DEFINITIONS.map(row => row.request)]) assert.equal(isFiatDiagnosticRequest(request), true, request);
  for (const request of ['14FFFF00', '14000000', '1902FF', '1904', '1904003313FF', '19040033130000', '190400331300\n', '19 02 0D', '19020d', 'ATZ', '2701', '2EF190', '220001', '221000', '', null, 19020]) assert.equal(isFiatDiagnosticRequest(request), false, String(request));
  assert.equal(buildFiatSnapshotRequest('003313'), '190400331300');
  for (const id of ['P0033-13', '00331300', '00331', '0033ff', '', {}, 123]) assert.throws(() => buildFiatSnapshotRequest(id));
  assert.throws(() => { FIAT_IDENTIFICATION_DEFINITIONS[0].request = '14FFFFFF'; }, TypeError);
});

test('faults retain full failure type, exact ECU status, component and standard code family', () => {
  const response = decodeFiatDtcResponse(bytes('59 02 CF 00 33 13 89 41 10 11 08 81 10 22 04 C1 02 00 00'));
  assert.equal(response.status, 'positive'); assert.equal(response.availabilityMask, 0xCF);
  assert.deepEqual(response.dtcs.map(fault => fault.code), ['P0033-13', 'C0110-11', 'B0110-22', 'U0102-00']);
  const first = response.dtcs[0];
  assert.equal(first.id, '003313'); assert.equal(first.description, 'Turbo vacuum valve');
  assert.equal(first.failureTypeDescription, 'Open circuit'); assert.equal(first.active, true); assert.equal(first.stored, true);
  assert.equal(first.warningIndicatorRequested, true); assert.equal(first.statusByte, 0x89); assert.equal(first.statusLabel, 'Present');
  assert.equal(response.dtcs[1].intermittent, true); assert.equal(response.dtcs[1].active, false);
  assert.equal(response.dtcs[2].pending, true); assert.equal(response.dtcs[2].confirmed, false);
  assert.equal(response.dtcs[3].descriptionKnown, true); assert.match(response.dtcs[3].description, /Transfer Case/);
  const unknown = decodeFiatDtcResponse(bytes('59 02 FF 3F FF FF 00')).dtcs[0];
  assert.equal(unknown.code, 'P3FFF-FF'); assert.equal(unknown.descriptionKnown, false); assert.match(unknown.failureTypeDescription, /0xFF/);
  assert.deepEqual(decodeFiatDtcResponse(bytes('59 02 CF')), { status: 'positive', availabilityMask: 0xCF, dtcs: [] });
});

test('all UDS fault status bits are retained without turning untested into clear', () => {
  const status = decodeFiatDtcStatus(0xFF);
  for (const key of ['active', 'stored', 'pending', 'confirmed', 'failedThisOperationCycle', 'testNotCompletedSinceClear', 'failedSinceClear', 'testNotCompletedThisOperationCycle', 'warningIndicatorRequested']) assert.equal(status[key], true, key);
  assert.equal(decodeFiatDtcStatus(0x50).statusLabel, 'Reported');
  assert.equal(decodeFiatDtcStatus(0x04).statusLabel, 'Pending');
  assert.equal(decodeFiatDtcStatus(0x08).statusLabel, 'Stored / intermittent');
  for (const value of [-1, 256, NaN, 0.5, '1']) assert.throws(() => decodeFiatDtcStatus(value));
});

test('negative responses preserve pending and busy semantics for their exact service', () => {
  const decoders = [
    [0x19, payload => decodeFiatDtcResponse(payload)],
    [0x19, payload => decodeFiatSnapshotResponse(payload, '003313')],
    [0x14, payload => decodeFiatClearResponse(payload)],
    [0x22, payload => decodeFiatIdentificationResponse(payload, 'vin')],
  ];
  for (const [service, decode] of decoders) {
    assert.deepEqual(decode([0x7F, service, 0x78]), { status: 'negative', code: 0x78, pending: true, retryable: false, message: 'The ECU is still processing the request.' });
    assert.equal(decode([0x7F, service, 0x21]).retryable, true);
    assert.equal(decode([0x7F, service, 0x22]).pending, false);
    assert.match(decode([0x7F, service, 0xFE]).message, /0xFE/);
    assert.throws(() => decode([0x7F, 0x2E, 0x78]), /different request/);
    assert.throws(() => decode([0x7F, service]), /malformed/);
    assert.throws(() => decode([0x7F, service, 0x78, 0]), /malformed/);
  }
});

test('malformed fault data cannot become a successful empty read or clear', () => {
  for (const payload of [[], '5902CF', {}, [0x59, 2], [0x59, 4, 0], [0x62, 2, 0], [0x59, 2, 0, 1], [0x59, 2, 0, 1, 2, 3], [0x59, 2, 0, 1, 2, 3, 256], [0x59, 2, 0, 1, 2, 3, -1], [0x59, 2, 0, 1, 2, 3, NaN], new Array(3), new Uint8Array(4096)]) assert.throws(() => decodeFiatDtcResponse(payload));
  assert.throws(() => decodeFiatDtcResponse(bytes('5902CF0033130800331389')), /duplicate/);
  assert.deepEqual(decodeFiatClearResponse([0x54]), { status: 'positive', acknowledged: true });
  for (const response of [[0x54, 0], [0x59, 2, 0], [0x14], [], [0x54, 255]]) assert.throws(() => decodeFiatClearResponse(response));
});

test('engine snapshot uses DID lengths, signed values and several views of one status byte', () => {
  const response = decodeFiatSnapshotResponse(snapshot(['10002EE0', '1812FF60', '195A08FC', '192321', '100300', '100800000100', '1921000102030405060708', '200005', '1302FFEC']), '003313');
  assert.equal(response.complete, true); assert.equal(response.declaredIdentifierCount, 9); assert.equal(response.decodedIdentifierCount, 9);
  assert.equal(response.code, 'P0033-13'); assert.equal(response.warningIndicatorRequested, true);
  assert.equal(response.fields.length, 13);
  const value = label => response.fields.find(field => field.label === label);
  assert.equal(value('Engine speed').value, 3000); assert.equal(value('Spark advance').value, -10);
  assert.equal(value('Boost pressure').value, 2300); assert.equal(value('Boost pressure').unit, 'mbar');
  assert.equal(value('Clutch pedal').value, 'Pressed'); assert.equal(value('Clutch contact 2').value, 'Released');
  assert.equal(value('Brake pedal').value, 'Released'); assert.equal(value('Brake contact 2').value, 'Released');
  assert.equal(value('Engine temperature').value, -40); assert.equal(value('Operating time').value, 256);
  assert.equal(value('Operational Mode Status').hidden, true); assert.equal(value('Operational Mode Status').rawHex, '000102030405060708');
  assert.equal(value('Engine oil temperature').value, -20);
  assert.equal(value('Universal code').value, 'Not enabled'); assert.equal(value('Engine startup').value, 'Allowed');
  assert.deepEqual(response.unknown, []);
  const empty = decodeFiatSnapshotResponse(snapshot([]), '003313');
  assert.equal(empty.complete, true); assert.deepEqual(empty.fields, []);
});

test('snapshot unknown identifiers retain evidence and stop without guessed alignment', () => {
  const payload = snapshot(['195A08FC', 'FFFF010219350A', '10040078']);
  const response = decodeFiatSnapshotResponse(payload, '003313');
  assert.equal(response.complete, false); assert.equal(response.decodedIdentifierCount, 1); assert.equal(response.declaredIdentifierCount, 3);
  assert.equal(response.fields.length, 1); assert.equal(response.fields[0].value, 2300);
  assert.deepEqual(response.unknown, [{ did: 'FFFF', offset: 12, remainingHex: 'FFFF010219350A10040078' }]);
});

test('snapshot rejects truncation, wrong attribution, duplicate IDs and inconsistent count', () => {
  assert.throws(() => decodeFiatSnapshotResponse(snapshot(['195A08FC']), '003312'), /different fault/);
  const record1 = snapshot(['195A08FC']); record1[6] = 1;
  assert.throws(() => decodeFiatSnapshotResponse(record1, '003313'), /record 00/);
  for (const payload of [snapshot(['195A08']), snapshot(['195A08FC'], 0), snapshot(['195A08FC'], 2), snapshot(['195A08FC', '195A07D0']), snapshot(['1921000102']), [0x59, 4, 0, 0x33, 0x13, 0x89, 0]]) assert.throws(() => decodeFiatSnapshotResponse(payload, '003313'));
  assert.throws(() => decodeFiatSnapshotResponse([0x59, 2, 0xCF], '003313'), /snapshot/);
});

test('all identification fields decode exact envelopes without losing leading zeroes', () => {
  const fixtures = { ecuIsoCode: '0000123400', vin: Buffer.from('ZFA12345678901234').toString('hex'), drawingNumber: Buffer.from('12345678   ').toString('hex'),
    hardwareNumber: Buffer.from('MM8GMKHW670').toString('hex'), hardwareVersion: '03', softwareNumber: Buffer.from('V862MH97   ').toString('hex'), softwareVersion: '0012',
    homologationNumber: Buffer.from('8GMKF4').toString('hex'), eepromOperatingTime: 'FFFFFFFF', operatingTime: '00000100' };
  const results = {};
  for (const definition of FIAT_IDENTIFICATION_DEFINITIONS) {
    const payload = bytes('62' + definition.request.slice(2) + fixtures[definition.key]);
    results[definition.key] = decodeFiatIdentificationResponse(payload, definition.key);
    assert.equal(results[definition.key].status, 'positive');
    assert.throws(() => decodeFiatIdentificationResponse([...payload, 0], definition.key), /unexpected extra/);
    assert.throws(() => decodeFiatIdentificationResponse(payload.slice(0, -1), definition.key), /truncated/);
  }
  assert.equal(results.ecuIsoCode.value, '00 00 12 34 00'); assert.equal(results.hardwareVersion.value, '03');
  assert.equal(results.softwareVersion.value, '0012'); assert.equal(results.drawingNumber.value, '12345678');
  assert.equal(results.softwareNumber.value, 'V862MH97'); assert.equal(results.eepromOperatingTime.value, 4294967295);
  assert.equal(results.operatingTime.value, 256); assert.equal(results.vin.value, 'ZFA12345678901234');
  assert.throws(() => decodeFiatIdentificationResponse(bytes('62F1950003'), 'hardwareVersion'), /different identification/);
  assert.throws(() => decodeFiatIdentificationResponse(bytes('62F19303'), 'anything'));
  assert.throws(() => decodeFiatIdentificationResponse([0x62, 0xF1, 0x90, ...new Array(17).fill(255)], 'vin'), /invalid text/);
  const interiorNull = Buffer.from('ZFA12345678901234'); interiorNull[5] = 0;
  assert.throws(() => decodeFiatIdentificationResponse([0x62, 0xF1, 0x90, ...interiorNull], 'vin'), /embedded null/);
});
