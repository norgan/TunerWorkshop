import test from 'node:test';
import assert from 'node:assert/strict';
import { SERVICE_TOOLS, getServiceTool, serviceToolRequests, decodeServiceResponse, validateServiceContext, runServiceTool, serviceWait } from '../service-tools.mjs';

const fromHex = value => Uint8Array.from(value.match(/../g).map(byte => Number.parseInt(byte, 16)));
const clock = () => 100000;
const context = () => ({ profileId: 'fiat-8gmk', status: 'connected', ecu: '18DAF110', acknowledged: true, engineRpm: 0, vehicleSpeed: 0, sampleAt: clock() });
function positive(request) {
  if (request === '221302') return fromHex('6213020050');
  if (request === '221860') return fromHex('6218600C');
  return fromHex((Number.parseInt(request.slice(0, 2), 16) + 0x40).toString(16) + request.slice(2, 8));
}
function rig(extra = {}) {
  const sent = [], delays = [], progress = [];
  return { sent, delays, progress, options: { context: context(), now: clock,
    command: async (request, options) => { sent.push({ request, ...options }); return positive(request); },
    wait: async (ms, { signal }) => { assert(!signal?.aborted); delays.push(ms); },
    onProgress: value => progress.push(value), ...extra
  } };
}

test('Fiat catalogue accounts for every actuator and adjustment, with honest unavailable workflows', () => {
  assert.equal(SERVICE_TOOLS.length, 34);
  assert.equal(SERVICE_TOOLS.filter(tool => tool.category === 'actuator').length, 21);
  assert.equal(SERVICE_TOOLS.filter(tool => tool.category === 'adjustment').length, 13);
  assert.equal(SERVICE_TOOLS.filter(tool => tool.available).length, 30);
  assert.equal(new Set(SERVICE_TOOLS.map(tool => tool.id)).size, 34);
  assert(SERVICE_TOOLS.every(tool => Object.isFrozen(tool) && Object.isFrozen(tool.steps)));
  for (const tool of SERVICE_TOOLS) {
    if (tool.available) assert(tool.steps.length && tool.conditions.length >= 3);
    else { assert(tool.unavailableReason); assert.deepEqual(serviceToolRequests(tool.id), []); }
  }
  assert.throws(() => getServiceTool('raw-command'), /supported/);
  assert.equal(getServiceTool('injector-1').durationMs, 500);
  assert.equal(getServiceTool('fan-high').durationMs, 6000);
  assert.equal(getServiceTool('fuel-pump').durationMs, 6000);
});

test('response decoding matches service, identifier and control echo; pending never means success', () => {
  assert.equal(decodeServiceResponse('2F500103', fromHex('6F500103')).status, 'positive');
  assert.equal(decodeServiceResponse('3101020B01', fromHex('7101020B00')).status, 'positive');
  assert.equal(decodeServiceResponse('2F500103', fromHex('7F2F78')).code, 0x78);
  assert.equal(decodeServiceResponse('2F500103', fromHex('7F2F33')).code, 0x33);
  assert.throws(() => decodeServiceResponse('2F500103', fromHex('6F500100')), /does not match/);
  assert.throws(() => decodeServiceResponse('2F500103', fromHex('6F500203')), /does not match/);
  assert.throws(() => decodeServiceResponse('2F504001', fromHex('6F5040')), /does not match/);
  assert.throws(() => decodeServiceResponse('2F504001', fromHex('6F504000')), /does not match/);
  assert.throws(() => decodeServiceResponse('3101020B01', fromHex('7102020B00')), /does not match/);
  assert.throws(() => decodeServiceResponse('2F500103', fromHex('7F3178')), /different request/);
  assert.throws(() => decodeServiceResponse('221860', fromHex('621860')), /length/);
  assert.throws(() => decodeServiceResponse('2F500103', []), /missing/);
  assert.throws(() => decodeServiceResponse('1101', fromHex('5101')), /supported service/);
});

test('confirmation and fresh stationary engine-off checks run before any command', async () => {
  for (const mutation of [{ acknowledged: false }, { engineRpm: 800 }, { engineRpm: NaN }, { vehicleSpeed: 1 }, { sampleAt: 90000 }, { sampleAt: 100001 }, { profileId: 'generic-obd' }, { status: 'disconnected' }, { ecu: '7E8' }]) {
    const r = rig({ context: { ...context(), ...mutation } });
    await assert.rejects(runServiceTool('fan-low', r.options));
    assert.deepEqual(r.sent, []);
  }
  const r = rig();
  await assert.rejects(runServiceTool('performance-limit-deactivation', r.options), /irreversible/);
  assert.deepEqual(r.sent, []);
  assert.equal(validateServiceContext('fan-low', context(), clock()).id, 'fan-low');
});

