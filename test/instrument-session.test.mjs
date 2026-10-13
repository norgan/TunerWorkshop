import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BaseSensorSession } from '../sensor-session.mjs';

const hex = value => value.toString(16).toUpperCase().padStart(2, '0');
const u24 = value => [value >> 16 & 255, value >> 8 & 255, value & 255];
function canReply(payload, source = '18 DA F1 60') {
  const frames = [];
  if (payload.length <= 7) frames.push([payload.length, ...payload]);
  else {
    frames.push([0x10 | payload.length >> 8, payload.length & 255, ...payload.slice(0, 6)]);
    for (let offset = 6, sequence = 1; offset < payload.length; offset += 7, sequence = (sequence + 1) & 15) frames.push([0x20 | sequence, ...payload.slice(offset, offset + 7)]);
  }
  return frames.map(frame => `${source} ${frame.map(hex).join(' ')}`).join('\r') + '\r>';
}
const didReply = (request, data, source) => canReply([0x62, Number.parseInt(request.slice(2, 4), 16), Number.parseInt(request.slice(4), 16), ...data], source);
const joinReplies = (...replies) => replies.map((reply, index) => index === replies.length - 1 ? reply : reply.replace('>', '')).join('');
function fixture(t, { reply, engineRpmRaw = [0, 0], speedRaw = [0], confirmReset = true } = {}) {
  class Port extends EventEmitter {
    isOpen = false; writes = []; active = false; closed = false; reset = false;
    open(callback) { this.isOpen = true; callback(null); }
    close(callback) { this.isOpen = false; this.closed = true; this.active = false; this.emit('close'); callback?.(); }
    defaultReply(command) {
      if (command === 'ATZ') return 'ELM327 v2.3\r>';
      if (command.startsWith('AT')) return 'OK\r>';
      if (command === '1003') return canReply([0x50, 3, 0, 50, 1, 244]);
      if (command === '1092') return canReply([0x50, 0x92]);
      if (command === '3E00') return canReply([0x7e, 0]);
      if (command === '2F556901') { this.reset = true; return canReply([0x6f, 0x55, 0x69, 1]); }
      const changed = this.reset && confirmReset;
      const data = {
        '22F1A5': [0x32, 0x83, 0x76, 0x0d, 0x0d],
        '221000': engineRpmRaw, '221002': speedRaw, '221004': [125],
        '220101': u24(changed ? 300000 : 5000), '222807': changed ? [1, 109] : [0, 20],
        '222802': u24(changed ? 0 : 24500), '222800': [changed ? 4 : 5],
        '222803': [60], '222806': [73], '222001': u24(1000000), '222801': [0x20, 0x25, 0x03, 0x01],
      }[command];
      assert.ok(data, `Unexpected instrument request: ${command}`);
      return didReply(command, data);
    }
    write(text, callback) {
      assert.equal(this.active, false, 'Instrument commands must remain serialized');
      this.active = true;
      const command = text.trim(); this.writes.push(command); this.emit('write', command); callback?.();
      const response = reply?.(command, this) ?? this.defaultReply(command);
      if (response === false) return;
      setImmediate(() => {
        const chunks = [response.slice(0, 6), response.slice(6, 17), response.slice(17)];
        for (const [index, chunk] of chunks.entries()) {
          if (index === chunks.length - 1) this.active = false;
          if (this.isOpen) this.emit('data', Buffer.from(chunk));
        }
      });
    }
  }
  const port = new Port(), session = new BaseSensorSession({ createPort: () => port, validateConnection() {}, commandTimeoutMs: 300, searchTimeoutMs: 300, pollIntervalMs: 100 });
  t.after(() => session.disconnect());
  return { port, session, connect: (channels = ['service-voltage']) => session.connect({ transport: 'serial', path: 'fixture', baudRate: 38400, profileId: 'fiat-service', channels }),
    reset: (overrides = {}) => session.diagnose({ action: 'run-service', toolId: 'service-interval-reset', sessionId: session.snapshot().sessionId, confirmation: 'run-service', acknowledged: true, ...overrides }) };
}
function nextEvent(emitter, event, predicate = () => true, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { emitter.off(event, onEvent); reject(new Error(`Timed out waiting for ${event}.`)); }, timeoutMs);
    function onEvent(value) { if (!predicate(value)) return; clearTimeout(timer); emitter.off(event, onEvent); resolve(value); }
    emitter.on(event, onEvent);
  });
}

