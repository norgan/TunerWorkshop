// Pure, bounded decoders for the Fiat 500X IAW8GMK6 engine protocol.
// Input is an attributed, assembled UDS payload, with no CAN/ISO-TP length byte.
// This module performs no adapter I/O. A request being listed is not permission
// to execute it; the session owns vehicle selection and clear-fault confirmation.
import { FIAT_IDENTIFICATION_ROWS, FIAT_SNAPSHOT_ROWS, FIAT_DTC_LABEL_ROWS, FIAT_FAILURE_TYPE_ROWS } from './fiat-diagnostics-data.mjs';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const hex = values => [...values].map(value => value.toString(16).toUpperCase().padStart(2, '0')).join('');
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const numericFormat = /^(num|nums)(?:,(\d+))?(?:,(-?\d+(?:\.\d+)?))?(?:,(-?\d+(?:\.\d+)?))?$/;
const faultLabels = new Map(FIAT_DTC_LABEL_ROWS);
const failureTypes = new Map(FIAT_FAILURE_TYPE_ROWS);

export const FIAT_DIAGNOSTIC_REQUESTS = freeze({ readDtc: '19020D', clearDtc: '14FFFFFF' });
export const FIAT_DIAGNOSTIC_PROFILE = freeze({ id: 'fiat-8gmk', ecu: 'IAW8GMK6', responseId: '18DAF110', requestId: '18DA10F1', evidence: 'static-interoperability', vehicleValidated: false });
export const FIAT_IDENTIFICATION_DEFINITIONS = freeze(FIAT_IDENTIFICATION_ROWS.map(([key, label, request, bytes, format, unit]) => ({ key, label, request, did: Number.parseInt(request.slice(2), 16), bytes, format, unit })));
export const FIAT_SNAPSHOT_DEFINITIONS = freeze(FIAT_SNAPSHOT_ROWS.map(([key, did, label, bytes, format, unit, rules, hidden]) => ({ key, did, label, bytes, format, unit, rules, hidden })));
const identificationRequests = new Set(FIAT_IDENTIFICATION_DEFINITIONS.map(definition => definition.request));
const snapshotDefinitions = new Map();
for (const definition of FIAT_SNAPSHOT_DEFINITIONS) {
  const rows = snapshotDefinitions.get(definition.did) ?? [];
  assert(rows.length === 0 || rows[0].bytes === definition.bytes, 'Conflicting static snapshot identifier lengths.');
  rows.push(definition); snapshotDefinitions.set(definition.did, rows);
}

/** Only admitted engine reads, explicit clear-all, and record-00 snapshots. */
export function isFiatDiagnosticRequest(request) {
  return typeof request === 'string' && (request === FIAT_DIAGNOSTIC_REQUESTS.readDtc || request === FIAT_DIAGNOSTIC_REQUESTS.clearDtc || identificationRequests.has(request) || /^1904[0-9A-F]{6}00$/.test(request));
}

function dtcId(value) {
  assert(typeof value === 'string' && /^[0-9A-F]{6}$/.test(value), 'Expected the selected fault\'s six-character hexadecimal identifier.');
  return value;
}

export function buildFiatSnapshotRequest(id) { return '1904' + dtcId(id) + '00'; }

function validatedPayload(payload) {
  assert(payload instanceof Uint8Array || Array.isArray(payload), 'Expected diagnostic response bytes.');
  assert(payload.length >= 1 && payload.length <= 4095 && [...payload].every(value => Number.isInteger(value) && value >= 0 && value <= 255), 'Invalid or empty diagnostic response bytes.');
  return Uint8Array.from(payload);
}

const negativeMessages = new Map([
  [0x10, 'The ECU rejected the request.'], [0x11, 'The ECU does not support this service.'],
  [0x12, 'The ECU does not support this operation.'], [0x13, 'The ECU rejected the request length or format.'],
  [0x21, 'The ECU is busy.'], [0x22, 'The ECU conditions do not allow this operation.'],
  [0x24, 'The ECU requires a different request sequence.'], [0x31, 'The requested data is not available.'],
  [0x33, 'The ECU requires authorised security access.'], [0x72, 'The ECU reported a programming failure.'],
  [0x78, 'The ECU is still processing the request.'], [0x7E, 'This operation is unavailable in the current diagnostic session.'],
  [0x7F, 'This service is unavailable in the current diagnostic session.'],
  [0x81, 'Engine speed is too high.'], [0x82, 'Engine speed is too low.'], [0x83, 'The engine is running.'],
  [0x84, 'The engine is not running.'], [0x85, 'The engine has not run long enough.'],
  [0x86, 'Temperature is too high.'], [0x87, 'Temperature is too low.'],
  [0x88, 'Vehicle speed is too high.'], [0x89, 'Vehicle speed is too low.'],
  [0x92, 'Supply voltage is too high.'], [0x93, 'Supply voltage is too low.'],
]);

