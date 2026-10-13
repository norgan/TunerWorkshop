import { SERVICE_TOOLS } from './service-tools-data.mjs';
export { SERVICE_TOOLS, FIAT_SERVICE_TOOLS } from './service-tools-data.mjs';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const hex = value => [...value].map(byte => byte.toString(16).padStart(2, '0').toUpperCase()).join('');
const bytes = value => Uint8Array.from(value.match(/../g).map(byte => Number.parseInt(byte, 16)));
const abortError = () => Object.assign(new Error('Service operation cancelled.'), { name: 'AbortError' });
const checkAbort = signal => { if (signal?.aborted) throw abortError(); };

export function getServiceTool(id) {
  const tool = SERVICE_TOOLS.find(item => item.id === id);
  assert(tool, 'Choose a supported service operation.');
  return tool;
}

export function serviceToolRequests(id) {
  const tool = getServiceTool(id);
  return [...new Set([...tool.steps.map(step => step.request), tool.stopRequest, tool.verificationRequest].filter(Boolean))];
}

const knownRequests = new Set(SERVICE_TOOLS.flatMap(tool => serviceToolRequests(tool.id)));
const reasons = {
  0x10: 'The ECU rejected the request.', 0x11: 'This service is not supported by the ECU.',
  0x12: 'This operation is not supported in the selected ECU session.', 0x13: 'The ECU rejected the request format.',
  0x21: 'The ECU is busy.', 0x22: 'The ECU conditions for this operation are not met.',
  0x24: 'The ECU rejected the operation sequence.', 0x31: 'This operation is outside the ECU supported range.',
  0x33: 'The ECU requires security access that this workflow does not provide.',
  0x78: 'The ECU is still processing; a terminal response was not received.',
  0x81: 'Engine speed is too high.', 0x82: 'Engine speed is too low.',
  0x83: 'The ECU requires the engine to be stopped.', 0x84: 'The ECU requires the engine to be running.',
  0x85: 'Engine run time is insufficient.', 0x86: 'Temperature is too high.', 0x87: 'Temperature is too low.',
  0x88: 'Vehicle speed is too high.', 0x89: 'Vehicle speed is too low.',
  0x8a: 'Throttle or pedal position is too high.', 0x8b: 'Throttle or pedal position is too low.',
  0x8c: 'The transmission is in neutral.', 0x8d: 'The transmission is in gear.',
  0x8f: 'The brake-pedal condition is not met.', 0x90: 'The transmission is not in park.',
  0x91: 'The torque converter is locked.', 0x92: 'ECU voltage is too high.', 0x93: 'ECU voltage is too low.'
};

/** Validate an already source-attributed terminal UDS payload. No transport I/O. */
export function decodeServiceResponse(request, payload) {
  assert(knownRequests.has(request), 'The request is not part of a supported service workflow.');
  assert((payload instanceof Uint8Array || Array.isArray(payload)) && payload.length >= 3 && payload.length <= 64 && [...payload].every(value => Number.isInteger(value) && value >= 0 && value <= 255), 'The ECU response is missing or malformed.');
  const sent = bytes(request);
  if (payload[0] === 0x7f) {
    assert(payload.length === 3 && payload[1] === sent[0], 'The ECU negative response belongs to a different request.');
    return { status: 'negative', code: payload[2], message: reasons[payload[2]] || `The ECU rejected the operation (code ${hex([payload[2]])}).` };
  }
  // 0x2F echoes DID and InputOutputControlParameter; 0x31 echoes subfunction
  // and routine ID. Do not accept a truncated DID-only 0x6F acknowledgement.
  // Independent protocol cross-check: udsoncan InputOutputControlByIdentifier
  // and client.io_control control_param_echo validation (official project docs).
  const echoBytes = sent[0] === 0x22 ? 3 : 4;
  assert(payload.length >= echoBytes && payload[0] === sent[0] + 0x40 && sent.slice(1, echoBytes).every((value, index) => value === payload[index + 1]), 'The ECU acknowledgement does not match this operation.');
  if (sent[0] === 0x22) {
    const expectedLength = request === '221302' ? 5 : 4;
    assert(payload.length === expectedLength, 'The service-check parameter response has an unexpected length.');
  }
  return { status: 'positive', data: Uint8Array.from(payload.slice(echoBytes)) };
}

