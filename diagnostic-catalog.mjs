import { SENSOR_DEFINITIONS } from './elm-protocol.mjs';

/**
 * Typed diagnostic metadata and observation boundaries only. These validators
 * do not verify ECU compatibility and do not enable or construct commands.
 * Validate a catalog once, then bind each live connection or historical import
 * with validateDiagnosticSession. Never reuse a session across sources.
 * All returned objects are independent, deeply frozen snapshots.
 */
export const DIAGNOSTIC_LIMITS = Object.freeze({ profiles: 64, channels: 512, subscriptions: 32, enumValues: 128, textLength: 160 });
const CATALOG_FORMAT = 'tuneworkshop-diagnostic-catalog';
const SOURCE_KINDS = ['live-obd', 'live-manufacturer', 'mes-log'];
const IDENTITY_FIELDS = ['catalogId', 'catalogVersion', 'profileId', 'moduleId', 'ecuId', 'connectionId', 'sessionId', 'sourceKind'];
const catalogs = new WeakSet(), sessions = new WeakMap();
const assert = (condition, message) => { if (!condition) throw new TypeError(message); };
function keys(value, allowed, label) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype, `${label} must be a plain object.`);
  assert(Object.keys(value).every(key => allowed.includes(key)), `${label} includes an unsupported field.`);
}
function number(value, label, min, max, integer = false) {
  assert(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isSafeInteger(value)), `${label} is outside the supported range.`);
  return value;
}
function text(value, label, maximum = 160, empty = false) {
  assert(typeof value === 'string' && value.length <= maximum && (empty || value.trim().length > 0) && !/[\u0000-\u001f\u007f]/.test(value), `${label} must be bounded text without control characters.`);
  return value;
}
function id(value, label) {
  assert(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(value), `${label} must be a stable ID of at most 96 characters.`);
  return value;
}
function frozen(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}
function timestamp(value, nullable) {
  if (nullable && value === null) return null;
  assert(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value), 'Observed time must be a canonical UTC timestamp.');
  const parsed = Date.parse(value);
  assert(Number.isFinite(parsed) && new Date(parsed).toISOString() === value, 'Observed time is invalid.');
  return value;
}
function normalizeChannel(input) {
  keys(input, ['id', 'label', 'valueType', 'unit', 'digits', 'staleAfterMs', 'enumValues', 'trueLabel', 'falseLabel', 'maxTextLength'], 'Channel');
  assert(['number', 'boolean', 'enum', 'text'].includes(input.valueType), 'Channel value type is unsupported.');
  const channel = { id: id(input.id, 'Channel ID'), label: text(input.label, 'Channel label'), valueType: input.valueType, unit: text(input.unit ?? '', 'Channel unit', 40, true), staleAfterMs: number(input.staleAfterMs, 'Channel stale period', 100, 3600000, true) };
  if (input.valueType === 'number') channel.digits = number(input.digits ?? 2, 'Display digits', 0, 8, true);
  else assert(input.digits === undefined, 'Display digits apply only to numeric channels.');
  if (input.valueType === 'enum') {
    assert(Array.isArray(input.enumValues) && input.enumValues.length > 0 && input.enumValues.length <= DIAGNOSTIC_LIMITS.enumValues, 'Enum channels require 1–128 code labels.');
    const seen = new Set();
    channel.enumValues = Array.from(input.enumValues, entry => {
      keys(entry, ['code', 'label'], 'Enum value');
      const code = number(entry.code, 'Enum code', -2147483648, 4294967295, true);
      assert(!seen.has(code), 'Enum codes must be unique.'); seen.add(code);
      return { code, label: text(entry.label, 'Enum label', 80) };
    });
  } else assert(input.enumValues === undefined, 'Enum labels apply only to enum channels.');
  if (input.valueType === 'boolean') {
    channel.trueLabel = text(input.trueLabel ?? 'True', 'True label', 80);
    channel.falseLabel = text(input.falseLabel ?? 'False', 'False label', 80);
  } else assert(input.trueLabel === undefined && input.falseLabel === undefined, 'Boolean labels apply only to boolean channels.');
  if (input.valueType === 'text') channel.maxTextLength = number(input.maxTextLength ?? 80, 'Text value length', 1, DIAGNOSTIC_LIMITS.textLength, true);
  else assert(input.maxTextLength === undefined, 'Text length applies only to text channels.');
  return channel;
}

