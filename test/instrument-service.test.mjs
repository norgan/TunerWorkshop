import test from 'node:test';
import assert from 'node:assert/strict';
import { INSTRUMENT_SERVICE_CONNECTION, INSTRUMENT_SERVICE_PROFILE, decodeInstrumentIdentity, decodeInstrumentParameter, resetInstrumentService } from '../instrument-service.mjs';

const context = { profileId: 'fiat-service', ecu: '18DAF160', sessionId: 'instrument-fixture', confirmed: true, serviceCompleted: true };
const u24 = value => [value >> 16 & 255, value >> 8 & 255, value & 255];
function fixture({ resetReply = [0x6f, 0x55, 0x69, 1], change = true, rpm = 0, speed = 0, coupons = 5, iso = [0x32, 0x83, 0x76, 0x0d, 0x0d], afterFailure = false } = {}) {
  const requests = [], sleeps = []; let sent = false;
  return { requests, sleeps, async command(request) {
    requests.push(request);
    if (request === '2F556901') { sent = true; return resetReply; }
    if (sent && afterFailure) throw new Error('Disconnected.');
    const updated = sent && change;
    const data = {
      '22F1A5': iso, '220101': u24(updated ? 300000 : 5000), '222807': updated ? [1, 109] : [0, 20],
      '222802': u24(updated ? 0 : 24500), '222800': [updated ? coupons - 1 : coupons],
      '222803': [60], '222806': [73], '221000': [rpm >> 6 & 255, rpm * 4 & 255], '221002': [speed],
    }[request];
    assert.ok(data, `Unexpected request ${request}`);
    return [0x62, Number.parseInt(request.slice(2, 4), 16), Number.parseInt(request.slice(4), 16), ...data];
  }, async sleep(ms) { sleeps.push(ms); } };
}

test('service profile is the direct instrument endpoint with its two recovered ISO identities', () => {
  assert.deepEqual(INSTRUMENT_SERVICE_CONNECTION.isoCodes, ['0003502D16', '3283760D0D']);
  assert.equal(INSTRUMENT_SERVICE_CONNECTION.requestId, '18DA60F1');
  assert.equal(INSTRUMENT_SERVICE_PROFILE.id, 'fiat-service');
  assert.equal(INSTRUMENT_SERVICE_PROFILE.channels.length, 11);
  assert.ok(INSTRUMENT_SERVICE_PROFILE.channels.every(channel => /^22[0-9A-F]{4}$/.test(channel.request)));
  assert.equal(decodeInstrumentIdentity([0, 3, 0x50, 0x2d, 0x16]).ecuIsoCode, '00 03 50 2D 16');
  assert.throws(() => decodeInstrumentIdentity([0, 1, 0x50, 0xa8, 0x15]), /not identified/);
  assert.ok(Object.isFrozen(INSTRUMENT_SERVICE_PROFILE.channels[0]));
});

test('instrument readings retain exact source scaling and dates do not invent valid days', () => {
  assert.equal(decodeInstrumentParameter('service-distance-remaining', [1, 0, 0]), 6553.6);
  assert.equal(decodeInstrumentParameter('service-distance-since', [1, 0, 0]), 65536);
  assert.equal(decodeInstrumentParameter('service-interval', [60]), 30000);
  assert.equal(decodeInstrumentParameter('service-period', [73]), 365);
  assert.equal(decodeInstrumentParameter('service-voltage', [124]), 12.4);
  assert.equal(decodeInstrumentParameter('service-rpm', [0x0c, 0x80]), 800);
  assert.equal(decodeInstrumentParameter('service-date', [0x20, 0x24, 0x02, 0x29]), '2024-02-29');
  assert.equal(decodeInstrumentParameter('service-date', [0x20, 0x23, 0x02, 0x29]), 'Unrecognized date');
  assert.equal(decodeInstrumentParameter('service-date', [0xff, 0xff, 0xff, 0xff]), 'Not recorded');
  assert.equal(decodeInstrumentParameter('service-date', [0x20, 0x24, 0x0a, 0x29]), 'Unrecognized date');
  for (const invalid of [[], [1], [1, 2], [256, 0, 0], [1, -1, 0], [1, NaN, 0]]) assert.throws(() => decodeInstrumentParameter('service-distance-since', invalid));
  assert.throws(() => decodeInstrumentParameter('other-module', [0]));
});

