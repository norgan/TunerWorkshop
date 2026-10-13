import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkshopServer, MAX_JSON_BYTES, MAX_EVENT_SUBSCRIBERS } from '../server.mjs';
import { AssistantError } from '../assistant.mjs';

async function fixture(t, overrides = {}) {
  const calls = [], session = new EventEmitter();
  let connected = false;
  session.snapshot = () => ({ connected, mode: 'mock' });
  session.connect = async options => { calls.push(['connect', options]); connected = true; };
  session.disconnect = async () => { calls.push(['disconnect']); connected = false; };
  const assetRoot = await mkdtemp(join(tmpdir(), 'tune-workshop-server-test-'));
  await writeFile(join(assetRoot, 'index.html'), '<title>Tune Workshop test</title>');
  await writeFile(join(assetRoot, 'live.mjs'), 'export const fixture = true;');
  await writeFile(join(assetRoot, 'formats.mjs'), 'export const fixture = true;');
  await writeFile(join(assetRoot, 'dimsport-ui.mjs'), 'export const fixture = true;');
  await writeFile(join(assetRoot, 'calibration-discovery.mjs'), 'export const fixture = true;');
  await writeFile(join(assetRoot, 'live.css'), 'body { color: black; }');
  await mkdir(join(assetRoot, '.local'));
  await writeFile(join(assetRoot, '.local', 'credentials.json'), '{"fixture":"private-test-value"}');
  const server = createWorkshopServer({
    session, assetRoot, heartbeatMs: 25,
    availability: async () => ({ available: true, mock: true }),
    listSerialPorts: async () => [{ path: 'MOCK1', manufacturer: 'Synthetic interface' }],
    assistantStatus: async () => ({ connected: false, provider: 'chatgpt' }),
    beginAssistantSignIn: async args => { calls.push(['sign-in', args]); return { authorizationUrl: 'https://example.invalid/test-sign-in', expiresAt: 1234 }; },
    disconnectAssistant: async () => { calls.push(['assistant-disconnect']); },
    askAssistant: async args => { calls.push(['message', args]); return { text: 'Synthetic reply.', model: args.model || 'mock-model', provider: 'chatgpt' }; },
    ...overrides,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolveClose => server.close(resolveClose));
    // The generated directory is a dedicated test fixture under the host temp root.
    const tempRoot = resolveTempRoot();
    assert.ok(assetRoot.startsWith(tempRoot) && assetRoot !== tempRoot);
    await rm(assetRoot, { recursive: true, force: true });
  });
  return { server, port, calls, session, origin: `http://127.0.0.1:${port}` };
}
function resolveTempRoot() { return join(tmpdir(), 'tune-workshop-server-test-'); }

test('desktop server requires its private session token for assets and APIs',async t=>{
  const accessToken='a'.repeat(64),f=await fixture(t,{accessToken});
  for(const path of ['/','/api/status']){
    assert.equal((await request(f,path)).status,403);
    assert.equal((await request(f,path,{headers:{'X-Tune-Desktop':'b'.repeat(64)}})).status,403);
    assert.equal((await request(f,path,{headers:{'X-Tune-Desktop':accessToken}})).status,200);
  }
  assert.deepEqual(f.calls,[]);
});

