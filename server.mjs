import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { AssistantError } from './assistant.mjs';
import { selectProfileChannels } from './fiat-8gmk.mjs';

const root = dirname(fileURLToPath(import.meta.url));
export const MAX_JSON_BYTES = 256 * 1024;
export const MAX_EVENT_SUBSCRIBERS = 8;
const files = new Map([
  ['/winols-project.mjs', ['winols-project.mjs', 'text/javascript']],
  ['/map-identification.mjs', ['map-identification.mjs', 'text/javascript']],
  ['/map-catalogue.mjs', ['map-catalogue.mjs', 'text/javascript']],
  ['/map-catalogue.css', ['map-catalogue.css', 'text/css']],
  ['/desktop/ols-smoke-fixture.mjs', ['desktop/ols-smoke-fixture.mjs', 'text/javascript']],
  ['/fiat-8gmk.mjs', ['fiat-8gmk.mjs', 'text/javascript']],
  ['/fiat-8gmk-data.mjs', ['fiat-8gmk-data.mjs', 'text/javascript']],
  ['/can-diagnostics.mjs', ['can-diagnostics.mjs', 'text/javascript']],
  ['/diagnostic-catalog.mjs', ['diagnostic-catalog.mjs', 'text/javascript']],
  ['/settings-schema.mjs', ['settings-schema.mjs', 'text/javascript']],
  ['/pressure-units.mjs', ['pressure-units.mjs', 'text/javascript']],
  ['/settings-client.mjs', ['settings-client.mjs', 'text/javascript']],
  ['/settings-ui.mjs', ['settings-ui.mjs', 'text/javascript']],
  ['/settings.css', ['settings.css', 'text/css']],
  ['/chat-keyboard.mjs', ['chat-keyboard.mjs', 'text/javascript']],
  ['/bluetooth-ui.mjs', ['bluetooth-ui.mjs', 'text/javascript']],
  ['/ble.mjs', ['ble.mjs', 'text/javascript']],
  ['/sensor-events.mjs', ['sensor-events.mjs', 'text/javascript']],
  ['/sensor-session.mjs', ['sensor-session.mjs', 'text/javascript']],
  ['/elm-protocol.mjs', ['elm-protocol.mjs', 'text/javascript']],
  ['/', ['index.html', 'text/html']],
  ['/index.html', ['index.html', 'text/html']],
  ['/styles.css', ['styles.css', 'text/css']],
  ['/live.css', ['live.css', 'text/css']],
  ['/app.mjs', ['app.mjs', 'text/javascript']],
  ['/live.mjs', ['live.mjs', 'text/javascript']],
  ['/chat-history.mjs', ['chat-history.mjs', 'text/javascript']],
  ['/core.mjs', ['core.mjs', 'text/javascript']],
  ['/formats.mjs', ['formats.mjs', 'text/javascript']],
  ['/dimsport-ui.mjs', ['dimsport-ui.mjs', 'text/javascript']],
  ['/calibration-discovery.mjs', ['calibration-discovery.mjs', 'text/javascript']],
  ['/map-workbench.mjs', ['map-workbench.mjs', 'text/javascript']],
  ['/map-workbench-model.mjs', ['map-workbench-model.mjs', 'text/javascript']],
  ['/map-workbench.css', ['map-workbench.css', 'text/css']],
  ['/map-references.mjs', ['map-references.mjs', 'text/javascript']],
  ['/map-reference-data.mjs', ['map-reference-data.mjs', 'text/javascript']],
  ['/ports.mjs', ['ports.mjs', 'text/javascript']],
  ['/mes-log.mjs', ['mes-log.mjs', 'text/javascript']],
]);
const apiMethods = new Map([
  ['/api/status', 'GET'], ['/api/serial/ports', 'GET'], ['/api/sensors', 'GET'], ['/api/events', 'GET'],
  ['/api/sensors/connect', 'POST'], ['/api/sensors/disconnect', 'POST'],
  ['/api/assistant/status', 'GET'], ['/api/assistant/sign-in', 'POST'],
  ['/api/assistant/disconnect', 'POST'], ['/api/assistant/message', 'POST'],
]);
const responseHeaders = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};
class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function json(res, status, body, extraHeaders = {}) {
  if (res.destroyed || res.writableEnded) return;
  const data = JSON.stringify(body);
  res.writeHead(status, { ...responseHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), ...extraHeaders });
  res.end(data);
}
function requestOrigin(req) {
  const host = req.headers.host, port = req.socket.localPort;
  if (host !== `localhost:${port}` && host !== `127.0.0.1:${port}`) throw new RequestError(403, 'Use the local Tune Workshop address.');
  return `http://${host}`;
}
function authorizeApi(req, origin) {
  if (req.headers['x-tune-workshop'] !== '1') throw new RequestError(403, 'The Tune Workshop request header is required.');
  const supplied = req.headers.origin;
  if ((supplied !== undefined && supplied !== origin) || req.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(403, 'Cross-origin API requests are not allowed.');
  if (req.method === 'POST' && supplied !== origin) throw new RequestError(403, 'A matching local origin is required.');
}
function readJson(req) {
  if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') throw new RequestError(415, 'Send an application/json request.');
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_JSON_BYTES)) {
    req.resume(); throw new RequestError(413, 'The JSON request exceeds 256 KiB.');
  }
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let length = 0, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('aborted', onAborted);
      if (error) { chunks.length = 0; req.resume(); rejectBody(error); } else resolveBody(value);
    };
    const onData = chunk => {
      length += chunk.length;
      if (length > MAX_JSON_BYTES) return finish(new RequestError(413, 'The JSON request exceeds 256 KiB.'));
      chunks.push(chunk);
    };
    const onError = () => finish(new RequestError(400, 'The request body could not be read.'));
    const onAborted = () => finish(new RequestError(400, 'The request was interrupted.'));
    const onEnd = () => {
      try {
        const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length)));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        finish(null, parsed);
      } catch { finish(new RequestError(400, 'Send a valid JSON object.')); }
    };
    req.on('data', onData); req.on('end', onEnd); req.on('error', onError); req.on('aborted', onAborted);
  });
}
function connectOptions(body) {
  let diagnostic={};
  if(body.profileId!==undefined||body.channels!==undefined){
    const profileId=body.profileId??'generic-obd';
    try{diagnostic={profileId,channels:selectProfileChannels(profileId,body.channels).map(d=>d.key)};}
    catch(error){throw new RequestError(400,error.message);}
  }
  if (body.transport === 'wifi') {
    const parts = typeof body.host === 'string' ? body.host.split('.') : [];
    const validParts = parts.length === 4 && parts.every(part => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
    const values = parts.map(Number);
    const privateAddress = validParts && (values[0] === 10 || values[0] === 172 && values[1] >= 16 && values[1] <= 31 || values[0] === 192 && values[1] === 168);
    const port = body.port ?? 35000;
    if (!privateAddress || !Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new RequestError(400, 'Enter the adapter\u2019s private IPv4 address and TCP port from 1024 to 65535.');
    return { transport: 'wifi', host: body.host, port,...diagnostic };
  }
  if (body.transport !== undefined && !['serial','bluetooth'].includes(body.transport)) throw new RequestError(400, 'Choose a supported connection type.');
  if (typeof body.path !== 'string' || !body.path.trim() || body.path.length > 260 || /[\r\n\u0000]/.test(body.path)) throw new RequestError(400, 'Choose a serial port.');
  if (body.baudRate !== undefined && (!Number.isSafeInteger(body.baudRate) || body.baudRate < 1 || body.baudRate > 4000000)) throw new RequestError(400, 'Choose a valid serial baud rate.');
  return { ...(body.transport !== undefined ? { transport: body.transport } : {}), path: body.path, ...(body.baudRate !== undefined ? { baudRate: body.baudRate } : {}),...diagnostic };
}

/** Importing/constructing is inert: no credentials, port enumeration, connection or sign-in. */
export function createWorkshopServer({ session, availability, listSerialPorts, assistantStatus, beginAssistantSignIn, disconnectAssistant, askAssistant, assetRoot = root, heartbeatMs = 15000, accessToken } = {}) {
  if(accessToken!==undefined&&(typeof accessToken!=='string'||!/^[a-f0-9]{64}$/.test(accessToken)))throw new TypeError('Invalid desktop session token.');
  for (const [name, value] of Object.entries({ availability, listSerialPorts, assistantStatus, beginAssistantSignIn, disconnectAssistant, askAssistant })) {
    if (typeof value !== 'function') throw new TypeError(`Missing server dependency: ${name}`);
  }
  if (!session || ['connect', 'disconnect', 'snapshot', 'on', 'off'].some(name => typeof session[name] !== 'function')) throw new TypeError('A sensor session is required.');
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 10) throw new TypeError('Invalid heartbeat interval.');
  const subscribers = new Set(), listeners = new Map();
  const removeSubscriber = subscriber => {
    if (!subscribers.delete(subscriber)) return;
    clearInterval(subscriber.timer); subscriber.response.off('close', subscriber.close);
  };
  const writeEvent = (subscriber, frame) => {
    const res = subscriber.response;
    if (res.destroyed || res.writableEnded) return removeSubscriber(subscriber);
    // Disconnect slow subscribers instead of buffering unbounded sensor events.
    if (!res.write(frame)) { removeSubscriber(subscriber); res.end(); }
  };
  const broadcast = (type, data) => {
    let frame;
    try { frame = `data: ${JSON.stringify({ type, data })}\n\n`; } catch { return; }
    if (Buffer.byteLength(frame) > 64 * 1024) return;
    for (const subscriber of subscribers) writeEvent(subscriber, frame);
  };
  for (const type of ['status', 'sample', 'fault']) {
    const listener = data => broadcast(type, type === 'fault' ? {
      message: 'The sensor connection reported an error. Check the device and connection status.',
      timestamp: typeof data?.timestamp === 'string' || typeof data?.timestamp === 'number' ? data.timestamp : null,
    } : data);
    listeners.set(type, listener); session.on(type, listener);
  }

  const server = http.createServer(async (req, res) => {
    try {
      if(accessToken&&req.headers['x-tune-desktop']!==accessToken)throw new RequestError(403,'This desktop session is private.');
      const origin = requestOrigin(req), target = req.url || '';
      if (!target.startsWith('/') || target.startsWith('//')) throw new RequestError(400, 'Invalid local request path.');
      const path = target.split('?')[0];
      if (req.method === 'OPTIONS') throw new RequestError(405, 'Cross-origin preflight is not supported.');
      if (!path.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(req.method)) { json(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, HEAD' }); return; }
        const entry = files.get(path);
        if (!entry) throw new RequestError(404, 'Not found.');
        let data;
        try { data = await readFile(join(assetRoot, entry[0])); } catch { throw new RequestError(500, 'Unable to load application file.'); }
        res.writeHead(200, { ...responseHeaders, 'Content-Type': `${entry[1]}; charset=utf-8`, 'Content-Length': data.length });
        res.end(req.method === 'HEAD' ? undefined : data); return;
      }
      authorizeApi(req, origin);
      const method = apiMethods.get(path);
      if (!method) throw new RequestError(404, 'API route not found.');
      if (method !== req.method) { json(res, 405, { error: 'Method not allowed.' }, { Allow: method }); return; }
      const body = req.method === 'POST' ? await readJson(req) : null;
      switch (path) {
        case '/api/status': {
          const sensors = session.snapshot();
          const [serial, assistant] = await Promise.all([availability(), assistantStatus()]);
          json(res, 200, { sensors, serial, assistant }); break;
        }
        case '/api/serial/ports': json(res, 200, { ports: await listSerialPorts() }); break;
        case '/api/sensors': json(res, 200, session.snapshot()); break;
        case '/api/sensors/connect': await session.connect(connectOptions(body)); json(res, 200, session.snapshot()); break;
        case '/api/sensors/disconnect': await session.disconnect(); json(res, 200, session.snapshot()); break;
        case '/api/assistant/status': json(res, 200, await assistantStatus()); break;
        case '/api/assistant/sign-in': {
          if (body.accountId !== undefined && (typeof body.accountId !== 'string' || body.accountId.length > 256)) throw new RequestError(400, 'The account selection is invalid.');
          json(res, 200, await beginAssistantSignIn(body.accountId === undefined ? {} : { accountId: body.accountId })); break;
        }
        case '/api/assistant/disconnect': await disconnectAssistant(); json(res, 200, await assistantStatus()); break;
        case '/api/assistant/message': {
          if (!Array.isArray(body.messages) || !body.messages.length) throw new RequestError(400, 'Provide at least one assistant message.');
          if (body.model !== undefined && (typeof body.model !== 'string' || body.model.length > 100)) throw new RequestError(400, 'The model selection is invalid.');
          json(res, 200, await askAssistant({ messages: body.messages, ...(body.model !== undefined ? { model: body.model } : {}), ...(body.context !== undefined ? { context: body.context } : {}) })); break;
        }
        case '/api/events': {
          if (subscribers.size >= MAX_EVENT_SUBSCRIBERS) throw new RequestError(503, 'Too many event streams are open.');
          const initial = `data: ${JSON.stringify({ type: 'status', data: session.snapshot() })}\n\n`;
          res.writeHead(200, { ...responseHeaders, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          res.flushHeaders(); req.socket.setTimeout(0);
          const subscriber = { response: res, timer: null, close: null };
          subscriber.close = () => removeSubscriber(subscriber);
          subscriber.timer = setInterval(() => writeEvent(subscriber, ': heartbeat\n\n'), heartbeatMs);
          subscriber.timer.unref(); subscribers.add(subscriber); res.on('close', subscriber.close);
          writeEvent(subscriber, initial); break;
        }
      }
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      if (error instanceof RequestError) json(res, error.status, { error: error.message }, error.status === 413 ? { Connection: 'close' } : {});
      else if (error instanceof AssistantError) json(res, error.status, { error: error.message, code: error.code, ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}) });
      else json(res, 500, { error: 'The operation could not be completed. Check the device or account status and try again.' });
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  server.on('close', () => {
    for (const [type, listener] of listeners) session.off(type, listener);
    for (const subscriber of subscribers) { removeSubscriber(subscriber); subscriber.response.end(); }
  });
  return server;
}

async function startDirectly() {
  const port = Number(process.env.TUNE_WORKSHOP_PORT || 8765);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port.');
  const [elm, assistant] = await Promise.all([import('./elm.mjs'), import('./assistant.mjs')]);
  const server = createWorkshopServer({
    session: new elm.SensorSession(), availability: elm.availability, listSerialPorts: elm.listSerialPorts,
    assistantStatus: assistant.assistantStatus, beginAssistantSignIn: assistant.beginAssistantSignIn,
    disconnectAssistant: assistant.disconnectAssistant, askAssistant: assistant.askAssistant,
  });
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `Tune Workshop could not start: port ${port} is already in use.` : 'Tune Workshop could not start the local server.');
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log(`Tune Workshop: http://127.0.0.1:${port}`));
}
const directUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (directUrl === import.meta.url) startDirectly().catch(() => {
  console.error('Tune Workshop could not start. Check the installed dependencies and local configuration.'); process.exitCode = 1;
});
