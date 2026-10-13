import { CalibrationProject, TYPES } from './core.mjs';

export const MAP_CATEGORIES = Object.freeze({ boost: 'Boost', ignition: 'Ignition timing', fuel: 'Fuel / AFR', other: 'Unsorted' });
export const MAP_ROLES = Object.freeze({ target: 'Target', limiter: 'Limiter', correction: 'Correction', unknown: 'Role unconfirmed' });
export const DEFINITION_STATES = Object.freeze({ candidate: 'Candidate', 'user-defined': 'User defined', reference: 'Reference definition' });

function numeric(input, label) {
  if (String(input ?? '').trim() === '' || !Number.isFinite(Number(input))) throw new Error(`${label} must be a number.`);
  return Number(input);
}
export function parseBreakpoints(input) {
  if (!String(input ?? '').trim()) return undefined;
  return String(input).split(',').map(value => numeric(value, 'Breakpoint'));
}
export function definitionFromFields(project, fields, base = {}) {
  const map = { ...base, id: base.id ?? 'map-preview' };
  for (const key of ['name', 'type', 'endian', 'unit', 'xLabel', 'yLabel', 'category', 'role', 'definitionStatus', 'notes', 'evidence']) {
    if (fields[key] !== undefined) map[key] = String(fields[key]);
  }
  for (const key of ['address', 'rows', 'cols', 'factor', 'offset']) map[key] = numeric(fields[key], key);
  if (fields.addressSpace === 'payload') {
    const width = TYPES[map.type]?.bytes;
    if (!width) throw new Error('Select a supported value type.');
    map.address = project.payloadToFileOffset(map.address, map.rows * map.cols * width);
  } else if (fields.addressSpace !== 'file') throw new Error('Select file or ECU image offsets.');
  for (const key of ['xAxis', 'yAxis']) {
    const values = parseBreakpoints(fields[key]);
    if (values) map[key] = values; else delete map[key];
  }
  return map;
}

/** Snapshot explicit breakpoints from the immutable source, never modify axis bytes. */
export function readOriginalAxis(project, { address, addressSpace, count, type, endian, factor, offset }) {
  address = numeric(address, 'Axis address'); count = numeric(count, 'Axis count');
  factor = numeric(factor, 'Axis scale'); offset = numeric(offset, 'Axis offset');
  if (!Number.isSafeInteger(count) || count < 1 || count > 64) throw new Error('An axis must have 1–64 breakpoints.');
  if (!Object.hasOwn(TYPES, type)) throw new Error('Select a supported axis type.');
  if (!['little', 'big'].includes(endian)) throw new Error('Select an axis byte order.');
  if (factor === 0) throw new Error('Axis scale cannot be zero.');
  const width = TYPES[type].bytes;
  if (addressSpace === 'payload') address = project.payloadToFileOffset(address, count * width);
  else if (addressSpace !== 'file') throw new Error('Select file or ECU image offsets.');
  const bytes = project.readBytes(address, count * width, { original: true });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: count }, (_, i) => {
    const value = view[TYPES[type].get](i * width, endian === 'little') * factor + offset;
    if (!Number.isFinite(value)) throw new Error('Axis contains a non-finite value. Check its encoding.');
    return value;
  });
}

export function previewDefinition(project, definition, replaceId) {
  definition = project.previewMapDefinition(definition, replaceId);
  // Use the production validator on both immutable and working bytes. This
  // disposable project has no connection to the real project's byte buffers.
  const original = new CalibrationProject(project.original, { maps: [definition] });
  const working = new CalibrationProject(project.bytes, { maps: [definition] });
  const map = working.maps[0], end = map.address + map.rows * map.cols * TYPES[map.type].bytes;
  if (project.maps.some(other => other.id !== replaceId && map.address < other.address + other.rows * other.cols * TYPES[other.type].bytes && end > other.address)) {
    throw new Error('This table overlaps another defined map. Adjust its address or dimensions.');
  }
  const values = working.readMap(map.id), originals = original.readMap(map.id);
  return { map, values, originals, end, min: Math.min(...values), max: Math.max(...values) };
}

export function selectionEditPreview(project, map, indices, operation, amount) {
  amount = numeric(amount, 'Adjustment');
  if (!['set', 'add', 'percent'].includes(operation)) throw new Error('Choose a supported adjustment.');
  const current = project.readMap(map.id);
  const edits = [...indices].map(index => ({ index, value: operation === 'set' ? amount : operation === 'add' ? current[index] + amount : current[index] * (1 + amount / 100) }));
  // Real encode/round/range validation, without mutating the user's project.
  const preview = new CalibrationProject(project.bytes, { maps: [map] });
  preview.editCells(map.id, edits);
  const encoded = preview.readMap(map.id);
  return { edits, count: edits.length, before: edits.map(edit => current[edit.index]), after: edits.map(edit => encoded[edit.index]), changedBytes: preview.changedByteCount };
}
