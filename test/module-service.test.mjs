import test from 'node:test';
import assert from 'node:assert/strict';
import { getFiatModuleConnection } from '../fiat-modules.mjs';
import {
  MODULE_SERVICE_TOOLS, MODULE_SERVICE_PREFLIGHT, getModuleServiceTools, getModuleServiceTool,
  moduleServiceRequests, modulePreflightRequests, decodeModuleServiceResponse,
  validateModuleServiceContext, runModulePreflight, runModuleServiceTool, moduleServiceWait,
} from '../module-service.mjs';

const data = value => Uint8Array.from(value.match(/../g), byte => Number.parseInt(byte, 16));
const contextFor = profileId => ({
  profileId, status: 'connected', ecu: getFiatModuleConnection(profileId).responseId,
  sessionId: 'synthetic-session', acknowledged: true, engineStoppedConfirmed: true, stationaryConfirmed: true,
});
function fixture(profileId, override = () => undefined) {
  const calls = [], waits = [];
  const command = async (request, options) => {
    calls.push({ request, ...options });
    const changed = await override(request, options, calls);
    if (changed !== undefined) return changed;
    if (request === '22F1A5') return data(`62F1A5${getFiatModuleConnection(profileId).isoCodes[0]}`);
    if (request.startsWith('22')) {
      const guard = MODULE_SERVICE_PREFLIGHT[profileId].find(item => item.request === request);
      assert.ok(guard, `Unexpected read ${request}`);
      return data(`62${request.slice(2)}${'00'.repeat(guard.bytes)}`);
    }
    assert.ok(request.startsWith('2F'), 'Only known I/O controls can be sent by these tests');
    return data(`6F${request.slice(2, 8)}`);
  };
  return { calls, waits, command, context: contextFor(profileId), wait: async ms => { waits.push(ms); } };
}

test('catalogue exposes all non-engine actuator rows, with specific unavailable mechanical workflows', () => {
  assert.equal(MODULE_SERVICE_TOOLS.length, 106);
  assert.equal(MODULE_SERVICE_TOOLS.filter(tool => tool.available).length, 83);
  assert.equal(getModuleServiceTools('fiat-body').length, 28);
  assert.equal(getModuleServiceTools('fiat-instrument').length, 21);
  assert.equal(getModuleServiceTools('fiat-climate-auto').length, 11);
  assert.equal(getModuleServiceTools('fiat-climate-manual').length, 8);
  assert.equal(new Set(MODULE_SERVICE_TOOLS.map(tool => tool.id)).size, MODULE_SERVICE_TOOLS.length);
  for (const tool of MODULE_SERVICE_TOOLS) {
    assert.match(tool.id, /^[a-z0-9-]{1,80}$/);
    assert.ok(Object.isFrozen(tool));
    if (tool.available) assert.ok(tool.releaseRequests.length);
    else {
      assert.ok(tool.unavailableReason.length > 30);
      assert.deepEqual(moduleServiceRequests(tool.id), []);
    }
  }
});

test('every available workflow completes with a synthetic ECU and releases all output identifiers', async () => {
  for (const tool of MODULE_SERVICE_TOOLS.filter(item => item.available)) {
    const transport = fixture(tool.profileId);
    const result = await runModuleServiceTool(tool.id, transport);
    assert.equal(result.status, 'completed', tool.id);
    assert.equal(result.stopStatus, 'acknowledged', tool.id);
    assert.equal(result.physicalOutcomeVerified, false);
    assert.equal(transport.waits.reduce((sum, value) => sum + value, 0), tool.durationMs, tool.id);
    assert.ok(transport.calls.every(call => moduleServiceRequests(tool.id).includes(call.request)));
  }
});

test('paired body lamps use exact requests, both releases and two-second sequence timing', async () => {
  const transport = fixture('fiat-body');
  const result = await runModuleServiceTool('fiat-body-low-beam', transport);
  assert.deepEqual(transport.calls.map(call => call.request), [
    '22F1A5', '221002', '2F511003FF', '2F521003FF', '2F51100300', '2F52100300', '2F511000', '2F521000',
  ]);
  assert.deepEqual(transport.waits, [2000, 2000, 2000, 2000, 2000]);
  assert.equal(result.preflight.conditions.engineStopped.evidence, 'user-confirmed');
  assert.equal(result.preflight.conditions.stationary.evidence, 'measured');
});

