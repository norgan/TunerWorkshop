import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SensorSession, SENSOR_DEFINITIONS, parseObdFrames, supportedPids, decodeSensor } from '../elm.mjs';
import { parseProtocolNumber } from '../elm-protocol.mjs';

const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
function bitmap(pids, base = 0) {
  const bytes = [0, 0, 0, 0];
  for (const pid of pids) { const bit = pid - base - 1; bytes[Math.floor(bit / 8)] |= 1 << (7 - bit % 8); }
  return bytes;
}
const hex = value => value.toString(16).toUpperCase().padStart(2, '0');
function frame(pid, bytes, ecu = '7E8') { return `${ecu} ${hex(bytes.length + 2)} 41 ${pid} ${bytes.map(hex).join(' ')}\r>`; }
function mockDriver({ reply, openDelay = 0, openError = null } = {}) {
  return class MockPort extends EventEmitter {
    static instances = [];
    static async list() { return [{ path: 'TEST_PORT', manufacturer: 'Mock adapter' }]; }
    constructor(options) { super(); this.options = options; this.isOpen = false; this.writes = []; this.closed = false; this.active = false; this.constructor.instances.push(this); }
    open(callback) { setTimeout(() => { if (openError) return callback(new Error(openError)); this.isOpen = true; callback(null); }, openDelay); }
    close(callback) { this.isOpen = false; this.closed = true; this.emit('close'); callback?.(null); }
    destroy() { this.isOpen = false; this.closed = true; }
    write(text, callback) {
      assert.equal(this.active, false, 'Commands must be serialized'); this.active = true;
      const command = text.replace(/\r$/, ''); this.writes.push(command); callback?.(null);
      let response = reply?.(command, this.writes.length, this);
      if (response === undefined) response = command === 'ATZ' ? 'ATZ\rELM327 v2.3\r>' : command.startsWith('AT') ? command === 'ATDPN' ? 'A6\r>' : 'OK\r>' : command === '0100' ? frame('00', bitmap([5, 11, 12, 15, 17, 32])) : command === '0120' ? frame('20', bitmap([64], 32)) : command === '0140' ? frame('40', bitmap([66], 64)) : frame(command.slice(2), ({ '0C': [0x1A, 0xF8], '05': [123], '0B': [99], '0F': [60], '11': [128], '42': [0x36, 0xB0] })[command.slice(2)]);
      if (response === null) return;
      const chunks = Array.isArray(response) ? response : [response];
      setImmediate(() => { chunks.forEach((chunk, index) => { if (index === chunks.length - 1) this.active = false; if (this.isOpen) this.emit('data', Buffer.from(chunk)); }); });
    }
  };
}
function sessionFor(Driver, options = {}) { return new SensorSession({ loadDriver: async () => Driver, commandTimeoutMs: 200, searchTimeoutMs: 200, pollIntervalMs: 100, ...options }); }
function mockSocket(options = {}) {
  const Driver = mockDriver(options);
  return class MockSocket extends Driver {
    constructor() { super({}); this.destroyed = false; this.connectOptions = null; }
    connect(options) { this.connectOptions = options; super.open(error => { if (this.destroyed) { this.isOpen = false; return; } error ? this.emit('error', error) : this.emit('connect'); }); return this; }
    setNoDelay(value) { this.noDelay = value; }
    destroy() { if (this.destroyed) return this; this.destroyed = true; super.close(); return this; }
  };
}
function wifiSession(Socket, options = {}) {
  return new SensorSession({ loadDriver: async () => { throw new Error('Wi-Fi must not load the serial driver'); }, createSocket: () => new Socket(), commandTimeoutMs: 200, searchTimeoutMs: 200, pollIntervalMs: 100, ...options });
}
function waitSamples(session, count = 1) {
  return new Promise((resolve, reject) => {
    const samples = [], timer = setTimeout(() => { cleanup(); reject(new Error('Sample wait timed out')); }, 3000);
    const onSample = sample => { samples.push(sample); if (samples.length === count) { cleanup(); resolve(samples); } };
    const onFault = fault => { cleanup(); reject(new Error(fault.message)); };
    const cleanup = () => { clearTimeout(timer); session.off('sample', onSample); session.off('fault', onFault); };
    session.on('sample', onSample); session.on('fault', onFault);
  });
}