test('diagnostic subscriptions admit only known profile channel IDs before connection',async t=>{
  const f=await fixture(t);
  const body={path:'MOCK1',baudRate:38400,profileId:'fiat-8gmk',channels:['mes-10500','mes-10155']};
  assert.equal((await request(f,'/api/sensors/connect',{method:'POST',body})).status,200);
  assert.deepEqual(f.calls,[['connect',body]]);
  for(const patch of [{profileId:'unknown'},{channels:[]},{channels:['221000']},{channels:['mes-10500','mes-10500']},{channels:['rpm']},{channels:Array(33).fill('mes-10500')}]){
    assert.equal((await request(f,'/api/sensors/connect',{method:'POST',body:{...body,...patch}})).status,400);
  }
  assert.equal(f.calls.length,1);
});
function request(f, path, { method = 'GET', body, raw, headers = {}, authorized = true, chunks } = {}) {
  const payload = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined;
  const defaults = authorized ? { 'X-Tune-Workshop': '1' } : {};
  if (method === 'POST' && authorized) Object.assign(defaults, { Origin: f.origin, 'Content-Type': 'application/json' });
  return new Promise((resolveResponse, rejectResponse) => {
    const req = http.request({ host: '127.0.0.1', port: f.port, path, method, headers: { ...defaults, ...headers } }, res => {
      const data = [];
      res.on('data', chunk => data.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(data).toString();
        let json;
        try { json = JSON.parse(text); } catch {}
        resolveResponse({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', rejectResponse);
    if (chunks) for (const chunk of chunks) req.write(chunk);
    req.end(payload);
  });
}
function eventStream(f) {
  return new Promise((resolveStream, rejectStream) => {
    const req = http.get({ host: '127.0.0.1', port: f.port, path: '/api/events', headers: { 'X-Tune-Workshop': '1' } }, res => {
      let text = '';
      const waiters = [];
      res.on('data', chunk => { text += chunk.toString(); for (const waiter of [...waiters]) waiter(); });
      resolveStream({ status: res.statusCode, close: () => { res.destroy(); req.destroy(); },
        waitFor: fragment => new Promise((resolveFound, rejectFound) => {
          const timeout = setTimeout(() => { cleanup(); rejectFound(new Error('SSE test timed out.')); }, 2000);
          const cleanup = () => { clearTimeout(timeout); const index = waiters.indexOf(check); if (index !== -1) waiters.splice(index, 1); };
          const check = () => { if (text.includes(fragment)) { cleanup(); resolveFound(text); } };
          waiters.push(check); check();
        }),
      });
    });
    req.on('error', rejectStream);
  });
}

test('constructing and static requests perform no hardware or sign-in actions', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.calls, []);
  for (const path of ['/', '/live.mjs', '/live.css', '/formats.mjs', '/dimsport-ui.mjs', '/calibration-discovery.mjs']) {
    const response = await request(f, path, { authorized: false });
    assert.equal(response.status, 200);
    assert.match(response.headers['content-security-policy'], /connect-src 'self'/);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  const head = await request(f, '/', { method: 'HEAD', authorized: false });
  assert.equal(head.status, 200); assert.equal(head.text, ''); assert.deepEqual(f.calls, []);
});

test('rejects missing header, foreign Host, cross-origin API calls and preflight', async t => {
  const f = await fixture(t);
  for (const options of [
    { authorized: false }, { headers: { Host: 'evil.invalid' } },
    { headers: { Host: `localhost:${f.port + 1}` } }, { headers: { 'X-Tune-Workshop': '0' } },
    { headers: { Origin: 'https://example.invalid' } }, { headers: { 'Sec-Fetch-Site': 'cross-site' } },
  ]) assert.equal((await request(f, '/api/status', options)).status, 403);
  const missingOrigin = await request(f, '/api/sensors/disconnect', { method: 'POST', body: {}, authorized: false, headers: { 'X-Tune-Workshop': '1', 'Content-Type': 'application/json' } });
  assert.equal(missingOrigin.status, 403);
  assert.equal((await request(f, '/api/sensors/disconnect', { method: 'POST', body: {}, headers: { Origin: `http://localhost:${f.port}` } })).status, 403);
  const options = await request(f, '/api/sensors/connect', { method: 'OPTIONS', headers: { Origin: 'https://example.invalid', 'Access-Control-Request-Headers': 'x-tune-workshop' } });
  assert.equal(options.status, 405); assert.equal(options.headers['access-control-allow-origin'], undefined); assert.deepEqual(f.calls, []);
});

test('dispatches status, ports and sensor controls through injected dependencies', async t => {
  const f = await fixture(t);
  assert.deepEqual((await request(f, '/api/status')).json, {
    sensors: { connected: false, mode: 'mock' }, serial: { available: true, mock: true }, assistant: { connected: false, provider: 'chatgpt' },
  });
  assert.deepEqual((await request(f, '/api/serial/ports')).json, { ports: [{ path: 'MOCK1', manufacturer: 'Synthetic interface' }] });
  const connected = await request(f, '/api/sensors/connect', { method: 'POST', body: { path: 'MOCK1', baudRate: 38400, ignored: 'not passed' } });
  assert.deepEqual(connected.json, { connected: true, mode: 'mock' });
  assert.deepEqual((await request(f, '/api/sensors')).json, connected.json);
  assert.deepEqual((await request(f, '/api/sensors/disconnect', { method: 'POST', body: {} })).json, { connected: false, mode: 'mock' });
  assert.deepEqual(f.calls, [['connect', { path: 'MOCK1', baudRate: 38400 }], ['disconnect']]);
  assert.equal((await request(f, '/api/status', { headers: { Host: `localhost:${f.port}` } })).status, 200);
});

test('assistant status, explicit sign-in, message and disconnect use mocked backend only', async t => {
  const f = await fixture(t);
  assert.deepEqual((await request(f, '/api/assistant/status')).json, { connected: false, provider: 'chatgpt' });
  assert.deepEqual((await request(f, '/api/assistant/sign-in', { method: 'POST', body: {} })).json, { authorizationUrl: 'https://example.invalid/test-sign-in', expiresAt: 1234 });
  const message = { messages: [{ role: 'user', content: 'Explain the synthetic sample.' }], model: 'mock-model', context: { source: 'synthetic' } };
  assert.deepEqual((await request(f, '/api/assistant/message', { method: 'POST', body: message })).json, { text: 'Synthetic reply.', model: 'mock-model', provider: 'chatgpt' });
  assert.deepEqual((await request(f, '/api/assistant/disconnect', { method: 'POST', body: {} })).json, { connected: false, provider: 'chatgpt' });
  assert.deepEqual(f.calls, [['sign-in', {}], ['message', message], ['assistant-disconnect']]);
});

test('Wi-Fi dispatch accepts explicit private IPv4 adapters without opening real sockets', async t => {
  const f = await fixture(t);
  const response = await request(f, '/api/sensors/connect', { method: 'POST', body: { transport: 'wifi', host: '192.168.0.10', port: 35000 } });
  assert.equal(response.status, 200);
  assert.deepEqual(f.calls, [['connect', { transport: 'wifi', host: '192.168.0.10', port: 35000 }]]);
  for (const host of ['localhost', '127.0.0.1', '8.8.8.8', '169.254.1.1', '192.168.000.1', '192.168.0.999']) {
    assert.equal((await request(f, '/api/sensors/connect', { method: 'POST', body: { transport: 'wifi', host, port: 35000 } })).status, 400);
  }
  assert.equal((await request(f, '/api/sensors/connect', { method: 'POST', body: { transport: 'wifi', host: '10.0.0.1', port: 80 } })).status, 400);
  assert.equal(f.calls.length, 1);
});

test('Bluetooth Classic API keeps its transport identity and BLE stays in the local renderer',async t=>{
  const f=await fixture(t);
  const options={transport:'bluetooth',path:'MOCK1',baudRate:38400};
  assert.equal((await request(f,'/api/sensors/connect',{method:'POST',body:options})).status,200);assert.deepEqual(f.calls,[['connect',options]]);
  assert.equal((await request(f,'/api/sensors/connect',{method:'POST',body:{transport:'ble'}})).status,400);
});

test('backend failures never expose raw exception or credential details', async t => {
  const f = await fixture(t, { askAssistant: async () => { throw new Error('sensitive-test-token private-test-value'); } });
  const response = await request(f, '/api/assistant/message', { method: 'POST', body: { messages: [{ role: 'user', content: 'Test' }] } });
  assert.equal(response.status, 500); assert.doesNotMatch(response.text, /sensitive-test-token|private-test-value|Error:/);
  assert.match(response.json.error, /could not be completed/);
});

test('assistant errors reach the UI with actionable messages and correct status', async t => {
  const error = new AssistantError('ChatGPT plan usage is temporarily unavailable. Try again later.', 'upstream_unavailable', 503);
  error.diagnostics = { httpStatus: 503, bodyShape: 'detail', requestId: 'req_test_123' };
  const f = await fixture(t, { askAssistant: async () => { throw error; } });
  const response = await request(f, '/api/assistant/message', { method: 'POST', body: { messages: [{ role: 'user', content: 'Hi' }] } });
  assert.equal(response.status, 503); assert.equal(response.json.error, error.message);
  assert.equal(response.json.code, error.code); assert.deepEqual(response.json.diagnostics, error.diagnostics);
  assert.doesNotMatch(response.text, /Check the device/);
});

test('rejects malformed content, oversized declared/chunked bodies and invalid options', async t => {
  const f = await fixture(t);
  assert.equal((await request(f, '/api/sensors/connect', { method: 'POST', body: {}, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  for (const raw of ['{', '[]', 'null', '']) assert.equal((await request(f, '/api/sensors/connect', { method: 'POST', raw })).status, 400);
  const payload = ' '.repeat(MAX_JSON_BYTES + 1);
  assert.equal((await request(f, '/api/sensors/connect', { method: 'POST', raw: payload, headers: { 'Content-Length': Buffer.byteLength(payload) } })).status, 413);
  assert.equal((await request(f, '/api/sensors/connect', { method: 'POST', chunks: [' '.repeat(MAX_JSON_BYTES), ' '] })).status, 413);
  assert.equal((await request(f, '/api/sensors/connect', { method: 'POST', body: { path: 'MOCK1', baudRate: -1 } })).status, 400);
  assert.equal((await request(f, '/api/assistant/message', { method: 'POST', body: { messages: [] } })).status, 400);
  assert.deepEqual(f.calls, []);
});

test('static allowlist blocks traversal, backend modules and private credential files', async t => {
  const f = await fixture(t);
  for (const path of ['/../server.mjs', '/%2e%2e/server.mjs', '/.local/credentials.json', '/%2elocal/credentials.json', '/assistant.mjs', '/elm.mjs', '/server.mjs', '/package.json', '/research/capability-manifest.json']) {
    const response = await request(f, path); assert.equal(response.status, 404, path); assert.doesNotMatch(response.text, /private-test-value/);
  }
  assert.equal((await request(f, '//example.invalid/api/status')).status, 400);
  assert.equal((await request(f, '/', { method: 'POST', body: {} })).status, 405);
  assert.equal((await request(f, '/api/status', { method: 'POST', body: {} })).status, 405);
  assert.equal((await request(f, '/api/sensors/connect')).status, 405);
  assert.equal((await request(f, '/api/missing')).status, 404);
});

test('SSE sends initial snapshot, samples, sanitized faults and heartbeats', async t => {
  const f = await fixture(t), stream = await eventStream(f); t.after(stream.close);
  assert.equal(stream.status, 200);
  assert.match(await stream.waitFor('"type":"status"'), /"data":\{"connected":false,"mode":"mock"\}/);
  f.session.emit('sample', { timestamp: 123, values: { rpm: 900 }, ecu: 'mock' });
  assert.match(await stream.waitFor('"type":"sample"'), /"rpm":900/);
  f.session.emit('fault', { message: 'private-test-value', timestamp: 456 });
  const fault = await stream.waitFor('"type":"fault"');
  assert.doesNotMatch(fault, /private-test-value/); assert.match(fault, /"timestamp":456/);
  assert.match(await stream.waitFor(': heartbeat'), /: heartbeat\n\n/);
});

test('SSE caps subscriptions and releases slots after a browser disconnects', async t => {
  const f = await fixture(t), streams = []; t.after(() => streams.forEach(stream => stream.close()));
  for (let index = 0; index < MAX_EVENT_SUBSCRIBERS; index++) {
    const stream = await eventStream(f); streams.push(stream); assert.equal(stream.status, 200); await stream.waitFor('"type":"status"');
  }
  assert.equal((await request(f, '/api/events')).status, 503);
  streams[0].close(); await new Promise(resolveTick => setTimeout(resolveTick, 40));
  const replacement = await eventStream(f); streams.push(replacement); assert.equal(replacement.status, 200); replacement.close();
});
