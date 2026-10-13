import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeElmCanReplies, decodeReadDataEnvelope, normalizeCanId } from '../can-diagnostics.mjs';

const options = { request: '221234', responseId: '18DAF110' };
const read = text => decodeElmCanReplies(text, options).map(item => [...item.payload]);

test('CAN decoder attributes 29-bit split and joined headers and 11-bit responses', () => {
  assert.deepEqual(read('221234\r18 DA F1 10 05 62 12 34 01 02 00 00\r>'), [[0x62, 0x12, 0x34, 1, 2]]);
  assert.deepEqual(read('18DAF110 04 62 12 34 FF\r>'), [[0x62, 0x12, 0x34, 255]]);
  assert.equal(decodeElmCanReplies('7E8 04 62 12 34 01', { ...options, responseId: '7e8' })[0].responseId, '7E8');
  assert.equal(normalizeCanId('18 DA F1 10'), '18DAF110');
  assert.throws(() => normalizeCanId('8FF'));
  assert.throws(() => normalizeCanId('2FFFFFFF'));
});

test('CAN decoder assembles only selected ECU and trims final padding', () => {
  assert.deepEqual(read([
    '18DAF111 03 7F 22 31',
    '18DAF110 10 0A 62 12 34 01 02 03',
    '18DAF111 21 FE FF FF FF FF FF FF',
    '18DAF110 21 04 05 06 07 00 00 00',
  ].join('\r')), [[0x62, 0x12, 0x34, 1, 2, 3, 4, 5, 6, 7]]);
  assert.throws(() => read('18DAF111 04 62 12 34 01'), /selected ECU/);
});

test('CAN decoder rejects missing, duplicate, interleaved and out-of-order frames', () => {
  const first = '18DAF110 10 14 62 12 34 01 02 03\r';
  assert.throws(() => read(first), /Incomplete/);
  assert.throws(() => read(first + '18DAF110 22 04 05 06 07 08 09 0A'), /sequence/);
  assert.throws(() => read(first + '18DAF110 21 04 05'), /Truncated/);
  assert.throws(() => read(first + '18DAF110 04 62 12 34 01'), /interrupted/);
  assert.throws(() => read(first + first), /interrupted/);
  assert.throws(() => read('18DAF110 21 01 02 03'), /no matching/);
  assert.throws(() => read(first + '18DAF110 21 04 05 06 07 08 09 0A\r18DAF110 21 04 05 06 07 08 09 0A'), /sequence/);
});

test('CAN decoder accepts sequence wrap and bounds declared lengths', () => {
  const payload = Array.from({ length: 125 }, (_, i) => i & 255);
  const hex = bytes => bytes.map(value => value.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  const lines = ['18DAF110 ' + hex([0x10, payload.length, ...payload.slice(0, 6)])];
  for (let start = 6, sequence = 1; start < payload.length; start += 7, sequence = (sequence + 1) & 15) lines.push('18DAF110 ' + hex([0x20 | sequence, ...payload.slice(start, start + 7)]));
  assert.deepEqual(read(lines.join('\r')), [payload]);
  assert.throws(() => read('18DAF110 1F FF 62 12 34 01 02 03'), /length/);
  assert.throws(() => read('18DAF110 10 07 62 12 34 01 02 03'), /length/);
});

test('CAN decoder rejects malformed frames, errors and unscoped input', () => {
  for (const text of ['NO DATA', 'CAN ERROR', '18DAF110 08 62 12 34 01 02 03 04', '18DAF110 04 62 12 34 ZZ', '18DAF110 00 00', '18DAF110 30 00 00', '62 12 34 01', '004\r0: 62 12 34 01']) assert.throws(() => read(text));
  assert.throws(() => decodeElmCanReplies('18DAF110 04 62 12 34 01', { ...options, request: 'ATZ' }));
});

test('UDS envelope retains pending/refusal codes and requires exact service, DID and length', () => {
  const replies = read('18DAF110 03 7F 22 78\r18DAF110 05 62 12 34 01 02');
  assert.deepEqual(decodeReadDataEnvelope(replies[0], 0x1234, 2), { status: 'negative', code: 0x78 });
  assert.deepEqual(decodeReadDataEnvelope(replies[1], 0x1234, 2), { status: 'positive', data: Uint8Array.of(1, 2) });
  assert.throws(() => decodeReadDataEnvelope([0x7f, 0x2e, 0x31], 0x1234, 2));
  assert.throws(() => decodeReadDataEnvelope([0x62, 0x12, 0x35, 1, 2], 0x1234, 2));
  assert.throws(() => decodeReadDataEnvelope([0x62, 0x12, 0x34, 1], 0x1234, 2));
  assert.throws(() => decodeReadDataEnvelope([0x62, 0x12, 0x34, 1, 256], 0x1234, 2));
});
