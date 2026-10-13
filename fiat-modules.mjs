import { FIAT_MODULE_METADATA, FIAT_MODULE_ROWS } from './fiat-module-data.mjs';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const numericFormat = /^(num|nums)(?:,(\d+))?(?:,(-?\d+(?:\.\d+)?))?(?:,(-?\d+(?:\.\d+)?))?$/;
const eq3Format = /^eq3,(\d+),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/;
const PROXI_REASON = 'This entry describes a network-configuration node. Its controller identity and PROXI workflow are not implemented as a sensor profile.';
const SIGNED_32_REASON = 'The reference marks this value signed but its four-byte formatter does not apply a sign. The scaling requires a verified controller sample.';
const ADAPTERS = {
  direct: { label: 'Direct OBD connection', diagramUrl: null },
  A5: { label: 'A5 blue adapter lead', diagramUrl: 'https://www.multiecuscan.net/images/OBDAdapter5.png' },
  A6: { label: 'A6 grey adapter lead', diagramUrl: 'https://www.multiecuscan.net/images/OBDAdapter6.png' },
};

function makeConnection(module) {
  assert(['CCAN29', 'BHCAN29'].includes(module.protocol) && /^[0-9A-F]{2}$/.test(module.ecuAddress) && module.testerAddress === 'F1', 'Invalid static module transport.');
  assert(module.isoCodes.every(code => /^[0-9A-F]{10}$/.test(code)), 'Invalid static ISO identity.');
  return {
    requestId: `18DA${module.ecuAddress}${module.testerAddress}`, responseId: `18DA${module.testerAddress}${module.ecuAddress}`,
    isoCodes: [...module.isoCodes], protocol: module.protocol, baud: module.protocol === 'BHCAN29' ? 125000 : 500000,
    adapter: module.adapter, adapterLabel: ADAPTERS[module.adapter].label, adapterDiagramUrl: ADAPTERS[module.adapter].diagramUrl,
    session: '1003', fallbackSession: module.protocol === 'CCAN29' ? '1092' : null,
    sessionFallbackNrc: module.protocol === 'CCAN29' ? 0x12 : null,
    fixedDlcRetryOnEmpty: true, keepAlive: '3E00', keepAliveMs: 2000, identityRequest: '22F1A5',
    variantIdentityRequest: module.variantIdentityTokens.length ? '22F100' : null,
    variantIdentityTokens: [...module.variantIdentityTokens],
    available: module.isoCodes.length > 0 && module.id !== 'fiat-proxi',
    unavailableReason: module.id === 'fiat-proxi' ? PROXI_REASON : module.isoCodes.length ? null : 'No verified controller identity is available for this profile.',
  };
}

function makeChannel(module, row) {
  const [key, label, unit, request, startByte, bytes, format, statusRules, sourceOffset] = row;
  assert(/^22[0-9A-F]{4}$/.test(request) && Number.isInteger(startByte) && startByte >= 0 && Number.isInteger(bytes) && bytes >= 1 && startByte + bytes <= 512, 'Invalid static module read definition.');
  let decoder, digits = 0, valueType = 'text', unavailableReason = null;
  const numeric = numericFormat.exec(format), eq3 = eq3Format.exec(format);
  if (module.id === 'fiat-proxi') {
    decoder = { kind: 'network-node', descriptor: format }; unavailableReason = PROXI_REASON;
  } else if (numeric) {
    digits = Number(numeric[2] ?? 0); valueType = 'number';
    decoder = { kind: 'numeric', signed: numeric[1] === 'nums', factor: Number(numeric[3] ?? 1), offset: Number(numeric[4] ?? 0) };
    if (bytes > 4 || digits > 8) unavailableReason = 'The numeric width or precision has not been verified.';
    else if (decoder.signed && bytes > 2) unavailableReason = SIGNED_32_REASON;
  } else if (format === 'bits' || format === 'bitw') {
    const width = format === 'bits' ? 2 : 4;
    assert(bytes === width / 2, 'Invalid static status width.');
    decoder = { kind: format, rules: statusRules.split('|').map(rule => {
      assert(new RegExp(`^[0-9A-F]{${width * 2}}.+$`).test(rule), 'Invalid static status rule.');
      return { mask: Number.parseInt(rule.slice(0, width), 16), expected: Number.parseInt(rule.slice(width, 2 * width), 16), label: rule.slice(width * 2) };
    }) };
  } else if (format === 'hex' || format === 'hex2') {
    decoder = { kind: format };
  } else if (format === 'date' && bytes === 4) {
    decoder = { kind: 'date' };
  } else if (eq3 && bytes === 3) {
    digits = Number(eq3[1]); valueType = 'number';
    decoder = { kind: 'eq3', factors: [Number(eq3[2]), Number(eq3[4]), Number(eq3[6])], offsets: [Number(eq3[3]), Number(eq3[5]), Number(eq3[7])] };
  } else {
    decoder = { kind: 'unsupported' }; unavailableReason = 'The response format has not been verified.';
  }
  return { key, label, unit, request, did: Number.parseInt(request.slice(2), 16), startByte, bytes, format,
    digits, valueType, staleAfterMs: 15000, decoder, sourceOffset,
    available: !unavailableReason, unavailableReason };
}