test('Bluetooth Classic uses a fresh enumerated COM port and preserves its transport identity',async()=>{
  const Driver=mockDriver(),session=sessionFor(Driver),sample=waitSamples(session);
  const state=await session.connect({transport:'bluetooth',path:'TEST_PORT',baudRate:115200});
  assert.equal(state.transport,'bluetooth');assert.equal(state.path,'TEST_PORT');assert.equal(Driver.instances[0].options.baudRate,115200);assert.equal(state.readOnly,true);
  assert.deepEqual((await sample)[0].values,{rpm:1726});await session.disconnect();assert.equal(Driver.instances[0].closed,true);
  await assert.rejects(session.connect({transport:'bluetooth',path:'MISSING'}),/paired Bluetooth/);
});
test('Bluetooth Classic has a bounded open timeout and closes a late port',async()=>{
  const Driver=mockDriver({openDelay:60}),session=sessionFor(Driver,{bluetoothOpenTimeoutMs:15});
  await assert.rejects(session.connect({transport:'bluetooth',path:'TEST_PORT'}),/outgoing COM port/);await tick(75);assert.equal(Driver.instances[0].closed,true);assert.equal(Driver.instances[0].writes.length,0);
});

test('PID decoding follows standard byte formulas and rejects incomplete input', () => {
  assert.equal(decodeSensor('0C', [0x1A, 0xF8]), 1726);
  assert.equal(decodeSensor('05', [123]), 83);
  assert.equal(decodeSensor('0F', [0]), -40);
  assert.equal(decodeSensor('0B', [99]), 99);
  assert.equal(decodeSensor('11', [255]), 100);
  assert.equal(decodeSensor('42', [0x36, 0xB0]), 14);
  assert.throws(() => decodeSensor('0C', [20]));
  assert.throws(() => decodeSensor('FF', [20]));
  assert.throws(() => decodeSensor('05', [-1]));
  assert.equal(SENSOR_DEFINITIONS.some(sensor => sensor.key === 'adapterVoltage'), false);
});

test('supported bitmaps preserve boundaries and independent pages', () => {
  assert.deepEqual(supportedPids([0x80, 0, 0, 1]), [1, 32]);
  assert.deepEqual(supportedPids([0, 0, 0, 1], 32), [64]);
  assert.deepEqual(supportedPids([0x40, 0, 0, 0], 64), [66]);
  assert.throws(() => supportedPids([0, 0, 0]));
});

test('protocol numbers preserve supported manual and automatic protocols with echoed commands', () => {
  for (let number = 1; number <= 9; number++) {
    assert.equal(parseProtocolNumber(`${number}\r>`), String(number));
    assert.equal(parseProtocolNumber(`\0at dpn\r\n a${number}\r\r>`), String(number));
  }
});

test('automatic protocol without a selected vehicle protocol is distinct from unsupported protocols', () => {
  for (const response of ['0\r>', 'A0\r\r>']) {
    assert.throws(() => parseProtocolNumber(response), error => /No vehicle connection detected/.test(error.message) && !/unsupported|does not support/.test(error.message));
  }
  for (const response of ['A', 'B', 'C', 'AA', 'AB', 'AC']) {
    assert.throws(() => parseProtocolNumber(`${response}\r>`), /which this sensor reader does not support/);
  }
});

test('protocol metadata rejects malformed, conflicting and error responses', () => {
  for (const response of ['', 'A6\rA7', 'A6\rOK', 'A6 ignored', 'A 6', '06', 'AUTO', 'A10', 'D', 'A6\x01', '7E8 06 41 00 00 10 00 00']) {
    assert.throws(() => parseProtocolNumber(`${response}\r>`), /invalid OBD protocol reply/);
  }
  assert.throws(() => parseProtocolNumber('?\r>'), /ELM327: \?/);
  assert.throws(() => parseProtocolNumber('CAN ERROR\r>'), /ELM327: CAN ERROR/);
  assert.throws(() => parseProtocolNumber('A'.repeat(16385)), /too large/);
});

