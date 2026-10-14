import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BaseSensorSession } from '../sensor-session.mjs';
import { FIAT_8GMK_DEFINITIONS } from '../fiat-8gmk.mjs';

const hex = value => value.toString(16).toUpperCase().padStart(2, '0');
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
function canReply(payload, source = '18 DA F1 10') {
  const frames = [];
  if (payload.length <= 7) frames.push([payload.length, ...payload]);
  else {
    frames.push([0x10 | payload.length >> 8, payload.length & 255, ...payload.slice(0, 6)]);
    for (let offset = 6, sequence = 1; offset < payload.length; offset += 7, sequence = (sequence + 1) & 15) {
      frames.push([0x20 | sequence, ...payload.slice(offset, offset + 7)]);
    }
  }
  return frames.map(frame => `${source} ${frame.map(hex).join(' ')}`).join('\r') + '\r>';
}
const didReply = (request, data, source) => canReply([0x62, Number.parseInt(request.slice(2, 4), 16), Number.parseInt(request.slice(4), 16), ...data], source);
const joinReplies = (...replies) => replies.map((reply, index) => index === replies.length - 1 ? reply : reply.replace('>', '')).join('');
function defaultReply(command) {
  if (command === 'ATZ') return 'ELM327 v2.3\r>';
  if (command.startsWith('AT')) return 'OK\r>';
  if (command === '1003') return canReply([0x50, 3, 0, 50, 1, 244]);
  if (command === '1092') return canReply([0x50, 0x92]);
  if (command === '3E00') return canReply([0x7e, 0]);
  if (command === '22F1A5') return didReply(command, [0, 1, 0x50, 0xa8, 0x15]);
  if (command === '22F192') return didReply(command, [...Buffer.from('MM8GMKHW670')]);
  if (command === '22F194') return didReply(command, [...Buffer.from('V862MH97   ')]);
  if (command === '221000') return didReply(command, [0x0c, 0x80]);
  if (command === '221804') return didReply(command, [0x30]);
  const row = FIAT_8GMK_DEFINITIONS.find(definition => definition.request === command);
  assert.ok(row, `Unexpected command ${command}`);
  return didReply(command, new Array(Math.max(...FIAT_8GMK_DEFINITIONS.filter(d => d.request === command).map(d => d.startByte + d.bytes))).fill(0));
}
function fixture(t, { reply, openDelay = 0, timeout = 300 } = {}) {
  class Port extends EventEmitter {
    isOpen = false; writes = []; active = false; closed = false;
    open(callback) { setTimeout(() => { this.isOpen = true; callback(null); }, openDelay); }
    close(callback) { this.isOpen = false; this.closed = true; this.active = false; this.emit('close'); callback?.(); }
    write(text, callback) {
      assert.equal(this.active, false, 'Only one command can be in flight');
      this.active = true;
      const command = text.trim(); this.writes.push(command); this.emit('write', command); callback?.();
      const response = reply?.(command, this) ?? defaultReply(command);
      if (response === false) return;
      const chunks = [response.slice(0, 5), response.slice(5, 19), response.slice(19)];
      setImmediate(() => {
        for (const [index, chunk] of chunks.entries()) {
          if (index === chunks.length - 1) this.active = false;
          if (this.isOpen) this.emit('data', Buffer.from(chunk));
        }
      });
    }
  }
  const port = new Port();
  const session = new BaseSensorSession({ createPort: () => port, validateConnection: () => {}, commandTimeoutMs: timeout, pollIntervalMs: 100 });
  t.after(() => session.disconnect());
  return { session, port, connect: channels => session.connect({ path: 'SYNTHETIC', profileId: 'fiat-8gmk', channels: channels ?? ['mes-10500'] }) };
}
function events(session, name, count = 1, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const collected = [];
    const cleanup = () => { clearTimeout(timer); session.off(name, listener); if (name !== 'fault') session.off('fault', fault); };
    const listener = event => { collected.push(event); if (collected.length >= count) { cleanup(); resolve(collected); } };
    const fault = event => { cleanup(); reject(new Error(event.message)); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${name}`)); }, timeout);
    session.on(name, listener); if (name !== 'fault') session.on('fault', fault);
  });
}

test('manufacturer session identifies the ECU with multi-frame replies before grouped parameter polling', async t => {
  const f = fixture(t), samples = events(f.session, 'sample', 2);
  const state = await f.connect(['mes-10500', 'mes-10024', 'mes-10018']);
  assert.equal(state.identity.hardwareNumber, 'MM8GMKHW670');
  assert.equal(state.identity.softwareNumber, 'V862MH97');
  assert.equal(state.ecu, '18DAF110');
  const readings = await samples;
  assert.deepEqual(readings[0].values, { 'mes-10500': 800 });
  assert.deepEqual(readings[1].values, { 'mes-10024': 'ON', 'mes-10018': 'ON' });
  assert.equal(f.port.writes.filter(command => command === '221804').length, 1);
  const isoAt = f.port.writes.indexOf('22F1A5'), hardwareAt = f.port.writes.indexOf('22F192'), softwareAt = f.port.writes.indexOf('22F194'), pollAt = f.port.writes.indexOf('221000');
  assert.ok(isoAt < hardwareAt && hardwareAt < softwareAt && softwareAt < pollAt);
  assert.equal(readings[0].sessionId, state.sessionId);
  assert.equal(state.readOnly, true);
});

test('sensor DID multi-frame data is reassembled and byte-offset groups retain their meanings', async t => {
  const f = fixture(t, { reply: command => command === '221931' ? didReply(command, [0xff, 8, 10, 20, 30, 40, 50, 60]) : command === '223850' ? didReply(command, [0xff, 0xff, 0xff, 0]) : undefined });
  const samples = events(f.session, 'sample', 2);
  await f.connect(['mes-10549', 'mes-11686']);
  const byKey = Object.assign({}, ...(await samples).map(sample => sample.values));
  assert.equal(byKey['mes-10549'], '1');
  assert.equal(byKey['mes-11686'], 'OK');
});

test('additional MultiAir channels share one complete DID response with distinct cylinder readings', async t => {
  const keys = [0, 2, 4, 6].map(offset => `8gmk-1996-${offset}`);
  const f = fixture(t, { reply: command => command === '221996' ? didReply(command, [0xff, 0xfb, 0, 10, 0, 15, 0, 20]) : undefined });
  const samples = events(f.session, 'sample'); await f.connect(keys);
  const [sample] = await samples;
  await f.session.disconnect();
  assert.deepEqual(sample.values, Object.fromEntries(keys.map((key, i) => [key, [-1, 2, 3, 4][i]])));
  assert.ok(keys.every(key => sample.quality[key] === 'valid'));
  assert.equal(f.port.writes.filter(command => command === '221996').length, 1);
  assert.equal(sample.profileId, 'fiat-8gmk');
});

test('truncated shared MultiAir records publish no partial cylinder group', async t => {
  const f = fixture(t, { reply: command => command === '22199E' ? didReply(command, [0, 5, 0, 10, 0, 15, 0]) : undefined });
  const faults = events(f.session, 'fault');
  const samples = []; f.session.on('sample', sample => samples.push(sample));
  await f.connect(['8gmk-199e-0', '8gmk-199e-6']); await faults;
  assert.equal(samples.length, 0);
  assert.equal(f.session.snapshot().values['8gmk-199e-0'], undefined);
  assert.equal(f.port.closed, true);
});

test('unsupported additional engine requests remain unavailable, then recover without changing meaning', async t => {
  let poll = 0;
  const f = fixture(t, { reply: command => command !== '221819' ? undefined : ++poll === 1 ? canReply([0x7f, 0x22, 0x31]) : didReply(command, [0xff, 0xff]) });
  const samples = events(f.session, 'sample', 2); await f.connect(['8gmk-1819-0']);
  const [unavailable, valid] = await samples; await f.session.disconnect();
  assert.equal(unavailable.values['8gmk-1819-0'], null);
  assert.equal(unavailable.quality['8gmk-1819-0'], 'unavailable');
  assert.equal(valid.values['8gmk-1819-0'], 100);
  assert.equal(valid.quality['8gmk-1819-0'], 'valid');
});

test('negative and NO DATA sensor replies become unavailable while later samples recover', async t => {
  let poll = 0;
  const f = fixture(t, { reply: command => command !== '221000' ? undefined : ++poll === 1 ? canReply([0x7f, 0x22, 0x31]) : poll === 2 ? 'NO DATA\r>' : undefined });
  const samples = events(f.session, 'sample', 3); await f.connect();
  const [refused, unavailable, valid] = await samples;
  assert.equal(refused.quality['mes-10500'], 'unavailable');
  assert.match(refused.parameterErrors['mes-10500'], /0x31/);
  assert.equal(unavailable.values['mes-10500'], null);
  assert.equal(valid.values['mes-10500'], 800);
  assert.equal(f.session.snapshot().status, 'streaming');
  assert.equal(f.session.snapshot().parameterErrors['mes-10500'], undefined);
});

test('NRC78 may precede one final DID response, but terminal refusals cannot collide', async t => {
  const pending = canReply([0x7f, 0x22, 0x78]), refused = canReply([0x7f, 0x22, 0x31]);
  for (const response of [joinReplies(pending, pending, defaultReply('221000')), joinReplies(pending, refused), joinReplies(pending, pending)]) {
    const f = fixture(t, { reply: command => command === '221000' ? response : undefined });
    const samples = events(f.session, 'sample'); await f.connect();
    const [sample] = await samples;
    assert.equal(sample.quality['mes-10500'], response.includes('62 10 00') ? 'valid' : 'unavailable');
    assert.equal(f.session.snapshot().status, 'streaming'); await f.session.disconnect();
  }
  for (const response of [joinReplies(refused, defaultReply('221000')), joinReplies(refused, refused), joinReplies(defaultReply('221000'), pending)]) {
    const f = fixture(t, { reply: command => command === '221000' ? response : undefined });
    const faults = events(f.session, 'fault'); await f.connect(); await faults;
    assert.match(f.session.snapshot().error, /conflicting responses/);
    assert.equal(f.session.snapshot().values['mes-10500'], undefined);
  }
});

test('wrong ISO, wrong hardware, missing software and wrong response source block parameter polling', async t => {
  for (const [command, response] of [
    ['22F1A5', didReply('22F1A5', [0, 1, 0x50, 0xa8, 0x16])],
    ['22F192', didReply('22F192', [...Buffer.from('MM8GMKHW999')])],
    ['22F194', 'NO DATA\r>'],
    ['22F1A5', didReply('22F1A5', [0, 1, 0x50, 0xa8, 0x15], '18DAF111')],
  ]) {
    const f = fixture(t, { reply: request => request === command ? response : undefined });
    await assert.rejects(f.connect());
    assert.equal(f.session.snapshot().status, 'error');
    assert.equal(f.port.writes.includes('221000'), false);
    assert.equal(f.port.closed, true);
  }
});

test('1003 uses 1092 fallback only for its exact NRC12 and accepts only matching session acknowledgements', async t => {
  const good = fixture(t, { reply: command => command === '1003' ? canReply([0x7f, 0x10, 0x12]) : undefined });
  await good.connect(); assert.ok(good.port.writes.includes('1092')); await good.session.disconnect();
  for (const response of [canReply([0x50, 0x92]), canReply([0x50, 3, 0]), canReply([0x7f, 0x10, 0x31]), canReply([0x50, 3]).replace('>', '') + canReply([0x50, 3])]) {
    const f = fixture(t, { reply: command => command === '1003' ? response : undefined });
    await assert.rejects(f.connect(), /did not start|conflicting diagnostic acknowledgements/);
    assert.equal(f.port.writes.includes('1092'), false);
    assert.equal(f.port.writes.includes('ATV0'), false);
    assert.equal(f.port.writes.includes('22F1A5'), false);
  }
  const badFallback = fixture(t, { reply: command => command === '1003' ? canReply([0x7f, 0x10, 0x12]) : command === '1092' ? canReply([0x50, 3]) : undefined });
  await assert.rejects(badFallback.connect(), /did not start/);
});

test('session acknowledgements allow pending intermediates but reject terminal collisions', async t => {
  const pending = canReply([0x7f, 0x10, 0x78]), refused = canReply([0x7f, 0x10, 0x31]);
  const f = fixture(t, { reply: command => command === '1003' ? joinReplies(pending, pending, defaultReply(command)) : undefined });
  await f.connect(); assert.equal(f.session.snapshot().status, 'streaming'); await f.session.disconnect();
  const g = fixture(t, { reply: command => command === '1003' ? joinReplies(pending, canReply([0x7f, 0x10, 0x12])) : command === '1092' ? joinReplies(pending, defaultReply(command)) : undefined });
  await g.connect(); assert.ok(g.port.writes.includes('1092')); await g.session.disconnect();
  for (const target of ['1003', '1092']) {
    const h = fixture(t, { reply: command => command === target ? joinReplies(refused, defaultReply(command)) : command === '1003' && target === '1092' ? canReply([0x7f, 0x10, 0x12]) : undefined });
    await assert.rejects(h.connect(), /conflicting diagnostic acknowledgements/);
    assert.equal(h.port.writes.includes('22F1A5'), false);
    assert.equal(h.port.writes.includes('ATV0'), false);
  }
  const pendingOnly = fixture(t, { reply: command => command === '1003' ? pending : undefined });
  await assert.rejects(pendingOnly.connect(), /did not start/);
  assert.equal(pendingOnly.port.writes.includes('ATV0'), false);
  const wrongService = fixture(t, { reply: command => command === '1003' ? joinReplies(canReply([0x7f, 0x22, 0x78]), defaultReply(command)) : undefined });
  await assert.rejects(wrongService.connect(), /different request/);
});

test('variable-DLC session retries with fixed DLC only after NO DATA', async t => {
  let attempts = 0;
  const f = fixture(t, { reply: command => command === '1003' && ++attempts === 1 ? 'NO DATA\r>' : undefined });
  await f.connect();
  const variableAt = f.port.writes.indexOf('ATV1'), firstAt = f.port.writes.indexOf('1003'), fixedAt = f.port.writes.indexOf('ATV0'), secondAt = f.port.writes.lastIndexOf('1003');
  assert.ok(variableAt < firstAt && firstAt < fixedAt && fixedAt < secondAt);
  assert.equal(attempts, 2); await f.session.disconnect();
  let fallbackAttempts = 0;
  const g = fixture(t, { reply: command => command === '1003' ? canReply([0x7f, 0x10, 0x12]) : command === '1092' && ++fallbackAttempts === 1 ? 'NO DATA\r>' : undefined });
  await g.connect();
  assert.equal(g.port.writes.filter(command => command === '1092').length, 2);
  assert.equal(g.port.writes.filter(command => command === 'ATV0').length, 1); await g.session.disconnect();
  const h = fixture(t, { reply: command => command === '1003' ? 'NO DATA\r>' : undefined });
  await assert.rejects(h.connect(), /did not start/);
  assert.equal(h.port.writes.filter(command => command === 'ATV0').length, 1);
  assert.equal(h.port.writes.includes('22F1A5'), false);
});

test('manufacturer host wait permits the ELM five-second response-pending interval', async t => {
  const f = fixture(t, { timeout: 4000, reply: (command, port) => {
    if (command !== '22F1A5') return undefined;
    setImmediate(() => port.emit('data', Buffer.from(canReply([0x7f, 0x22, 0x78]).replace('>', ''))));
    const timer = setTimeout(() => {
      port.active = false;
      if (port.isOpen) port.emit('data', Buffer.from(defaultReply(command)));
    }, 5100);
    t.after(() => clearTimeout(timer));
    return false;
  } });
  const state = await f.connect();
  assert.equal(state.status, 'streaming');
  assert.equal(state.identity.hardwareNumber, 'MM8GMKHW670');
});

test('cancelling during identity reading closes the port and discards late data', async t => {
  const f = fixture(t, { reply: command => command === '22F192' ? false : undefined });
  const atHardware = new Promise(resolve => f.port.on('write', command => { if (command === '22F192') resolve(); }));
  const connecting = assert.rejects(f.connect(), /stopped|cancelled/);
  await atHardware; await f.session.disconnect(); await connecting;
  f.port.emit('data', Buffer.from(defaultReply('22F192')));
  await tick(120);
  assert.equal(f.session.snapshot().status, 'disconnected');
  assert.equal(f.port.writes.includes('221000'), false);
  assert.equal(f.port.writes.includes('22F194'), false);
});

test('wrong-DID, truncated and wrong-source samples stop without publishing invented values', async t => {
  for (const response of [didReply('221001', [0x0c, 0x80]), didReply('221000', [0x0c]), didReply('221000', [0x0c, 0x80], '18DAF111'), 'NO DATA\rCAN ERROR\r>']) {
    const f = fixture(t, { reply: command => command === '221000' ? response : undefined });
    const faults = events(f.session, 'fault'); await f.connect(); await faults;
    assert.equal(f.session.snapshot().status, 'error');
    assert.equal(f.session.snapshot().values['mes-10500'], undefined);
    assert.equal(f.port.closed, true);
  }
});

test('manufacturer setup and selected channels admit no actuator, memory or persistent adapter writes', async t => {
  const f = fixture(t), samples = events(f.session, 'sample'); await f.connect(); await samples;
  assert.ok(f.port.writes.includes('ATTP7'));
  assert.ok(f.port.writes.includes('ATV1'));
  assert.ok(f.port.writes.includes('ATAT1'));
  assert.ok(f.port.writes.includes('ATST99'));
  assert.ok(f.port.writes.includes('ATCAF1'));
  assert.ok(f.port.writes.includes('ATH1'));
  assert.ok(f.port.writes.includes('ATCRA18DAF110'));
  assert.ok(f.port.writes.includes('ATSHDA10F1'));
  const allowedSetup = new Set(['ATZ', 'ATE0', 'ATL0', 'ATS1', 'ATH1', 'ATM0', 'ATCAF1', 'ATD0', 'ATTP7', 'ATV1', 'ATCP18', 'ATCRA18DAF110', 'ATSHDA10F1', 'ATCFC1', 'ATAT1', 'ATST99']);
  assert.ok(f.port.writes.every(command => allowedSetup.has(command) || ['1003', '3E00', '22F1A5', '22F192', '22F194', '221000'].includes(command)));
  assert.ok(f.port.writes.every(command => !/^AT(?:PP|SP)/.test(command) && !/^(14|27|2E|2F|31|34|35|36|37)/.test(command)));
  assert.equal(f.port.writes.includes('03221000'), false);
  await f.session.disconnect();
  const writes = f.port.writes.length;
  for (const key of ['2E1000', '31010001', '22F190']) await assert.rejects(f.connect([key]));
  assert.equal(f.port.writes.length, writes);
});

test('tester-present keepalive is serialized with polling and rejects malformed acknowledgements', async t => {
  const f = fixture(t, { reply: command => command === '3E00' ? canReply([0x7e, 0, 0x99]) : undefined });
  const fault = events(f.session, 'fault', 1, 3500); await f.connect(); await fault;
  assert.ok(f.port.writes.includes('3E00'));
  assert.match(f.session.snapshot().error, /keepalive/);
  assert.equal(f.port.closed, true);
  const g = fixture(t, { reply: command => command === '3E00' ? joinReplies(canReply([0x7f, 0x3e, 0x78]), defaultReply(command)) : undefined }), keepalive = new Promise(resolve => g.port.on('write', command => { if (command === '3E00') resolve(); }));
  await g.connect(); await keepalive; await tick(30);
  assert.equal(g.session.snapshot().status, 'streaming');
});

test('tester-present terminal refusal followed by an acknowledgement stops the session', async t => {
  const f = fixture(t, { reply: command => command === '3E00' ? joinReplies(canReply([0x7f, 0x3e, 0x31]), defaultReply(command)) : undefined });
  const faults = events(f.session, 'fault', 1, 3500); await f.connect(); await faults;
  assert.match(f.session.snapshot().error, /conflicting diagnostic acknowledgements/);
  assert.equal(f.port.closed, true);
});

test('all 152 engine readings poll sequentially once per shared DID with freshness covering the full cycle', async t => {
  const f = fixture(t, { timeout: 4000 });
  const keys=FIAT_8GMK_DEFINITIONS.map(d=>d.key),requests=[...new Set(FIAT_8GMK_DEFINITIONS.map(d=>d.request))];
  const firstCycle=events(f.session,'sample',requests.length,20000);
  const state = await f.connect(keys);
  assert.equal(state.channels.length,152);
  assert.ok(state.channels.every(channel=>channel.staleAfterMs>=requests.length*600*2&&channel.staleAfterMs>30000));
  const samples=await firstCycle;await f.session.disconnect();
  assert.equal(samples.length,requests.length);
  for(const request of requests)assert.equal(f.port.writes.filter(command=>command===request).length,1,request);
  const values=Object.assign({},...samples.map(sample=>sample.values));
  assert.equal(Object.keys(values).length,152);
  assert.ok(keys.every(key=>Object.hasOwn(values,key)));
  assert.ok(samples.every(sample=>sample.sessionId===state.sessionId&&sample.profileId==='fiat-8gmk'&&Object.values(sample.quality).every(quality=>quality==='valid')));
  assert.ok(f.port.writes.includes('3E00'),'Keepalive must still run during a full sensor cycle');
});