/** All 26 source entries include alternatives; this is not a fitted-module list. */
export const FIAT_MODULE_CATALOG = freeze(FIAT_MODULE_METADATA.map(module => ({
  ...module, connection: makeConnection(module), physicalAcceptance: 'not-tested',
})));

/** Existing 8GMK and service profiles remain owned by their dedicated modules. */
export const FIAT_MODULE_PROFILES = freeze(FIAT_MODULE_CATALOG.filter(module => !['fiat-8gmk', 'fiat-service'].includes(module.id)).map(module => {
  const channels = FIAT_MODULE_ROWS[module.moduleID].map(row => makeChannel(module, row));
  const preferred = channels.filter(channel => channel.available && /^(?:Battery voltage|Vehicle speed|Engine speed|Odometer|Engine temperature|Outside temperature|Inside temperature|Gear engaged)$/.test(channel.label));
  const defaults = [...preferred, ...channels.filter(channel => channel.available && !preferred.includes(channel))].slice(0, 8);
  return { ...module, channels, defaultChannels: defaults.map(channel => channel.key),
    available: module.connection.available && defaults.length > 0, unavailableReason: module.connection.unavailableReason,
    sourceParameterCount: channels.length, supportedParameterCount: channels.filter(channel => channel.available).length };
}));

export function getFiatModuleProfile(profileId) {
  const profile = FIAT_MODULE_PROFILES.find(profile => profile.id === profileId);
  assert(profile, 'Unknown Fiat module profile.'); return profile;
}

export function getFiatModuleConnection(profileId) {
  const module = FIAT_MODULE_CATALOG.find(module => module.id === profileId);
  assert(module, 'Unknown Fiat module connection.'); return module.connection;
}

function byteArray(data) {
  assert((data instanceof Uint8Array || Array.isArray(data)) && data.length <= 512 && Array.from(data).every(value => Number.isInteger(value) && value >= 0 && value <= 255), 'Invalid module response bytes.');
  return Array.from(data);
}

/** Identity input is the attributed F1A5 data record, without its service/DID. */
export function decodeFiatModuleIdentity(profileId, data) {
  const module = FIAT_MODULE_CATALOG.find(module => module.id === profileId);
  assert(module && module.connection.available, module?.connection.unavailableReason ?? 'Unknown Fiat module identity.');
  const bytes = byteArray(data);
  assert(bytes.length === 5, 'The controller returned an invalid ISO identity.');
  const isoCode = bytes.map(byte => byte.toString(16).toUpperCase().padStart(2, '0')).join('');
  assert(module.connection.isoCodes.includes(isoCode), 'This controller is not identified for the selected Fiat module profile.');
  return { source: 'live-manufacturer', ecuIsoCode: isoCode.match(/../g).join(' '), moduleID: module.moduleID, profileId };
}

/**
 * The reference admits the F100 variant route only for these exact F1A5
 * responses. An unrelated ISO, timeout, pending or other NRC is not a trigger.
 * Input is a terminal UDS payload (no CAN framing or length byte).
 */