test('fan and injector tests preserve recovered activation duration then release control', async () => {
  const fan = rig(), result = await runServiceTool('fan-low', fan.options);
  assert.deepEqual(fan.sent, [{ request: '3101020B01', cleanup: false }, { request: '3101020B00', cleanup: true }]);
  assert.deepEqual(fan.delays, [6000]);
  assert.equal(result.status, 'completed'); assert.equal(result.stopStatus, 'acknowledged');
  assert.equal(result.physicalOutcomeVerified, false);
  const injector = rig(); await runServiceTool('injector-4', injector.options);
  assert.deepEqual(injector.sent.map(item => item.request), ['2F510303', '2F510300']);
  assert.deepEqual(injector.delays, [500]);
});

test('fuel pump executes on-off-on-release sequence with two-second intervals', async () => {
  const r = rig(); await runServiceTool('fuel-pump', r.options);
  assert.deepEqual(r.sent.map(item => item.request), ['2F502103FF', '2F50210300', '2F502103FF', '2F502100']);
  assert.deepEqual(r.delays, [2000, 2000, 2000]);
});

test('cancelling an active test executes its stop command despite the aborted signal', async () => {
  const controller = new AbortController();
  const r = rig({ signal: controller.signal, wait: async () => { controller.abort(); throw Object.assign(new Error('cancel'), { name: 'AbortError' }); } });
  const result = await runServiceTool('fuel-pump', r.options);
  assert.deepEqual(r.sent.map(item => item.request), ['2F502103FF', '2F502100']);
  assert.equal(r.sent.at(-1).cleanup, true);
  assert.equal(result.status, 'cancelled'); assert.equal(result.stopStatus, 'acknowledged');
});

test('a lost activation acknowledgement still attempts release, without retrying activation', async () => {
  const r = rig();
  r.options.command = async (request, options) => { r.sent.push({ request, ...options }); if (request.endsWith('03')) throw new Error('Response timed out'); return positive(request); };
  const result = await runServiceTool('wastegate', r.options);
  assert.deepEqual(r.sent.map(item => item.request), ['2F500A03', '2F500A00']);
  assert.equal(result.status, 'failed'); assert.equal(result.stopStatus, 'acknowledged');
  assert.match(result.message, /timed out/);
});

test('an unconfirmed return of control stops the workflow and requests disconnection', async () => {
  const r = rig();
  r.options.command = async (request, options) => { r.sent.push({ request, ...options }); if (options.cleanup) throw new Error('Cable disconnected'); return positive(request); };
  const result = await runServiceTool('wastegate', r.options);
  assert.equal(r.sent.length, 2); assert.equal(result.status, 'failed');
  assert.equal(result.stopStatus, 'unconfirmed'); assert.equal(result.requiresDisconnect, true);
  assert.match(result.message, /Switch the ignition off/);
});

test('oil change performs both resets and requires the key-off dwell', async () => {
  const r = rig(), result = await runServiceTool('oil-change', r.options);
  assert.deepEqual(r.sent.map(item => item.request), ['221302', '2F504001', '2F506001']);
  assert.deepEqual(r.delays, [2000, 2000]);
  assert.equal(result.status, 'completed'); assert.equal(result.requiresDisconnect, true);
  assert.equal(result.keyOffSeconds, 60); assert.match(result.message, /does not reset the instrument-panel/);
});

test('oil change tolerates an unsupported optional temperature read, never an unacknowledged reset', async () => {
  const r = rig();
  r.options.command = async request => { r.sent.push(request); return request === '221302' ? fromHex('7F2231') : positive(request); };
  const result = await runServiceTool('oil-change', r.options);
  assert.equal(result.status, 'completed'); assert.equal(result.notices.length, 1);
  const failed = rig();
  failed.options.command = async request => { failed.sent.push(request); return request === '2F504001' ? fromHex('7F2F22') : positive(request); };
  const rejected = await runServiceTool('oil-change', failed.options);
  assert.deepEqual(failed.sent, ['221302', '2F504001']);
  assert.equal(rejected.status, 'failed'); assert.equal(rejected.diagnosticCode, 0x22);
  assert.equal(rejected.requiresDisconnect, true); assert.equal(rejected.changesMayHaveOccurred, true);
});

test('oil check busy or pending prevents subsequent modifying commands', async () => {
  for (const code of ['21', '78']) {
    const r = rig(); r.options.command = async request => { r.sent.push(request); return fromHex(`7F22${code}`); };
    const result = await runServiceTool('oil-change', r.options);
    assert.deepEqual(r.sent, ['221302']); assert.equal(result.status, 'failed'); assert.equal(result.changesMayHaveOccurred, false);
  }
});

