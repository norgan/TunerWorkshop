import test from 'node:test';
import assert from 'node:assert/strict';
import { CalibrationProject, sha256 } from '../core.mjs';
import { inspectBinaryFormat } from '../formats.mjs';

const PAYLOAD_OFFSET = 351, PAYLOAD_LENGTH = 4 * 1024 * 1024;
function fixture() {
  const bytes = new Uint8Array(PAYLOAD_OFFSET + PAYLOAD_LENGTH);
  bytes.set(new TextEncoder().encode('GEN_FILE'));
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 0x03010020, true);
  view.setUint32(12, 327, true);
  for (let i = 16; i < PAYLOAD_OFFSET; i++) bytes[i] = i % 256;
  bytes.set([0x12, 0x34, 0x56, 0x78], PAYLOAD_OFFSET);
  bytes[bytes.length - 1] = 0xA5;
  return bytes;
}

test('observed GEN_FILE layout exposes only a candidate region with unverified checksums', () => {
  const bytes = fixture(), info = inspectBinaryFormat(bytes), payload = info.candidatePayload;
  assert.equal(info.format, 'gen-file-container');
  assert.equal(info.requiresValidation, true);
  assert.equal(info.readOnly, false);
  assert.equal(payload.fileOffset, PAYLOAD_OFFSET);
  assert.equal(payload.headerByteLength, PAYLOAD_OFFSET);
  assert.equal(payload.byteLength, PAYLOAD_LENGTH);
  assert.equal(payload.confidence, 'candidate');
  assert.equal(payload.checksumStatus, 'unverified');
  assert.match(payload.reason, /does not validate/);
  // DataView must respect a typed-array view's offset in its backing buffer.
  const padded = new Uint8Array(bytes.length + 19);
  padded.set(bytes, 11);
  assert.deepEqual(inspectBinaryFormat(padded.subarray(11, 11 + bytes.length)).candidatePayload, payload);
});

test('unknown GEN_FILE variants, length fields, truncation and trailers have no guessed payload', () => {
  for (const mutate of [
    bytes => { bytes[0] = 0; return bytes; },
    bytes => { bytes[8] ^= 1; return bytes; },
    bytes => { bytes[12] ^= 1; return bytes; },
    bytes => { new DataView(bytes.buffer).setUint32(12, 0xFFFFFFFF, true); return bytes; },
    bytes => bytes.subarray(0, bytes.length - 1),
    bytes => { const longer = new Uint8Array(bytes.length + 1); longer.set(bytes); return longer; },
    bytes => bytes.subarray(0, 16),
  ]) assert.equal(inspectBinaryFormat(mutate(fixture())).candidatePayload, undefined);
  assert.equal(inspectBinaryFormat(new TextEncoder().encode('GEN_FILE')).candidatePayload, undefined);
  assert.equal(inspectBinaryFormat(new Uint8Array(0)).candidatePayload, undefined);
});

test('payload coordinates translate into bounded container offsets including empty end ranges', () => {
  const project = new CalibrationProject(fixture());
  assert.equal(project.payloadToFileOffset(0), PAYLOAD_OFFSET);
  assert.equal(project.payloadToFileOffset(PAYLOAD_LENGTH - 1), project.byteLength - 1);
  assert.equal(project.payloadToFileOffset(PAYLOAD_LENGTH, 0), project.byteLength);
  assert.equal(project.fileToPayloadOffset(PAYLOAD_OFFSET), 0);
  assert.equal(project.fileToPayloadOffset(project.byteLength - 1), PAYLOAD_LENGTH - 1);
  assert.equal(project.fileToPayloadOffset(project.byteLength, 0), PAYLOAD_LENGTH);
  assert.deepEqual(project.readPayload(PAYLOAD_LENGTH, 0), new Uint8Array(0));
  for (const offset of [-1, 0.5, NaN, Infinity, '0', PAYLOAD_LENGTH + 1]) {
    assert.throws(() => project.payloadToFileOffset(offset, 0));
  }
  for (const offset of [PAYLOAD_OFFSET - 1, project.byteLength + 1, 351.5, NaN, '351']) {
    assert.throws(() => project.fileToPayloadOffset(offset, 0));
  }
  for (const length of [-1, 1.5, NaN, Infinity, '1', PAYLOAD_LENGTH + 1]) {
    assert.throws(() => project.payloadToFileOffset(0, length));
    assert.throws(() => project.fileToPayloadOffset(PAYLOAD_OFFSET, length));
  }
  assert.throws(() => project.payloadToFileOffset(PAYLOAD_LENGTH));
  assert.throws(() => project.fileToPayloadOffset(project.byteLength));
  assert.throws(() => project.readPayload(0, PAYLOAD_LENGTH + 1));
  assert.throws(() => project.readPayload(0, 1, { original: 'yes' }));
  assert.throws(() => project.exportPayload({ original: 'yes' }));
});

