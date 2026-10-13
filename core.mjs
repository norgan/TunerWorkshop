/** Offline calibration data model. All addresses and dimensions must be supplied explicitly. */
import { inspectBinaryFormat } from './formats.mjs';
export const TYPES = Object.freeze({
  uint8: Object.freeze({ bytes: 1, min: 0, max: 255, get: 'getUint8', set: 'setUint8', integer: true }),
  int8: Object.freeze({ bytes: 1, min: -128, max: 127, get: 'getInt8', set: 'setInt8', integer: true }),
  uint16: Object.freeze({ bytes: 2, min: 0, max: 65535, get: 'getUint16', set: 'setUint16', integer: true }),
  int16: Object.freeze({ bytes: 2, min: -32768, max: 32767, get: 'getInt16', set: 'setInt16', integer: true }),
  uint32: Object.freeze({ bytes: 4, min: 0, max: 4294967295, get: 'getUint32', set: 'setUint32', integer: true }),
  int32: Object.freeze({ bytes: 4, min: -2147483648, max: 2147483647, get: 'getInt32', set: 'setInt32', integer: true }),
  float32: Object.freeze({ bytes: 4, min: -3.4028234663852886e38, max: 3.4028234663852886e38, get: 'getFloat32', set: 'setFloat32', integer: false }),
});

export const LIMITS = Object.freeze({ fileBytes: 32 * 1024 * 1024, maps: 256, dimension: 64, cells: 4096, history: 100 });
const FORMAT = 'tuneworkshop-workspace';
const VERSION = 1;
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function assert(condition, message) { if (!condition) throw new Error(message); }
function finite(value, name) { assert(typeof value === 'number' && Number.isFinite(value), `${name} must be a finite number.`); return value; }
function integer(value, name, min, max) { assert(Number.isSafeInteger(value) && value >= min && value <= max, `${name} must be an integer from ${min} to ${max}.`); return value; }
function textValue(value, name, max = 200) { assert(typeof value === 'string' && value.length <= max, `${name} must be text up to ${max} characters.`); return value; }
function enumValue(value, name, allowed, fallback) { const selected = value === undefined ? fallback : value; assert(allowed.includes(selected), `${name} must be one of: ${allowed.join(', ')}.`); return selected; }
function plainObject(value, name) { assert(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)), `${name} must be an object.`); }
function copyBytes(bytes) {
  assert(bytes instanceof Uint8Array || bytes instanceof ArrayBuffer, 'Binary data must be a Uint8Array or ArrayBuffer.');
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  integer(data.byteLength, 'Binary size', 1, LIMITS.fileBytes);
  return new Uint8Array(data);
}
function cloneMap(map) { return { ...map, ...(map.xAxis ? { xAxis: [...map.xAxis] } : {}), ...(map.yAxis ? { yAxis: [...map.yAxis] } : {}) }; }
function mapEnd(map) { return map.address + map.rows * map.cols * TYPES[map.type].bytes; }
function mapInterpretationChanged(previous, map) { return ['address', 'type', 'endian', 'factor', 'offset', 'min', 'max'].some(key => previous[key] !== map[key]) || mapEnd(previous) !== mapEnd(map); }

