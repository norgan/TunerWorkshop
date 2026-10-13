/** Offline reader for the English MultiECUScan text-log structure.
 * No file access, vehicle connection, target execution or persistent storage.
 */
export const MES_LOG_LIMITS = Object.freeze({
  bytes: 5 * 1024 * 1024,
  lines: 100000,
  lineLength: 4096,
  samples: 50000,
  channels: 256,
  faults: 200,
});

const identityFields = new Map([
  ['ECU ISO code', 'ecuIsoCode'],
  ['FIAT drawing number', 'fiatDrawingNumber'],
  ['Hardware number', 'hardwareNumber'],
  ['Hardware version', 'hardwareVersion'],
  ['Software number', 'softwareNumber'],
  ['Software version', 'softwareVersion'],
  ['Homologation number', 'homologationNumber'],
]);

// Filter identifying fields before considering either metadata or samples.
const privateField = /\b(?:VIN|chassis|vehicle identification|serial|licen[cs]e|registration|activation|password|secret|token|immobili[sz]er|transponder|key(?:s)?|security code|universal code|odometer)\b/i;
const possibleIdentifier = /(?:\b(?=[A-HJ-NPR-Z0-9]{17}\b)(?=[A-HJ-NPR-Z0-9]*\d)[A-HJ-NPR-Z0-9]{17}\b|\b\d{17,}\b|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b)/i;
const unsafeText = /[\u0000-\u0008\u000b\u000c\u000e-\u001f<>]|(?:https?:\/\/|[A-Z]:\\)/i;
const isPublicText = (value, maxLength = 200) => value.length <= maxLength
  && !privateField.test(value) && !possibleIdentifier.test(value) && !unsafeText.test(value);

function safeLabel(value, maxLength = 200) {
  return value && isPublicText(value, maxLength) ? value : '';
}

function modelLabel(value) {
  // A model/module description has no metadata key, path or arbitrary payload.
  return /^[A-Za-z0-9][A-Za-z0-9 ._()/+,&-]{0,159}$/.test(value) ? safeLabel(value, 160) : '';
}

function recordedDate(value) {
  // Retain the displayed local time. Never invent a timezone or UTC conversion.
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})(?:\s+(AM|PM))?$/i.exec(value);
  if (!match) return '';
  const [, day, month, year, hour, minute, second, period] = match;
  const date = new Date(Date.UTC(+year, +month - 1, +day));
  if (date.getUTCFullYear() !== +year || date.getUTCMonth() !== +month - 1
      || date.getUTCDate() !== +day || +minute > 59 || +second > 59
      || (period ? +hour < 1 || +hour > 12 : +hour > 23)) return '';
  return value;
}

function reading(value) {
  const numeric = /^([+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)(?:[eE][+-]?\d+)?)(?:\s+([^\d].*))?$/.exec(value);
  if (numeric) {
    const number = Number(numeric[1].replace(',', '.'));
    const unit = (numeric[2] || '').trim();
    if (Number.isFinite(number) && isPublicText(unit, 40)) return { value: number, unit };
    return null;
  }
  // Status values such as "Not active" are useful but remain categorical.
  if (/^[A-Za-z][A-Za-z .()/-]{0,79}$/.test(value) && isPublicText(value, 80)) {
    return { value, unit: '' };
  }
  return null;
}

/**
 * @param {string} text Complete saved MES text log (English operation headings).
 * @returns {{appVersion:string,date:string,vehicle:string,module:string,
 * identity:Record<string,string>,faults:Array<{code:string,description:string}>,
 * channels:Array<{name:string,unit:string,samples:Array<{time:null,value:number|string}>}>,
 * limitations:string[]}}
 * Sample time is null: the supported text format records order, not elapsed time.
 * Throws TypeError/RangeError/Error on unsupported input or explicit size limits.
 */