test('payload reads and exports are independent copies and leave full-container export intact', () => {
  const source = fixture(), project = new CalibrationProject(source);
  project.editBytes(project.payloadToFileOffset(0, 2), [0xAB, 0xCD]);
  assert.deepEqual(project.readPayload(0, 4), Uint8Array.from([0xAB, 0xCD, 0x56, 0x78]));
  assert.deepEqual(project.readPayload(0, 4, { original: true }), Uint8Array.from([0x12, 0x34, 0x56, 0x78]));
  assert.equal(project.exportPayload().length, PAYLOAD_LENGTH);
  assert.equal(project.exportBinary().length, source.length);
  assert.equal(project.exportPayload({ original: true })[0], 0x12);
  assert.deepEqual(project.exportBinary().subarray(0, PAYLOAD_OFFSET), source.subarray(0, PAYLOAD_OFFSET));
  source[PAYLOAD_OFFSET] = 0;
  project.readPayload(0, 1)[0] = 0;
  project.exportPayload()[0] = 0;
  project.exportPayload({ original: true })[0] = 0;
  project.payloadInfo.fileOffset = 0;
  project.fileInfo.candidatePayload.byteLength = 0;
  assert.equal(project.readPayload(0, 1)[0], 0xAB);
  assert.equal(project.readPayload(0, 1, { original: true })[0], 0x12);
  assert.equal(project.payloadInfo.fileOffset, PAYLOAD_OFFSET);
  assert.equal(project.payloadInfo.byteLength, PAYLOAD_LENGTH);
});

test('payload map edits and project roundtrip preserve the complete original and container header', async () => {
  const source = fixture(), project = new CalibrationProject(source, { name: 'Synthetic candidate fixture' });
  project.addMap({ id: 'payload-map', name: 'Explicit fixture definition', address: project.payloadToFileOffset(0, 4), rows: 1, cols: 2, type: 'uint16', endian: 'big' });
  assert.deepEqual(project.readMap('payload-map'), [0x1234, 0x5678]);
  project.editCells('payload-map', [{ index: 0, value: 0xABCD }], 'Edit candidate map');
  assert.equal(project.changedByteCount, 2);
  assert.deepEqual(project.diff().map(change => change.offset), [PAYLOAD_OFFSET, PAYLOAD_OFFSET + 1]);
  assert.deepEqual(project.bytes.subarray(0, PAYLOAD_OFFSET), source.subarray(0, PAYLOAD_OFFSET));
  assert.equal(project.undo(), true);
  assert.deepEqual(project.exportBinary(), source);
  assert.equal(project.redo(), true);
  const saved = await project.serialize();
  assert.equal(saved.version, 1);
  assert.equal(saved.byteLength, source.length);
  assert.equal(saved.originalSha256, await sha256(source));
  assert.equal(Object.hasOwn(saved, 'candidatePayload'), false);
  const reopened = await CalibrationProject.fromJSON(saved);
  assert.deepEqual(reopened.original, source);
  assert.deepEqual(reopened.bytes, project.bytes);
  assert.deepEqual(reopened.maps, project.maps);
  assert.deepEqual(reopened.payloadInfo, project.payloadInfo);
  assert.deepEqual(reopened.exportPayload(), project.exportPayload());
  assert.deepEqual(reopened.exportPayload({ original: true }), source.subarray(PAYLOAD_OFFSET));
  assert.equal(reopened.changedByteCount, 2);
  assert.equal(reopened.canUndo, false); // Existing v1 snapshots do not persist undo stacks.
});

test('editing the header does not reinterpret payload boundaries or lose original classification', async () => {
  const project = new CalibrationProject(fixture()), payload = project.payloadInfo;
  project.editBytes(0, [0x00]);
  project.editBytes(12, [0x00, 0x00, 0x00, 0x00]);
  assert.deepEqual(project.payloadInfo, payload);
  assert.equal(project.readPayload(0, 1)[0], 0x12);
  assert.equal(project.bytes[0], 0);
  assert.equal(project.original[0], 0x47);
  const reopened = await CalibrationProject.fromJSON(await project.serialize());
  assert.deepEqual(reopened.payloadInfo, payload);
  assert.deepEqual(reopened.bytes, project.bytes);
  assert.equal(reopened.original[0], 0x47);
});

test('unknown files retain whole-file editing and cannot masquerade as extracted payloads', () => {
  const project = new CalibrationProject(new TextEncoder().encode('GEN_FILE unsupported layout'));
  assert.equal(project.payloadInfo, null);
  for (const operation of [
    () => project.payloadToFileOffset(0), () => project.fileToPayloadOffset(0),
    () => project.readPayload(0, 1), () => project.exportPayload(),
  ]) assert.throws(operation, /No candidate ECU payload/);
  project.editBytes(0, [0x41]);
  assert.equal(project.exportBinary()[0], 0x41);
  assert.equal(project.original[0], 0x47);
});