function normalizeMap(input, length) {
  plainObject(input, 'Map definition');
  assert(typeof input.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(input.id), 'Map id must contain 1–80 letters, numbers, dots, dashes or underscores.');
  assert(typeof input.type === 'string' && Object.hasOwn(TYPES, input.type), 'Unsupported data type.');
  const map = {
    id: input.id,
    name: textValue(input.name ?? input.id, 'Map name'),
    address: integer(input.address, 'Map address', 0, length - 1),
    rows: integer(input.rows, 'Rows', 1, LIMITS.dimension),
    cols: integer(input.cols, 'Columns', 1, LIMITS.dimension),
    type: input.type,
    endian: input.endian ?? 'little',
    factor: finite(input.factor ?? 1, 'Scaling factor'),
    offset: finite(input.offset ?? 0, 'Scaling offset'),
    unit: textValue(input.unit ?? '', 'Unit', 40),
    xLabel: textValue(input.xLabel ?? 'Column', 'X axis label', 80),
    yLabel: textValue(input.yLabel ?? 'Row', 'Y axis label', 80),
    category: enumValue(input.category, 'Map category', ['boost', 'ignition', 'fuel', 'other'], 'other'),
    role: enumValue(input.role, 'Map role', ['target', 'limiter', 'correction', 'unknown'], 'unknown'),
    definitionStatus: enumValue(input.definitionStatus, 'Definition status', ['candidate', 'user-defined', 'reference'], 'user-defined'),
    notes: textValue(input.notes === undefined ? '' : input.notes, 'Map notes', 2000),
    evidence: textValue(input.evidence === undefined ? '' : input.evidence, 'Definition evidence', 1000),
  };
  assert(map.name.trim(), 'Map name cannot be empty.');
  assert(map.endian === 'little' || map.endian === 'big', 'Endianness must be little or big.');
  assert(map.factor !== 0, 'Scaling factor cannot be zero.');
  assert(map.rows * map.cols <= LIMITS.cells, 'Map has too many cells.');
  assert(mapEnd(map) <= length, 'Map extends beyond the binary.');
  if (input.min !== undefined) map.min = finite(input.min, 'Minimum engineering value');
  if (input.max !== undefined) map.max = finite(input.max, 'Maximum engineering value');
  assert(map.min === undefined || map.max === undefined || map.min <= map.max, 'Minimum cannot exceed maximum.');
  for (const [key, size] of [['xAxis', map.cols], ['yAxis', map.rows]]) {
    if (input[key] !== undefined) {
      assert(Array.isArray(input[key]) && input[key].length === size, `${key} must have exactly ${size} values.`);
      map[key] = Array.from(input[key], value => finite(value, key));
    }
  }
  if (input.synthetic !== undefined) { assert(typeof input.synthetic === 'boolean', 'Synthetic marker must be boolean.'); map.synthetic = input.synthetic; }
  return map;
}

function engineeringValue(view, map, index) {
  const type = TYPES[map.type];
  const raw = view[type.get](map.address + index * type.bytes, map.endian === 'little');
  const value = raw * map.factor + map.offset;
  assert(Number.isFinite(value), `Map ${map.name} contains a non-finite value at cell ${index}.`);
  return value;
}
function validateRange(value, map) {
  // Permit only floating-point arithmetic noise at a stated engineering boundary.
  const tolerance = bound => 4 * Number.EPSILON * Math.max(Math.abs(value), Math.abs(bound));
  assert(map.min === undefined || value >= map.min - tolerance(map.min), `${map.name}: value must be at least ${map.min}.`);
  assert(map.max === undefined || value <= map.max + tolerance(map.max), `${map.name}: value must be at most ${map.max}.`);
}
function validateMapData(bytes, map, enforceRange = false) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < map.rows * map.cols; i++) {
    const value = engineeringValue(view, map, i);
    if (enforceRange) validateRange(value, map);
  }
}
function validateChangedMapData(original, modified, map) {
  const width = TYPES[map.type].bytes, view = new DataView(modified.buffer, modified.byteOffset, modified.byteLength);
  for (let i = 0; i < map.rows * map.cols; i++) {
    const start = map.address + i * width;
    let changed = false;
    for (let j = 0; j < width; j++) if (original[start + j] !== modified[start + j]) changed = true;
    if (changed) validateRange(engineeringValue(view, map, i), map);
  }
}
function encodeCell(value, map) {
  finite(value, 'Cell value');
  validateRange(value, map);
  const type = TYPES[map.type];
  let raw = (value - map.offset) / map.factor;
  assert(Number.isFinite(raw), 'Scaled raw value is not finite.');
  if (raw < type.min || raw > type.max) {
    const boundary = raw < type.min ? type.min : type.max;
    // Inverting the scale can stray beyond a storage boundary by arithmetic
    // noise (178.5 / 0.7 is 255.00000000000003). Accept only the exact forward
    // engineering value of that boundary; actual out-of-range inputs still fail.
    assert(value === boundary * map.factor + map.offset, `Value exceeds the ${map.type} storage range.`);
    raw = boundary;
  }
  if (type.integer) raw = Math.round(raw);
  const result = new Uint8Array(type.bytes);
  const view = new DataView(result.buffer);
  view[type.set](0, raw, map.endian === 'little');
  const encoded = view[type.get](0, map.endian === 'little') * map.factor + map.offset;
  assert(Number.isFinite(encoded), 'Encoded engineering value is not finite.');
  validateRange(encoded, map);
  return result;
}