test('CAN parser handles echo, search text, padding and separate ECU responses', () => {
  const result = parseObdFrames('010C\rSEARCHING...\r7E9 04 41 0C 0F A0 00 00 00\r7E8 04 41 0C 1A F8\r>', '0C', '6');
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], { ecu: '7E9', pid: '0C', data: [15, 160] });
  assert.deepEqual(result[1], { ecu: '7E8', pid: '0C', data: [26, 248] });
  assert.deepEqual(parseObdFrames('18 DA F1 10 03 41 05 7B\r>', '05', '7')[0], { ecu: '18DAF110', pid: '05', data: [123] });
  assert.equal(parseObdFrames('18DAF110 03 41 05 7B\r>', '05', '9')[0].ecu, '18DAF110');
});

test('legacy header parsing keeps source and payload separate', () => {
  const frames = parseObdFrames('48 6B 10 41 00 BE 3E B8 11 FA\r48 6B 18 41 00 80 10 80 00 C0\r>', '00', '3');
  assert.deepEqual(frames.map(item => item.ecu), ['10', '18']);
  assert.deepEqual(frames[0].data, [0xBE, 0x3E, 0xB8, 0x11]);
  assert.equal(parseObdFrames('86 F1 10 41 00 BE 3E B8 11 FF\r>', '00', '5')[0].ecu, parseObdFrames('83 F1 10 41 05 7B FF\r>', '05', '5')[0].ecu);
});

test('malformed, headerless, truncated, mixed, conflicting and error frames fail closed', () => {
  for (const raw of ['41 0C 1A F8>', '7E8 04 41 0C 1A\r7E9 F8>', '7E8 10 04 41 0C 1A F8>', '7E8 03 41 05 7B>', 'NO DATA>', 'CAN ERROR>', '?', '7E8 04 41 0C 1A F8\r7E8 04 41 0C 00 00>']) assert.throws(() => parseObdFrames(raw, '0C', '6'));
});

test('connect discovers supported sensors and emits real timestamps from one ECU', async () => {
  const Driver = mockDriver({ reply: command => command === '010C' ? ['010C\r7E9 04 41 0C 00 04\r7E8 04 41 ', '0C 1A F8\r', '>'] : undefined });
  const session = sessionFor(Driver), samplesPromise = waitSamples(session, 6);
  try {
    const connected = await session.connect({ path: 'TEST_PORT', baudRate: 38400 });
    assert.equal(connected.status, 'streaming'); assert.equal(connected.ecu, '7E8');
    assert.equal(connected.supportedSensors.length, 6);
    const samples = await samplesPromise;
    assert.deepEqual(samples[0].values, { rpm: 1726 });
    assert.ok(samples.every(sample => sample.ecu === '7E8' && Number.isFinite(Date.parse(sample.timestamp)) && Object.keys(sample.values).length === 1));
    const state = session.snapshot(); assert.equal(state.values.ecuVoltage, 14);
    state.values.rpm = 0; assert.equal(session.snapshot().values.rpm, 1726);
    assert.ok(Driver.instances[0].writes.every(command => /^AT(?:Z|E0|L0|S1|H1|M0|CAF1|D0|SP0|DPN)$|^01(?:00|20|40|0C|05|0B|0F|11|42)$/.test(command)));
  } finally { await session.disconnect(); }
  assert.equal(Driver.instances[0].closed, true);
  assert.equal(session.snapshot().status, 'disconnected');
});

test('initial vehicle discovery errors stop before protocol metadata can mask the cause', async () => {
  for (const failure of ['UNABLE TO CONNECT', 'NO DATA', 'CAN ERROR', 'BUS INIT: ...ERROR', 'STOPPED']) {
    const Driver = mockDriver({ reply: command => command === '0100' ? `0100\rSEARCHING...\r${failure}\r>` : command === 'ATDPN' ? 'A0\r\r>' : undefined });
    const session = sessionFor(Driver), samples = [];
    session.on('sample', sample => samples.push(sample));
    await assert.rejects(session.connect({ path: 'TEST_PORT' }), error => error.message.includes(failure));
    assert.equal(Driver.instances[0].writes.includes('ATDPN'), false);
    assert.equal(Driver.instances[0].writes.at(-1), '0100');
    assert.equal(Driver.instances[0].closed, true);
    assert.equal(session.snapshot().status, 'error');
    assert.equal(session.snapshot().protocol, null);
    assert.deepEqual(session.snapshot().values, {});
    assert.deepEqual(samples, []);
  }
});

