import test from 'node:test';
import assert from 'node:assert/strict';
import { getModuleDiagnostics, isModuleDiagnosticRequest, buildModuleSnapshotRequest,
  decodeModuleFaults, decodeModuleClear, decodeModuleIdentification, decodeModuleSnapshot } from '../module-diagnostics.mjs';

const bytes = text => Uint8Array.from(text.replaceAll(' ', '').match(/../g).map(value => Number.parseInt(value, 16)));
const snapshot = (records, id = '900011', status = 0x89, count = records.length) => [0x59, 4, ...bytes(id), status, 0, count, ...records.flatMap(record => [...bytes(record)])];
const value = (response, label) => response.fields.find(field => field.label === label);
const fixedSnapshot = (length, id = '900011') => {
  const response = new Uint8Array(length);
  response.set([0x59, 4, ...bytes(id), 0x89, 0, 3, 0x10, 8, 0, 0, 1, 0]);
  return response;
};
const profiles = ['fiat-gearbox-ddct', 'fiat-8gmk', 'fiat-instrument', 'fiat-service', 'fiat-body', 'fiat-proxi', 'fiat-engine-lpg',
  'fiat-abs', 'fiat-airbag', 'fiat-parking', 'fiat-steering', 'fiat-comfort', 'fiat-climate-auto', 'fiat-climate-manual',
  'fiat-awd', 'fiat-gearbox-zf', 'fiat-blindspot-left', 'fiat-blindspot-right', 'fiat-amplifier', 'fiat-radio-5', 'fiat-radio-65',
  'fiat-selector', 'fiat-rfhub', 'fiat-rfhub-basic', 'fiat-lane-camera', 'fiat-radar'];

test('module metadata preserves exact connections and separates physical acceptance from static coverage', () => {
  const modules = [...new Set(profiles.map(profile => getModuleDiagnostics(profile).moduleId))].map(getModuleDiagnostics);
  assert.equal(modules.length, 24);
  assert.equal(modules.reduce((total, module) => total + module.identification.length, 0), 241);
  assert.equal(modules.reduce((total, module) => total + module.snapshots.definitions.length, 0), 179);
  assert.equal(modules.reduce((total, module) => total + module.faultDescriptionCount, 0), 2580);
  assert.equal(modules.filter(module => module.snapshots.mode === 'did-list').length, 5);
  assert.equal(modules.filter(module => module.snapshots.mode === 'fixed-offset').length, 15);
  for (const profile of profiles) {
    const module = getModuleDiagnostics(profile);
    assert.equal(module.profileId, profile); assert.equal(module.connection.profileId, profile);
    assert.equal(module.vehicleValidated, false); assert.equal(module.evidence, 'static-interoperability');
    assert.ok(Object.isFrozen(module)); assert.ok(Object.isFrozen(module.identification));
    assert.ok(module.connection.isoCodes.every(code => /^(?:[0-9A-F]{2} ){4}[0-9A-F]{2}$/.test(code)));
  }
  assert.equal(getModuleDiagnostics('BODY25').connection.requestId, '18DA40F1');
  assert.equal(getModuleDiagnostics('fiat-abs').connection.responseId, '18DAF128');
  assert.equal(getModuleDiagnostics('fiat-abs').connection.adapterCode, 600);
  assert.equal(getModuleDiagnostics('fiat-climate-auto').connection.protocol, 'BHCAN29');
  assert.equal(getModuleDiagnostics('fiat-climate-auto').connection.adapterCode, 500);
  assert.equal(getModuleDiagnostics('LRBSS1').connection, null);
  assert.equal(getModuleDiagnostics('fiat-blindspot-left').connection.requestId, '18DA62F1');
  assert.equal(getModuleDiagnostics('fiat-blindspot-right').connection.requestId, '18DA65F1');
  assert.equal(getModuleDiagnostics('CNAV12').connections.length, 2);
  assert.equal(getModuleDiagnostics('fiat-radio-5').connection.requestId, '18DA87F1');
  assert.equal(getModuleDiagnostics('fiat-proxi').capabilities.identification, false);
  assert.equal(getModuleDiagnostics('fiat-proxi').unsupported.length, 3);
  for (const selector of ['fiat-proxi', 'fiat-service']) {
    assert.equal(getModuleDiagnostics(selector).capabilities.readFaults, false);
    assert.equal(getModuleDiagnostics(selector).capabilities.clearFaults, false);
  }
  for (const selector of ['', 'BODY24', 'generic', null, {}, 0, '__proto__']) assert.equal(getModuleDiagnostics(selector), null);
  assert.throws(() => { getModuleDiagnostics('fiat-body').connection.requestId = '18DA10F1'; }, TypeError);
});

