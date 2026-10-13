const MAX_SCAN_BYTES = 16 * 1024 * 1024;
const DEFAULT_SCAN_BYTES = 8 * 1024 * 1024;
const MAX_RESULTS = 200;
const MAX_RETAINED = 1024;
const MIN_COUNT = 8;
const MAX_COUNT = 64;

const gcd = (a, b) => b ? gcd(b, a % b) : a;
const hex = value => `0x${value.toString(16).toUpperCase().padStart(6, '0')}`;

function integerOption(value, fallback, min, max, label) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new RangeError(`${label} must be an integer from ${min} to ${max}.`);
  }
  return result;
}

/**
 * Find bounded monotonic raw 16-bit series for human inspection. A series may
 * be an axis, a curve, part of a table, or unrelated data. Its physical meaning,
 * scaling, ECU address and relationship to other bytes are deliberately unknown.
 * Offsets are relative to the supplied image, never inferred ECU addresses.
 */
export function discoverCalibrationCandidates(bytes, options = {}) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Provide an ECU image as Uint8Array bytes.');
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Scan options must be an object.');
  const start = integerOption(options.start, 0, 0, bytes.length, 'Scan start');
  const requestedEnd = integerOption(options.end, bytes.length, start, bytes.length, 'Scan end');
  const maxResults = integerOption(options.maxResults, 40, 1, MAX_RESULTS, 'Maximum results');
  const maxScanBytes = integerOption(options.maxScanBytes, DEFAULT_SCAN_BYTES, 1, MAX_SCAN_BYTES, 'Maximum scan bytes');
  const end = Math.min(requestedEnd, start + maxScanBytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const candidates = [];
  let totalCandidates = 0;
  const compare = (a, b) => b.score - a.score || a.offset - b.offset || a.encoding.localeCompare(b.encoding);

  for (const littleEndian of [false, true]) {
    const read = offset => view.getUint16(offset, littleEndian);
    let cursor = start;
    while (cursor + MIN_COUNT * 2 <= end) {
      let first = read(cursor);
      const second = read(cursor + 2);
      if (first === 0xffff || second === 0xffff) { cursor += 2; continue; }
      const direction = Math.sign(second - first);
      if (!direction) { cursor += 2; continue; }
      let runEnd = cursor + 4;
      let previous = second;
      let count = 2;
      let minStep = Math.abs(second - first), maxStep = minStep, divisor = minStep;
      // Walk the entire run, including runs longer than MAX_COUNT, so an
      // arbitrary slice of a long counter ramp is not offered as a table.
      while (runEnd + 2 <= end) {
        const value = read(runEnd);
        if (value === 0xffff || Math.sign(value - previous) !== direction) break;
        const step = Math.abs(value - previous);
        minStep = Math.min(minStep, step); maxStep = Math.max(maxStep, step);
        divisor = gcd(divisor, step); previous = value;
        count++; runEnd += 2;
      }
      let offset = cursor;
      // Keep the turning point available for an opposite-direction run.
      cursor = runEnd - 2;
      // A range boundary can cut an existing run. Do not offer a clipped series.
      if (offset >= 2 && read(offset - 2) !== 0xffff && Math.sign(first - read(offset - 2)) === direction) continue;
      if (runEnd + 2 <= bytes.length && read(runEnd) !== 0xffff && Math.sign(read(runEnd) - previous) === direction) continue;

      // A possible length word can itself continue the monotonic run. Expose
      // the following values when that word exactly matches their count; this
      // is still structural evidence, not a validated record-format rule.
      let countPrefix = false;
      if (first === count - 1 && count - 1 >= MIN_COUNT && count - 1 <= MAX_COUNT) {
        offset += 2; count--; first = read(offset); countPrefix = true;
        minStep = Infinity; maxStep = 0; divisor = 0;
        for (let position = offset + 2; position < runEnd; position += 2) {
          const step = Math.abs(read(position) - read(position - 2));
          minStep = Math.min(minStep, step); maxStep = Math.max(maxStep, step);
          divisor = gcd(divisor, step);
        }
      }
      if (count < MIN_COUNT || count > MAX_COUNT || maxStep > minStep * 16 || Math.abs(previous - first) < 32) continue;

      const values = Array.from({ length: count }, (_, index) => read(offset + index * 2));
      countPrefix ||= offset >= start + 2 && read(offset - 2) === count;
      const uniform = minStep === maxStep;
      let score = count + (divisor >= 10 ? 8 : 0) + (uniform ? 8 : 0) + (countPrefix ? 12 : 0);
      // A byte-swapped small integer series also appears monotonic. Keep the
      // possibility visible, but prefer candidates not made only of zero lows.
      if (values.every(value => value % 256 === 0)) score -= 12;
      const endian = littleEndian ? 'little' : 'big';
      const evidence = [`${count} strictly ${direction > 0 ? 'increasing' : 'decreasing'} unsigned 16-bit values.`, `${endian === 'big' ? 'Big' : 'Little'}-endian interpretation; ${hex(offset)} is an image byte offset.`];
      if (uniform) evidence.push(`Constant raw step of ${minStep}.`);
      if (countPrefix) evidence.push('The preceding word equals the series length; its meaning is unverified.');
      totalCandidates++;
      candidates.push({
        id: `raw-series-${endian}-${offset}`, kind: 'axis-or-curve',
        name: `Candidate raw series ${hex(offset)}`, offset, count, rows: 1, cols: count,
        encoding: littleEndian ? 'uint16le' : 'uint16be', type: 'uint16', endian,
        values, confidence: 'heuristic', verified: false, evidence, score,
      });
      if (candidates.length >= MAX_RETAINED * 2) {
        candidates.sort(compare); candidates.length = MAX_RETAINED;
      }
    }
  }
  candidates.sort(compare);
  const selected = candidates.slice(0, maxResults);
  return {
    candidates: selected,
    scannedRange: { start, endExclusive: end, bytes: end - start },
    requestedRange: { start, endExclusive: requestedEnd },
    totalCandidates, truncated: totalCandidates > selected.length, scanLimited: end < requestedEnd,
    warning: 'These are unverified raw series, not identified tuning maps. Their purpose, physical units, scaling and table relationships are unknown. Inspect each candidate before adding it.',
  };
}