test('unselected, unsupported and malformed protocol metadata never starts sensor polling', async () => {
  for (const [reply, message] of [['A0\r\r>', /No vehicle connection detected/], ['0\r>', /No vehicle connection detected/], ['AB\r>', /does not support/], ['A6\rA7\r>', /invalid OBD protocol reply/]]) {
    const Driver = mockDriver({ reply: command => command === 'ATDPN' ? reply : undefined });
    const session = sessionFor(Driver), samples = [];
    session.on('sample', sample => samples.push(sample));
    await assert.rejects(session.connect({ path: 'TEST_PORT' }), message);
    assert.equal(Driver.instances[0].writes.at(-1), 'ATDPN');
    assert.equal(Driver.instances[0].closed, true);
    assert.equal(session.snapshot().protocol, null);
    assert.deepEqual(session.snapshot().supportedSensors, []);
    assert.deepEqual(samples, []);
  }
});

test('unsupported sensors and unsupported bitmap pages are never requested', async () => {
  const Driver = mockDriver({ reply: command => command === '0100' ? frame('00', bitmap([12])) : undefined });
  const session = sessionFor(Driver), samplePromise = waitSamples(session);
  try {
    await session.connect({ path: 'TEST_PORT' }); await samplePromise;
    assert.deepEqual(session.snapshot().supportedSensors, ['rpm']);
    assert.equal(Driver.instances[0].writes.includes('0120'), false);
    assert.equal(Driver.instances[0].writes.includes('0140'), false);
    assert.equal(Driver.instances[0].writes.includes('0105'), false);
  } finally { await session.disconnect(); }
});

test('path must match fresh enumeration and baud must be explicitly supported', async () => {
  const Driver = mockDriver(), session = sessionFor(Driver);
  await assert.rejects(session.connect({ path: 'ARBITRARY_PORT' }), /no longer available/);
  assert.equal(Driver.instances.length, 0);
  await assert.rejects(session.connect({ path: 'TEST_PORT', baudRate: 12345 }), /baud rate/);
  assert.equal(Driver.instances.length, 0);
});

test('timeouts stop requests, close the adapter, and cannot produce late samples', async () => {
  const Driver = mockDriver({ reply: command => command === '010C' ? null : undefined });
  const session = sessionFor(Driver, { commandTimeoutMs: 25 }), samples = [];
  session.on('sample', sample => samples.push(sample));
  const failed = new Promise(resolve => session.once('fault', resolve));
  await session.connect({ path: 'TEST_PORT' });
  const fault = await failed;
  assert.match(fault.message, /timed out/); assert.equal(session.snapshot().status, 'error');
  const port = Driver.instances[0], count = port.writes.length;
  port.emit('data', Buffer.from('7E8 04 41 0C 1A F8\r>'));
  await tick(130);
  assert.equal(port.closed, true); assert.equal(port.writes.length, count); assert.equal(samples.length, 0);
});

test('NO DATA and another ECU reply do not silently reuse previous sensor data', async () => {
  for (const response of ['NO DATA\r>', frame('0C', [0, 4], '7E9')]) {
    const Driver = mockDriver({ reply: command => command === '010C' ? response : undefined });
    const session = sessionFor(Driver), failed = new Promise(resolve => session.once('fault', resolve));
    await session.connect({ path: 'TEST_PORT' }); await failed;
    assert.equal(session.snapshot().status, 'error'); assert.deepEqual(session.snapshot().values, {});
    assert.equal(Driver.instances[0].closed, true);
  }
});

test('manual disconnect cancels pending polling and no commands continue', async () => {
  const Driver = mockDriver(), session = sessionFor(Driver);
  await session.connect({ path: 'TEST_PORT' }); await session.disconnect();
  const count = Driver.instances[0].writes.length; await tick(150);
  assert.equal(Driver.instances[0].writes.length, count);
  assert.equal(session.snapshot().status, 'disconnected');
});