test('requests are bound to each module with no raw-command or unsupported-snapshot admission', () => {
  for (const profile of profiles) {
    const module = getModuleDiagnostics(profile);
    assert.equal(isModuleDiagnosticRequest(profile, '19020D'), module.capabilities.readFaults);
    assert.equal(isModuleDiagnosticRequest(profile, '14FFFFFF'), module.capabilities.clearFaults);
    assert.equal(isModuleDiagnosticRequest(profile, '190490001100'), module.capabilities.snapshot);
    for (const field of module.identification) assert.equal(isModuleDiagnosticRequest(profile, field.request), true);
  }
  for (const request of ['', null, 19020, 'ATSH18DA10F1', '14FFFF00', '1902FF', '1904', '190490001101', '19049000110000',
    '190490001100\n', '19 02 0D', '19020d', '2701', '2EF190', '222023', '2240A1', '221000', '22F191\n']) assert.equal(isModuleDiagnosticRequest('fiat-body', request), false, String(request));
  assert.equal(isModuleDiagnosticRequest('fiat-body', '22F18C'), true);
  assert.equal(isModuleDiagnosticRequest('fiat-8gmk', '22F18C'), false);
  assert.equal(isModuleDiagnosticRequest('fiat-gearbox-zf', '22F191'), true);
  assert.equal(isModuleDiagnosticRequest('fiat-gearbox-zf', '22F100'), true);
  assert.equal(isModuleDiagnosticRequest('fiat-body', '22F100'), false);
  assert.equal(isModuleDiagnosticRequest('unknown', '19020D'), false);
  assert.equal(buildModuleSnapshotRequest('fiat-body', '900011'), '190490001100');
  for (const id of ['B1000-11', '90001', '9000110', '90001f', null, 1]) assert.throws(() => buildModuleSnapshotRequest('fiat-body', id));
  assert.throws(() => buildModuleSnapshotRequest('fiat-radio-5', '900011'), /not supported/);
  assert.throws(() => decodeModuleFaults('fiat-proxi', [0x59, 2, 0xFF]), /not supported/);
  assert.throws(() => decodeModuleClear('fiat-service', [0x54]), /not supported/);
});

test('fault codes and subtype/status use module-specific labels without borrowing engine descriptions', () => {
  const payload = bytes('5902CF900011899907130840521304C1000000');
  const body = decodeModuleFaults('fiat-body', payload), dash = decodeModuleFaults('fiat-instrument', payload);
  assert.equal(body.status, 'positive'); assert.equal(body.availabilityMask, 0xCF);
  assert.equal(body.dtcs[0].description, 'Body computer control unit');
  assert.equal(dash.dtcs[0].description, 'Control unit fault');
  assert.equal(body.dtcs[0].code, 'B1000-11'); assert.equal(body.dtcs[0].failureTypeDescription, 'Short circuit to ground');
  assert.equal(body.dtcs[0].active, true); assert.equal(body.dtcs[0].warningIndicatorRequested, true);
  assert.equal(body.dtcs[1].intermittent, true); assert.equal(body.dtcs[1].stored, true); assert.equal(body.dtcs[1].active, false);
  assert.equal(body.dtcs[2].pending, true); assert.equal(body.dtcs[3].code, 'U0100-00');
  assert.equal(decodeModuleFaults('fiat-climate-auto', payload).dtcs[1].description, 'Right mix motor feedback');
  assert.equal(decodeModuleFaults('fiat-abs', payload).dtcs[2].description, 'Steering angle sensor (NGE)');
  const engineCodeInBody = decodeModuleFaults('fiat-body', bytes('5902CF00331308')).dtcs[0];
  assert.equal(engineCodeInBody.descriptionKnown, false); assert.equal(engineCodeInBody.description, 'Unknown module fault');
  assert.deepEqual(decodeModuleFaults('fiat-body', [0x59, 2, 0xCF]), { status: 'positive', availabilityMask: 0xCF, dtcs: [] });
});