test('instrument connection uses its own address and one-byte source measurements', async t => {
  const f = fixture(t), sample = nextEvent(f.session, 'sample', value => value.values['service-voltage'] !== undefined);
  const state = await f.connect(), value = await sample;
  assert.equal(state.profileId, 'fiat-service');
  assert.equal(state.ecu, '18DAF160');
  assert.equal(state.identity.ecuIsoCode, '32 83 76 0D 0D');
  assert.equal(value.values['service-voltage'], 12.5);
  assert.equal(value.ecu, '18DAF160');
  assert.ok(f.port.writes.includes('ATCRA18DAF160'));
  assert.ok(f.port.writes.includes('ATSHDA60F1'));
  assert.ok(!f.port.writes.includes('ATCRA18DAF110'));
  assert.ok(!f.port.writes.includes('22F192'));
  assert.ok(f.port.writes.every(command => !/^AT(?:PP|SP)/.test(command) && !/^(14|27|2E|2F|31|34|35|36|37)/.test(command)));
  assert.ok(!f.port.writes.includes('03221004'));
});

test('engine identity and wrong-controller replies cannot start instrument polling', async t => {
  for (const reply of [
    command => command === '22F1A5' ? didReply(command, [0, 1, 0x50, 0xa8, 0x15]) : undefined,
    command => command === '22F1A5' ? didReply(command, [0x32, 0x83, 0x76, 0x0d, 0x0d], '18 DA F1 10') : undefined,
  ]) {
    const f = fixture(t, { reply }); await assert.rejects(f.connect());
    assert.equal(f.port.closed, true); assert.ok(!f.port.writes.includes('221004')); assert.ok(!f.port.writes.includes('2F556901'));
  }
});

test('dashboard service reset holds the adapter, writes once, reads back and resumes polling', async t => {
  const f = fixture(t); await f.connect();
  const result = await f.reset();
  assert.equal(result.kind, 'service');
  assert.equal(result.result.status, 'verified');
  assert.equal(f.port.writes.filter(command => command === '2F556901').length, 1);
  const writeIndex = f.port.writes.indexOf('2F556901');
  assert.deepEqual(f.port.writes.slice(writeIndex - 2, writeIndex), ['221000', '221002']);
  const previousIsoIndex = f.port.writes.lastIndexOf('22F1A5', writeIndex);
  assert.ok(previousIsoIndex > f.port.writes.indexOf('22F1A5'));
  const after = f.port.writes.slice(writeIndex + 1);
  assert.ok(after.includes('222800')); assert.ok(after.includes('3E00'));
  const serviceTransaction = after.slice(0, after.indexOf('222806') + 1);
  assert.ok(!serviceTransaction.includes('221004'), 'The sensor poll must not interleave the service transaction');
  const sample = await nextEvent(f.session, 'sample', value => value.values['service-voltage'] !== undefined);
  assert.equal(sample.values['service-voltage'], 12.5);
  assert.equal(f.session.snapshot().status, 'streaming');
});

test('a stale session ID is rejected before any service requests', async t => {
  const f = fixture(t); await f.connect(); const before = f.port.writes.length;
  await assert.rejects(f.reset({ sessionId: 'previous-session' }), error => error.code === 'session_changed');
  assert.equal(f.port.writes.length, before);
  assert.ok(!f.port.writes.includes('2F556901'));
});

test('fresh cluster motion readings stop a reset before its write', async t => {
  for (const conditions of [{ speedRaw: [1] }, { engineRpmRaw: [0, 1] }]) {
    const f = fixture(t, conditions); await f.connect();
    await assert.rejects(f.reset(), /engine off|stationary/i);
    assert.ok(!f.port.writes.includes('2F556901'));
    assert.equal(f.session.snapshot().status, 'streaming');
  }
});

test('instrument pending-only reset response is not replayed or marked complete', async t => {
  const f = fixture(t, { reply: command => command === '2F556901' ? canReply([0x7f, 0x2f, 0x78]) : undefined });
  await f.connect(); const result = await f.reset();
  assert.equal(result.result.status, 'outcome-unknown'); assert.equal(result.result.changesMayHaveOccurred, true); assert.equal(result.success, false);
  assert.equal(f.port.writes.filter(command => command === '2F556901').length, 1);
});

test('instrument session fallback is limited to the documented unsupported-session response', async t => {
  const f = fixture(t, { reply: command => command === '1003' ? canReply([0x7f, 0x10, 0x12]) : undefined });
  await f.connect(); assert.ok(f.port.writes.includes('1092'));
  const g = fixture(t, { reply: command => command === '1003' ? joinReplies(canReply([0x7f, 0x10, 0x78]), canReply([0x50, 3])) : undefined });
  await g.connect(); assert.ok(!g.port.writes.includes('1092'));
});