/** Validates metadata shape, not manufacturer correctness or protocol coverage. */
export function validateDiagnosticCatalog(input) {
  keys(input, ['format', 'schemaVersion', 'id', 'version', 'profiles'], 'Diagnostic catalog');
  assert(input.format === CATALOG_FORMAT && input.schemaVersion === 1, 'Unsupported diagnostic catalog format or schema version.');
  const result = { format: CATALOG_FORMAT, schemaVersion: 1, id: id(input.id, 'Catalog ID'), version: id(input.version, 'Catalog version'), profiles: [] };
  assert(Array.isArray(input.profiles) && input.profiles.length > 0 && input.profiles.length <= DIAGNOSTIC_LIMITS.profiles, 'Catalog must contain 1–64 profiles.');
  const profileIds = new Set(); let channelCount = 0;
  result.profiles = Array.from(input.profiles, inputProfile => {
    keys(inputProfile, ['id', 'moduleId', 'label', 'kind', 'channels'], 'Diagnostic profile');
    const profile = { id: id(inputProfile.id, 'Profile ID'), moduleId: id(inputProfile.moduleId, 'Module ID'), label: text(inputProfile.label, 'Profile label'), kind: inputProfile.kind, channels: [] };
    assert(['generic-obd', 'manufacturer'].includes(profile.kind), 'Profile kind is unsupported.');
    assert(!profileIds.has(profile.id), 'Profile IDs must be unique.'); profileIds.add(profile.id);
    assert(Array.isArray(inputProfile.channels) && inputProfile.channels.length > 0 && inputProfile.channels.length <= DIAGNOSTIC_LIMITS.channels, 'Profile must contain 1–512 channels.');
    channelCount += inputProfile.channels.length;
    assert(channelCount <= DIAGNOSTIC_LIMITS.channels, 'The catalog exceeds 512 channels.');
    const channelIds = new Set();
    profile.channels = Array.from(inputProfile.channels, inputChannel => {
      const channel = normalizeChannel(inputChannel);
      assert(!channelIds.has(channel.id), 'Channel IDs must be unique within their profile.'); channelIds.add(channel.id);
      return channel;
    });
    return profile;
  });
  frozen(result); catalogs.add(result); return result;
}

/** Derives the existing six generic measurements; no manufacturer IDs added. */
export function createGenericObdCatalog() {
  const displayDigits = { rpm: 0, coolantTemperature: 0, mapPressure: 0, intakeAirTemperature: 0, throttlePosition: 1, ecuVoltage: 2 };
  return validateDiagnosticCatalog({
    format: CATALOG_FORMAT, schemaVersion: 1, id: 'generic-obd', version: '1',
    profiles: [{ id: 'generic-obd-mode01', moduleId: 'selected-obd-ecu', label: 'Generic OBD measurements', kind: 'generic-obd', channels: SENSOR_DEFINITIONS.map(sensor => ({ id: sensor.key, label: sensor.label, valueType: 'number', unit: sensor.unit, digits: displayDigits[sensor.key] ?? 2, staleAfterMs: 5000 })) }],
  });
}

/** Bind immutable profile identity to one physical session or historical import. */
export function validateDiagnosticSession(catalog, input) {
  assert(catalogs.has(catalog), 'Validate the catalog before binding a session.');
  keys(input, IDENTITY_FIELDS, 'Diagnostic session');
  assert(input.catalogId === catalog.id && input.catalogVersion === catalog.version, 'Session catalog identity does not match.');
  const profile = catalog.profiles.find(profile => profile.id === input.profileId);
  assert(profile && input.moduleId === profile.moduleId, 'Session profile or module identity does not match.');
  assert(SOURCE_KINDS.includes(input.sourceKind), 'Session source kind is unsupported.');
  const historical = input.sourceKind === 'mes-log';
  if (!historical) assert(input.sourceKind === (profile.kind === 'generic-obd' ? 'live-obd' : 'live-manufacturer'), 'Live source kind does not match the catalog profile.');
  if (historical) assert(input.connectionId === null, 'Historical imports cannot claim a live connection.');
  const result = { catalogId: catalog.id, catalogVersion: catalog.version, profileId: profile.id, moduleId: profile.moduleId, ecuId: historical && input.ecuId === null ? null : id(input.ecuId, 'ECU response identity'), connectionId: historical ? null : id(input.connectionId, 'Connection ID'), sessionId: id(input.sessionId, 'Session ID'), sourceKind: input.sourceKind };
  frozen(result); sessions.set(result, { catalog, profile }); return result;
}
function boundProfile(catalog, session) {
  const binding = sessions.get(session);
  assert(catalogs.has(catalog) && binding?.catalog === catalog, 'Use a validated session bound to this catalog.');
  return binding.profile;
}

