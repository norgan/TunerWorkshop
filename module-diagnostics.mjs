// Pure diagnostic codecs for the Fiat 500X module bindings in the MES inventory.
// Inputs must already be attributed to the selected module and reassembled into
// UDS payloads. This module does not open a port or authorize any vehicle action.
import { MODULE_DIAGNOSTIC_ROWS } from './module-diagnostics-data.mjs';
import { FIAT_FAILURE_TYPE_ROWS } from './fiat-diagnostics-data.mjs';
import { decodeFiatDtcStatus, decodeFiatClearResponse } from './fiat-diagnostics.mjs';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const hex = data => [...data].map(byte => byte.toString(16).toUpperCase().padStart(2, '0')).join('');
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const failures = new Map(FIAT_FAILURE_TYPE_ROWS);
const modules = new Map(), selectors = new Map();
const numericFormat = /^(num|nums)(?:,(\d+))?(?:,(-?\d+(?:\.\d+)?))?(?:,(-?\d+(?:\.\d+)?))?$/;

for (const row of MODULE_DIAGNOSTIC_ROWS) {
  const identification = row.identification.map(([key, label, request, bytes, format, unit]) => ({ key, label, request, did: Number.parseInt(request.slice(2), 16), bytes, format, unit }));
  const definitions = row.snapshots.map(([key, did, label, dataBytes, offset, bytes, format, unit, rules, hidden]) => ({ key, did, label, dataBytes, offset, bytes, format, unit, rules, hidden }));
  const faultSupported = row.faults.length > 0;
  const soleConnection = row.connections.length === 1 ? row.connections[0] : null;
  const metadata = freeze({ moduleId: row.moduleId, profileId: soleConnection?.profileId ?? null, connection: soleConnection, connections: row.connections,
    identification, identityFallback: row.identityFallback, snapshots: { mode: row.snapshotMode, definitions },
    requests: { readDtc: faultSupported ? '19020D' : null, clearDtc: faultSupported ? '14FFFFFF' : null, snapshotTemplate: definitions.length ? '1904{dtcId}00' : null },
    capabilities: { identification: identification.length > 0, readFaults: faultSupported, clearFaults: faultSupported, snapshot: definitions.length > 0 },
    faultDescriptionCount: row.faults.length, evidence: 'static-interoperability', vehicleValidated: false, unsupported: row.unsupported });
  const snapshotsByDid = new Map();
  for (const definition of definitions) if (definition.did !== null) {
    const group = snapshotsByDid.get(definition.did) ?? [];
    assert(group.length === 0 || group[0].dataBytes === definition.dataBytes, 'Conflicting static snapshot identifier lengths.');
    group.push(definition); snapshotsByDid.set(definition.did, group);
  }
  modules.set(row.moduleId, { metadata, faultLabels: new Map(row.faults), snapshotsByDid });
  selectors.set(row.moduleId, metadata);
  for (const connection of metadata.connections) selectors.set(connection.profileId, freeze({ ...metadata, profileId: connection.profileId, connection }));
}

/** Unknown selectors return null. No connection or vehicle acceptance is inferred. */
export function getModuleDiagnostics(selector) { return typeof selector === 'string' ? selectors.get(selector) ?? null : null; }

function selected(selector, capability) {
  const metadata = getModuleDiagnostics(selector);
  assert(metadata, 'Unknown Fiat diagnostic module.');
  assert(!capability || metadata.capabilities[capability], 'This diagnostic operation is not supported for the selected module.');
  return { ...modules.get(metadata.moduleId), metadata };
}

function dtcId(value) {
  assert(typeof value === 'string' && /^[0-9A-F]{6}$/.test(value), 'Expected the selected fault\'s six-character hexadecimal identifier.');
  return value;
}

/** Diagnostic reads, exact clear-all, and record-00 snapshots only. */
export function isModuleDiagnosticRequest(selector, request) {
  const metadata = getModuleDiagnostics(selector);
  if (!metadata || typeof request !== 'string') return false;
  return metadata.requests.readDtc === request || metadata.requests.clearDtc === request || metadata.identification.some(field => field.request === request) || metadata.identityFallback?.request === request || metadata.capabilities.snapshot && /^1904[0-9A-F]{6}00$/.test(request);
}