export function parseMesLog(text) {
  if (typeof text !== 'string') throw new TypeError('Expected MultiECUScan log text.');
  if (text.length > MES_LOG_LIMITS.bytes || new TextEncoder().encode(text).length > MES_LOG_LIMITS.bytes) {
    throw new RangeError('The log exceeds the 5 MiB import limit.');
  }
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  if (lines.length > MES_LOG_LIMITS.lines) throw new RangeError('The log exceeds the line limit.');
  if (lines.some(line => line.length > MES_LOG_LIMITS.lineLength)) throw new RangeError('A log line is too long.');
  const start = lines.findIndex(line => line.trim());
  const header = /^\(Multiecuscan\s+([0-9]+(?:\.[0-9]+)*(?:R[0-9]+)?)\)$/i.exec((lines[start] || '').trim());
  if (!header) throw new Error('This is not a supported MultiECUScan text log.');

  const result = {
    appVersion: header[1],
    date: recordedDate((lines[start + 1] || '').trim()),
    vehicle: modelLabel((lines[start + 2] || '').trim()),
    module: modelLabel((lines[start + 3] || '').trim()),
    identity: {},
    faults: [],
    channels: [],
    limitations: [
      'Saved historical log only; no vehicle is connected and current fault status is unknown.',
      'Sample timestamps are absent in this text format. Samples retain recorded order, not elapsed time.',
      'Only English text-log headings are supported. Fault freeze-frame values and unrecognized fields are omitted.',
      'Identifying fields and odometer readings are omitted. Imported labels and values are unverified log content.',
    ],
  };
  if (!result.date) result.limitations.push('The recorded date was missing or could not be interpreted.');
  const channels = new Map();
  const faults = new Set();
  let mode = 'header';
  let sampleCount = 0;
  let sawClearing = false;
  for (let index = start + 4; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    if (/^\(Multiecuscan\s/i.test(line)) {
      throw new Error('Import one MultiECUScan session at a time.');
    }
    if (line === 'READING PARAMETERS:') { mode = 'parameters'; continue; }
    if (line === 'READING ERROR CODES:') { mode = 'faults'; continue; }
    if (/^CLEARING STORED FAULT CODES/.test(line)) {
      sawClearing = true;
      mode = 'other';
      continue;
    }
    // Other operation headings end a parameter section; their payload is ignored.
    if (/^(?:EXECUTING|READING|WRITING|ADJUSTING|ACTUATING|CONNECTING|DISCONNECTING)\b/.test(line)) {
      mode = 'other';
      continue;
    }
    if (privateField.test(line) || possibleIdentifier.test(line) || unsafeText.test(line)) continue;

    if (mode === 'header') {
      const separator = line.indexOf(':');
      if (separator === -1) continue;
      const field = identityFields.get(line.slice(0, separator).trim());
      const value = line.slice(separator + 1).trim();
      if (field && /^[A-Za-z0-9 ._()/+-]{1,48}$/.test(value)) result.identity[field] = value;
      continue;
    }
    if (mode === 'faults') {
      const fault = /^(?:\d+\.\s*)?([PCBU][0-9A-F]{4}(?:-[0-9A-F]{2})?)\s+-\s+(.+)$/i.exec(line);
      if (fault) {
        const code = fault[1].toUpperCase();
        const description = safeLabel(fault[2]);
        const key = `${code}\u0000${description}`;
        if (description && !faults.has(key)) {
          if (faults.size >= MES_LOG_LIMITS.faults) throw new RangeError('The log exceeds the fault limit.');
          faults.add(key);
          result.faults.push({ code, description });
        }
      }
      continue;
    }
    if (mode !== 'parameters') continue;
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const name = safeLabel(line.slice(0, separator).trim(), 160);
    if (!name || identityFields.has(name)) continue;
    const parsed = reading(line.slice(separator + 1).trim());
    if (!parsed) continue;
    const key = `${name}\u0000${parsed.unit}`;
    let channel = channels.get(key);
    if (!channel) {
      if (channels.size >= MES_LOG_LIMITS.channels) throw new RangeError('The log exceeds the channel limit.');
      channel = { name, unit: parsed.unit, samples: [] };
      channels.set(key, channel);
      result.channels.push(channel);
    }
    if (++sampleCount > MES_LOG_LIMITS.samples) throw new RangeError('The log exceeds the sample limit.');
    channel.samples.push({ time: null, value: parsed.value });
  }
  if (sawClearing) result.limitations.push('The log records a fault-clear request; this does not establish success or present fault status.');
  if (!result.channels.length) result.limitations.push('No supported parameter samples were found.');
  return result;
}