test('fault decoders reject malformed/empty data and clear requires an exact terminal acknowledgement', () => {
  for (const payload of [[], '5902CF', {}, new Array(3), [0x59, 2], [0x59, 4, 0], [0x59, 2, 0, 1],
    [0x59, 2, 0, 1, 2, 3], [0x59, 2, 0, 1, 2, 3, 256], [0x59, 2, 0, 1, 2, 3, NaN], new Uint8Array(4096)]) assert.throws(() => decodeModuleFaults('fiat-body', payload));
  assert.throws(() => decodeModuleFaults('fiat-body', bytes('5902CF9000110890001189')), /duplicate/);
  assert.deepEqual(decodeModuleClear('fiat-body', [0x54]), { status: 'positive', acknowledged: true });
  for (const payload of [[], [0x54, 0], [0x14], [0x59, 2, 0]]) assert.throws(() => decodeModuleClear('fiat-body', payload));
  for (const decode of [payload => decodeModuleFaults('fiat-climate-auto', payload), payload => decodeModuleSnapshot('fiat-body', '900011', payload)]) {
    assert.equal(decode([0x7F, 0x19, 0x78]).pending, true);
    assert.equal(decode([0x7F, 0x19, 0x21]).retryable, true);
    const noData = decode([0x7F, 0x19, 0x31]);
    assert.equal(noData.status, 'negative'); assert.equal(noData.fields, undefined); assert.equal(noData.dtcs, undefined);
    assert.match(noData.message, /not available/);
    assert.throws(() => decode([0x7F, 0x22, 0x31]), /different request/);
    assert.throws(() => decode([0x7F, 0x19]), /malformed/);
  }
  assert.equal(decodeModuleClear('fiat-body', [0x7F, 0x14, 0x22]).acknowledged, undefined);
});

test('identification preserves serial/version text and rejects wrong DID, length, or text', () => {
  const serial = [0x62, 0xF1, 0x8C, ...Buffer.from('AB0123456789   ')];
  const result = decodeModuleIdentification('fiat-body', 'identity-f18c', serial);
  assert.equal(result.value, 'AB0123456789'); assert.equal(result.did, 'F18C'); assert.equal(result.rawHex, Buffer.from('AB0123456789   ').toString('hex').toUpperCase());
  assert.equal(decodeModuleIdentification('fiat-gearbox-zf', 'identity-f191', [0x62, 0xF1, 0x91, ...Buffer.from('12345678   ')]).value, '12345678');
  assert.equal(decodeModuleIdentification('fiat-body', 'identity-f195', [0x62, 0xF1, 0x95, 0, 2]).value, '0002');
  assert.equal(decodeModuleIdentification('fiat-body', 'identity-2008', [0x62, 0x20, 8, 0xFF, 0xFF, 0xFF, 0xFF]).value, 4294967295);
  assert.equal(decodeModuleIdentification('fiat-body', 'identity-f18c', [0x7F, 0x22, 0x31]).status, 'negative');
  assert.throws(() => decodeModuleIdentification('fiat-8gmk', 'identity-f18c', serial), /Unknown identification/);
  assert.throws(() => decodeModuleIdentification('fiat-body', 'identity-f18c', [...serial, 0]), /unexpected extra/);
  assert.throws(() => decodeModuleIdentification('fiat-body', 'identity-f18c', serial.slice(0, -1)), /truncated/);
  assert.throws(() => decodeModuleIdentification('fiat-body', 'identity-f18c', [0x62, 0xF1, 0x90, ...serial.slice(3)]), /different identification/);
  const invalid = [...serial]; invalid[5] = 255;
  assert.throws(() => decodeModuleIdentification('fiat-body', 'identity-f18c', invalid), /invalid text/);
  invalid[5] = 0;
  assert.throws(() => decodeModuleIdentification('fiat-body', 'identity-f18c', invalid), /embedded null/);
  assert.throws(() => decodeModuleIdentification('fiat-proxi', 'identity-2023', [0x62, 0x20, 0x23]), /not supported/);
});

