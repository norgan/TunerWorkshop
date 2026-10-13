import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FIAT_MODULE_CATALOG, FIAT_MODULE_PROFILES, getFiatModuleProfile, getFiatModuleConnection,
  decodeFiatModuleIdentity, decodeFiatModuleParameter,
  getFiatModuleIdentityFallback, decodeFiatModuleVariantIdentity,
} from '../fiat-modules.mjs';

test('26 model entries retain alternatives, exact addressing, adapter and network distinctions', () => {
  assert.equal(FIAT_MODULE_CATALOG.length, 26);
  assert.equal(FIAT_MODULE_PROFILES.length, 24);
  assert.equal(FIAT_MODULE_PROFILES.filter(p => p.available).length, 23);
  assert.equal(FIAT_MODULE_PROFILES.reduce((count, p) => count + p.channels.length, 0), 663);
  assert.equal(FIAT_MODULE_PROFILES.reduce((count, p) => count + p.supportedParameterCount, 0), 581);
  assert.ok(!FIAT_MODULE_PROFILES.some(p => ['fiat-8gmk', 'fiat-service'].includes(p.id)));
  const expected = {
    'fiat-body': ['18DA40F1', '18DAF140', 500000, 'direct'],
    'fiat-abs': ['18DA28F1', '18DAF128', 500000, 'A6'],
    'fiat-climate-auto': ['18DA98F1', '18DAF198', 125000, 'A5'],
    'fiat-blindspot-left': ['18DA62F1', '18DAF162', 125000, 'A5'],
    'fiat-blindspot-right': ['18DA65F1', '18DAF165', 125000, 'A5'],
    'fiat-lane-camera': ['18DA31F1', '18DAF131', 500000, 'A6'],
  };
  for (const [id, values] of Object.entries(expected)) {
    const connection = getFiatModuleConnection(id);
    assert.deepEqual([connection.requestId, connection.responseId, connection.baud, connection.adapter], values);
  }
  for (const module of FIAT_MODULE_CATALOG) {
    assert.equal(module.connection.session, '1003');
    assert.equal(module.connection.fallbackSession, module.protocol === 'BHCAN29' ? null : '1092');
    assert.equal(module.connection.sessionFallbackNrc, module.protocol === 'BHCAN29' ? null : 0x12);
    assert.equal(module.physicalAcceptance, 'not-tested');
    assert.equal(module.connection.identityRequest, '22F1A5');
    assert.ok(Object.isFrozen(module.connection.isoCodes));
  }
  assert.deepEqual(FIAT_MODULE_CATALOG.reduce((counts, m) => ({ ...counts, [m.adapter]: (counts[m.adapter] ?? 0) + 1 }), {}), { direct: 13, A6: 5, A5: 8 });
});

test('ISO gating uses the selected module list and never an empty-list wildcard', () => {
  assert.deepEqual(decodeFiatModuleIdentity('fiat-body', [0, 0, 0x60, 0x3A, 0x15]), {
    source: 'live-manufacturer', ecuIsoCode: '00 00 60 3A 15', moduleID: 'BODY25', profileId: 'fiat-body',
  });
  assert.throws(() => decodeFiatModuleIdentity('fiat-abs', [0, 0, 0x60, 0x3A, 0x15]), /not identified/);
  for (const bytes of [[], [0, 0, 0x60, 0x3A], [0, 0, 0x60, 0x3A, 0x15, 0], [-1, 0, 0, 0, 0], [256, 0, 0, 0, 0], '0000603A15']) {
    assert.throws(() => decodeFiatModuleIdentity('fiat-body', bytes));
  }
  assert.throws(() => decodeFiatModuleIdentity('fiat-proxi', [0, 0, 0x60, 0x3A, 0x15]), /PROXI workflow/);
  assert.throws(() => decodeFiatModuleIdentity('unknown', [0, 0, 0, 0, 0]), /Unknown/);
  assert.equal(getFiatModuleConnection('fiat-radio-5').isoCodes.length, 7);
  assert.deepEqual(getFiatModuleConnection('fiat-radio-5').isoCodes, getFiatModuleConnection('fiat-radio-65').isoCodes);
  assert.deepEqual(getFiatModuleConnection('fiat-gearbox-zf').isoCodes, ['5285040D3D']);
  assert.deepEqual(FIAT_MODULE_CATALOG.find(m => m.id === 'fiat-gearbox-zf').unresolvedIdentityTokens, []);
});