test('climate distributor retains the established 200-second workflow', async () => {
  const transport = fixture('fiat-climate-auto');
  await runModuleServiceTool('fiat-climate-auto-air-distributor', transport);
  assert.deepEqual(transport.calls.map(call => call.request), [
    '22F1A5', '221000', '221002', '2F56C003FF', '2F56C00300', '2F56C0037F', '2F56C00300', '2F56C000',
  ]);
  assert.deepEqual(transport.waits, [50000, 50000, 50000, 50000]);
});

test('cluster self-test is bound to the two established identities and explicitly returns control after ten seconds', async () => {
  assert.deepEqual(getFiatModuleConnection('fiat-instrument').isoCodes, ['0003502D16', '3283760D0D']);
  for (const iso of ['0003502D16', '3283760D0D']) {
    const transport = fixture('fiat-instrument', request => request === '22F1A5' ? data(`62F1A5${iso}`) : undefined);
    const result = await runModuleServiceTool('fiat-instrument-self-test', transport);
    assert.equal(result.status, 'completed');
    assert.equal(result.stopStatus, 'acknowledged');
    assert.equal(result.physicalOutcomeVerified, false);
    assert.deepEqual(transport.calls.map(call => call.request), [
      '22F1A5', '221000', '221002', '2F557B03FF', '2F557B00',
    ]);
    assert.deepEqual(transport.waits, [10000]);
  }
  // Another instrument variant in the reference remains outside this profile.
  const otherVariant = fixture('fiat-instrument', request => request === '22F1A5' ? data('62F1A50003502D15') : undefined);
  const rejected = await runModuleServiceTool('fiat-instrument-self-test', otherVariant);
  assert.equal(rejected.status, 'failed');
  assert.deepEqual(otherVariant.calls.map(call => call.request), ['22F1A5']);
  assert.equal(moduleServiceRequests('fiat-instrument-self-test').includes('2F557B0300'), false);
});

test('cluster self-test cancellation releases the output and a lost release is never reported as completed', async () => {
  const controller = new AbortController();
  const transport = fixture('fiat-instrument');
  transport.wait = async () => { controller.abort(); };
  const cancelled = await runModuleServiceTool('fiat-instrument-self-test', { ...transport, signal: controller.signal });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.stopStatus, 'acknowledged');
  assert.deepEqual(transport.calls.slice(3).map(call => call.request), ['2F557B03FF', '2F557B00']);
  assert.equal(transport.calls.at(-1).cleanup, true);

  const interrupted = fixture('fiat-instrument', request => {
    if (request === '2F557B00') throw new Error('Return-control acknowledgement lost');
  });
  const unconfirmed = await runModuleServiceTool('fiat-instrument-self-test', interrupted);
  assert.equal(unconfirmed.status, 'failed');
  assert.equal(unconfirmed.stopStatus, 'unconfirmed');
  assert.equal(unconfirmed.requiresDisconnect, true);
  assert.equal(interrupted.calls.filter(call => call.request === '2F557B00').length, 1);
});

test('boot, lock and horn tests retain distinct pulse timing', async () => {
  for (const [id, waits] of [['boot-release', [1000]], ['door-lock', [500]], ['door-unlock', [500]], ['horn', [500, 500]]]) {
    const transport = fixture('fiat-body');
    await runModuleServiceTool(`fiat-body-${id}`, transport);
    assert.deepEqual(transport.waits, waits);
  }
});

test('cross-profile, wrong address, lost confirmation and unavailable procedures cannot send commands', async () => {
  for (const patch of [{ profileId: 'fiat-climate-auto' }, { ecu: '18DAF160' }, { sessionId: '' }, { status: 'stopped' }, { acknowledged: false }, { engineStoppedConfirmed: false }]) {
    const transport = fixture('fiat-body');
    transport.context = { ...transport.context, ...patch };
    await assert.rejects(runModuleServiceTool('fiat-body-low-beam', transport));
    assert.equal(transport.calls.length, 0);
  }
  const unsupported = fixture('fiat-gearbox-ddct');
  await assert.rejects(runModuleServiceTool('fiat-gearbox-ddct-pump', unsupported), /hydraulic setup/);
  assert.equal(unsupported.calls.length, 0);
  assert.throws(() => validateModuleServiceContext('arbitrary-command', contextFor('fiat-body')));
  assert.throws(() => modulePreflightRequests('fiat-proxi'));
});

