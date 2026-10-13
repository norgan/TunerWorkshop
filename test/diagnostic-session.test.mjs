import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BaseSensorSession } from '../sensor-session.mjs';
import { FIAT_IDENTIFICATION_DEFINITIONS } from '../fiat-diagnostics.mjs';
import { getServiceTool } from '../service-tools.mjs';

// Synthetic adapter only. No host serial, TCP or BLE implementation is imported.
const hex = byte => byte.toString(16).toUpperCase().padStart(2, '0');
const tick = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const fromHex = text => [...text.match(/../g)].map(byte => Number.parseInt(byte, 16));
function canReply(payload, source = '18DAF110') {
  const frames = [];
  if (payload.length <= 7) frames.push([payload.length, ...payload]);
  else {
    frames.push([0x10 | payload.length >> 8, payload.length & 255, ...payload.slice(0, 6)]);
    for (let offset = 6, sequence = 1; offset < payload.length; offset += 7, sequence = (sequence + 1) & 15) frames.push([0x20 | sequence, ...payload.slice(offset, offset + 7)]);
  }
  return frames.map(frame => `${source} ${frame.map(hex).join(' ')}`).join('\r') + '\r>';
}
const didReply = (request, data) => canReply([0x62, ...fromHex(request.slice(2)), ...data]);
const joinReplies = (...responses) => responses.map((response, index) => index === responses.length - 1 ? response : response.replace('>', '')).join('');
const identification = {
  '22F1A5': [0, 1, 0x50, 0xA8, 0x15], '22F190': [...Buffer.from('ZFA12345678901234')],
  '22F187': [...Buffer.from('12345678   ')], '22F192': [...Buffer.from('MM8GMKHW670')], '22F193': [3],
  '22F194': [...Buffer.from('V862MH97   ')], '22F195': [0, 0x12], '22F196': [...Buffer.from('8GMKF4')],
  '222008': [0, 0, 1, 0], '221008': [0, 0, 2, 0],
};
function baseReply(command, profileId) {
  if (command === 'ATZ') return 'ELM327 v2.3\r>';
  if (command === 'ATDPN') return 'A6\r>';
  if (command.startsWith('AT')) return 'OK\r>';
  if (profileId === 'generic-obd') {
    const replies = {
      '0100': [0x41, 0, 0, 0x10, 0, 0], '010C': [0x41, 0x0C, 0, 0], '010D': [0x41, 0x0D, 0],
      '03': [0x43, 2, 1, 0x33, 0xD0, 0x16], '07': [0x47, 1, 3, 0], '0A': [0x4A, 0],
      '0101': [0x41, 1, 0x82, 7, 0x65, 4], '0902': [0x49, 2, 1, ...Buffer.from('ZFA12345678901234')],
      '020200': [0x42, 2, 0, 1, 0x33], '020C00': [0x42, 0x0C, 0, 0x0C, 0x80],
      '020500': [0x42, 5, 0, 80], '020B00': [0x42, 0x0B, 0, 100], '020F00': [0x42, 0x0F, 0, 60],
      '021100': [0x42, 0x11, 0, 128], '024200': [0x42, 0x42, 0, 0x30, 0xD4],
    };
    assert.ok(replies[command], `Unexpected synthetic OBD request ${command}`);
    return canReply(replies[command], '7E8');
  }
  if (command === '1003') return canReply([0x50, 3, 0, 50, 1, 244]);
  if (command === '3E00') return canReply([0x7E, 0]);
  if (identification[command]) return didReply(command, identification[command]);
  if (command === '221000' || command === '221002') return didReply(command, [0, 0]);
  if (command === '19020D') return canReply([0x59, 2, 0xCF, 0, 0x33, 0x13, 0x89, 0xC1, 2, 0, 8]);
  if (command === '190400331300') return canReply([0x59, 4, 0, 0x33, 0x13, 0x89, 0, 2, 0x10, 0, 0x2E, 0xE0, 0x19, 0x5A, 8, 0xFC]);
  if (command === '14FFFFFF') return canReply([0x54]);
  if (getServiceTool('injector-1').steps.some(step => step.request === command) || getServiceTool('fan-low').steps.some(step => step.request === command)) {
    const payload = fromHex(command); return canReply([payload[0] + 0x40, ...payload.slice(1, 4)]);
  }
  throw new Error(`Unexpected synthetic engine request ${command}`);
}