test('all 241 published identification fields have bounded decoders and exact response lengths', () => {
  const seen = new Set(); let count = 0;
  for (const profile of profiles) {
    const module = getModuleDiagnostics(profile);
    if (seen.has(module.moduleId)) continue;
    seen.add(module.moduleId);
    for (const field of module.identification) {
      const data = new Uint8Array(field.bytes).fill(field.format === 'str' ? 0x41 : 1);
      const response = [0x62, field.did >> 8, field.did & 255, ...data];
      const decoded = decodeModuleIdentification(profile, field.key, response);
      assert.equal(decoded.status, 'positive'); assert.notEqual(decoded.value, undefined);
      assert.throws(() => decodeModuleIdentification(profile, field.key, response.slice(0, -1)), /truncated/);
      assert.throws(() => decodeModuleIdentification(profile, field.key, [...response, 0]), /unexpected extra/);
      count++;
    }
  }
  assert.equal(count, 241);
});

test('DID snapshots use each module length and field window, including LPG and DDCT exceptions', () => {
  const lpg = decodeModuleSnapshot('fiat-engine-lpg', '003313', snapshot(['191E2009', '10002EE0', '1812F0'], '003313'));
  assert.equal(lpg.complete, true); assert.equal(value(lpg, 'Engine status').value, 'Idle');
  assert.equal(value(lpg, 'Engine speed').value, 3000); assert.equal(value(lpg, 'Spark advance').value, -12);
  assert.equal(value(lpg, 'Engine status').rawHex, '09');
  const gearbox = decodeModuleSnapshot('fiat-gearbox-ddct', '056013', snapshot(['1C43FE7F', '100800000100'], '056013'));
  assert.equal(gearbox.complete, true); assert.equal(value(gearbox, 'Gearbox oil temperature').value, -52);
  assert.equal(value(gearbox, 'Gearbox oil temperature').rawHex, 'FE'); assert.equal(value(gearbox, 'Operating time').value, 256);
  const rfh = decodeModuleSnapshot('fiat-rfhub', '550111', snapshot(['100480', '10090010'], '550111'));
  assert.equal(rfh.complete, true); assert.equal(value(rfh, 'Battery voltage').value, 12.8);
  assert.equal(rfh.description, 'Front left tire pressure');
  assert.throws(() => decodeModuleSnapshot('fiat-8gmk', '550111', snapshot(['100480'], '550111')), /truncated/);
  const empty = decodeModuleSnapshot('fiat-rfhub', '550111', snapshot([], '550111'));
  assert.equal(empty.complete, true); assert.deepEqual(empty.fields, []);
});

test('DID snapshots stop on unknown identifiers without fabricating subsequent alignment', () => {
  const payload = snapshot(['10047D', 'FFFF010210090002', '100800000001'], '550111');
  const result = decodeModuleSnapshot('fiat-rfhub', '550111', payload);
  assert.equal(result.complete, false); assert.equal(result.decodedIdentifierCount, 1); assert.equal(result.declaredIdentifierCount, 3);
  assert.equal(result.fields.length, 1); assert.equal(result.fields[0].value, 12.5);
  assert.deepEqual(result.unknown, [{ did: 'FFFF', offset: 11, remainingHex: 'FFFF010210090002100800000001' }]);
  for (const payload of [snapshot(['1004'], '550111'), snapshot(['10047D', '100480'], '550111'), snapshot(['10047D'], '550111', 0x89, 0), snapshot(['10047D'], '550111', 0x89, 2)]) assert.throws(() => decodeModuleSnapshot('fiat-rfhub', '550111', payload));
});