test('fresh identity and exact raw-zero guards block writes on mismatched, missing or nonzero readings', async () => {
  for (const [request, reply] of [
    ['22F1A5', data('62F1A50000000000')], ['22F1A5', data('62F1A50000603A')],
    ['221000', data('6210000001')], ['221002', data('62100201')],
    ['221002', data('6210020000')], ['221000', data('7F2231')],
  ]) {
    const transport = fixture('fiat-instrument', sent => sent === request ? reply : undefined);
    const result = await runModuleServiceTool('fiat-instrument-engine-warning', transport);
    assert.equal(result.status, 'failed');
    assert.equal(result.changesMayHaveOccurred, false);
    assert.equal(result.stopStatus, 'not-required');
    assert.ok(transport.calls.every(call => call.request.startsWith('22')));
  }
});

test('preflight distinguishes confirmations from measurements and uses gearbox-specific DIDs', async () => {
  const comfort = fixture('fiat-comfort');
  const result = await runModulePreflight('fiat-comfort', comfort);
  assert.deepEqual(comfort.calls.map(call => call.request), ['22F1A5']);
  assert.equal(result.conditions.engineStopped.evidence, 'user-confirmed');
  assert.equal(result.conditions.stationary.evidence, 'user-confirmed');
  await assert.rejects(runModulePreflight('fiat-comfort', { ...comfort, context: { ...comfort.context, stationaryConfirmed: false } }), /Confirm that the vehicle/);
  const gearbox = fixture('fiat-gearbox-ddct');
  const measured = await runModulePreflight('fiat-gearbox-ddct', gearbox);
  assert.deepEqual(gearbox.calls.map(call => call.request), ['22F1A5', '221C11', '221C14']);
  assert.equal(measured.conditions.engineStopped.rawHex, '0000');
  assert.equal(measured.conditions.stationary.evidence, 'measured');
});

test('ZF preflight uses only the recovered identity fallback and checks stopped conditions afterwards', async () => {
  for (const primary of ['7F2231', '62F1A50000000000', '62F1A52020202020', '62F1A5FFFFFFFFFF']) {
    const transport = fixture('fiat-gearbox-zf', request => request === '22F1A5' ? data(primary) : request === '22F100' ? data('62F100996202') : undefined);
    const result = await runModulePreflight('fiat-gearbox-zf', transport);
    assert.equal(result.identity.ecuIsoCode, 'TCM6202');
    assert.deepEqual(transport.calls.map(call => call.request), ['22F1A5', '22F100', '22F40C', '22F40D']);
    assert.equal(result.conditions.engineStopped.evidence, 'measured');
  }
  assert.ok(modulePreflightRequests('fiat-gearbox-zf').includes('22F100'));
  for (const profileId of Object.keys(MODULE_SERVICE_PREFLIGHT).filter(id => id !== 'fiat-gearbox-zf')) assert.equal(modulePreflightRequests(profileId).includes('22F100'), false);
  for (const primary of ['7F2278', '7F2233', '62F1A50000603A15', '62F1A500000000', '7F2331']) {
    const transport = fixture('fiat-gearbox-zf', request => request === '22F1A5' ? data(primary) : undefined);
    await assert.rejects(runModulePreflight('fiat-gearbox-zf', transport));
    assert.deepEqual(transport.calls.map(call => call.request), ['22F1A5']);
  }
  for (const variant of ['62F100006203', '62F1000062', '7F2231', '62F101006202']) {
    const transport = fixture('fiat-gearbox-zf', request => request === '22F1A5' ? data('7F2231') : request === '22F100' ? data(variant) : undefined);
    await assert.rejects(runModulePreflight('fiat-gearbox-zf', transport));
    assert.deepEqual(transport.calls.map(call => call.request), ['22F1A5', '22F100']);
  }
});

test('responses require matching service, DID and control echo and exact guard lengths', () => {
  const id = 'fiat-body-low-beam';
  for (const reply of ['6F5110', '6F511000', '6F521003', '62511003', '7F2231', '7F2F3100']) {
    assert.throws(() => decodeModuleServiceResponse(id, '2F511003FF', data(reply)));
  }
  assert.equal(decodeModuleServiceResponse(id, '2F511003FF', data('6F511003FF')).status, 'positive');
  assert.equal(decodeModuleServiceResponse(id, '2F511003FF', data('7F2F78')).status, 'negative');
  assert.throws(() => decodeModuleServiceResponse(id, '2F500303FF', data('6F500303')));
  assert.throws(() => decodeModuleServiceResponse(id, '221002', [0x62, 0x10, 0x02, -1]));
});