function negativeResponse(payload, service) {
  if (payload[0] !== 0x7F) return null;
  assert(payload.length === 3 && payload[1] === service, 'Negative response belongs to a different request or is malformed.');
  const code = payload[2];
  return { status: 'negative', code, pending: code === 0x78, retryable: code === 0x21,
    message: negativeMessages.get(code) ?? `The ECU rejected the request (code 0x${hex([code])}).` };
}

/** Keep raw status bits; do not confuse a pending fault with NRC response-pending. */
export function decodeFiatDtcStatus(statusByte) {
  assert(Number.isInteger(statusByte) && statusByte >= 0 && statusByte <= 255, 'Invalid diagnostic fault status.');
  const active = Boolean(statusByte & 1), stored = Boolean(statusByte & 8), pending = Boolean(statusByte & 4);
  return { statusByte, active, stored, pending, confirmed: stored, intermittent: (statusByte & 9) === 8,
    failedThisOperationCycle: Boolean(statusByte & 2), testNotCompletedSinceClear: Boolean(statusByte & 0x10),
    failedSinceClear: Boolean(statusByte & 0x20), testNotCompletedThisOperationCycle: Boolean(statusByte & 0x40),
    warningIndicatorRequested: Boolean(statusByte & 0x80), statusLabel: active ? 'Present' : stored ? 'Stored / intermittent' : pending ? 'Pending' : 'Reported' };
}

function describeDtc(id, statusByte) {
  const first = Number.parseInt(id.slice(0, 2), 16), failureType = Number.parseInt(id.slice(4), 16);
  const baseCode = 'PCBU'[first >> 6] + hex([first & 0x3F, Number.parseInt(id.slice(2, 4), 16)]);
  return { id, code: baseCode + '-' + id.slice(4), baseCode,
    description: faultLabels.get(id.slice(0, 4)) ?? 'Unknown engine fault', descriptionKnown: faultLabels.has(id.slice(0, 4)),
    failureType, failureTypeDescription: failureType === 0 ? 'No additional failure type' : failureTypes.get(failureType) ?? `Failure type 0x${id.slice(4)}`,
    ...decodeFiatDtcStatus(statusByte) };
}

/** Response to 19 02 0D: service, subfunction, availability mask, 4-byte entries. */
export function decodeFiatDtcResponse(input) {
  const payload = validatedPayload(input), negative = negativeResponse(payload, 0x19);
  if (negative) return negative;
  assert(payload.length >= 3 && payload[0] === 0x59 && payload[1] === 0x02, 'Response does not belong to the engine fault-list request.');
  assert((payload.length - 3) % 4 === 0, 'Engine fault list contains a truncated entry.');
  const dtcs = [], seen = new Set();
  for (let offset = 3; offset < payload.length; offset += 4) {
    const id = hex(payload.slice(offset, offset + 3));
    assert(!seen.has(id), 'Engine fault list contains a duplicate fault identifier.');
    seen.add(id); dtcs.push(describeDtc(id, payload[offset + 3]));
  }
  return { status: 'positive', availabilityMask: payload[2], dtcs };
}

/** A clear acknowledgement is not proof that faults stayed cleared; re-read. */
export function decodeFiatClearResponse(input) {
  const payload = validatedPayload(input), negative = negativeResponse(payload, 0x14);
  if (negative) return negative;
  assert(payload.length === 1 && payload[0] === 0x54, 'Response does not acknowledge the clear-fault request.');
  return { status: 'positive', acknowledged: true };
}

