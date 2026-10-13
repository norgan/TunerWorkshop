export const SENSOR_DEFINITIONS = Object.freeze([
  { key: 'rpm', pid: '0C', label: 'Engine speed', unit: 'rpm', bytes: 2 },
  { key: 'coolantTemperature', pid: '05', label: 'Coolant temperature', unit: '°C', bytes: 1 },
  { key: 'mapPressure', pid: '0B', label: 'Manifold absolute pressure', unit: 'kPa', bytes: 1 },
  { key: 'intakeAirTemperature', pid: '0F', label: 'Intake air temperature', unit: '°C', bytes: 1 },
  { key: 'throttlePosition', pid: '11', label: 'Absolute throttle position', unit: '%', bytes: 1 },
  { key: 'ecuVoltage', pid: '42', label: 'Control module voltage', unit: 'V', bytes: 2 },
].map(Object.freeze));
export const INITIALIZE = Object.freeze(['ATZ', 'ATE0', 'ATL0', 'ATS1', 'ATH1', 'ATM0', 'ATCAF1', 'ATD0', 'ATSP0']);
export const ALLOWED = new Set([...INITIALIZE, 'ATDPN', '0100', '0120', '0140', ...SENSOR_DEFINITIONS.map(sensor => `01${sensor.pid}`)]);
const assert=(condition,message)=>{if(!condition)throw new Error(message);};
export function cleanLines(response, command) {
  assert(typeof response === 'string' && response.length <= 16384, 'Adapter response is too large.');
  const lines = response.toUpperCase().replace(/\0/g, '').replace(/SEARCHING\.{0,3}/g, '').replace(/BUS INIT:\s*OK/g, '').split(/[\r\n>]+/).map(line => line.trim()).filter(Boolean);
  return lines.filter(line => line.replace(/\s/g, '') !== command);
}
export function adapterError(lines) {
  const error = lines.find(line => /(?:^\?$|NO DATA|UNABLE TO CONNECT|STOPPED|ERROR|BUS BUSY|BUFFER FULL|CAN ERROR|LV RESET|ACT ALERT)/.test(line));
  if (error) throw new Error(`ELM327: ${error.slice(0, 160)}`);
}

/** ATDPN describes the selected protocol; 0/A0 is automatic with none selected. */
export function parseProtocolNumber(response) {
  const lines = cleanLines(response, 'ATDPN'); adapterError(lines);
  const match = lines.length === 1 ? /^A?([0-9A-C])$/.exec(lines[0]) : null;
  assert(match, 'Adapter returned an invalid OBD protocol reply to ATDPN. Reconnect the adapter.');
  const protocol = match[1];
  assert(protocol !== '0', `No vehicle connection detected. Connect the adapter to the car and switch the ignition on, then retry. (ATDPN ${lines[0]})`);
  assert(/^[1-9]$/.test(protocol), `Adapter selected protocol ${protocol}, which this sensor reader does not support.`);
  return protocol;
}

/** Decode independent complete frames; never concatenate data from different ECU headers. */
export function parseObdFrames(response, pid, protocol) {
  assert(/^[0-9A-F]{2}$/.test(pid), 'Invalid PID.');
  assert(/^[1-9]$/.test(String(protocol)), 'Unsupported ELM327 protocol.');
  const lines = cleanLines(response, `01${pid}`); adapterError(lines);
  const result = [];
  const can = Number(protocol) >= 6;
  for (const line of lines) {
    const tokens = line.split(/\s+/);
    let ecu, payload;
    if (can) {
      let header, dataTokens;
      if ([6, 8].includes(Number(protocol))) {
        if (!/^7E[8-F]$/.test(tokens[0])) continue;
        header = tokens[0]; dataTokens = tokens.slice(1);
      } else {
        // ELM displays 29-bit headers as four bytes; some compatible adapters join them.
        if (/^18DAF1[0-9A-F]{2}$/.test(tokens[0])) { header = tokens[0]; dataTokens = tokens.slice(1); }
        else if (tokens.slice(0, 3).join('') === '18DAF1' && /^[0-9A-F]{2}$/.test(tokens[3] ?? '')) { header = tokens.slice(0, 4).join(''); dataTokens = tokens.slice(4); }
        else continue;
      }
      if (!dataTokens.length || !dataTokens.every(token => /^[0-9A-F]{2}$/.test(token))) continue;
      const bytes = dataTokens.map(token => parseInt(token, 16));
      // Only J1979 single-frame responses are needed for the explicitly allowed PIDs.
      const count = bytes[0];
      if (count < 3 || count > 7 || bytes.length < count + 1 || bytes.length > 8) continue;
      ecu = header; payload = bytes.slice(1, count + 1);
    } else {
      if (!tokens.every(token => /^[0-9A-F]{2}$/.test(token)) || tokens.length < 7 || tokens.length > 11) continue;
      // J1850 / ISO 9141 / ISO 14230: 3 header bytes, payload, trailing checksum.
      // Frame integrity is checked by the ELM adapter. Headers remain visible for attribution.
      // The transmitter address identifies the ECU. In KWP the first header byte
      // includes message length and therefore changes between PID pages and samples.
      ecu = tokens[2]; payload = tokens.slice(3, -1).map(token => parseInt(token, 16));
    }
    if (payload[0] !== 0x41 || payload[1] !== parseInt(pid, 16)) continue;
    const data = payload.slice(2);
    const expected = ['00', '20', '40'].includes(pid) ? 4 : SENSOR_DEFINITIONS.find(sensor => sensor.pid === pid)?.bytes;
    if (!expected || data.length !== expected) continue;
    const previous = result.find(frame => frame.ecu === ecu);
    assert(!previous || previous.data.every((value, i) => value === data[i]), `Conflicting responses from ECU ${ecu}.`);
    if (!previous) result.push({ ecu, pid, data });
  }
  assert(result.length, `No complete mode 01 PID ${pid} response with an identifiable ECU header.`);
  return result;
}

export function supportedPids(data, base = 0) {
  assert(Array.isArray(data) && data.length === 4 && data.every(value => Number.isInteger(value) && value >= 0 && value <= 255), 'Invalid supported-PID bitmap.');
  assert([0, 32, 64].includes(base), 'Unsupported PID bitmap page.');
  const supported = [];
  for (let bit = 0; bit < 32; bit++) if (data[Math.floor(bit / 8)] & (1 << (7 - bit % 8))) supported.push(base + bit + 1);
  return supported;
}
export function decodeSensor(pid, data) {
  const sensor = SENSOR_DEFINITIONS.find(item => item.pid === pid);
  assert(sensor && Array.isArray(data) && data.length === sensor.bytes && data.every(value => Number.isInteger(value) && value >= 0 && value <= 255), 'Invalid sensor response.');
  const [a, b] = data;
  if (pid === '0C') return (a * 256 + b) / 4;
  if (pid === '05' || pid === '0F') return a - 40;
  if (pid === '0B') return a;
  if (pid === '11') return a * 100 / 255;
  return (a * 256 + b) / 1000;
}