test('cancelling after two activations releases both body lamp DIDs despite the aborted signal', async () => {
  const abort = new AbortController();
  const transport = fixture('fiat-body');
  let waits = 0;
  transport.wait = async () => { if (++waits === 2) { abort.abort(); throw Object.assign(new Error('cancel'), { name: 'AbortError' }); } };
  const result = await runModuleServiceTool('fiat-body-low-beam', { ...transport, signal: abort.signal });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.stopStatus, 'acknowledged');
  assert.deepEqual(transport.calls.slice(2).map(call => call.request), ['2F511003FF', '2F521003FF', '2F511000', '2F521000']);
  assert.ok(transport.calls.slice(-2).every(call => call.cleanup));
});

test('lost activation response still releases the potentially active output without retrying activation', async () => {
  const transport = fixture('fiat-body', request => { if (request === '2F511003FF') throw new Error('Response lost'); });
  const result = await runModuleServiceTool('fiat-body-low-beam', transport);
  assert.equal(result.status, 'failed');
  assert.equal(result.changesMayHaveOccurred, true);
  assert.equal(result.stopStatus, 'acknowledged');
  assert.deepEqual(transport.calls.slice(2).map(call => call.request), ['2F511003FF', '2F511000']);
});

test('lost first release is not retried and cannot prevent the second release', async () => {
  const transport = fixture('fiat-body', request => { if (request === '2F511000') throw new Error('Stop acknowledgement lost'); });
  const result = await runModuleServiceTool('fiat-body-low-beam', transport);
  assert.equal(result.status, 'failed');
  assert.equal(result.stopStatus, 'unconfirmed');
  assert.equal(result.requiresDisconnect, true);
  assert.equal(transport.calls.filter(call => call.request === '2F511000').length, 1);
  assert.equal(transport.calls.filter(call => call.request === '2F521000').length, 1);
  assert.match(result.message, /Switch the ignition off/);
});

test('cancellation before a second RF output activates does not release untouched outputs', async () => {
  const abort = new AbortController();
  const transport = fixture('fiat-rfhub');
  let waits = 0;
  transport.wait = async () => { if (++waits === 2) abort.abort(); };
  const result = await runModuleServiceTool('fiat-rfhub-tyre-warning', { ...transport, signal: abort.signal });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.stopStatus, 'acknowledged');
  assert.deepEqual(transport.calls.slice(2).map(call => call.request), ['2F5C6F03FF', '2F5C6F00']);
});

test('pending activation or stop replies cannot report success', async () => {
  for (const request of ['2F502803FF', '2F502800']) {
    const transport = fixture('fiat-body', sent => sent === request ? data('7F2F78') : undefined);
    const result = await runModuleServiceTool('fiat-body-horn', transport);
    assert.equal(result.status, 'failed');
    assert.equal(result.diagnosticCode, 0x78);
    assert.equal(transport.calls.filter(call => call.request === request).length, 1);
    assert.equal(result.stopStatus, request === '2F502800' ? 'unconfirmed' : 'acknowledged');
  }
});

test('late cancellation and observer errors cannot skip cleanup or falsely report completion', async () => {
  const abort = new AbortController();
  const transport = fixture('fiat-body', request => { if (request === '2F502800') abort.abort(); });
  const result = await runModuleServiceTool('fiat-body-horn', {
    ...transport, signal: abort.signal, onProgress: () => { throw new Error('observer'); },
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.stopStatus, 'acknowledged');
  assert.equal(transport.calls.filter(call => call.request === '2F502800').length, 1);
});

test('an aborted operation performs no reads or writes, and waits are abortable', async () => {
  const controller = new AbortController(); controller.abort();
  const transport = fixture('fiat-body');
  await assert.rejects(runModuleServiceTool('fiat-body-horn', { ...transport, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(transport.calls.length, 0);
  await assert.rejects(moduleServiceWait(1000, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(getModuleServiceTool('fiat-body-horn').durationMs, 1000);
});
