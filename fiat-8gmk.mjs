import { SENSOR_DEFINITIONS } from './elm-protocol.mjs';
import { FIAT_8GMK_ROWS, FIAT_8GMK_EXTRA_ROWS } from './fiat-8gmk-data.mjs';
import { INSTRUMENT_SERVICE_PROFILE } from './instrument-service.mjs';
import { FIAT_MODULE_PROFILES } from './fiat-modules.mjs';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const genericDigits = { rpm: 0, coolantTemperature: 0, mapPressure: 0, intakeAirTemperature: 0, throttlePosition: 1, ecuVoltage: 2 };
const numericFormat = /^(num|nums)(?:,(\d+))?(?:,(-?\d+(?:\.\d+)?))?(?:,(-?\d+(?:\.\d+)?))?$/;
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

const originalDefinitions = FIAT_8GMK_ROWS.map(([key, label, unit, request, startByte, bytes, format, statusRules]) => {
  const numeric = numericFormat.exec(format);
  const definition = { key, label, unit, request, did: Number.parseInt(request.slice(2), 16), startByte, bytes,
    digits: numeric ? +(numeric[2] ?? 0) : 0, valueType: numeric ? 'number' : 'text', staleAfterMs: 15000,
    decoder: numeric ? { kind: 'numeric', signed: numeric[1] === 'nums', factor: +(numeric[3] ?? 1), offset: +(numeric[4] ?? 0) }
      : { kind: format, rules: statusRules.split('|').map(rule => {
        const width = format === 'bitw' ? 4 : 2;
        assert(new RegExp(`^[0-9A-F]{${width * 2}}.+$`).test(rule), 'Invalid static status definition.');
        return { mask: Number.parseInt(rule.slice(0, width), 16), expected: Number.parseInt(rule.slice(width, width * 2), 16), label: rule.slice(width * 2) };
      }) }
  };
  assert(/^[0-9A-F]{6}$/.test(request) && request.startsWith('22'), 'Only the recovered read service is admitted.');
  return definition;
});

export const FIAT_8GMK_DEFINITIONS = freeze([...originalDefinitions,
  ...FIAT_8GMK_EXTRA_ROWS.map(([did, label, unit, bytes, digits, signed, factor, offset = 0, startByte = 0, kind = 'linear']) => {
    assert(/^[0-9A-F]{4}$/.test(did), 'Invalid additional read identifier.');
    return { key: `8gmk-${did.toLowerCase()}-${startByte}`, label, unit, request: `22${did}`, did: Number.parseInt(did, 16),
      startByte, bytes, digits, valueType: 'number', staleAfterMs: 15000,
      decoder: { kind, signed, factor, offset } };
  })
]);

export const DIAGNOSTIC_PROFILES = freeze([
  { id: 'generic-obd', label: 'Standard OBD sensors', channels: SENSOR_DEFINITIONS.map(sensor => ({ key: sensor.key, label: sensor.label, unit: sensor.unit, digits: genericDigits[sensor.key], valueType: 'number', staleAfterMs: 5000 })), defaultChannels: SENSOR_DEFINITIONS.map(sensor => sensor.key) },
  { id: 'fiat-8gmk', label: `Fiat 500X · IAW 8GMK · ${FIAT_8GMK_DEFINITIONS.length} parameters`, channels: FIAT_8GMK_DEFINITIONS.map(({ key, label, unit, digits, valueType, staleAfterMs }) => ({ key, label, unit, digits, valueType, staleAfterMs })),
    defaultChannels: ['mes-10500', 'mes-10144', 'mes-10510', 'mes-10155', 'mes-10351', 'mes-11517', 'mes-10533', 'mes-10853'] },
  INSTRUMENT_SERVICE_PROFILE,
  ...FIAT_MODULE_PROFILES
]);

export function getDiagnosticProfile(id = 'generic-obd') {
  const profile = DIAGNOSTIC_PROFILES.find(profile => profile.id === id);
  assert(profile, 'Choose a supported diagnostic profile.'); return profile;
}
export function selectProfileChannels(profileId, input) {
  const profile = getDiagnosticProfile(profileId), ids = input ?? profile.defaultChannels;
  assert(profile.available!==false,profile.unavailableReason||'This controller is not yet available.');
  assert(Array.isArray(ids) && ids.length >= 1 && ids.length <= 32 && new Set(ids).size === ids.length, 'Select between 1 and 32 distinct parameters.');
  assert(ids.every(id => profile.channels.some(channel => channel.key === id&&channel.available!==false)), 'A selected parameter is not available in this profile.');
  return profile.channels.filter(channel => ids.includes(channel.key));
}

/** Decode an already attributed DID data record, without service/DID header bytes. */
export function decodeFiatParameter(key, data) {
  const definition = FIAT_8GMK_DEFINITIONS.find(definition => definition.key === key);
  assert(definition && (data instanceof Uint8Array || Array.isArray(data)), 'Unknown Fiat parameter or invalid response data.');
  assert(data.length >= definition.startByte + definition.bytes && data.length <= 512 && [...data].every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255), 'Fiat parameter response is truncated or invalid.');
  const bytes = data.slice(definition.startByte, definition.startByte + definition.bytes);
  let raw = [...bytes].reduce((value, byte) => value * 256 + byte, 0);
  if (definition.valueType === 'number') {
    if (definition.decoder.signed && raw >= 2 ** (definition.bytes * 8 - 1)) raw -= 2 ** (definition.bytes * 8);
    // This DID uses a piecewise encoding, not ordinary signed 16-bit values.
    if (definition.decoder.kind === 'vva-late-opening' && raw >= 11200) raw -= 12800;
    const divisor = definition.decoder.kind === 'numeric' ? 10 ** definition.digits : 1;
    const result = (raw * definition.decoder.factor + definition.decoder.offset) / divisor;
    assert(Number.isFinite(result), 'Fiat parameter calculation is not finite.');
    return Number(result.toFixed(definition.digits));
  }
  // Both byte and word rules use network order. The recovered formatter uses
  // the first matching rule, and the final rule as its explicit fallback.
  const rule = definition.decoder.rules.find(rule => (raw & rule.mask) === rule.expected);
  return rule?.label ?? definition.decoder.rules.at(-1)?.label ?? `Unknown (${raw})`;
}