test('dashboard reset re-identifies, reads conditions, writes once and verifies changed counters', async () => {
  const f = fixture(), result = await resetInstrumentService({ ...f, context });
  assert.equal(result.status, 'verified');
  assert.equal(f.requests[0], '22F1A5');
  const write = f.requests.indexOf('2F556901');
  assert.deepEqual(f.requests.slice(write - 2, write), ['221000', '221002']);
  assert.equal(f.requests.filter(request => request === '2F556901').length, 1);
  assert.deepEqual(f.sleeps, [8000]);
  assert.equal(result.before['service-coupons'], 5);
  assert.equal(result.after['service-coupons'], 4);
  assert.ok(f.requests.every(request => request.startsWith('22') || request === '2F556901'));
});

test('missing confirmation, wrong session, identity, movement and exhausted coupons prevent the write', async () => {
  for (const input of [{ ...context, confirmed: false }, { ...context, serviceCompleted: false }, { ...context, profileId: 'fiat-8gmk' }, { ...context, ecu: '18DAF110' }, { ...context, sessionId: '' }]) {
    const f = fixture(); await assert.rejects(resetInstrumentService({ ...f, context: input })); assert.deepEqual(f.requests, []);
  }
  for (const options of [{ rpm: 800 }, { rpm: 0.25 }, { speed: 1 }, { coupons: 0 }, { iso: [0, 1, 0x50, 0xa8, 0x15] }]) {
    const f = fixture(options); await assert.rejects(resetInstrumentService({ ...f, context })); assert.ok(!f.requests.includes('2F556901'));
  }
});

test('an attributed negative refusal rejects the reset without retrying', async () => {
  for (const resetReply of [[0x7f, 0x2f, 0x22], [0x7f, 0x2f, 0x31], [0x7f, 0x2f, 0x33]]) {
    const f = fixture({ resetReply });
    await assert.rejects(resetInstrumentService({ ...f, context }));
    assert.equal(f.requests.filter(request => request === '2F556901').length, 1);
    assert.deepEqual(f.sleeps, []);
  }
});

test('pending, wrong-identifier and missing replies preserve unknown outcome without retrying', async () => {
  for (const resetReply of [[], [0x7f, 0x2f, 0x78], [0x7f, 0x22, 0x31], [0x6f, 0x55, 0x68], [0x71, 0x55, 0x69], [0x6f, 0x55, 0x69], [0x6f, 0x55, 0x69, 0], [0x6f, 0x55, 0x69, 3]]) {
    const f = fixture({ resetReply }), result = await resetInstrumentService({ ...f, context });
    assert.equal(result.status, 'outcome-unknown'); assert.equal(result.changesMayHaveOccurred, true);
    assert.equal(result.after, null); assert.match(result.message, /may have been applied/);
    assert.equal(f.requests.filter(request => request === '2F556901').length, 1);
    assert.deepEqual(f.sleeps, []);
  }
});

test('connection loss while sending a reset preserves possible change and is never retried', async () => {
  const f = fixture(), originalCommand = f.command;
  const result = await resetInstrumentService({ ...f, context, command: async request => {
    const reply = await originalCommand(request); if (request === '2F556901') throw new Error('Adapter disconnected.'); return reply;
  } });
  assert.equal(result.status, 'outcome-unknown'); assert.equal(result.changesMayHaveOccurred, true);
  assert.equal(f.requests.filter(request => request === '2F556901').length, 1);
});

test('acknowledged reset with unchanged or unavailable post-readings remains unverified', async () => {
  for (const options of [{ change: false }, { afterFailure: true }]) {
    const f = fixture(options), result = await resetInstrumentService({ ...f, context });
    assert.equal(result.status, 'accepted-unverified');
    assert.equal(f.requests.filter(request => request === '2F556901').length, 1);
    assert.ok(result.before);
  }
});

test('reset acknowledgement matches service, DID and control parameter before optional status bytes', async () => {
  for (const resetReply of [[0x6f, 0x55, 0x69, 1], [0x6f, 0x55, 0x69, 1, 0x80, 0]]) {
    const f = fixture({ resetReply }), result = await resetInstrumentService({ ...f, context });
    assert.equal(result.status, 'verified');
    assert.equal(f.requests.filter(request => request === '2F556901').length, 1);
  }
});