test('disconnect while port opening prevents initialization and closes the late port', async () => {
  const Driver = mockDriver({ openDelay: 40 }), session = sessionFor(Driver);
  const connecting = session.connect({ path: 'TEST_PORT' });
  const rejected = assert.rejects(connecting, /cancelled/);
  await tick(10); await session.disconnect(); await rejected;
  assert.equal(Driver.instances[0].writes.length, 0); assert.equal(Driver.instances[0].closed, true);
});

test('opening timeout closes a late-opened driver without sending setup commands', async () => {
  const Driver = mockDriver({ openDelay: 80 }), session = sessionFor(Driver, { commandTimeoutMs: 20 });
  await assert.rejects(session.connect({ path: 'TEST_PORT' }), /Timed out opening/);
  await tick(100);
  assert.equal(Driver.instances[0].writes.length, 0); assert.equal(Driver.instances[0].closed, true);
  assert.equal(session.snapshot().status, 'error');
});

test('overlong responses stop the session before any values are published', async () => {
  const Driver = mockDriver({ reply: command => command === '0100' ? 'X'.repeat(16385) : undefined });
  const session = sessionFor(Driver);
  await assert.rejects(session.connect({ path: 'TEST_PORT' }), /buffer limit/);
  assert.equal(Driver.instances[0].closed, true); assert.deepEqual(session.snapshot().values, {});
});

test('supported-PID pages cannot be borrowed from another ECU', async () => {
  const Driver = mockDriver({ reply: command => command === '0120' ? frame('20', bitmap([64], 32), '7E9') : undefined });
  const session = sessionFor(Driver);
  await assert.rejects(session.connect({ path: 'TEST_PORT' }), /selected ECU/);
  assert.equal(Driver.instances[0].closed, true); assert.equal(Driver.instances[0].writes.includes('0140'), false);
});

test('serial errors, open failure, and extra prompts terminate cleanly', async () => {
  const FailingDriver = mockDriver({ openError: 'Access denied' }), failed = sessionFor(FailingDriver);
  await assert.rejects(failed.connect({ path: 'TEST_PORT' }), /Access denied/);
  assert.equal(failed.snapshot().status, 'error');
  const ExtraDriver = mockDriver({ reply: command => command === 'ATE0' ? 'OK\r>OK\r>' : undefined }), extra = sessionFor(ExtraDriver);
  await assert.rejects(extra.connect({ path: 'TEST_PORT' }), /extra adapter/);
  assert.equal(ExtraDriver.instances[0].closed, true);
  const Driver = mockDriver(), session = sessionFor(Driver);
  await session.connect({ path: 'TEST_PORT' }); Driver.instances[0].emit('error', new Error('Cable removed'));
  assert.equal(session.snapshot().status, 'error'); assert.match(session.snapshot().error, /Cable removed/);
});

test('Wi-Fi TCP transport reads supported sensors without the serial dependency', async () => {
  const Socket = mockSocket({ reply: command => command === '010C' ? ['7E8 04 41 0C ', '1A F8\r>'] : undefined });
  const session = wifiSession(Socket), samples = waitSamples(session);
  try {
    const state = await session.connect({ transport: 'wifi', host: '192.168.0.10' });
    assert.equal(state.transport, 'wifi'); assert.equal(state.host, '192.168.0.10'); assert.equal(state.port, 35000);
    assert.equal(state.path, null); assert.equal(state.baudRate, null); assert.equal(state.readOnly, true);
    assert.deepEqual(Socket.instances[0].connectOptions, { host: '192.168.0.10', port: 35000, family: 4 });
    assert.equal(Socket.instances[0].noDelay, true);
    assert.deepEqual((await samples)[0].values, { rpm: 1726 });
  } finally { await session.disconnect(); }
  assert.equal(Socket.instances[0].destroyed, true);
  assert.equal(session.snapshot().status, 'disconnected');
});