export function validateServiceContext(id, context, now = Date.now()) {
  const tool = getServiceTool(id);
  assert(tool.available, tool.unavailableReason);
  assert(context && context.profileId === 'fiat-8gmk' && context.status === 'connected' && context.ecu === '18DAF110', 'Connect to the Fiat IAW 8GMK engine profile before running this operation.');
  assert(context.acknowledged === true, 'Read and confirm the conditions for the selected operation.');
  assert(Number.isFinite(context.sampleAt) && now >= context.sampleAt && now - context.sampleAt <= 5000, 'Read fresh engine speed and vehicle speed before running this operation.');
  assert(Number.isFinite(context.engineRpm) && context.engineRpm === 0, 'Stop the engine before running this operation.');
  assert(Number.isFinite(context.vehicleSpeed) && context.vehicleSpeed === 0, 'The vehicle must be stationary before running this operation.');
  return tool;
}

export function serviceWait(milliseconds, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const onAbort = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run one fixed, user-confirmed operation. The owner must provide an exclusive
 * transport queue, current ECU attribution, and a bounded terminal-response
 * command callback. It must never expose command() as a renderer API.
 *
 * command(hex, {cleanup}) -> terminal Uint8Array; writes are never retried.
 * wait(ms,{signal}) may maintain tester-present without reissuing writes.
 * Cancellation cannot undo an adjustment. Actuators use their explicit final
 * return-control request, including when an earlier response was lost.
 */
export async function runServiceTool(id, { command, signal, wait = serviceWait, onProgress = () => {}, context, now = Date.now } = {}) {
  assert(typeof command === 'function' && typeof wait === 'function' && typeof onProgress === 'function' && typeof now === 'function', 'A service transport and timing callbacks are required.');
  checkAbort(signal);
  const tool = validateServiceContext(id, context, now()), steps = [], notices = [];
  let potentiallyActive = false, mutationAttempted = false, stopAttempted = false, stopStatus = 'not-required';
  const progress = (phase, message, extra = {}) => { try { onProgress({ toolId: id, phase, message, totalSteps: tool.steps.length, completedSteps: steps.length, ...extra }); } catch { /* Observers must not interrupt stop handling. */ } };
  const send = async (request, cleanup = false) => {
    const result = decodeServiceResponse(request, await command(request, { cleanup }));
    if (result.status === 'negative') throw Object.assign(new Error(result.message), { diagnosticCode: result.code });
    return result;
  };
  progress('starting', `Starting ${tool.label.toLowerCase()}.`);
  try {
    for (const [index, step] of tool.steps.entries()) {
      checkAbort(signal);
      const isStop = tool.stopRequest && index === tool.steps.length - 1;
      if (isStop) stopAttempted = true;
      if (!step.request.startsWith('22')) mutationAttempted = true;
      if (tool.stopRequest && !isStop) potentiallyActive = true;
      progress(isStop ? 'stopping' : 'running', isStop ? 'Returning control to the ECU.' : `Running step ${index + 1} of ${tool.steps.length}.`, { step: index + 1 });
      let result;
      if (step.optionalRead) {
        result = decodeServiceResponse(step.request, await command(step.request, { cleanup: false }));
        // MES marks oil change EXECANY. Preserve its optional read while
        // requiring every modifying request to have a positive response.
        if (result.status === 'negative') {
          if (![0x11, 0x12, 0x31].includes(result.code)) throw Object.assign(new Error(result.message), { diagnosticCode: result.code });
          notices.push(`Oil-temperature check: ${result.message}`);
        }
      } else result = await send(step.request, Boolean(isStop));
      steps.push({ step: index + 1, request: step.request, status: result.status === 'positive' ? 'acknowledged' : 'optional-check-unavailable' });
      if (isStop) { potentiallyActive = false; stopStatus = 'acknowledged'; }
      if (step.waitAfterMs) await wait(step.waitAfterMs, { signal });
    }
    checkAbort(signal);
    let verification = 'ecu-acknowledged', message = tool.completion;
    if (tool.verificationRequest) {
      // The recovered throttle workflow asks the user to inspect the learned
      // state. Read that same DID once; do not manufacture a completion code.
      const result = decodeServiceResponse(tool.verificationRequest, await command(tool.verificationRequest, { cleanup: false }));
      if (result.status === 'positive' && result.data[0] === 0x0c) {
        verification = 'learning-confirmed'; message = 'The ECU reports that throttle learning has completed.';
      } else {
        verification = 'learning-unconfirmed';
        message = 'The ECU accepted the throttle-learning requests. Check Throttle learning stage in live parameters until it reports Learned.';
        if (result.status === 'negative') notices.push(result.message);
      }
    }
    checkAbort(signal);
    progress('completed', message);
    return { toolId: id, status: 'completed', verification, message, steps, notices, stopStatus,
      requiresDisconnect: tool.requiresDisconnect, keyOffSeconds: tool.keyOffSeconds, aftercare: tool.aftercare || null, physicalOutcomeVerified: verification === 'learning-confirmed' };
  } catch (error) {
    let cleanupError = null;
    if (potentiallyActive && tool.stopRequest && !stopAttempted) {
      progress('stopping', 'Returning control to the ECU.');
      try { await send(tool.stopRequest, true); stopStatus = 'acknowledged'; }
      catch (stopError) { cleanupError = stopError.message; stopStatus = 'unconfirmed'; }
    } else if (potentiallyActive && tool.stopRequest) {
      cleanupError = error.message; stopStatus = 'unconfirmed';
    }
    const cancelled = error?.name === 'AbortError' || Boolean(signal?.aborted);
    const partialAdjustment = tool.category === 'adjustment' && mutationAttempted;
    const remainingWrites = tool.steps.slice(steps.length).some(step => !step.request.startsWith('22'));
    const cancelledAdjustment = remainingWrites
      ? 'Stopped before the remaining steps. Changes already accepted by the ECU cannot be undone.'
      : 'The adjustment requests had already been acknowledged when cancellation arrived. Their effects cannot be undone; check the resulting ECU state before repeating the operation.';
    const message = cancelled ? (partialAdjustment ? cancelledAdjustment : 'Test cancelled.') : error.message;
    const result = { toolId: id, status: cancelled ? 'cancelled' : 'failed', verification: 'unconfirmed', message, steps, notices, stopStatus, cleanupError,
      requiresDisconnect: (tool.requiresDisconnect && mutationAttempted) || stopStatus === 'unconfirmed', keyOffSeconds: mutationAttempted ? tool.keyOffSeconds : 0,
      aftercare: mutationAttempted ? tool.aftercare || null : null, physicalOutcomeVerified: false, changesMayHaveOccurred: mutationAttempted,
      diagnosticCode: error.diagnosticCode ?? null };
    if (!cancelled && partialAdjustment) {
      const acceptedWrites = steps.filter(step => !step.request.startsWith('22') && step.status === 'acknowledged').length;
      if (error.diagnosticCode === undefined || error.diagnosticCode === 0x78) {
        result.message += ' The adjustment outcome is unconfirmed and one or more requests may already have taken effect. No reset was retried; check the ECU state before repeating the operation.';
      } else if (acceptedWrites > 0) {
        result.message += ' Earlier adjustment steps were acknowledged and cannot be undone. Complete the required aftercare before checking the ECU state.';
      }
    }
    if (stopStatus === 'unconfirmed') result.message += ' Return of ECU control was not confirmed. Switch the ignition off before inspecting the component.';
    progress(result.status, result.message);
    return result;
  }
}