function toBase64(bytes) {
  const chunks = [];
  let text = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1] ?? 0, c = bytes[i + 2] ?? 0;
    text += BASE64[a >> 2] + BASE64[((a & 3) << 4) | (b >> 4)] + (i + 1 < bytes.length ? BASE64[((b & 15) << 2) | (c >> 6)] : '=') + (i + 2 < bytes.length ? BASE64[c & 63] : '=');
    if (text.length >= 16384) { chunks.push(text); text = ''; }
  }
  chunks.push(text);
  return chunks.join('');
}
function fromBase64(value, expectedLength) {
  assert(typeof value === 'string' && value.length === 4 * Math.ceil(expectedLength / 3), 'Invalid encoded binary length.');
  const output = new Uint8Array(expectedLength);
  let position = 0;
  for (let i = 0; i < value.length; i += 4) {
    const a = BASE64.indexOf(value[i]), b = BASE64.indexOf(value[i + 1]);
    const c = value[i + 2] === '=' ? 0 : BASE64.indexOf(value[i + 2]);
    const d = value[i + 3] === '=' ? 0 : BASE64.indexOf(value[i + 3]);
    assert(a >= 0 && b >= 0 && c >= 0 && d >= 0, 'Invalid base64 binary.');
    output[position++] = (a << 2) | (b >> 4);
    if (position < expectedLength) output[position++] = ((b & 15) << 4) | (c >> 2);
    if (position < expectedLength) output[position++] = ((c & 3) << 6) | d;
  }
  assert(toBase64(output) === value, 'Binary encoding is not canonical.');
  return output;
}
export async function sha256(bytes) {
  const copy = copyBytes(bytes);
  assert(globalThis.crypto?.subtle, 'SHA-256 requires a modern browser on localhost/HTTPS or Node.js 20+.');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copy);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export class CalibrationProject {
  #original;
  #bytes;
  #maps = [];
  #undo = [];
  #redo = [];
  #name;
  #synthetic;
  #fileInfo;
  #changedCount = 0;
  #rawEdits = false;

  constructor(bytes, { name = 'Untitled binary', maps = [], synthetic = false } = {}) {
    this.#original = copyBytes(bytes);
    this.#fileInfo = inspectBinaryFormat(this.#original);
    this.#bytes = new Uint8Array(this.#original);
    this.#name = textValue(name, 'Project name');
    assert(this.#name.trim(), 'Project name cannot be empty.');
    assert(typeof synthetic === 'boolean', 'Project synthetic marker must be boolean.');
    this.#synthetic = synthetic;
    assert(Array.isArray(maps) && maps.length <= LIMITS.maps, 'Too many map definitions.');
    for (const map of maps) this.addMap(map);
  }

  get name() { return this.#name; }
  get synthetic() { return this.#synthetic; }
  get fileInfo() { return structuredClone(this.#fileInfo); }
  get payloadInfo() { return this.#fileInfo.candidatePayload ? structuredClone(this.#fileInfo.candidatePayload) : null; }
  get maps() { return this.#maps.map(cloneMap); }
  get original() { return new Uint8Array(this.#original); }
  get bytes() { return new Uint8Array(this.#bytes); }
  get byteLength() { return this.#bytes.length; }
  get canUndo() { return this.#undo.length > 0; }
  get canRedo() { return this.#redo.length > 0; }
  get history() { return { undo: this.#undo.map(item => item.label), redo: this.#redo.map(item => item.label) }; }
  get changedByteCount() { return this.#changedCount; }

  #map(id) { const map = this.#maps.find(item => item.id === id); assert(map, `Unknown map: ${id}`); return map; }

  /** Validate an addition or replacement without changing definitions, bytes or history. */
  previewMapDefinition(definition, replaceId) {
    const previous = replaceId === undefined ? null : this.#map(replaceId);
    if (!previous) assert(this.#maps.length < LIMITS.maps, 'Too many map definitions.');
    const map = normalizeMap(definition, this.byteLength);
    if (previous) assert(map.id === replaceId, 'An updated map must keep its existing id.');
    else assert(!this.#maps.some(item => item.id === map.id), 'Map id is already in use.');
    assert(!this.#maps.some(item => item !== previous && map.address < mapEnd(item) && mapEnd(map) > item.address), 'Map definitions cannot overlap.');
    validateMapData(this.#original, map);
    validateMapData(this.#bytes, map);
    // Keep the existing allowance for untouched, out-of-range original values.
    // Metadata-only replacements also retain explicit raw editing provenance.
    if (previous && (!this.#rawEdits || mapInterpretationChanged(previous, map))) validateChangedMapData(this.#original, this.#bytes, map);
    return cloneMap(map);
  }

  addMap(definition) {
    const map = this.previewMapDefinition(definition);
    this.#maps.push(map);
    return cloneMap(map);
  }

  /** Replace a complete definition atomically; byte edits and their history remain intact. */
  updateMap(id, definition) {
    const previous = this.#map(id), map = this.previewMapDefinition(definition, id);
    const interpretationChanged = mapInterpretationChanged(previous, map);

    let rawEdits = this.#rawEdits;
    const previousEnd = mapEnd(previous), nextEnd = mapEnd(map);
    const uncovered = address => address >= previous.address && address < previousEnd && (address < map.address || address >= nextEnd);
    if (!rawEdits && (map.address > previous.address || nextEnd < previousEnd)) {
      for (let address = previous.address; address < previousEnd; address++) {
        if (uncovered(address) && this.#original[address] !== this.#bytes[address]) { rawEdits = true; break; }
      }
    }
    if (!rawEdits && interpretationChanged) {
      // Older edits may become uncovered or violate a new encoding/range when
      // replayed. Preserve those exact bytes as raw history rather than dropping
      // the history or allowing a later save to reject its own byte snapshot.
      rawEdits = [...this.#undo, ...this.#redo].some(entry => entry.changes.some(change =>
        uncovered(change.offset) || change.offset >= map.address && change.offset < nextEnd));
    }
    this.#maps[this.#maps.indexOf(previous)] = map;
    this.#rawEdits = rawEdits;
    return cloneMap(map);
  }

  removeMap(id) {
    const map = this.#map(id);
    for (let i = map.address; i < mapEnd(map); i++) assert(this.#bytes[i] === this.#original[i], 'Revert this map’s edits before removing its definition.');
    this.#maps = this.#maps.filter(item => item.id !== id);
    // Old edits must not be replayed into memory no longer described by a map.
    this.#undo = [];
    this.#redo = [];
  }

  #read(bytes, id) {
    const map = this.#map(id), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return Array.from({ length: map.rows * map.cols }, (_, index) => engineeringValue(view, map, index));
  }
  readMap(id) { return this.#read(this.#bytes, id); }
  readOriginalMap(id) { return this.#read(this.#original, id); }

  readBytes(address, length, { original = false } = {}) {
    integer(address, 'Byte address', 0, this.byteLength);
    integer(length, 'Byte length', 0, this.byteLength - address);
    assert(typeof original === 'boolean', 'Original bytes option must be boolean.');
    return (original ? this.#original : this.#bytes).slice(address, address + length);
  }

  payloadToFileOffset(offset, length = 1) {
    const payload = this.#fileInfo.candidatePayload;
    assert(payload, 'No candidate ECU payload has been identified for this file layout.');
    integer(offset, 'Payload offset', 0, payload.byteLength);
    integer(length, 'Payload range length', 0, payload.byteLength - offset);
    return payload.fileOffset + offset;
  }

  fileToPayloadOffset(offset, length = 1) {
    const payload = this.#fileInfo.candidatePayload;
    assert(payload, 'No candidate ECU payload has been identified for this file layout.');
    integer(offset, 'File offset within payload', payload.fileOffset, payload.fileOffset + payload.byteLength);
    integer(length, 'Payload range length', 0, payload.fileOffset + payload.byteLength - offset);
    return offset - payload.fileOffset;
  }

  readPayload(offset, length, options = {}) {
    return this.readBytes(this.payloadToFileOffset(offset, length), length, options);
  }

  exportPayload({ original = false } = {}) {
    const payload = this.#fileInfo.candidatePayload;
    assert(payload, 'No candidate ECU payload has been identified for this file layout.');
    return this.readPayload(0, payload.byteLength, { original });
  }

  #writeByte(address, value) {
    this.#changedCount += Number(value !== this.#original[address]) - Number(this.#bytes[address] !== this.#original[address]);
    this.#bytes[address] = value;
  }

  #commit(changes, label) {
    if (!changes.length) return false;
    for (const change of changes) this.#writeByte(change.offset, change.after);
    this.#undo.push({ label, changes });
    if (this.#undo.length > LIMITS.history) this.#undo.shift();
    this.#redo = [];
    return true;
  }

  editBytes(address, values, label = 'Edit bytes') {
    integer(address, 'Byte address', 0, this.byteLength - 1);
    assert(values instanceof Uint8Array || Array.isArray(values), 'Provide byte values.');
    integer(values.length, 'Byte edit length', 1, Math.min(65536, this.byteLength - address));
    textValue(label, 'History label');
    const changes = [];
    for (let i = 0; i < values.length; i++) {
      integer(values[i], 'Byte value', 0, 255);
      if (values[i] !== this.#bytes[address + i]) changes.push({ offset: address + i, before: this.#bytes[address + i], after: values[i] });
    }
    const changed = this.#commit(changes, label);
    if (changed) this.#rawEdits = true;
    return changed;
  }

  restoreBytes(address, length) {
    integer(length, 'Restore byte length', 1, 65536);
    return this.editBytes(address, this.readBytes(address, length, { original: true }), 'Restore original bytes');
  }

  editCells(id, cells, label = 'Edit cells') {
    const map = this.#map(id), type = TYPES[map.type];
    const currentView = new DataView(this.#bytes.buffer);
    assert(Array.isArray(cells) && cells.length > 0 && cells.length <= LIMITS.cells, 'Choose 1–4096 cells to edit.');
    textValue(label, 'History label');
    const used = new Set(), changes = [];
    for (const cell of cells) {
      plainObject(cell, 'Cell edit');
      integer(cell.index, 'Cell index', 0, map.rows * map.cols - 1);
      assert(!used.has(cell.index), 'A cell occurs more than once in the edit.');
      used.add(cell.index);
      // A no-op engineering edit must preserve the raw bits, including values whose
      // tiny magnitude is hidden by an engineering offset at Number precision.
      if (cell.value === engineeringValue(currentView, map, cell.index)) continue;
      const encoded = encodeCell(cell.value, map);
      const start = map.address + cell.index * type.bytes;
      for (let byte = 0; byte < type.bytes; byte++) if (this.#bytes[start + byte] !== encoded[byte]) changes.push({ offset: start + byte, before: this.#bytes[start + byte], after: encoded[byte] });
    }
    return this.#commit(changes, label);
  }

  restoreCells(id, indices, label = 'Restore original cells') {
    const map = this.#map(id), type = TYPES[map.type];
    assert(Array.isArray(indices) && indices.length > 0 && indices.length <= LIMITS.cells, 'Choose 1–4096 cells to restore.');
    textValue(label, 'History label');
    const used = new Set(), changes = [];
    for (const index of indices) {
      integer(index, 'Cell index', 0, map.rows * map.cols - 1);
      assert(!used.has(index), 'A cell occurs more than once in the restore.');
      used.add(index);
      const start = map.address + index * type.bytes;
      for (let byte = 0; byte < type.bytes; byte++) {
        const address = start + byte;
        if (this.#bytes[address] !== this.#original[address]) changes.push({ offset: address, before: this.#bytes[address], after: this.#original[address] });
      }
    }
    return this.#commit(changes, label);
  }

  undo() {
    const entry = this.#undo.pop();
    if (!entry) return false;
    for (const change of entry.changes) this.#writeByte(change.offset, change.before);
    this.#redo.push(entry);
    return true;
  }
  redo() {
    const entry = this.#redo.pop();
    if (!entry) return false;
    for (const change of entry.changes) this.#writeByte(change.offset, change.after);
    this.#undo.push(entry);
    return true;
  }
  diff(limit = Infinity) {
    assert(limit === Infinity || Number.isSafeInteger(limit) && limit >= 0, 'Diff limit must be a nonnegative integer.');
    const changes = [];
    if (limit === 0 || this.#changedCount === 0) return changes;
    const regions = this.#rawEdits ? [{address:0,rows:1,cols:this.byteLength,type:'uint8'}] : [...this.#maps].sort((a,b)=>a.address-b.address);
    for (const map of regions) {
      for (let i = map.address; i < mapEnd(map); i++) if (this.#bytes[i] !== this.#original[i]) {
        changes.push({ offset: i, original: this.#original[i], modified: this.#bytes[i] });
        if (changes.length >= limit) return changes;
      }
    }
    return changes;
  }
  exportBinary() { return this.bytes; }

  async serialize() {
    // Capture before awaiting so a concurrent UI edit cannot produce a mixed snapshot.
    const original = this.original, modified = this.bytes, maps = this.maps, rawByteEdits = this.#rawEdits;
    return {
      format: FORMAT, version: VERSION, name: this.name, synthetic: this.synthetic,
      byteLength: original.length, originalSha256: await sha256(original),
      originalBase64: toBase64(original), modifiedBase64: toBase64(modified), maps, rawByteEdits,
    };
  }

  static async fromJSON(input) {
    if (typeof input === 'string') {
      assert(input.length <= LIMITS.fileBytes * 3 + 2 * 1024 * 1024, 'Workspace file is too large.');
      input = JSON.parse(input);
    }
    plainObject(input, 'Workspace');
    assert(input.format === FORMAT && input.version === VERSION, 'Unsupported workspace format or version.');
    const length = integer(input.byteLength, 'Workspace binary size', 1, LIMITS.fileBytes);
    assert(typeof input.originalSha256 === 'string' && /^[a-f0-9]{64}$/.test(input.originalSha256), 'Invalid original SHA-256.');
    assert(Array.isArray(input.maps) && input.maps.length <= LIMITS.maps, 'Invalid workspace map definitions.');
    // Copy supplied metadata synchronously; do not trust later mutation while hashing.
    const maps = input.maps.map(map => normalizeMap(map, length));
    const name = textValue(input.name, 'Project name'), synthetic = input.synthetic;
    assert(typeof synthetic === 'boolean', 'Project synthetic marker must be boolean.');
    const expectedHash = input.originalSha256;
    assert(input.rawByteEdits === undefined || typeof input.rawByteEdits === 'boolean', 'Invalid raw-byte editing marker.');
    const rawByteEdits = input.rawByteEdits === true;
    const original = fromBase64(input.originalBase64, length);
    const modified = fromBase64(input.modifiedBase64, length);
    assert(await sha256(original) === expectedHash, 'Original binary SHA-256 does not match the workspace.');
    const project = new CalibrationProject(original, { name, maps, synthetic });
    const sortedMaps = [...project.#maps].sort((a, b) => a.address - b.address);
    let mapIndex = 0;
    for (let address = 0; address < length; address++) {
      if (original[address] === modified[address]) continue;
      while (mapIndex < sortedMaps.length && mapEnd(sortedMaps[mapIndex]) <= address) mapIndex++;
      const map = sortedMaps[mapIndex];
      assert(rawByteEdits || map && address >= map.address && address < mapEnd(map), 'Workspace contains modified bytes outside defined maps.');
      project.#changedCount++;
    }
    // Preserve pre-existing out-of-range calibration values, but reject every changed
    // cell whose decoded engineering value violates the supplied map constraints.
    for (const map of rawByteEdits ? [] : project.#maps) {
      validateMapData(modified, map);
      validateChangedMapData(original, modified, map);
    }
    project.#bytes = modified;
    project.#rawEdits = rawByteEdits;
    return project;
  }
}

export function createDemoProject() {
  const bytes = new Uint8Array(4096);
  const view = new DataView(bytes.buffer);
  const rpm = [800, 1200, 1800, 2400, 3000, 4000, 5000, 6000];
  const load = [20, 40, 60, 80, 100, 120];
  const definitions = [
    { id: 'demo-ve', name: 'Synthetic fuel VE', category: 'fuel', address: 256, type: 'uint16', factor: 0.1, unit: '%', min: 0, max: 150 },
    { id: 'demo-ignition', name: 'Synthetic ignition', category: 'ignition', address: 512, type: 'int16', factor: 0.1, unit: '°', min: -20, max: 60 },
    { id: 'demo-lambda', name: 'Synthetic target lambda', category: 'fuel', address: 768, type: 'uint16', factor: 0.001, unit: 'λ', min: 0.5, max: 1.5 },
  ].map(map => ({ ...map, rows: 6, cols: 8, endian: 'little', offset: 0, xLabel: 'RPM (synthetic)', yLabel: 'Load kPa (synthetic)', xAxis: rpm, yAxis: load, synthetic: true }));
  for (const map of definitions) {
    for (let row = 0; row < map.rows; row++) for (let col = 0; col < map.cols; col++) {
      const raw = map.id === 'demo-ve' ? 420 + row * 75 + col * 22 : map.id === 'demo-ignition' ? 110 + col * 30 - row * 14 : 1020 - row * 22 - col * 4;
      view[TYPES[map.type].set](map.address + (row * map.cols + col) * 2, raw, true);
    }
  }
  return new CalibrationProject(bytes, { name: 'Synthetic demonstration — not a vehicle tune', maps: definitions, synthetic: true });
}
