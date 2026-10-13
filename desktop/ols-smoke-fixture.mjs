/** Generated structural test data. No proprietary calibration bytes or values. */
export function createOlsSmokeFixture(extraRecords = 110) {
  const bytes = new Uint8Array(262144), data = new DataView(bytes.buffer);
  const encoder = new TextEncoder();
  const u32 = (at, value) => data.setUint32(at, value, true);
  const str = (at, text) => { const raw = encoder.encode(text); u32(at, raw.length); bytes.set(raw, at + 4); return at + 4 + raw.length; };
  const f64 = (at, value) => data.setFloat64(at, value, true);
  str(0, 'WinOLS File'); u32(16, 0x255);
  let cursor = 128;
  const axis = (at, name, unit, address) => {
    let p = str(at, name); p = str(p + 12, unit);
    f64(p, 1); f64(p + 8, 0); u32(p + 16, 1); u32(p + 20, address);
    u32(p + 24, 2); u32(p + 28, 2); u32(p + 32, 10);
    return p + 79;
  };
  const records = [
    ['Synthetic boost pressure target', 'TBDPREUTHDYN', 'mBar', 1],
    ['Synthetic base spark advance', 'PQAV', 'deg', 0.0625],
    ['Synthetic hot lambda target', 'PQLAMMP', 'lambda', 1 / 1024],
    ['Synthetic miscellaneous temperature', 'UNKNOWN', 'C', 1],
    ['Synthetic base spark advance alternate', 'PQAV', 'deg', 0.0625],
    ...Array.from({ length: extraRecords }, (_, i) => ['Synthetic unrelated parameter ' + i, 'UNRELATED_' + i, '', 1]),
  ];
  for (const [index, [name, symbol, unit, scale]] of records.entries()) {
    const end = str(cursor, name);
    [0, 0, 0, 4, 1, 2, 2, 10, 0].forEach((word, i) => u32(end + i * 4, word));
    const s = str(end + 36, symbol); str(s, '');
    u32(s + 117, 2); u32(s + 121, 3);
    let p = str(s + 137, 'Value'); p = str(p, unit);
    f64(p, scale); f64(p + 8, 0); u32(p + 16, 0x100 + index * 12); u32(p + 20, 0x10c + index * 12);
    const next = axis(p + 56, 'Engine speed', 'rpm', 0x80);
    cursor = axis(next, 'Engine load', '%', 0x90) + 16;
  }
  return bytes.slice(0, cursor + 64);
}