function fixture(t, { profileId = 'fiat-8gmk', reply, pollIntervalMs = 60000 } = {}) {
  class Port extends EventEmitter {
    isOpen = false; active = false; writes = []; closed = false;
    open(callback) { this.isOpen = true; queueMicrotask(() => callback(null)); }
    close(callback) { this.isOpen = false; this.active = false; this.closed = true; this.emit('close'); callback?.(); }
    respond(response) { assert.equal(this.active, true, 'Synthetic response needs an outstanding command'); this.active = false; if (this.isOpen) this.emit('data', Buffer.from(response)); }
    write(text, callback) {
      assert.equal(this.active, false, 'Diagnostic commands must serialize with polling');
      this.active = true; const command = text.trim(); this.writes.push(command); this.emit('write', command); callback?.();
      const response = reply?.(command, this) ?? baseReply(command, profileId);
      if (response !== false) setImmediate(() => { if (this.isOpen) this.respond(response); });
    }
  }
  const port = new Port(), session = new BaseSensorSession({ createPort: () => port, validateConnection: () => {}, commandTimeoutMs: 300, searchTimeoutMs: 300, pollIntervalMs });
  t.after(() => session.disconnect());
  const connect = () => session.connect({ path: 'SYNTHETIC-NO-HARDWARE', profileId, channels: [profileId === 'fiat-8gmk' ? 'mes-10500' : 'rpm'] });
  return { port, session, connect, diagnose: (action, options = {}) => session.diagnose({ action, sessionId: session.snapshot().sessionId, ...options }) };
}

function nextEvent(emitter, name, predicate = () => true, timeout = 2500) {
  return new Promise((resolve, reject) => {
    const listener = value => { if (predicate(value)) { clearTimeout(timer); emitter.off(name, listener); resolve(value); } };
    const timer = setTimeout(() => { emitter.off(name, listener); reject(new Error(`Synthetic test timed out waiting for ${name}`)); }, timeout);
    emitter.on(name, listener);
  });
}

test('engine faults, snapshot and all identification fields run through attributed CAN transport', async t => {
  const f = fixture(t); const connected = await f.connect();
  const faults = await f.diagnose('read-faults');
  assert.equal(faults.sessionId, connected.sessionId); assert.equal(faults.ecu, '18DAF110');
  assert.equal(faults.kind, 'faults'); assert.equal(faults.availabilityMask, 0xCF);
  assert.deepEqual(faults.groups[0].faults.map(fault => fault.code), ['P0033-13', 'U0102-00']);
  assert.equal(faults.groups[0].faults[0].active, true);
  const frame = await f.diagnose('read-freeze-frame', { dtcId: '003313' });
  assert.equal(frame.kind, 'snapshot'); assert.equal(frame.complete, true);
  assert.equal(frame.fields.find(field => field.label === 'Engine speed').value, 3000);
  assert.equal(frame.fields.find(field => field.label === 'Boost pressure').value, 2300);
  const at = f.port.writes.length, identity = await f.diagnose('read-identification');
  assert.equal(identity.kind, 'identity'); assert.equal(identity.fields.length, 10);
  assert.deepEqual(f.port.writes.slice(at), FIAT_IDENTIFICATION_DEFINITIONS.map(definition => definition.request));
  assert.equal(identity.fields.find(field => field.key === 'vin').value, 'ZFA12345678901234');
  assert.equal(identity.fields.find(field => field.key === 'softwareVersion').value, '0012');
  assert.equal(f.session.snapshot().status, 'streaming');
});

test('generic CAN diagnostics read stored, pending and permanent faults, readiness and VIN from selected ECU', async t => {
  const f = fixture(t, { profileId: 'generic-obd', reply: command => command === '03' ? joinReplies(canReply([0x43, 1, 0x99, 0x99], '7E9'), baseReply(command, 'generic-obd')) : undefined });
  await f.connect(); const at = f.port.writes.length;
  const faults = await f.diagnose('read-faults');
  assert.equal(faults.ecu, '7E8'); assert.deepEqual(f.port.writes.slice(at), ['03', '07', '0A', '0101']);
  assert.deepEqual(faults.groups.map(group => group.faults.map(fault => fault.code)), [['P0133', 'U1016'], ['P0300'], []]);
  assert.equal(faults.readiness.mil, true); assert.equal(faults.readiness.reportedDtcCount, 2);
  assert.equal(faults.readiness.monitors.find(monitor => monitor.name === 'Evaporative system').complete, false);
  const identity = await f.diagnose('read-identification');
  assert.equal(identity.fields.find(field => field.label === 'VIN').value, 'ZFA12345678901234');
  const frame = await f.diagnose('read-freeze-frame');
  assert.equal(frame.code, 'P0133'); assert.equal(frame.fields.length, 6);
  assert.equal(frame.fields.find(field => field.key === 'rpm').value, 800);
});