test('cancelled adjustment never uses its final modifying request as an abort command', async () => {
  const controller = new AbortController(), r = rig({ signal: controller.signal });
  r.options.wait = async () => { if (r.sent.at(-1).request === '2F504001') { controller.abort(); throw Object.assign(new Error('cancel'), { name: 'AbortError' }); } };
  const result = await runServiceTool('oil-change', r.options);
  assert.deepEqual(r.sent.map(item => item.request), ['221302', '2F504001']);
  assert.equal(result.status, 'cancelled'); assert.equal(result.requiresDisconnect, true);
  assert.equal(result.keyOffSeconds, 60); assert.equal(result.stopStatus, 'not-required');
  assert.match(result.message, /cannot be undone/);
});

test('throttle learning checks the actual learned-state DID and preserves an unfinished result', async () => {
  const r = rig(), result = await runServiceTool('throttle-learning', r.options);
  assert.deepEqual(r.sent.map(item => item.request), ['2F500301', '2F501003', '221860']);
  assert.equal(result.verification, 'learning-confirmed');
  const pending = rig(); pending.options.command = async request => request === '221860' ? fromHex('62186001') : positive(request);
  const incomplete = await runServiceTool('throttle-learning', pending.options);
  assert.equal(incomplete.verification, 'learning-unconfirmed');
  assert.equal(incomplete.physicalOutcomeVerified, false); assert.match(incomplete.message, /Check Throttle learning stage/);
});

test('pre-aborted operations issue no command and the default wait is abort-aware', async () => {
  const controller = new AbortController(); controller.abort();
  const r = rig({ signal: controller.signal });
  await assert.rejects(runServiceTool('fan-high', r.options), { name: 'AbortError' }); assert.deepEqual(r.sent, []);
  await assert.rejects(serviceWait(1, { signal: controller.signal }), { name: 'AbortError' });
  const current = new AbortController(), waiting = serviceWait(60000, { signal: current.signal }); current.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
});

test('a broken progress observer cannot prevent recovered actuator release', async () => {
  const r = rig({ onProgress: () => { throw new Error('UI destroyed'); } });
  const result = await runServiceTool('fan-high', r.options);
  assert.equal(result.status, 'completed'); assert.equal(r.sent.at(-1).request, '3101020B00');
});

test('cancellation after an acknowledged adjustment does not imply that the reset was prevented', async () => {
  const controller = new AbortController();
  const r = rig({ signal: controller.signal, wait: async () => { controller.abort(); throw Object.assign(new Error('stop waiting'), { name: 'AbortError' }); } });
  const result = await runServiceTool('timing-sensor-replacement', r.options);
  assert.equal(r.sent.length, 1); assert.equal(result.status, 'cancelled');
  assert.match(result.message, /already been acknowledged/);
  assert.equal(result.changesMayHaveOccurred, true); assert.equal(result.requiresDisconnect, true); assert.equal(result.keyOffSeconds, 60);
});

test('cancellation during post-learning verification cannot return a completed status', async () => {
  const controller = new AbortController(), r = rig({ signal: controller.signal });
  r.options.command = async request => { r.sent.push(request); if (request === '221860') controller.abort(); return positive(request); };
  const result = await runServiceTool('throttle-learning', r.options);
  assert.equal(result.status, 'cancelled'); assert.match(result.message, /already been acknowledged/);
  assert.equal(result.physicalOutcomeVerified, false);
});

test('failure after the first oil reset preserves partial acknowledgement and required aftercare', async () => {
  const r = rig();
  r.options.command = async request => { r.sent.push(request); if (request === '2F506001') throw new Error('The response was lost'); return positive(request); };
  const result = await runServiceTool('oil-change', r.options);
  assert.equal(result.status, 'failed'); assert.equal(result.steps.length, 2);
  assert.equal(result.steps.at(-1).request, '2F504001'); assert.equal(result.steps.at(-1).status, 'acknowledged');
  assert.equal(result.changesMayHaveOccurred, true); assert.equal(result.requiresDisconnect, true); assert.equal(result.keyOffSeconds, 60);
  assert.match(result.message, /outcome is unconfirmed/); assert.match(result.message, /No reset was retried/);
  assert.match(result.aftercare, /60 seconds/); assert.deepEqual(r.sent, ['221302', '2F504001', '2F506001']);
});

test('a rejected later reset reports earlier accepted changes without claiming a full reset', async () => {
  const r = rig();
  r.options.command = async request => request === '2F506001' ? fromHex('7F2F22') : positive(request);
  const result = await runServiceTool('oil-change', r.options);
  assert.equal(result.status, 'failed'); assert.match(result.message, /Earlier adjustment steps were acknowledged/);
  assert.equal(result.steps.length, 2); assert.equal(result.requiresDisconnect, true); assert.equal(result.physicalOutcomeVerified, false);
});