test('Wi-Fi rejects public, loopback, link-local, hostname, IPv6 and malformed destinations before creating a socket', async () => {
  let created = 0;
  const session = new SensorSession({ createSocket: () => { created++; throw new Error('Should not create socket'); } });
  for (const host of ['8.8.8.8', '127.0.0.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '172.15.0.1', '172.32.0.1', '192.169.0.1', 'localhost', 'adapter.local', '::1', '::ffff:192.168.0.10', 'http://192.168.0.10', '192.168.0.256', '192.168.000.10', ' 192.168.0.10', '192.168.0.10\n', '3232235530', '', null]) await assert.rejects(session.connect({ transport: 'wifi', host }));
  for (const port of [0, 80, 1023, 65536, 35000.5, '35000', null, NaN, Infinity]) await assert.rejects(session.connect({ transport: 'wifi', host: '192.168.0.10', port }));
  await assert.rejects(session.connect({ transport: 'http', host: '192.168.0.10' }));
  assert.equal(created, 0); assert.equal(session.snapshot().status, 'disconnected');
});

test('Wi-Fi permits the exact RFC1918 ranges and custom nonprivileged ports', async () => {
  for (const host of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.255.254']) {
    const Socket = mockSocket(), session = wifiSession(Socket);
    await session.connect({ transport: 'wifi', host, port: 1024 });
    assert.deepEqual(Socket.instances[0].connectOptions, { host, port: 1024, family: 4 });
    await session.disconnect();
  }
});

test('Wi-Fi response timeout destroys its socket and prevents late data or polling', async () => {
  const Socket = mockSocket({ reply: command => command === '010C' ? null : undefined });
  const session = wifiSession(Socket, { commandTimeoutMs: 25 }), samples = [];
  session.on('sample', sample => samples.push(sample));
  const failed = new Promise(resolve => session.once('fault', resolve));
  await session.connect({ transport: 'wifi', host: '192.168.0.10', port: 35000 }); await failed;
  const socket = Socket.instances[0], count = socket.writes.length;
  socket.emit('data', Buffer.from('7E8 04 41 0C 1A F8\r>')); await tick(150);
  assert.equal(socket.destroyed, true); assert.equal(socket.writes.length, count); assert.equal(samples.length, 0);
  assert.equal(session.snapshot().status, 'error'); assert.match(session.snapshot().error, /timed out/);
});

test('Wi-Fi connect timeout and cancellation destroy sockets still connecting', async () => {
  const SlowSocket = mockSocket({ openDelay: 100 }), timeoutSession = wifiSession(SlowSocket, { commandTimeoutMs: 20 });
  await assert.rejects(timeoutSession.connect({ transport: 'wifi', host: '10.0.0.1' }), /Timed out opening/);
  assert.equal(SlowSocket.instances[0].destroyed, true); await tick(120);
  assert.equal(SlowSocket.instances[0].writes.length, 0);
  const Socket = mockSocket({ openDelay: 100 }), session = wifiSession(Socket);
  const connecting = session.connect({ transport: 'wifi', host: '10.0.0.1' });
  const rejected = assert.rejects(connecting, /cancelled/);
  await session.disconnect(); await rejected;
  assert.equal(Socket.instances[0].destroyed, true); assert.equal(Socket.instances[0].writes.length, 0);
});

test('Wi-Fi connection refusal, remote end and abrupt close all stop cleanly', async () => {
  const Refused = mockSocket({ openError: 'ECONNREFUSED' }), failed = wifiSession(Refused);
  await assert.rejects(failed.connect({ transport: 'wifi', host: '192.168.0.10' }), /ECONNREFUSED/);
  assert.equal(Refused.instances[0].destroyed, true);
  for (const event of ['end', 'close']) {
    const Socket = mockSocket(), session = wifiSession(Socket);
    await session.connect({ transport: 'wifi', host: '192.168.0.10' });
    Socket.instances[0].emit(event);
    assert.equal(session.snapshot().status, 'error'); assert.equal(Socket.instances[0].destroyed, true);
    const count = Socket.instances[0].writes.length; await tick(120); assert.equal(Socket.instances[0].writes.length, count);
  }
});

test('a Wi-Fi connect cancelled synchronously from status never creates a socket', async () => {
  let created = 0;
  const session = new SensorSession({ createSocket: () => { created++; throw new Error('Should not create socket'); } });
  session.on('status', state => { if (state.status === 'connecting') void session.disconnect(); });
  await assert.rejects(session.connect({ transport: 'wifi', host: '192.168.0.10' }), /cancelled/);
  assert.equal(created, 0); assert.equal(session.snapshot().status, 'disconnected');
});
