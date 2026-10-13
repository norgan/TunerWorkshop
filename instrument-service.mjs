import { decodeReadDataEnvelope } from './can-diagnostics.mjs';

const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

// Recovered SVCRSTX1 / DASHX1 linkage: same cluster and CCAN29 transport.
// Static compatibility evidence is separate from physical acceptance.
export const INSTRUMENT_SERVICE_CONNECTION = freeze({
  requestId: '18DA60F1', responseId: '18DAF160', isoCodes: ['0003502D16', '3283760D0D'],
  adapter: 'direct', protocol: 'CCAN29', baud: 500000,
});

const channelRows = [
  ['service-distance-remaining', 'Distance till next service', 'km', '220101', 3, 1, 0.1],
  ['service-days-remaining', 'Days till next service', 'days', '222807', 2, 0, 1],
  ['service-distance-since', 'Distance after last service', 'km', '222802', 3, 0, 1],
  ['service-date', 'Last service date', '', '222801', 4, 0, null],
  ['service-coupons', 'Remaining service coupons', '', '222800', 1, 0, 1],
  ['service-interval', 'Service interval', 'km', '222803', 1, 0, 500],
  ['service-period', 'Service period', 'days', '222806', 1, 0, 5],
  ['service-odometer', 'Instrument odometer', 'km', '222001', 3, 1, 0.1],
  ['service-rpm', 'Engine speed', 'rpm', '221000', 2, 0, 0.25],
  ['service-speed', 'Vehicle speed', 'km/h', '221002', 1, 0, 1],
  ['service-voltage', 'Battery voltage', 'V', '221004', 1, 1, 0.1],
];
export const INSTRUMENT_SERVICE_PROFILE = freeze({
  id: 'fiat-service', label: 'Fiat 500X · Service interval',
  channels: channelRows.map(([key, label, unit, request, bytes, digits, factor]) => ({
    key, label, unit, request, startByte: 0, bytes, digits, factor,
    did: Number.parseInt(request.slice(2), 16), valueType: factor === null ? 'text' : 'number',
    format: factor === null ? 'date' : 'numeric', staleAfterMs: 15000,
  })),
  defaultChannels: ['service-distance-remaining', 'service-days-remaining', 'service-coupons', 'service-interval', 'service-rpm', 'service-speed', 'service-voltage'],
});

function byteArray(data) {
  requireValue((data instanceof Uint8Array || Array.isArray(data)) && data.length <= 512 && Array.from(data).every(value => Number.isInteger(value) && value >= 0 && value <= 255), 'Invalid instrument response bytes.');
  return Array.from(data);
}

export function decodeInstrumentIdentity(data) {
  const bytes = byteArray(data);
  requireValue(bytes.length === 5, 'The instrument panel returned an invalid ISO identity.');
  const isoCode = bytes.map(value => value.toString(16).toUpperCase().padStart(2, '0')).join('');
  requireValue(INSTRUMENT_SERVICE_CONNECTION.isoCodes.includes(isoCode), 'This instrument panel is not identified for the Fiat 500X service profile.');
  return { source: 'live-manufacturer', ecuIsoCode: isoCode.match(/../g).join(' ') };
}