test('ZF variant fallback has exact triggers and a controller-specific allowlist', () => {
  const id = 'fiat-gearbox-zf';
  assert.equal(getFiatModuleConnection(id).variantIdentityRequest, '22F100');
  assert.deepEqual(getFiatModuleConnection(id).variantIdentityTokens, ['TCM6202', 'TCM6420']);
  for (const payload of [[0x7f, 0x22, 0x31], ...[0, 0x20, 0xff].map(byte => [0x62, 0xf1, 0xa5, ...new Array(5).fill(byte)])]) {
    assert.deepEqual(getFiatModuleIdentityFallback(id, payload), { request: '22F100', minimumBytes: 3 });
    assert.equal(getFiatModuleIdentityFallback('fiat-body', payload), null);
  }
  for (const payload of [[], [0x7f, 0x22, 0x78], [0x7f, 0x22, 0x22], [0x7f, 0x22, 0x31, 0], [0x62, 0xf1, 0xa5, 0, 0, 0, 0], [0x62, 0xf1, 0xa5, 0, 0, 0, 0, 1], [0x62, 0xf1, 0xa5, 0, 0x20, 0xff, 0, 0], [0x62, 0xf1, 0xa5, 0x52, 0x85, 4, 13, 0x3d]]) {
    assert.equal(getFiatModuleIdentityFallback(id, payload), null);
  }
  assert.equal(decodeFiatModuleVariantIdentity(id, [0x99, 0x62, 0x02]).ecuIsoCode, 'TCM6202');
  assert.equal(decodeFiatModuleVariantIdentity(id, [0, 0x64, 0x20, 99]).ecuIsoCode, 'TCM6420');
  assert.equal(decodeFiatModuleVariantIdentity(id, [0, 0x64, 0x20]).identityMethod, 'variant-version');
  for (const bytes of [[0x62, 0x02], [0x62, 0x02, 0], [0, 0x62, 0x03], [0, 0x62, 256], '006202']) assert.throws(() => decodeFiatModuleVariantIdentity(id, bytes));
  assert.throws(() => decodeFiatModuleVariantIdentity('fiat-gearbox-ddct', [0, 0x62, 0x02]), /not verified/);
});

test('real module formulas distinguish data offsets, signed values and controller-specific scale', () => {
  assert.equal(decodeFiatModuleParameter('fiat-body', 'mes-10144-1004-1', [123]), 12.3);
  assert.equal(decodeFiatModuleParameter('fiat-abs', 'mes-10500-1000-1', [0x0c, 0x80]), 800);
  assert.equal(decodeFiatModuleParameter('fiat-gearbox-ddct', 'mes-10500-1c11-1', [0x0c, 0x80]), 3200);
  assert.equal(decodeFiatModuleParameter('fiat-abs', 'mes-11537-0885-1', [0xff, 0x90]), -7);
  assert.equal(decodeFiatModuleParameter('fiat-climate-auto', 'mes-10144-0263-1', [0, 80]), 12.8);
  assert.equal(decodeFiatModuleParameter('fiat-comfort', 'mes-11436-0105-5', [1, 2, 3, 4, 130]), 25);
  assert.equal(decodeFiatModuleParameter('fiat-rfhub', 'mes-11095-2001-1', [1, 0, 0]), 6553.6);
});

test('the three-byte DDCT overtemperature timer is weighted seconds, minutes, hours', () => {
  assert.equal(decodeFiatModuleParameter('fiat-gearbox-ddct', 'mes-10244-1c52-1', [3, 2, 1]), 3723);
  assert.equal(decodeFiatModuleParameter('fiat-gearbox-ddct', 'mes-10245-1c51-1', [59, 59, 2]), 10799);
  assert.throws(() => decodeFiatModuleParameter('fiat-gearbox-ddct', 'mes-10245-1c51-1', [2, 59]), /truncated/);
});