function decodeValue(definition, data) {
  assert(data.length === definition.bytes, 'Diagnostic value has an unexpected length.');
  const numeric = numericFormat.exec(definition.format);
  if (numeric) {
    let raw = [...data].reduce((value, byte) => value * 256 + byte, 0);
    if (numeric[1] === 'nums' && raw >= 2 ** (data.length * 8 - 1)) raw -= 2 ** (data.length * 8);
    const digits = +(numeric[2] ?? 0), value = (raw * +(numeric[3] ?? 1) + +(numeric[4] ?? 0)) / 10 ** digits;
    assert(Number.isFinite(value), 'Diagnostic value is not finite.');
    return { value: Number(value.toFixed(digits)), digits };
  }
  if (definition.format === 'hex' || definition.format === 'hex2') return { value: definition.format === 'hex' ? [...data].map(byte => hex([byte])).join(' ') : hex(data), digits: 0 };
  if (definition.format === 'str') {
    assert([...data].every(byte => byte === 0 || byte >= 0x20 && byte <= 0x7E), 'ECU identification contains invalid text bytes.');
    const value = String.fromCharCode(...data).replace(/[ \0]+$/, '');
    assert(!value.includes('\0'), 'ECU identification contains embedded null bytes.');
    return { value, digits: 0 };
  }
  assert(definition.format === 'bits' || definition.format === 'bitw', 'Unsupported static diagnostic value format.');
  const width = definition.format === 'bitw' ? 4 : 2, raw = [...data].reduce((value, byte) => value * 256 + byte, 0);
  const rules = definition.rules.split('|').map(rule => ({ mask: Number.parseInt(rule.slice(0, width), 16), expected: Number.parseInt(rule.slice(width, width * 2), 16), label: rule.slice(width * 2) }));
  const match = rules.find(rule => (raw & rule.mask) === rule.expected);
  // Retain the source definition's explicit final fallback, while exposing rawHex.
  return { value: match?.label ?? rules.at(-1).label, digits: 0 };
}

/** Response to an allowlisted identification DID; never accepts another DID. */
export function decodeFiatIdentificationResponse(input, key) {
  const definition = FIAT_IDENTIFICATION_DEFINITIONS.find(definition => definition.key === key);
  assert(definition, 'Unknown Fiat identification field.');
  const payload = validatedPayload(input), negative = negativeResponse(payload, 0x22);
  if (negative) return negative;
  assert(payload[0] === 0x62 && payload.length >= 3 && payload[1] * 256 + payload[2] === definition.did, 'Response belongs to a different identification field.');
  assert(payload.length === definition.bytes + 3, 'ECU identification response is truncated or has unexpected extra data.');
  const data = payload.slice(3);
  return { status: 'positive', key: definition.key, label: definition.label, unit: definition.unit, did: hex(payload.slice(1, 3)), ...decodeValue(definition, data), rawHex: hex(data) };
}

/** Decode record 00 only. Unknown identifier lengths stop parsing without guesses. */
export function decodeFiatSnapshotResponse(input, selectedId) {
  const id = dtcId(selectedId), payload = validatedPayload(input), negative = negativeResponse(payload, 0x19);
  if (negative) return negative;
  assert(payload.length >= 8 && payload[0] === 0x59 && payload[1] === 0x04, 'Response does not belong to the engine snapshot request.');
  assert(hex(payload.slice(2, 5)) === id, 'Snapshot belongs to a different fault.');
  assert(payload[6] === 0, 'Snapshot record does not match the requested record 00.');
  const declaredIdentifierCount = payload[7], fields = [], unknown = [], seen = new Set();
  assert(payload.length >= 8 + declaredIdentifierCount * 2, 'Snapshot identifier list is truncated.');
  let offset = 8, decodedIdentifierCount = 0;
  while (decodedIdentifierCount < declaredIdentifierCount) {
    assert(offset + 2 <= payload.length, 'Snapshot identifier is truncated.');
    const did = hex(payload.slice(offset, offset + 2)), definitions = snapshotDefinitions.get(did);
    if (!definitions) { unknown.push({ did, offset, remainingHex: hex(payload.slice(offset)) }); break; }
    assert(!seen.has(did), 'Snapshot contains a duplicate identifier.'); seen.add(did);
    const bytes = definitions[0].bytes;
    assert(offset + 2 + bytes <= payload.length, `Snapshot data for ${did} is truncated.`);
    const data = payload.slice(offset + 2, offset + 2 + bytes);
    for (const definition of definitions) fields.push({ key: definition.key, did, label: definition.label, unit: definition.unit, hidden: definition.hidden, ...decodeValue(definition, data), rawHex: hex(data) });
    offset += 2 + bytes; decodedIdentifierCount++;
  }
  const complete = decodedIdentifierCount === declaredIdentifierCount;
  assert(!complete || offset === payload.length, 'Snapshot has unexpected trailing data or a wrong identifier count.');
  return { status: 'positive', ...describeDtc(id, payload[5]), recordNumber: 0, declaredIdentifierCount, decodedIdentifierCount,
    complete, fields, unknown, rawHex: hex(payload) };
}
