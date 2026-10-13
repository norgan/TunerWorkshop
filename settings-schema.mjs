// Preferences only: account credentials, vehicle data and connection permissions
// do not belong in this file. Reading preferences never starts a connection.
export const SETTINGS_DEFAULTS = Object.freeze({
  sendOnEnter: true,
  autoScrollChat: true,
  chatTextSize: 14,
  rememberModel: true,
  preferredModel: '',
  startupWorkspace: 'tuning',
  defaultMapView: 'table',
  pressureUnit: 'bar',
  showSensorStrip: true,
  chartHistorySeconds: 60,
  rememberConnection: true,
  connection: Object.freeze({
    transport: 'serial', path: '', baudRate: 38400, host: '', port: 35000,
    profile: 'auto', service: '', write: '', notify: '',
  }),
});

export class SettingsValidationError extends Error {
  constructor(message) { super(message); this.name = 'SettingsValidationError'; }
}

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const oneOf = values => value => values.includes(value);
const boolean = value => typeof value === 'boolean';
const text = maximum => value => typeof value === 'string' && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
const uuid = value => value === '' || typeof value === 'string' && /^(?:[a-f0-9]{4}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(value);
const fields = {
  sendOnEnter: boolean,
  autoScrollChat: boolean,
  chatTextSize: oneOf([14, 16, 18]),
  rememberModel: boolean,
  preferredModel: value => value === '' || typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,120}$/.test(value),
  startupWorkspace: oneOf(['tuning', 'diagnostics', 'live']),
  defaultMapView: oneOf(['table', 'curve', 'surface', 'hex']),
  pressureUnit: oneOf(['bar', 'psi']),
  showSensorStrip: boolean,
  chartHistorySeconds: oneOf([30, 60, 120]),
  rememberConnection: boolean,
};
const connectionFields = {
  transport: oneOf(['serial', 'ble', 'bluetooth', 'wifi']),
  path: text(511),
  baudRate: oneOf([9600, 38400, 115200]),
  host: text(253),
  port: value => Number.isInteger(value) && value >= 1024 && value <= 65535,
  profile: oneOf(['auto', 'custom']),
  service: uuid, write: uuid, notify: uuid,
};

function cleanFields(value, validators, defaults) {
  const source = plainObject(value) ? value : {};
  return Object.fromEntries(Object.entries(validators).map(([key, valid]) =>
    [key, Object.hasOwn(source, key) && valid(source[key]) ? source[key] : defaults[key]]));
}

export function normalizeSettings(value) {
  const source = plainObject(value) ? value : {};
  const settings = cleanFields(source, fields, SETTINGS_DEFAULTS);
  settings.connection = cleanFields(Object.hasOwn(source, 'connection') ? source.connection : undefined, connectionFields, SETTINGS_DEFAULTS.connection);
  if (!settings.rememberModel) settings.preferredModel = '';
  if (!settings.rememberConnection) settings.connection = { ...SETTINGS_DEFAULTS.connection };
  return settings;
}

function assertFields(value, validators, section, extras = []) {
  if (!plainObject(value)) throw new SettingsValidationError(`${section} must be an object.`);
  const allowed = new Set([...Object.keys(validators), ...extras]);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new SettingsValidationError(`${section} contains an unknown setting.`);
  for (const [key, valid] of Object.entries(validators)) {
    if (!Object.hasOwn(value, key) || !valid(value[key])) throw new SettingsValidationError(`Invalid setting: ${key}.`);
  }
}

export function validateSettings(value) {
  assertFields(value, fields, 'Settings', ['connection']);
  if (!Object.hasOwn(value, 'connection')) throw new SettingsValidationError('Connection settings are required.');
  assertFields(value.connection, connectionFields, 'Connection settings');
  return normalizeSettings(value);
}