export function decodeInstrumentParameter(key, data) {
  const channel = INSTRUMENT_SERVICE_PROFILE.channels.find(item => item.key === key);
  requireValue(channel, 'Unknown instrument service parameter.');
  const bytes = byteArray(data);
  requireValue(bytes.length >= channel.startByte + channel.bytes, 'Instrument service response is truncated.');
  const slice = bytes.slice(channel.startByte, channel.startByte + channel.bytes);
  if (channel.format === 'date') {
    // The reference formatter displays four bytes as packed BCD YYYY/MM/DD.
    const raw = slice.map(value => value.toString(16).toUpperCase().padStart(2, '0')).join('');
    if (raw === '00000000' || raw === 'FFFFFFFF') return 'Not recorded';
    if (!/^\d{8}$/.test(raw)) return 'Unrecognized date';
    const year = Number(raw.slice(0, 4)), month = Number(raw.slice(4, 6)), day = Number(raw.slice(6));
    if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return 'Unrecognized date';
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}`;
  }
  const raw = slice.reduce((value, byte) => value * 256 + byte, 0);
  return Number((raw * channel.factor).toFixed(channel.digits));
}

const SERVICE_REPORT_KEYS = Object.freeze(['service-distance-remaining', 'service-days-remaining', 'service-distance-since', 'service-coupons', 'service-interval', 'service-period']);
const NEGATIVE_REASONS = Object.freeze({ 0x22: 'conditions are not correct', 0x31: 'service is not supported', 0x33: 'access is denied', 0x78: 'completion is still pending', 0x81: 'engine speed is too high', 0x83: 'engine is running', 0x88: 'vehicle speed is too high', 0x92: 'voltage is too high', 0x93: 'voltage is too low' });

/**
 * One dashboard-reminder reset using an existing, session-bound command sender.
 * command(request) must return the terminal UDS payload for this cluster and
 * reject on a changed/disconnected session. It must not retry writes.
 * The caller owns user confirmation, operation locking and transport teardown.
 */
export async function resetInstrumentService({ command, context, sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) }) {
  requireValue(typeof command === 'function' && typeof sleep === 'function', 'Instrument service requires a connected command sender.');
  requireValue(context?.profileId === 'fiat-service' && context.ecu === INSTRUMENT_SERVICE_CONNECTION.responseId && typeof context.sessionId === 'string' && context.sessionId.length > 0, 'Connect the Fiat 500X service profile before resetting the reminder.');
  requireValue(context.confirmed === true && context.serviceCompleted === true, 'Confirm that the scheduled service is complete before resetting its reminder.');

  async function read(request, length) {
    const result = decodeReadDataEnvelope(await command(request), Number.parseInt(request.slice(2), 16), length);
    requireValue(result.status === 'positive', `The instrument panel could not supply a required service reading${result.status === 'negative' ? ` (response ${result.code.toString(16).toUpperCase().padStart(2, '0')})` : ''}. No successful reset is established.`);
    return result.data;
  }
  async function parameter(key) {
    const channel = INSTRUMENT_SERVICE_PROFILE.channels.find(item => item.key === key);
    return decodeInstrumentParameter(key, await read(channel.request, channel.bytes));
  }
  async function report() {
    const values = {};
    for (const key of SERVICE_REPORT_KEYS) values[key] = await parameter(key);
    return values;
  }
  const identity = decodeInstrumentIdentity(await read('22F1A5', 5));
  const before = await report();
  requireValue(before['service-coupons'] > 0, 'No service coupons remain. This reset cannot restore the reminder; changing the coupon count is a separate operation.');
  // Read directly immediately before the one write; cached engine values do not qualify.
  const rpmBytes = await read('221000', 2), speedBytes = await read('221002', 1);
  requireValue(Array.from(rpmBytes).every(byte => byte === 0) && speedBytes[0] === 0, 'Switch the engine off and keep the vehicle stationary before resetting the service reminder.');
  const unknownOutcome = reason => ({ status: 'outcome-unknown', identity, before, after: null, changesMayHaveOccurred: true,
    message: `The service reset may have been applied, but completion could not be confirmed. The reset was not retried. ${reason}` });
  let payload;
  try { payload = byteArray(await command('2F556901')); }
  catch (error) { return unknownOutcome(error.message); }
  if (payload[0] === 0x7f) {
    if (payload.length !== 3 || payload[1] !== 0x2f) return unknownOutcome('The instrument returned an unrelated service response.');
    if (payload[2] === 0x78) return unknownOutcome('The instrument was still processing the request when its response ended.');
    throw new Error(`Service reset was not confirmed: ${NEGATIVE_REASONS[payload[2]] ?? `ECU response ${payload[2].toString(16).toUpperCase().padStart(2, '0')}`}. The reset was not retried.`);
  }
  // Match the control parameter as well as service/DID. The retained reference
  // handler is looser; UDS InputOutputControlByIdentifier requires the echo.
  if (!(payload.length >= 4 && payload.length <= 32 && payload[0] === 0x6f && payload[1] === 0x55 && payload[2] === 0x69 && payload[3] === 1)) return unknownOutcome('The instrument reply did not match the requested reset.');
  // Reference simple-operation handler waits eight seconds for this single command.
  let after;
  try { await sleep(8000); after = await report(); }
  catch (error) { return { status: 'accepted-unverified', identity, before, after: null, changesMayHaveOccurred: true, message: `The cluster accepted the reset, but its new service readings could not be checked. ${error.message}` }; }
  const couponDecreased = after['service-coupons'] === before['service-coupons'] - 1;
  const distanceReset = before['service-distance-since'] > 0 && after['service-distance-since'] === 0;
  const countdownIncreased = after['service-distance-remaining'] > before['service-distance-remaining'] || after['service-days-remaining'] > before['service-days-remaining'];
  const verified = couponDecreased && (distanceReset || countdownIncreased);
  return { status: verified ? 'verified' : 'accepted-unverified', identity, before, after, changesMayHaveOccurred: true,
    message: verified ? `The cluster accepted the service reset and its reminder values changed.${after['service-coupons'] === 0 ? ' No service coupons remain; restoring future reminders is a separate configuration operation.' : ''}` : 'The cluster accepted the reset. Its readings do not yet establish that the reminder reset completed.' };
}
