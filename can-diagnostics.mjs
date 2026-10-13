// Receive-only ISO-TP decoding for ELM replies with ATH1 / ATS1 / ATD0.
// Source: ELM327DSL, "CAN Message Types" and CAF1 / H1 descriptions.
// https://www.elmelectronics.com/wp-content/uploads/2020/05/ELM327DSL.pdf
// No adapter I/O or request generation takes place in this module.
import { cleanLines, adapterError } from './elm-protocol.mjs';

const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
export function normalizeCanId(value) {
  requireValue(typeof value === 'string', 'A CAN response identifier is required.');
  const id = value.replaceAll(' ', '').toUpperCase();
  requireValue(/^(?:[0-7][0-9A-F]{2}|[01][0-9A-F]{7})$/.test(id), 'Invalid CAN response identifier.');
  return id;
}

function frameFromLine(line) {
  const parts = line.split(/\s+/);
  let id, data;
  if (/^(?:[0-7][0-9A-F]{2}|[01][0-9A-F]{7})$/.test(parts[0])) {
    id = parts[0]; data = parts.slice(1);
  } else if (parts.length >= 6 && parts.slice(0, 4).every(value => /^[0-9A-F]{2}$/.test(value))
      && /^[01][0-9A-F]{7}$/.test(parts.slice(0, 4).join(''))) {
    id = parts.slice(0, 4).join(''); data = parts.slice(4);
  } else throw new Error('Expected a CAN frame with its response identifier.');
  requireValue(data.length >= 2 && data.length <= 8 && data.every(value => /^[0-9A-F]{2}$/.test(value)), 'Malformed CAN frame data.');
  return { id, bytes: data.map(value => Number.parseInt(value, 16)) };
}

/** Decode one bounded ELM command response; never combine different ECU sources. */
export function decodeElmCanReplies(response, { request, responseId, maxPayloadBytes = 512 } = {}) {
  requireValue(typeof request === 'string' && /^(?:[0-9A-F]{2}){1,7}$/.test(request), 'Expected a normalized short diagnostic request.');
  const id = normalizeCanId(responseId);
  requireValue(Number.isInteger(maxPayloadBytes) && maxPayloadBytes >= 8 && maxPayloadBytes <= 4095, 'Invalid diagnostic response size limit.');
  const lines = cleanLines(response, request); adapterError(lines);
  requireValue(lines.length <= 600, 'Too many CAN response frames.');
  const replies = [];
  let pending = null;
  for (const line of lines) {
    const frame = frameFromLine(line);
    if (frame.id !== id) continue;
    const bytes = frame.bytes, type = bytes[0] >> 4;
    if (type === 0) {
      requireValue(!pending, 'A new response interrupted an incomplete CAN message.');
      const length = bytes[0] & 15;
      requireValue(length >= 1 && length <= 7 && bytes.length >= length + 1, 'Invalid single-frame response length.');
      replies.push({ responseId: id, payload: Uint8Array.from(bytes.slice(1, length + 1)) });
    } else if (type === 1) {
      requireValue(!pending, 'A first frame interrupted an incomplete CAN message.');
      const length = (bytes[0] & 15) * 256 + bytes[1];
      requireValue(bytes.length === 8 && length >= 8 && length <= maxPayloadBytes, 'Invalid multi-frame response length.');
      pending = { length, nextSequence: 1, bytes: bytes.slice(2) };
    } else if (type === 2) {
      requireValue(pending, 'A consecutive CAN frame has no matching first frame.');
      requireValue((bytes[0] & 15) === pending.nextSequence, 'CAN response sequence is missing, repeated or out of order.');
      const needed = Math.min(7, pending.length - pending.bytes.length);
      requireValue(bytes.length >= needed + 1, 'Truncated consecutive CAN frame.');
      pending.bytes.push(...bytes.slice(1, needed + 1));
      pending.nextSequence = (pending.nextSequence + 1) & 15;
      if (pending.bytes.length === pending.length) {
        replies.push({ responseId: id, payload: Uint8Array.from(pending.bytes) });
        pending = null;
      }
    } else throw new Error('Unexpected CAN diagnostic frame type.');
    requireValue(replies.length <= 32, 'Too many diagnostic messages in one response.');
  }
  requireValue(!pending, 'Incomplete multi-frame CAN response.');
  requireValue(replies.length > 0, 'No complete response from the selected ECU.');
  return replies;
}

/** Strict single-DID UDS envelope validation, before a separately verified decoder. */
export function decodeReadDataEnvelope(payload, did, expectedBytes) {
  requireValue(payload instanceof Uint8Array || Array.isArray(payload), 'Expected diagnostic response bytes.');
  requireValue(payload.length >= 3 && payload.length <= 4095 && [...payload].every(value => Number.isInteger(value) && value >= 0 && value <= 255), 'Invalid diagnostic response bytes.');
  requireValue(Number.isInteger(did) && did >= 0 && did <= 65535, 'Invalid data identifier.');
  const minimum = typeof expectedBytes === 'number' ? expectedBytes : expectedBytes?.minimum;
  const maximum = typeof expectedBytes === 'number' ? expectedBytes : expectedBytes?.maximum;
  requireValue(Number.isInteger(minimum) && Number.isInteger(maximum) && minimum >= 1 && maximum >= minimum && maximum <= 4092, 'Invalid identifier data length.');
  if (payload[0] === 0x7f) {
    requireValue(payload.length === 3 && payload[1] === 0x22, 'Negative response belongs to a different request.');
    return { status: 'negative', code: payload[2] };
  }
  requireValue(payload[0] === 0x62 && payload[1] * 256 + payload[2] === did, 'Response belongs to a different data identifier.');
  requireValue(payload.length >= minimum + 3 && payload.length <= maximum + 3, 'Unexpected identifier data length.');
  return { status: 'positive', data: Uint8Array.from(payload.slice(3)) };
}