export function buildModuleSnapshotRequest(selector, id) {
  selected(selector, 'snapshot');
  return '1904' + dtcId(id) + '00';
}

function payloadBytes(input) {
  assert(input instanceof Uint8Array || Array.isArray(input), 'Expected diagnostic response bytes.');
  assert(input.length >= 1 && input.length <= 4095 && [...input].every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255), 'Invalid or empty diagnostic response bytes.');
  return Uint8Array.from(input);
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

function describeDtc(module, id, statusByte) {
  const first = Number.parseInt(id.slice(0, 2), 16), failureType = Number.parseInt(id.slice(4), 16);
  const baseCode = 'PCBU'[first >> 6] + hex([first & 0x3F, Number.parseInt(id.slice(2, 4), 16)]);
  const description = module.faultLabels.get(id.slice(0, 4));
  return { id, code: baseCode + '-' + id.slice(4), baseCode,
    description: description ?? 'Unknown module fault', descriptionKnown: description !== undefined,
    failureType, failureTypeDescription: failureType === 0 ? 'No additional failure type' : failures.get(failureType) ?? `Failure type 0x${id.slice(4)}`,
    ...decodeFiatDtcStatus(statusByte) };
}

/** Shared 19 02 0D handler, with fault descriptions scoped to this module. */
export function decodeModuleFaults(selector, input) {
  const module = selected(selector, 'readFaults'), payload = payloadBytes(input), negative = negativeResponse(payload, 0x19);
  if (negative) return negative;
  assert(payload.length >= 3 && payload[0] === 0x59 && payload[1] === 0x02, 'Response does not belong to the selected module fault-list request.');
  assert((payload.length - 3) % 4 === 0, 'Module fault list contains a truncated entry.');
  const dtcs = [], seen = new Set();
  for (let offset = 3; offset < payload.length; offset += 4) {
    const id = hex(payload.slice(offset, offset + 3));
    assert(!seen.has(id), 'Module fault list contains a duplicate fault identifier.');
    seen.add(id); dtcs.push(describeDtc(module, id, payload[offset + 3]));
  }
  return { status: 'positive', availabilityMask: payload[2], dtcs };
}

/** Exact 54 acknowledgement only; callers must re-read the faults afterwards. */
export function decodeModuleClear(selector, input) {
  selected(selector, 'clearFaults');
  return decodeFiatClearResponse(input);
}