/** Return existing IDs only; a large catalog never implies polling all channels. */
export function validateSubscriptions(catalog, session, channelIds) {
  const profile = boundProfile(catalog, session);
  assert(Array.isArray(channelIds) && channelIds.length <= DIAGNOSTIC_LIMITS.subscriptions, 'Select at most 32 channels.');
  const seen = new Set();
  const selected = Array.from(channelIds, channelId => {
    id(channelId, 'Subscribed channel ID');
    assert(profile.channels.some(channel => channel.id === channelId), 'Subscribed channel is absent from the bound profile.');
    assert(!seen.has(channelId), 'Subscribed channels cannot repeat.'); seen.add(channelId); return channelId;
  });
  return frozen(selected);
}

/** Reject cross-session/source samples; preserve unknown enum codes as numbers. */
export function validateMeasurement(catalog, session, input) {
  const profile = boundProfile(catalog, session);
  keys(input, [...IDENTITY_FIELDS, 'channelId', 'sequence', 'observedAt', 'value', 'quality'], 'Diagnostic measurement');
  for (const field of IDENTITY_FIELDS) assert(input[field] === session[field], `Measurement ${field} does not match the active source.`);
  const channel = profile.channels.find(channel => channel.id === input.channelId);
  assert(channel, 'Measurement channel is absent from the bound profile.');
  assert(['valid', 'unavailable', 'decode-error'].includes(input.quality), 'Measurement quality is unsupported.');
  const result = { ...session, channelId: channel.id, sequence: number(input.sequence, 'Sample sequence', 0, Number.MAX_SAFE_INTEGER, true), observedAt: timestamp(input.observedAt, session.sourceKind === 'mes-log'), value: input.value, quality: input.quality };
  if (input.quality !== 'valid') assert(input.value === null, 'Unavailable or invalid readings must have a null value.');
  else if (channel.valueType === 'number') result.value = number(input.value, 'Numeric measurement', -1e12, 1e12);
  else if (channel.valueType === 'boolean') assert(typeof input.value === 'boolean', 'Boolean measurements must be true or false.');
  else if (channel.valueType === 'enum') result.value = number(input.value, 'Enum measurement code', -2147483648, 4294967295, true);
  else result.value = text(input.value, 'Text measurement', channel.maxTextLength, true);
  return frozen(result);
}

/** Freshness is derived per channel. Historical observations never become live. */
export function measurementState(catalog, session, input, nowMs = Date.now()) {
  const measurement = validateMeasurement(catalog, session, input);
  number(nowMs, 'Current time', 0, 8640000000000000, true);
  const channel = boundProfile(catalog, session).channels.find(channel => channel.id === measurement.channelId);
  if (measurement.quality !== 'valid') return frozen({ quality: measurement.quality, ageMs: null });
  if (session.sourceKind === 'mes-log') return frozen({ quality: 'historical', ageMs: null });
  const ageMs = nowMs - Date.parse(measurement.observedAt);
  return frozen({ quality: ageMs < 0 ? 'clock-skew' : ageMs > channel.staleAfterMs ? 'stale' : 'fresh', ageMs });
}

/** Display only; values and enum codes retain their original typed meaning. */
export function formatMeasurement(catalog, session, input) {
  const measurement = validateMeasurement(catalog, session, input);
  const channel = boundProfile(catalog, session).channels.find(channel => channel.id === measurement.channelId);
  if (measurement.quality !== 'valid') return frozen({ text: '—', unit: channel.unit, known: false });
  if (channel.valueType === 'number') return frozen({ text: measurement.value.toFixed(channel.digits), unit: channel.unit, known: true });
  if (channel.valueType === 'boolean') return frozen({ text: measurement.value ? channel.trueLabel : channel.falseLabel, unit: channel.unit, known: true });
  if (channel.valueType === 'enum') {
    const entry = channel.enumValues.find(entry => entry.code === measurement.value);
    return frozen({ text: entry?.label ?? `Unknown (${measurement.value})`, unit: channel.unit, known: !!entry });
  }
  return frozen({ text: measurement.value, unit: channel.unit, known: true });
}
