import { getFiatModuleConnection, decodeFiatModuleIdentity, getFiatModuleIdentityFallback, decodeFiatModuleFallbackIdentity } from './fiat-modules.mjs';
import { MODULE_SERVICE_TOOLS, MODULE_SERVICE_PREFLIGHT, getModuleServiceTools } from './module-service-data.mjs';
export { MODULE_SERVICE_TOOLS, MODULE_SERVICE_PREFLIGHT, getModuleServiceTools } from './module-service-data.mjs';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const hex = data => Array.from(data, byte => byte.toString(16).toUpperCase().padStart(2, '0')).join('');
const bytes = value => Uint8Array.from(value.match(/../g), byte => Number.parseInt(byte, 16));
const abortError = () => Object.assign(new Error('Actuator test cancelled.'), { name: 'AbortError' });
const checkAbort = signal => { if (signal?.aborted) throw abortError(); };
const reasons = {
  0x11: 'The controller does not support this service.', 0x12: 'This operation is not supported in the current session.',
  0x13: 'The controller rejected the request format.', 0x21: 'The controller is busy.',
  0x22: 'The controller conditions for this operation are not met.', 0x24: 'The controller rejected the operation sequence.',
  0x31: 'The operation is outside the supported range.', 0x33: 'This controller requires security access that is not provided.',
  0x78: 'The controller was still processing the request; no terminal response was received.',
  0x81: 'Engine speed is too high.', 0x83: 'The engine must be stopped.', 0x88: 'Vehicle speed is too high.',
  0x92: 'Controller voltage is too high.', 0x93: 'Controller voltage is too low.',
};

export function getModuleServiceTool(id) {
  const tool = MODULE_SERVICE_TOOLS.find(item => item.id === id);
  assert(tool, 'Choose a known actuator test for the connected controller.');
  return tool;
}

export function modulePreflightRequests(profileId) {
  assert(Object.hasOwn(MODULE_SERVICE_PREFLIGHT, profileId), 'This controller has no verified preflight workflow.');
  return ['22F1A5', ...(profileId === 'fiat-gearbox-zf' ? ['22F100'] : []), ...MODULE_SERVICE_PREFLIGHT[profileId].map(item => item.request)];
}

export function moduleServiceRequests(id) {
  const tool = getModuleServiceTool(id);
  if (!tool.available) return [];
  return [...new Set([...modulePreflightRequests(tool.profileId), ...tool.steps.map(step => step.request), ...tool.releaseRequests])];
}

function terminal(request, payload, readLength) {
  assert((payload instanceof Uint8Array || Array.isArray(payload)) && payload.length >= 3 && payload.length <= (request.startsWith('22') ? 512 : 64)
    && Array.from(payload).every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255), 'The controller response is missing or malformed.');
  const sent = bytes(request);
  if (payload[0] === 0x7f) {
    assert(payload.length === 3 && payload[1] === sent[0], 'The controller negative response belongs to a different request.');
    return { status: 'negative', code: payload[2], message: reasons[payload[2]] || `The controller rejected the request (code ${hex([payload[2]])}).` };
  }
  const echoLength = sent[0] === 0x22 ? 3 : 4;
  assert(payload.length >= echoLength && payload[0] === sent[0] + 0x40
    && sent.slice(1, echoLength).every((byte, index) => payload[index + 1] === byte), 'The controller acknowledgement does not match this request.');
  if (sent[0] === 0x22) assert(Number.isInteger(readLength) ? payload.length === 3 + readLength
    : payload.length >= 3 + readLength?.minimum && payload.length <= 3 + readLength?.maximum, 'The controller returned an unexpected parameter length.');
  return { status: 'positive', data: Uint8Array.from(payload.slice(echoLength)) };
}

export function decodeModuleServiceResponse(id, request, payload) {
  const tool = getModuleServiceTool(id);
  assert(moduleServiceRequests(id).includes(request), 'The request is not part of this actuator workflow.');
  const length = request === '22F1A5' ? 5 : MODULE_SERVICE_PREFLIGHT[tool.profileId].find(item => item.request === request)?.bytes;
  return terminal(request, payload, length);
}