function decodeValue(definition, data) {
  assert(data.length === definition.bytes, 'Diagnostic value is truncated or has an unexpected length.');
  const numeric = numericFormat.exec(definition.format);
  if (numeric) {
    let raw = [...data].reduce((value, byte) => value * 256 + byte, 0);
    assert(Number.isSafeInteger(raw), 'Diagnostic numeric value exceeds the supported precision.');
    if (numeric[1] === 'nums' && raw >= 2 ** (data.length * 8 - 1)) raw -= 2 ** (data.length * 8);
    const digits = Number(numeric[2] ?? 0), value = (raw * Number(numeric[3] ?? 1) + Number(numeric[4] ?? 0)) / 10 ** digits;
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
  assert(rules.length > 0 && rules.every(rule => Number.isInteger(rule.mask) && Number.isInteger(rule.expected) && rule.label), 'Invalid static diagnostic bit rules.');
  const matched = rules.find(rule => (raw & rule.mask) === rule.expected);
  return { value: matched?.label ?? rules.at(-1).label, digits: 0 };
}

export function decodeModuleIdentification(selector, key, input) {
  const { metadata } = selected(selector, 'identification');
  const definition = metadata.identification.find(field => field.key === key);
  assert(definition, 'Unknown identification field for the selected module.');
  const payload = payloadBytes(input), negative = negativeResponse(payload, 0x22);
  if (negative) return negative;
  assert(payload.length >= 3 && payload[0] === 0x62 && payload[1] * 256 + payload[2] === definition.did, 'Response belongs to a different identification field.');
  assert(payload.length === definition.bytes + 3, 'ECU identification response is truncated or has unexpected extra data.');
  const data = payload.slice(3);
  return { status: 'positive', key: definition.key, label: definition.label, unit: definition.unit, did: hex(payload.slice(1, 3)), ...decodeValue(definition, data), rawHex: hex(data) };
}

function decodeDidSnapshot(module, payload, id) {
  const declaredIdentifierCount = payload[7], fields = [], unknown = [], seen = new Set();
  let offset = 8, decodedIdentifierCount = 0;
  while (decodedIdentifierCount < declaredIdentifierCount) {
    assert(offset + 2 <= payload.length, 'Snapshot identifier is truncated.');
    const did = hex(payload.slice(offset, offset + 2)), definitions = module.snapshotsByDid.get(did);
    if (!definitions) { unknown.push({ did, offset, remainingHex: hex(payload.slice(offset)) }); break; }
    assert(!seen.has(did), 'Snapshot contains a duplicate identifier.'); seen.add(did);
    const dataBytes = definitions[0].dataBytes;
    assert(offset + 2 + dataBytes <= payload.length, `Snapshot data for ${did} is truncated.`);
    const identifierData = payload.slice(offset + 2, offset + 2 + dataBytes);
    for (const definition of definitions) {
      const data = identifierData.slice(definition.offset, definition.offset + definition.bytes);
      fields.push({ key: definition.key, did, label: definition.label, unit: definition.unit, hidden: definition.hidden, ...decodeValue(definition, data), rawHex: hex(data) });
    }
    offset += 2 + dataBytes; decodedIdentifierCount++;
  }
  const complete = decodedIdentifierCount === declaredIdentifierCount;
  assert(!complete || offset === payload.length, 'Snapshot has unexpected trailing data or a wrong identifier count.');
  return { status: 'positive', ...describeDtc(module, id, payload[5]), recordNumber: 0, declaredIdentifierCount, decodedIdentifierCount,
    layout: 'did-list', complete, fields, unknown, rawHex: hex(payload) };
}

function decodeFixedSnapshot(module, payload, id) {
  const definitions = module.metadata.snapshots.definitions, declaredIdentifierCount = payload[7];
  const fields = [];
  if (declaredIdentifierCount === 0) assert(payload.length === 8, 'Empty snapshot record contains unexpected extra data.');
  else {
    assert(payload.length >= Math.max(...definitions.map(field => field.offset + field.bytes)), 'Module snapshot is truncated before its defined fields.');
    for (const definition of definitions) {
      const data = payload.slice(definition.offset, definition.offset + definition.bytes);
      fields.push({ key: definition.key, did: null, offset: definition.offset, label: definition.label, unit: definition.unit, hidden: definition.hidden,
        ...decodeValue(definition, data), rawHex: hex(data) });
    }
  }
  // MES reads these fields at fixed response offsets. The intervening identifier
  // structure is not independently established, so do not invent a DID walk or
  // claim the whole record was decoded. Retain the entire payload for inspection.
  return { status: 'positive', ...describeDtc(module, id, payload[5]), recordNumber: 0, declaredIdentifierCount, decodedIdentifierCount: null,
    layout: 'fixed-offset', complete: false, noSnapshotData: declaredIdentifierCount === 0, fields, unknown: [],
    layoutNote: 'Selected fields use the module’s fixed snapshot layout. The complete identifier layout has not been verified.', rawHex: hex(payload) };
}

/** Record 00 only, with module-specific DID lengths or explicit fixed offsets. */
export function decodeModuleSnapshot(selector, selectedId, input) {
  const module = selected(selector, 'snapshot'), id = dtcId(selectedId), payload = payloadBytes(input), negative = negativeResponse(payload, 0x19);
  if (negative) return negative;
  assert(payload.length >= 8 && payload[0] === 0x59 && payload[1] === 0x04, 'Response does not belong to the selected module snapshot request.');
  assert(hex(payload.slice(2, 5)) === id, 'Snapshot belongs to a different fault.');
  assert(payload[6] === 0, 'Snapshot record does not match the requested record 00.');
  assert(payload.length >= 8 + payload[7] * 2, 'Snapshot identifier list is truncated.');
  return module.metadata.snapshots.mode === 'did-list' ? decodeDidSnapshot(module, payload, id) : decodeFixedSnapshot(module, payload, id);
}