test('session binding, confirmation and allowlisted action inputs reject before adapter commands', async t => {
  const f = fixture(t); await f.connect(); const count = f.port.writes.length;
  await assert.rejects(f.diagnose('read-faults', { sessionId: 'old-session' }), error => error.code === 'session_changed');
  await assert.rejects(f.diagnose('clear-faults'), error => error.code === 'confirmation_required');
  await assert.rejects(f.diagnose('clear-faults', { confirmation: true }), error => error.code === 'confirmation_required');
  await assert.rejects(f.diagnose('run-service', { toolId: 'injector-1', confirmation: 'run-service', acknowledged: false }), error => error.code === 'confirmation_required');
  await assert.rejects(f.diagnose('run-service', { toolId: 'invented-procedure', confirmation: 'run-service', acknowledged: true }), error => error.code === 'invalid_request');
  await assert.rejects(f.diagnose('run-service', { toolId: 'performance-limit-deactivation', confirmation: 'run-service', acknowledged: true }), error => error.code === 'unsupported');
  await assert.rejects(f.diagnose('read-faults', { request: '14FFFFFF' }), error => error.code === 'invalid_request');
  await assert.rejects(f.diagnose('send-command', { request: '2701' }), error => error.code === 'invalid_request');
  assert.throws(() => f.session.stopService({ sessionId: 'old-session' }), error => error.code === 'session_changed');
  assert.throws(() => f.session.stopService({ sessionId: f.session.snapshot().sessionId }), error => error.code === 'not_running');
  assert.equal(f.port.writes.length, count);
  const generic = fixture(t, { profileId: 'generic-obd' }); await generic.connect(); const genericCount = generic.port.writes.length;
  await assert.rejects(generic.diagnose('clear-faults', { confirmation: 'clear-faults' }), error => error.code === 'unsupported');
  await assert.rejects(generic.diagnose('run-service', { toolId: 'injector-1', confirmation: 'run-service', acknowledged: true }), error => error.code === 'unsupported');
  assert.equal(generic.port.writes.length, genericCount);
});

test('diagnostics wait for polling and retain exclusive transport ownership until terminal response', async t => {
  let holdPoll = true;
  const f = fixture(t, { pollIntervalMs: 100, reply: command => command === '221000' && holdPoll ? (holdPoll = false, false) : command === '19020D' ? false : undefined });
  const pollStarted = nextEvent(f.port, 'write', command => command === '221000');
  await f.connect(); await pollStarted;
  const before = f.port.writes.length, diagStarted = nextEvent(f.port, 'write', command => command === '19020D');
  const operation = f.diagnose('read-faults');
  await tick(30); assert.equal(f.port.writes.length, before);
  f.port.respond(baseReply('221000', 'fiat-8gmk')); await diagStarted;
  const during = f.port.writes.length;
  await assert.rejects(f.diagnose('read-identification'), error => error.code === 'busy');
  await tick(150); assert.equal(f.port.writes.length, during);
  const resumed = nextEvent(f.session, 'sample');
  f.port.respond(baseReply('19020D', 'fiat-8gmk'));
  assert.equal((await operation).kind, 'faults'); await resumed;
  assert.equal(f.port.writes.at(-1), '221000'); assert.equal(f.session.snapshot().status, 'streaming');
});

test('fresh engine or road speed blocks modifying diagnostics even after a stopped sample', async t => {
  let running = false;
  const f = fixture(t, { pollIntervalMs: 100, reply: command => command === '221000' ? didReply(command, running ? [0x0C, 0x80] : [0, 0]) : undefined });
  const sample = nextEvent(f.session, 'sample'); await f.connect(); await sample;
  assert.equal(f.session.snapshot().values['mes-10500'], 0); running = true;
  for (const [action, options] of [['clear-faults', { confirmation: 'clear-faults' }], ['run-service', { confirmation: 'run-service', acknowledged: true, toolId: 'injector-1' }]]) {
    const at = f.port.writes.length;
    await assert.rejects(f.diagnose(action, options), error => error.code === 'precondition');
    assert.deepEqual(f.port.writes.slice(at), ['221000', '221002']);
  }
  assert.equal(f.port.writes.includes('14FFFFFF'), false);
  assert.ok(getServiceTool('injector-1').steps.every(step => !f.port.writes.includes(step.request)));
  const moving = fixture(t, { reply: command => command === '221002' ? didReply(command, [0, 128]) : undefined });
  await moving.connect();
  await assert.rejects(moving.diagnose('clear-faults', { confirmation: 'clear-faults' }), error => error.code === 'precondition');
  assert.equal(moving.port.writes.includes('14FFFFFF'), false);
  for (const command of ['221000', '221002']) {
    const fractional = fixture(t, { reply: request => request === command ? didReply(request, [0, 1]) : undefined });
    await fractional.connect();
    await assert.rejects(fractional.diagnose('clear-faults', { confirmation: 'clear-faults' }), error => error.code === 'precondition');
    assert.equal(fractional.port.writes.includes('14FFFFFF'), false, 'A nonzero raw sample must not round into a stopped condition');
  }
});

