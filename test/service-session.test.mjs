import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BaseSensorSession } from '../sensor-session.mjs';

const hex = byte => byte.toString(16).toUpperCase().padStart(2, '0');
function response(payload) {
  const frames = payload.length <= 7 ? [[payload.length, ...payload]] : [[0x10 | payload.length >> 8, payload.length & 255, ...payload.slice(0, 6)]];
  if (payload.length > 7) for (let offset = 6, sequence = 1; offset < payload.length; offset += 7, sequence++) frames.push([0x20 | sequence & 15, ...payload.slice(offset, offset + 7)]);
  return frames.map(frame => `18 DA F1 10 ${frame.map(hex).join(' ')}`).join('\r') + '\r>';
}
const did = (request, data) => response([0x62, parseInt(request.slice(2, 4), 16), parseInt(request.slice(4), 16), ...data]);
const ack = request => response([parseInt(request.slice(0, 2), 16) + 0x40, ...request.slice(2, 8).match(/../g).map(value => parseInt(value, 16))]);
const modifying = request => /^(?:2F|31)/.test(request);

function fixture(t, { rpm = 0, speed = 0, reply } = {}) {
  class Port extends EventEmitter {
    isOpen = false; writes = []; active = false;
    open(callback) { this.isOpen = true; callback(); }
    close(callback) { this.isOpen = false; this.active = false; this.emit('close'); callback?.(); }
    write(text, callback) {
      assert.equal(this.active, false, 'Sensor polling and service commands must share one exclusive queue');
      const command = text.trim(); this.writes.push(command); this.active = true; this.emit('command', command); callback?.();
      let data = reply?.(command);
      if (data === undefined) {
        if (command === 'ATZ') data = 'ELM327 v2.3\r>';
        else if (command.startsWith('AT')) data = 'OK\r>';
        else if (command === '1003') data = response([0x50, 3, 0, 50, 1, 244]);
        else if (command === '3E00') data = response([0x7e, 0]);
        else if (command === '22F1A5') data = did(command, [0, 1, 0x50, 0xa8, 0x15]);
        else if (command === '22F192') data = did(command, [...Buffer.from('MM8GMKHW670')]);
        else if (command === '22F194') data = did(command, [...Buffer.from('V862MH97   ')]);
        else if (command === '221000') data = did(command, [rpm >> 6 & 255, rpm * 4 & 255]);
        else if (command === '221002') data = did(command, [speed >> 8 & 255, speed & 255]);
        else if (modifying(command)) data = ack(command);
        else throw new Error(`Unexpected fixture command: ${command}`);
      }
      setImmediate(() => { this.active = false; if (this.isOpen) this.emit('data', Buffer.from(data)); });
    }
  }
  const port = new Port(), session = new BaseSensorSession({ createPort: () => port, validateConnection: () => {}, pollIntervalMs: 100, commandTimeoutMs: 100 });
  t.after(() => session.disconnect());
  return { port, session, connect: () => session.connect({ path: 'SYNTHETIC-SERVICE', profileId: 'fiat-8gmk', channels: ['mes-10500'] }) };
}
const action = (sessionId, toolId = 'injector-1') => ({ action: 'run-service', sessionId, toolId, confirmation: 'run-service', acknowledged: true });

test('service session rechecks stopped conditions and excludes polling until actuator return-control', async t => {
  const f = fixture(t), state = await f.connect();
  const result = await f.session.diagnose(action(state.sessionId));
  const start = f.port.writes.indexOf('2F510003'), stop = f.port.writes.indexOf('2F510000');
  assert.deepEqual(f.port.writes.slice(start - 2, start), ['221000', '221002']);
  assert.deepEqual(f.port.writes.slice(start, stop + 1), ['2F510003', '2F510000']);
  assert.equal(result.kind, 'service'); assert.equal(result.result.status, 'completed'); assert.equal(result.result.stopStatus, 'acknowledged');
  assert.equal(f.session.snapshot().status, 'streaming');
});

test('service cancellation transmits its recovered stop and keeps sensor connection available', async t => {
  const f = fixture(t), state = await f.connect();
  f.port.on('command', command => { if (command === '3101020B01') setImmediate(() => f.session.stopService({ sessionId: state.sessionId })); });
  const result = await f.session.diagnose(action(state.sessionId, 'fan-low'));
  assert.deepEqual(f.port.writes.filter(modifying), ['3101020B01', '3101020B00']);
  assert.equal(result.result.status, 'cancelled'); assert.equal(result.result.stopStatus, 'acknowledged');
  assert.equal(f.session.snapshot().status, 'streaming');
});

test('running engine, movement and unreadable preconditions cause no service writes', async t => {
  for (const config of [{ rpm: 800 }, { rpm: 0.25 }, { speed: 1 }, { reply: request => request === '221002' ? response([0x7f, 0x22, 0x31]) : undefined }]) {
    const f = fixture(t, config), state = await f.connect();
    await assert.rejects(f.session.diagnose(action(state.sessionId)), /Stop the engine|could not be checked/);
    assert.deepEqual(f.port.writes.filter(modifying), []);
    await f.session.disconnect();
  }
});

test('session binding and acknowledgement cannot be bypassed by a caller', async t => {
  const f = fixture(t), state = await f.connect();
  for (const input of [action('old-session'), { ...action(state.sessionId), acknowledged: false }, { ...action(state.sessionId), command: '2F510003' }, action(state.sessionId, 'performance-limit-deactivation')]) await assert.rejects(f.session.diagnose(input));
  assert.deepEqual(f.port.writes.filter(modifying), []);
  assert.throws(() => f.session.stopService({ sessionId: 'old-session' }), /changed/);
});

test('lost activation acknowledgement attempts release once and does not report success', async t => {
  const f = fixture(t, { reply: request => request === '2F510003' ? 'NO DATA\r>' : undefined }), state = await f.connect();
  const result = await f.session.diagnose(action(state.sessionId));
  assert.deepEqual(f.port.writes.filter(modifying), ['2F510003', '2F510000']);
  assert.equal(result.success, false); assert.equal(result.result.status, 'failed'); assert.equal(result.result.stopStatus, 'acknowledged');
});

test('missing stop acknowledgement causes disconnection and explicit unconfirmed-control result', async t => {
  const f = fixture(t, { reply: request => request === '2F510000' ? 'NO DATA\r>' : undefined }), state = await f.connect();
  const result = await f.session.diagnose(action(state.sessionId));
  assert.deepEqual(f.port.writes.filter(modifying), ['2F510003', '2F510000']);
  assert.equal(result.success, false); assert.equal(result.result.stopStatus, 'unconfirmed');
  assert.equal(f.session.snapshot().status, 'disconnected'); assert.equal(f.port.isOpen, false);
});

test('a duplicate service action is rejected while the first action owns the command queue', async t => {
  const f = fixture(t), state = await f.connect();
  const pending = f.session.diagnose(action(state.sessionId));
  await assert.rejects(f.session.diagnose(action(state.sessionId)), /already running/);
  await pending;
  assert.deepEqual(f.port.writes.filter(modifying), ['2F510003', '2F510000']);
});