test('fixed snapshots decode only verified offset fields and retain the unparsed record', () => {
  const bodyPayload = fixedSnapshot(42); bodyPayload[41] = 125;
  const body = decodeModuleSnapshot('fiat-body', '900011', bodyPayload);
  assert.equal(body.layout, 'fixed-offset'); assert.equal(body.complete, false); assert.equal(body.decodedIdentifierCount, null);
  assert.equal(body.noSnapshotData, false); assert.match(body.layoutNote, /complete identifier layout has not been verified/);
  assert.equal(value(body, 'Operating time').value, 256); assert.equal(value(body, 'Battery voltage').value, 12.5);
  assert.equal(value(body, 'Battery voltage').offset, 41); assert.equal(body.rawHex.length, bodyPayload.length * 2);
  assert.equal(body.description, 'Body computer control unit');
  const absPayload = fixedSnapshot(52, '405213'); absPayload[38] = 0x83; absPayload[41] = 128; absPayload[44] = 72; absPayload.set([0xFF, 0], 50);
  const abs = decodeModuleSnapshot('fiat-abs', '405213', absPayload);
  assert.equal(value(abs, 'Battery voltage').value, 12.8); assert.equal(value(abs, 'Vehicle speed').value, 72);
  assert.equal(value(abs, 'Brake pedal pressure').value, -4); assert.equal(value(abs, 'Brake pedal switch').value, 'ON');
  assert.equal(value(abs, 'Brake contact 2').value, 'ON'); assert.equal(value(abs, 'EPB control switch').value, 'Deactivate');
  const climatePayload = fixedSnapshot(40, '990711'); climatePayload.set([0, 80], 38);
  assert.equal(value(decodeModuleSnapshot('fiat-climate-auto', '990711', climatePayload), 'Battery voltage').value, 12.8);
  const steeringPayload = fixedSnapshot(47, '405213'); steeringPayload.set([0xFF, 0xE0], 45);
  assert.equal(value(decodeModuleSnapshot('fiat-steering', '405213', steeringPayload), 'Steering angle').value, -2);
});

test('fixed snapshots reject truncation and wrong attribution instead of showing missing readings as zero', () => {
  const payload = fixedSnapshot(42);
  assert.throws(() => decodeModuleSnapshot('fiat-body', '900011', payload.slice(0, 41)), /truncated/);
  assert.throws(() => decodeModuleSnapshot('fiat-body', '900013', payload), /different fault/);
  const wrongRecord = payload.slice(); wrongRecord[6] = 1;
  assert.throws(() => decodeModuleSnapshot('fiat-body', '900011', wrongRecord), /record 00/);
  const wrongCount = payload.slice(); wrongCount[7] = 100;
  assert.throws(() => decodeModuleSnapshot('fiat-body', '900011', wrongCount), /identifier list is truncated/);
  const empty = decodeModuleSnapshot('fiat-body', '900011', snapshot([]));
  assert.equal(empty.noSnapshotData, true); assert.deepEqual(empty.fields, []); assert.equal(empty.complete, false);
  const trailing = snapshot([]); trailing.push(0);
  assert.throws(() => decodeModuleSnapshot('fiat-body', '900011', trailing), /unexpected extra/);
  assert.throws(() => decodeModuleSnapshot('fiat-body', '900011', []), /Invalid or empty/);
  assert.throws(() => decodeModuleSnapshot('fiat-radio-5', '900011', payload), /not supported/);
});

test('ZF variant identities remain distinct from five-byte ISO codes and fallback is narrowly allowlisted', () => {
  const zf = getModuleDiagnostics('fiat-gearbox-zf');
  assert.deepEqual(zf.connection.isoCodes, ['52 85 04 0D 3D']);
  assert.deepEqual(zf.connection.alternateIdentityCodes, ['TCM6202', 'TCM6420']);
  assert.deepEqual(zf.identityFallback.acceptedCodes, ['TCM6202', 'TCM6420']);
  assert.equal(zf.identityFallback.dataOffset, 4); assert.equal(zf.identityFallback.dataBytes, 2);
  assert.deepEqual(zf.identityFallback.triggerResponses, ['7F2231', '62F1A5FFFFFFFFFF', '62F1A52020202020', '62F1A50000000000']);
  assert.equal(getModuleDiagnostics('fiat-body').identityFallback, null);
  assert.equal(isModuleDiagnosticRequest('fiat-gearbox-zf', '22F100'), true);
  assert.equal(isModuleDiagnosticRequest('fiat-gearbox-ddct', '22F100'), false);
});