export function getFiatModuleIdentityFallback(profileId, primaryPayload) {
  const connection = getFiatModuleConnection(profileId);
  if (!connection.variantIdentityRequest) return null;
  const bytes = byteArray(primaryPayload);
  const rejectedDid = bytes.length === 3 && bytes[0] === 0x7f && bytes[1] === 0x22 && bytes[2] === 0x31;
  const blankIso = bytes.length === 8 && bytes[0] === 0x62 && bytes[1] === 0xf1 && bytes[2] === 0xa5
    && [0x00, 0x20, 0xff].some(fill => bytes.slice(3).every(byte => byte === fill));
  return rejectedDid || blankIso ? { request: connection.variantIdentityRequest, minimumBytes: 3 } : null;
}

/** Attributed F100 DID data: skip byte 0 and read the two-byte variant code. */
export function decodeFiatModuleVariantIdentity(profileId, data) {
  const module = FIAT_MODULE_CATALOG.find(module => module.id === profileId);
  assert(module?.moduleID === 'ZF9HP48' && module.connection.variantIdentityRequest === '22F100', 'A variant identity is not verified for this module.');
  const bytes = byteArray(data);
  assert(bytes.length >= 3, 'The controller returned a truncated variant identity.');
  const token = `TCM${bytes.slice(1, 3).map(byte => byte.toString(16).toUpperCase().padStart(2, '0')).join('')}`;
  assert(module.connection.variantIdentityTokens.includes(token), 'This controller variant is not identified for the selected Fiat module profile.');
  return { source: 'live-manufacturer', ecuIsoCode: token, moduleID: module.moduleID, profileId, identityMethod: 'variant-version' };
}

export const decodeFiatModuleFallbackIdentity = decodeFiatModuleVariantIdentity;

/** Decode attributed DID data only. The session owns service/address validation. */
export function decodeFiatModuleParameter(profileId, key, data) {
  const profile = getFiatModuleProfile(profileId), channel = profile.channels.find(channel => channel.key === key);
  assert(profile.available, profile.unavailableReason ?? 'This module is unavailable.');
  assert(channel, 'The parameter does not belong to the selected module.');
  assert(channel.available, channel.unavailableReason);
  const dataBytes = byteArray(data);
  assert(dataBytes.length >= channel.startByte + channel.bytes, 'Module parameter response is truncated.');
  const bytes = dataBytes.slice(channel.startByte, channel.startByte + channel.bytes);
  let raw = bytes.reduce((value, byte) => value * 256 + byte, 0);
  const decoder = channel.decoder;
  if (decoder.kind === 'numeric') {
    if (decoder.signed && raw >= 2 ** (channel.bytes * 8 - 1)) raw -= 2 ** (channel.bytes * 8);
    const result = (raw * decoder.factor + decoder.offset) / 10 ** channel.digits;
    assert(Number.isFinite(result), 'The module calculation is not finite.');
    return Number(result.toFixed(channel.digits));
  }
  if (decoder.kind === 'eq3') {
    // The recovered three-byte time formatter applies individual weights;
    // its precision controls display only, unlike the numeric format divisor.
    const result = bytes.reduce((sum, byte, index) => sum + byte * decoder.factors[index] + decoder.offsets[index], 0);
    assert(Number.isFinite(result), 'The module time calculation is not finite.');
    return Number(result.toFixed(channel.digits));
  }
  if (decoder.kind === 'bits' || decoder.kind === 'bitw') {
    // The first match wins; the reference's final row is its explicit fallback.
    return (decoder.rules.find(rule => (raw & rule.mask) === rule.expected) ?? decoder.rules.at(-1)).label;
  }
  const hex = bytes.map(byte => byte.toString(16).toUpperCase().padStart(2, '0'));
  if (decoder.kind === 'hex') return hex.join(' ');
  if (decoder.kind === 'hex2') return hex.join('');
  if (decoder.kind === 'date') {
    const packed = hex.join('');
    if (packed === '00000000' || packed === 'FFFFFFFF') return 'Not recorded';
    if (!/^\d{8}$/.test(packed)) return 'Unrecognized date';
    const year = Number(packed.slice(0, 4)), month = Number(packed.slice(4, 6)), day = Number(packed.slice(6));
    if (year < 1900 || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return 'Unrecognized date';
    return `${packed.slice(0, 4)}-${packed.slice(4, 6)}-${packed.slice(6)}`;
  }
  throw new Error('This module parameter decoder is unavailable.');
}