function requirePositive(result) {
  if (result.status === 'negative') throw Object.assign(new Error(result.message), { diagnosticCode: result.code });
  return result;
}

function validateContext(profileId, context) {
  assert(Object.hasOwn(MODULE_SERVICE_PREFLIGHT, profileId), 'This controller has no verified preflight workflow.');
  const connection = getFiatModuleConnection(profileId);
  assert(connection?.available, 'The selected controller identity or connection workflow is not established.');
  assert(context?.profileId === profileId && context.status === 'connected' && context.ecu === connection.responseId
    && typeof context.sessionId === 'string' && context.sessionId.length > 0, 'The vehicle connection changed. Connect and review the operation again.');
  assert(context.acknowledged === true, 'Read and confirm the conditions for this operation.');
  const guards = MODULE_SERVICE_PREFLIGHT[profileId];
  if (!guards.some(item => item.key === 'engineRpm')) assert(context.engineStoppedConfirmed === true, 'Confirm that the engine is switched off. This controller cannot measure engine speed for this check.');
  if (!guards.some(item => item.key === 'vehicleSpeed')) assert(context.stationaryConfirmed === true, 'Confirm that the vehicle is stationary and secured. This controller cannot measure vehicle speed for this check.');
  return connection;
}

export function validateModuleServiceContext(id, context) {
  const tool = getModuleServiceTool(id);
  assert(tool.available, tool.unavailableReason);
  validateContext(tool.profileId, context);
  return tool;
}

/**
 * Shared actuator/fault-clear preflight, using only recovered read requests.
 * The owner attributes responses to the selected ECU, binds the session, and
 * serializes the whole operation against polling and other diagnostic work.
 * Identity and every measurable guard are read here; cached values are unused.
 */
export async function runModulePreflight(profileId, { command, context, signal } = {}) {
  assert(typeof command === 'function', 'A connected diagnostic command sender is required.');
  validateContext(profileId, context);
  checkAbort(signal);
  const read = async (request, length) => {
    checkAbort(signal);
    const result = requirePositive(terminal(request, await command(request, { cleanup: false }), length));
    checkAbort(signal);
    return result.data;
  };
  // The ZF controller has one recovered variant-identifier fallback. Only an
  // exact unsupported-DID response or documented blank ISO record selects it;
  // a real but mismatched identity cannot fall back into this profile.
  const primaryPayload = await command('22F1A5', { cleanup: false });
  checkAbort(signal);
  const fallback = getFiatModuleIdentityFallback(profileId, primaryPayload);
  const identity = fallback
    ? decodeFiatModuleFallbackIdentity(profileId, await read(fallback.request, { minimum: fallback.minimumBytes, maximum: 509 }))
    : decodeFiatModuleIdentity(profileId, requirePositive(terminal('22F1A5', primaryPayload, 5)).data);
  const conditions = {
    engineStopped: { satisfied: true, evidence: 'user-confirmed' },
    stationary: { satisfied: true, evidence: 'user-confirmed' },
  };
  for (const guard of MODULE_SERVICE_PREFLIGHT[profileId]) {
    const data = await read(guard.request, guard.bytes);
    assert(Array.from(data).every(byte => byte === 0), guard.key === 'engineRpm'
      ? 'Stop the engine before running this operation.' : 'The vehicle must be stationary before running this operation.');
    conditions[guard.key === 'engineRpm' ? 'engineStopped' : 'stationary'] = {
      satisfied: true, evidence: 'measured', request: guard.request, rawHex: hex(data),
    };
  }
  checkAbort(signal);
  return { identity, conditions, sessionId: context.sessionId, capturedAt: new Date().toISOString() };
}