test('engine clear requires fresh stopped conditions and an exact terminal acknowledgement', async t => {
  const f = fixture(t, { reply: command => command === '14FFFFFF' ? joinReplies(canReply([0x7F, 0x14, 0x78]), canReply([0x54])) : undefined });
  await f.connect(); const at = f.port.writes.length;
  const result = await f.diagnose('clear-faults', { confirmation: 'clear-faults' });
  assert.equal(result.kind, 'cleared'); assert.equal(result.acknowledged, true);
  assert.deepEqual(f.port.writes.slice(at), ['221000', '221002', '14FFFFFF']);
  assert.equal(f.port.writes.filter(command => command === '14FFFFFF').length, 1);
  for (const response of [canReply([0x54, 0]), canReply([0x7F, 0x14, 0x78]), joinReplies(canReply([0x54]), canReply([0x54])), canReply([0x54], '18DAF111')]) {
    const g = fixture(t, { reply: command => command === '14FFFFFF' ? response : undefined }); await g.connect();
    await assert.rejects(g.diagnose('clear-faults', { confirmation: 'clear-faults' }), error => error.code === 'outcome_unknown' && /read faults again/i.test(error.message));
    assert.equal(g.port.writes.filter(command => command === '14FFFFFF').length, 1);
  }
});

test('pending-only diagnostic replies are not success and do not leave the action queue busy', async t => {
  let pending = true;
  const f = fixture(t, { reply: command => command === '19020D' && pending ? canReply([0x7F, 0x19, 0x78]) : undefined });
  await f.connect();
  await assert.rejects(f.diagnose('read-faults'), error => error.code === 'response_pending');
  assert.equal(f.port.writes.filter(command => command === '19020D').length, 1);
  assert.equal(f.session.snapshot().status, 'streaming'); pending = false;
  assert.equal((await f.diagnose('read-faults')).groups[0].faults.length, 2);
});

test('stop-service cancels a queued actuator before it can send a modifying command', async t => {
  let holdPoll = true;
  const f = fixture(t, { pollIntervalMs: 100, reply: command => command === '221000' && holdPoll ? (holdPoll = false, false) : undefined });
  const polling = nextEvent(f.port, 'write', command => command === '221000');
  await f.connect(); await polling;
  const at = f.port.writes.length;
  const cancelled = assert.rejects(f.diagnose('run-service', { toolId: 'injector-1', confirmation: 'run-service', acknowledged: true }), /abort/i);
  assert.deepEqual(f.session.stopService({ sessionId: f.session.snapshot().sessionId }), { stopping: true });
  f.port.respond(baseReply('221000', 'fiat-8gmk')); await cancelled;
  assert.deepEqual(f.port.writes.slice(at), []);
  assert.ok(getServiceTool('injector-1').steps.every(step => !f.port.writes.includes(step.request)));
});

test('an actuator workflow sends its fixed sequence once and cancellation returns ECU control', async t => {
  const f = fixture(t); await f.connect(); const at = f.port.writes.length, tool = getServiceTool('injector-1');
  const completed = await f.diagnose('run-service', { toolId: tool.id, confirmation: 'run-service', acknowledged: true });
  assert.equal(completed.kind, 'service'); assert.equal(completed.result.status, 'completed');
  assert.equal(completed.result.stopStatus, 'acknowledged');
  assert.deepEqual(f.port.writes.slice(at), ['221000', '221002', ...tool.steps.map(step => step.request)]);
  const fan = getServiceTool('fan-low'), started = nextEvent(f.port, 'write', command => command === fan.steps[0].request);
  const startAt = f.port.writes.length, operation = f.diagnose('run-service', { toolId: fan.id, confirmation: 'run-service', acknowledged: true });
  await started;
  assert.throws(() => f.session.stopService({ sessionId: 'old-session' }), error => error.code === 'session_changed');
  assert.deepEqual(f.session.stopService({ sessionId: f.session.snapshot().sessionId }), { stopping: true });
  const cancelled = await operation;
  assert.equal(cancelled.result.status, 'cancelled'); assert.equal(cancelled.result.stopStatus, 'acknowledged');
  assert.deepEqual(f.port.writes.slice(startAt), ['221000', '221002', fan.steps[0].request, fan.stopRequest]);
  assert.equal(f.session.snapshot().status, 'streaming');
});