test('status words preserve byte order, first match and recovered fallback', () => {
  assert.equal(decodeFiatModuleParameter('fiat-body', 'mes-11551-0135-1', [1, 0]), 'Vol+');
  assert.equal(decodeFiatModuleParameter('fiat-body', 'mes-11551-0135-1', [0, 1]), '>>');
  assert.equal(decodeFiatModuleParameter('fiat-body', 'mes-11551-0135-1', [3, 0]), 'Vol+');
  assert.equal(decodeFiatModuleParameter('fiat-body', 'mes-11551-0135-1', [0, 0]), 'No request');
  assert.equal(decodeFiatModuleParameter('fiat-comfort', 'mes-11436-0101-1', [3]), '2');
  assert.equal(decodeFiatModuleParameter('fiat-comfort', 'mes-11436-0101-1', [0]), 'Not available');
});

test('identifiers retain hexadecimal leading zeros without becoming numeric sensor values', () => {
  assert.equal(decodeFiatModuleParameter('fiat-body', 'mes-10964-40a3-5', [99, 99, 99, 99, 0, 1, 0xab, 0xcd]), '00 01 AB CD');
  assert.equal(decodeFiatModuleParameter('fiat-rfhub', 'mes-10599-31cb-1', [0, 1, 0xab, 0xcd]), '0001ABCD');
  assert.equal(getFiatModuleProfile('fiat-rfhub').channels.find(c => c.key === 'mes-10599-31cb-1').valueType, 'text');
});

test('every available row decodes bounded zero/max data and rejects a truncated record', () => {
  for (const profile of FIAT_MODULE_PROFILES) {
    assert.equal(new Set(profile.channels.map(channel => channel.key)).size, profile.channels.length, profile.id);
    assert.ok(profile.defaultChannels.every(key => profile.channels.some(channel => channel.key === key && channel.available)));
    for (const channel of profile.channels.filter(channel => channel.available)) {
      assert.match(channel.request, /^22[0-9A-F]{4}$/);
      assert.ok(Object.isFrozen(channel.decoder));
      for (const byte of [0, 255]) {
        const result = decodeFiatModuleParameter(profile.id, channel.key, new Uint8Array(channel.startByte + channel.bytes).fill(byte));
        assert.ok(channel.valueType === 'number' ? Number.isFinite(result) : typeof result === 'string' && result.length > 0, `${profile.id}/${channel.key}`);
      }
      assert.throws(() => decodeFiatModuleParameter(profile.id, channel.key, new Uint8Array(channel.startByte + channel.bytes - 1)), /truncated/);
    }
  }
});

test('unknown keys, invalid bytes and unrelated modules cannot produce plausible readings', () => {
  for (const data of [[256], [-1], [NaN], [1.5], ['1'], '7B', new Uint8Array(513)]) assert.throws(() => decodeFiatModuleParameter('fiat-body', 'mes-10144-1004-1', data));
  assert.throws(() => decodeFiatModuleParameter('fiat-climate-auto', 'mes-10144-1004-1', [123]), /does not belong/);
  assert.throws(() => decodeFiatModuleParameter('unknown-module', 'mes-10144-1004-1', [123]), /Unknown/);
  assert.throws(() => getFiatModuleConnection('unknown-module'), /Unknown/);
  assert.throws(() => getFiatModuleProfile('fiat-service'), /Unknown/);
});

test('PROXI descriptors and conflicting signed radar formats stay visibly unavailable', () => {
  const proxi = getFiatModuleProfile('fiat-proxi');
  assert.equal(proxi.available, false);
  assert.equal(proxi.channels.length, 80);
  assert.ok(proxi.channels.every(channel => !channel.available && channel.unavailableReason.includes('network-configuration')));
  assert.deepEqual(proxi.defaultChannels, []);
  assert.throws(() => decodeFiatModuleParameter('fiat-proxi', proxi.channels[0].key, new Uint8Array(64)), /PROXI workflow/);
  const radar = getFiatModuleProfile('fiat-radar');
  assert.deepEqual(radar.channels.filter(channel => !channel.available).map(channel => channel.label), ['Slow misalignment angle', 'Fast misalignment angle']);
  for (const channel of radar.channels.filter(channel => !channel.available)) {
    assert.ok(!radar.defaultChannels.includes(channel.key));
    assert.throws(() => decodeFiatModuleParameter('fiat-radar', channel.key, [0, 0, 0, 0]), /sign/);
  }
});
