import test from 'node:test';
import assert from 'node:assert/strict';
import { MES_LOG_LIMITS, parseMesLog } from '../mes-log.mjs';

// Synthetic structure and values only. No real diagnostic log is copied here.
const header = `(Multiecuscan 4.7R3)
01/02/2026 10:30:00 AM
Fiat 500X 1.4 16V T-Jet/MultiAir
Magneti Marelli IAW 8GMK CF6/EOBD Injection (1.4)
--------------------------------------------------------------
ECU ISO code: 00 01 02 03 04
FIAT drawing number: 55000000
Hardware number: TEST8GMKHW001
Hardware version: 01
Software number: TESTSW01
Software version: 0001
Homologation number: TEST01
`;

test('reads whitelisted historical identification and full channel names', () => {
  const result = parseMesLog(`\uFEFF${header}READING PARAMETERS:
IBS Battery charge status: 75 %
Maximum engine over-rev RPM: 3000 rpm
Turbo vacuum valve: Not active
READING PARAMETERS:
IBS Battery charge status: 76 %
Turbo vacuum valve: Active
`);
  assert.equal(result.appVersion, '4.7R3');
  assert.equal(result.date, '01/02/2026 10:30:00 AM');
  assert.equal(result.vehicle, 'Fiat 500X 1.4 16V T-Jet/MultiAir');
  assert.equal(result.module, 'Magneti Marelli IAW 8GMK CF6/EOBD Injection (1.4)');
  assert.deepEqual(result.identity, {
    ecuIsoCode: '00 01 02 03 04', fiatDrawingNumber: '55000000',
    hardwareNumber: 'TEST8GMKHW001', hardwareVersion: '01',
    softwareNumber: 'TESTSW01', softwareVersion: '0001', homologationNumber: 'TEST01',
  });
  assert.deepEqual(result.channels, [
    { name: 'IBS Battery charge status', unit: '%', samples: [{ time: null, value: 75 }, { time: null, value: 76 }] },
    { name: 'Maximum engine over-rev RPM', unit: 'rpm', samples: [{ time: null, value: 3000 }] },
    { name: 'Turbo vacuum valve', unit: '', samples: [{ time: null, value: 'Not active' }, { time: null, value: 'Active' }] },
  ]);
  assert.match(result.limitations.join(' '), /historical.*no vehicle is connected/);
  assert.match(result.limitations.join(' '), /not elapsed time/);
});

test('does not mix freeze-frame readings with parameter streams or claim faults are current', () => {
  const result = parseMesLog(`${header}READING ERROR CODES:
1. P0100-00 - Example air flow sensor
  Engine speed: 0 rpm
  ERROR DETAILS:
  Battery voltage:  V
CLEARING STORED FAULT CODES...
READING ERROR CODES:
No fault codes
READING ERROR CODES:
1. P0100-00 - Example air flow sensor
READING PARAMETERS:
Engine speed: 800 rpm
`);
  assert.deepEqual(result.faults, [{ code: 'P0100-00', description: 'Example air flow sensor' }]);
  assert.deepEqual(result.channels, [{ name: 'Engine speed', unit: 'rpm', samples: [{ time: null, value: 800 }] }]);
  assert.match(result.limitations.join(' '), /fault-clear request.*does not establish success/);
});

test('omits identifying or arbitrary metadata without retaining the source text', () => {
  const result = parseMesLog(`${header}VIN: [omitted]
License: [omitted]
Serial number: [omitted]
Unknown header: arbitrary payload
READING PARAMETERS:
Odometer: 999 km
Registration number: [omitted]
License activation: [omitted]
Hardware number: TEST01
Engine speed: 1200 rpm
`);
  assert.deepEqual(Object.keys(result).sort(), ['appVersion', 'channels', 'date', 'faults', 'identity', 'limitations', 'module', 'vehicle']);
  assert.deepEqual(result.channels.map(channel => channel.name), ['Engine speed']);
  assert.equal(JSON.stringify(result).includes('[omitted]'), false);
  assert.equal(JSON.stringify(result).includes('arbitrary payload'), false);
  const malformedHeader = parseMesLog(header.replace('Fiat 500X 1.4 16V T-Jet/MultiAir', 'Owner: [omitted]'));
  assert.equal(malformedHeader.vehicle, '');
});

test('handles decimal commas, negatives, CRLF and changes of unit without invented timing', () => {
  const result = parseMesLog(`${header}READING PARAMETERS:
Spark advance: -1,25 deg.
Battery voltage: 13.7 V
Boost pressure: 1,05 bar
READING PARAMETERS:
Boost pressure: 1050 mbar
`.replaceAll('\n', '\r\n'));
  assert.deepEqual(result.channels.map(channel => [channel.name, channel.unit, channel.samples[0].value]), [
    ['Spark advance', 'deg.', -1.25], ['Battery voltage', 'V', 13.7],
    ['Boost pressure', 'bar', 1.05], ['Boost pressure', 'mbar', 1050],
  ]);
  assert.ok(result.channels.every(channel => channel.samples.every(sample => sample.time === null)));
});

test('ends the parameter section before an unrelated operation payload', () => {
  const result = parseMesLog(`${header}READING PARAMETERS:
Engine speed: 900 rpm
EXECUTING ADJUSTMENT...
New value: 4000 rpm
`);
  assert.deepEqual(result.channels.map(channel => channel.name), ['Engine speed']);
});

test('rejects unsupported files and combined sessions; invalid dates are not silently normalized', () => {
  assert.throws(() => parseMesLog(null), TypeError);
  assert.throws(() => parseMesLog('plain text'), /not a supported/);
  assert.throws(() => parseMesLog(header + header), /one MultiECUScan session/);
  const result = parseMesLog(header.replace('01/02/2026', '31/02/2026'));
  assert.equal(result.date, '');
  assert.match(result.limitations.join(' '), /date was missing or could not be interpreted/);
});

test('enforces byte, line, line length and sample limits', () => {
  assert.throws(() => parseMesLog('x'.repeat(MES_LOG_LIMITS.bytes + 1)), /5 MiB/);
  assert.throws(() => parseMesLog('é'.repeat(MES_LOG_LIMITS.bytes / 2 + 1)), /5 MiB/);
  assert.throws(() => parseMesLog(header + '\n'.repeat(MES_LOG_LIMITS.lines)), /line limit/);
  assert.throws(() => parseMesLog(header + 'x'.repeat(MES_LOG_LIMITS.lineLength + 1)), /line is too long/);
  assert.throws(() => parseMesLog(`${header}READING PARAMETERS:\n${'Engine speed: 800 rpm\n'.repeat(MES_LOG_LIMITS.samples + 1)}`), /sample limit/);
});

test('enforces distinct channel and fault limits', () => {
  const channels = Array.from({ length: MES_LOG_LIMITS.channels + 1 }, (_, i) => `Example parameter ${i}: 1 V`).join('\n');
  assert.throws(() => parseMesLog(`${header}READING PARAMETERS:\n${channels}`), /channel limit/);
  const faults = Array.from({ length: MES_LOG_LIMITS.faults + 1 }, (_, i) => `P${i.toString(16).padStart(4, '0')} - Example sensor`).join('\n');
  assert.throws(() => parseMesLog(`${header}READING ERROR CODES:\n${faults}`), /fault limit/);
});
