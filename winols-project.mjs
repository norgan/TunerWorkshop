/** Read source-labelled definitions from the observed OLS 0x255 record layout.
 * This is deliberately a metadata reader, not a ROM decoder. Project image
 * addresses must never be used as offsets into the OLS container itself.
 * Layout evidence: research/mito-map-recovery and research/ols-map-decoding.
 */
import { identifyMap } from './map-identification.mjs';

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_RECORDS = 10000;
const decoder = new TextDecoder('latin1');

export function inspectWinolsProject(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const signature = decoder.decode(bytes.subarray(0, 24));
  if (!signature.includes('WinOLS File')) return null;
  const result = { format: 'winols-project', supported: false, version: null,
    records: [], counts: { total: 0, boost: 0, ignition: 0, fuel: 0, other: 0 },
    imageStatus: 'unresolved', valuesAvailable: false,
    message: 'This WinOLS layout is not yet supported. Calibration values have not been decoded.' };
  if (bytes.length < 20 || bytes.length > MAX_BYTES) return result;
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = at => data.getUint32(at, true);
  const f64 = at => {
    const value = data.getFloat64(at, true);
    if (!Number.isFinite(value)) throw new Error('Invalid scale');
    return value;
  };
  // The signature is a length-prefixed, NUL-terminated string in this layout.
  if (u32(0) !== 11 || decoder.decode(bytes.subarray(4, 16)) !== 'WinOLS File\0') return result;
  result.version = u32(16);
  if (result.version !== 0x255) return result;
  result.supported = true;
  const stringAt = at => {
    const count = u32(at);
    // Stored string references are retained as unresolved, never invented.
    if (count >= 0xffff0000) return { text: '', next: at + 4, unresolved: true };
    if (count > 1024 || at + 4 + count > bytes.length) throw new Error('Invalid string range');
    const text = decoder.decode(bytes.subarray(at + 4, at + 4 + count));
    if (text && !/^[\x20-\x7e\r\n\t]+$/.test(text)) throw new Error('Unsupported string encoding');
    return { text, next: at + 4 + count, unresolved: false };
  };
  const axisAt = (at, count) => {
    const label = stringAt(at);
    for (let i = 0; i < 12; i++) if (bytes[label.next + i] !== 0) throw new Error('Invalid axis padding');
    const unit = stringAt(label.next + 12), p = unit.next;
    if (p + 79 > bytes.length) throw new Error('Truncated axis');
    return { axis: { label: label.text, unit: unit.text, count,
      factor: f64(p), offset: f64(p + 8), source: u32(p + 16), address: u32(p + 20),
      unresolvedText: label.unresolved || unit.unresolved }, next: p + 79 };
  };
  const text = decoder.decode(bytes);
  let rejected = 0, truncated = false;
  for (const match of text.matchAll(/[\x20-\x7e]{3,512}/g)) {
    const at = match.index, end = at + match[0].length;
    if (at < 4 || end + 40 > bytes.length || u32(at - 4) !== match[0].length) continue;
    const words = Array.from({ length: 9 }, (_, i) => u32(end + i * 4));
    if (words[0] || words[1] || words[2] || ![2, 3, 4].includes(words[3]) ||
      ![1, 2, 3].includes(words[4]) || words[5] < 1 || words[5] > 9 ||
      ![1, 2, 4, 8].includes(words[6]) || ![2, 10, 16].includes(words[7])) continue;
    const symbolLength = u32(end + 36);
    if (symbolLength < 1 || symbolLength > 100 || end + 40 + symbolLength > bytes.length) continue;
    const symbol = decoder.decode(bytes.subarray(end + 40, end + 40 + symbolLength));
    if (!/^[A-Za-z_][A-Za-z0-9_\[\].]{0,99}$/.test(symbol)) continue;
    try {
      const s = end + 40 + symbolLength, comment = stringAt(s), shift = comment.next - s - 4;
      const dimension1 = u32(s + 117 + shift), dimension2 = u32(s + 121 + shift);
      if (dimension1 < 1 || dimension1 > 4096 || dimension2 < 1 || dimension2 > 4096) throw new Error('Invalid dimensions');
      const valueLabel = stringAt(s + 137 + shift), unit = stringAt(valueLabel.next), p = unit.next;
      const factor = f64(p), offset = f64(p + 8), address = u32(p + 16), endAddress = u32(p + 20);
      const width = (endAddress - address) / (dimension1 * dimension2);
      if (address > endAddress || endAddress > 0x10000000 || ![1, 2, 4].includes(width)) throw new Error('Invalid image span');
      const first = axisAt(p + 56, dimension1), second = axisAt(first.next, dimension2);
      if (result.records.length >= MAX_RECORDS) { truncated = true; break; }
      const identification = identifyMap({ name: match[0], symbol, unit: unit.text, comment: comment.text });
      result.records.push({ ...identification, id: 'ols-' + at.toString(16),
        name: match[0], symbol, unit: unit.text, comment: comment.text,
        dimension1, dimension2, address, endAddress, factor, offset, axes: [first.axis, second.axis],
        sourceRecordOffset: at - 4, dataOrganization: words[5], cellBytes: width,
        valuesAvailable: false, addressSpace: 'project-image',
        unresolvedText: unit.unresolved || valueLabel.unresolved || comment.unresolved });
    } catch { rejected++; }
  }
  result.counts.total = result.records.length;
  for (const record of result.records) result.counts[record.category]++;
  result.rejected = rejected;
  result.truncated = truncated;
  result.message = result.records.length
    ? `${result.records.length.toLocaleString()} source definitions found. Groups come from saved names and symbols. Calibration values have not been decoded; tables and graphs are unavailable. These definitions belong to this imported project, not automatically to your connected vehicle.`
    : 'No supported map definitions were found in this WinOLS project. Calibration values have not been decoded.';
  if (truncated) result.message += ' The catalogue limit was reached; additional definitions were not loaded.';
  return result;
}