export function moduleServiceWait(milliseconds, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const onAbort = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Execute one fixed test. No arbitrary command or user-supplied sequence exists.
 * command(request,{cleanup}) returns a terminal UDS payload. The owner's cleanup
 * sender must survive cancellation and remain bound to the original session.
 * wait(ms,{signal}) should maintain tester-present without repeating writes.
 * A lost activation reply still schedules its known release request. Every DID
 * is released once, including paired lights, and a lost release is not retried.
 */
export async function runModuleServiceTool(id, { command, context, signal, wait = moduleServiceWait, onProgress = () => {} } = {}) {
  assert(typeof command === 'function' && typeof wait === 'function' && typeof onProgress === 'function', 'A command sender and timing callbacks are required.');
  const tool = validateModuleServiceContext(id, context);
  checkAbort(signal);
  const releases = new Map(tool.releaseRequests.map(request => [request.slice(2, 6), request]));
  const active = new Map(), steps = [], cleanup = [];
  let preflight = null, mutationAttempted = false;
  const progress = (phase, message, extra = {}) => {
    try { onProgress({ toolId: id, phase, message, totalSteps: tool.steps.length, completedSteps: steps.length, ...extra }); }
    catch { /* An observer must not interrupt return of control. */ }
  };
  const send = async (request, isCleanup) => requirePositive(decodeModuleServiceResponse(id, request, await command(request, { cleanup: isCleanup })));
  try {
    progress('checking', 'Checking the controller and operation conditions.');
    preflight = await runModulePreflight(tool.profileId, { command, context, signal });
    for (const [index, step] of tool.steps.entries()) {
      checkAbort(signal);
      const did = step.request.slice(2, 6), isRelease = step.request === releases.get(did);
      if (!isRelease) {
        assert(releases.has(did), 'This output has no established return-control request.');
        active.set(did, { request: releases.get(did), attempted: false });
      } else if (active.has(did)) active.get(did).attempted = true;
      mutationAttempted = true;
      progress(isRelease ? 'stopping' : 'running', isRelease ? 'Returning the output to controller control.' : `Running step ${index + 1} of ${tool.steps.length}.`, { step: index + 1 });
      await send(step.request, isRelease);
      steps.push({ step: index + 1, request: step.request, status: 'acknowledged' });
      if (isRelease) active.delete(did);
      if (step.waitAfterMs) await wait(step.waitAfterMs, { signal });
    }
    checkAbort(signal);
    assert(active.size === 0, 'Return of controller control is incomplete.');
    progress('completed', tool.completion);
    return { toolId: id, status: 'completed', verification: 'ecu-acknowledged', message: tool.completion,
      preflight, steps, cleanup, stopStatus: 'acknowledged', requiresDisconnect: false, physicalOutcomeVerified: false };
  } catch (error) {
    // A rejected or lost release for one output must not skip the other output.
    // Never repeat the same release after an unconfirmed acknowledgement.
    for (const [did, state] of active) {
      if (state.attempted) { cleanup.push({ request: state.request, status: 'unconfirmed', message: error.message }); continue; }
      state.attempted = true;
      progress('stopping', 'Returning active outputs to controller control.');
      try {
        await send(state.request, true);
        cleanup.push({ request: state.request, status: 'acknowledged' }); active.delete(did);
      } catch (releaseError) { cleanup.push({ request: state.request, status: 'unconfirmed', message: releaseError.message }); }
    }
    const cancelled = error?.name === 'AbortError' || Boolean(signal?.aborted);
    const stopStatus = active.size ? 'unconfirmed' : mutationAttempted ? 'acknowledged' : 'not-required';
    let message = cancelled ? 'Actuator test cancelled.' : error.message;
    if (cancelled && mutationAttempted && ['fiat-body-boot-release', 'fiat-body-door-lock', 'fiat-body-door-unlock'].includes(id)) message += ' Returning control does not reverse a lock or latch action that already took effect.';
    if (active.size) message += ' Return of controller control was not confirmed. Switch the ignition off before inspecting the component.';
    else if (mutationAttempted && !cancelled) message += ' The test was not completed; return of control was acknowledged.';
    progress(cancelled ? 'cancelled' : 'failed', message);
    return { toolId: id, status: cancelled ? 'cancelled' : 'failed', verification: 'unconfirmed', message,
      preflight, steps, cleanup, stopStatus, requiresDisconnect: active.size > 0, physicalOutcomeVerified: false,
      changesMayHaveOccurred: mutationAttempted, diagnosticCode: error.diagnosticCode ?? null };
  }
}
