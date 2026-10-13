import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installServiceLifecycle } from '../desktop/service-lifecycle.mjs';

function fixture() {
  const window = new EventEmitter(), contents = new EventEmitter(), handlers = new Map(), mainFrame = {}, messages = [];
  let currentUrl = 'http://127.0.0.1:12345/', destroyed = false;
  Object.assign(contents, {
    mainFrame, getURL: () => currentUrl, isDestroyed: () => destroyed,
    send: (...args) => messages.push(args)
  });
  const ipcMain = {
    handle(channel, handler) { assert.equal(handlers.has(channel), false); handlers.set(channel, handler); },
    removeHandler(channel) { handlers.delete(channel); }
  };
  const installed = installServiceLifecycle({ window, contents, ipcMain, origin: 'http://127.0.0.1:12345' });
  const event = { sender: contents, senderFrame: mainFrame };
  return {
    window, contents, handlers, event, messages, ...installed,
    invoke(value, sender = event, ...extra) { return handlers.get('workshop:service-active')(sender, value, ...extra); },
    navigate(url) { currentUrl = url; }, destroyRenderer() { destroyed = true; },
    close() { let prevented = false; window.emit('close', { preventDefault() { prevented = true; } }); return prevented; },
    closed() { window.emit('closed'); }
  };
}

test('service guard only admits the owning local main frame and a boolean payload', async () => {
  const f = fixture();
  try {
    for (const sender of [null, { ...f.event, sender: {} }, { ...f.event, senderFrame: {} }]) {
      await assert.rejects(f.invoke(true, sender), /only available/);
    }
    for (const value of [undefined, null, 0, 1, 'true', {}, []]) await assert.rejects(f.invoke(value), /must be a boolean/);
    await assert.rejects(f.invoke(true, f.event, 'extra'), /must be a boolean/);
    for (const url of ['https://example.test/', 'http://127.0.0.1:54321/', 'http://127.0.0.1:12345/other.html']) {
      f.navigate(url); await assert.rejects(f.invoke(true), /only available/);
    }
    assert.equal(f.isActive(), false); assert.equal(f.close(), false); assert.deepEqual(f.messages, []);
    f.navigate('http://127.0.0.1:12345/index.html');
    assert.deepEqual(await f.invoke(true), { active: true }); assert.equal(f.isActive(), true);
  } finally { f.closed(); }
});

test('an active service blocks closing and signals its renderer until trusted cleanup releases it', async () => {
  const f = fixture();
  try {
    assert.equal(f.close(), false);
    const setting = f.invoke(true);
    assert.equal(f.isActive(), true, 'Protection is active before the IPC acknowledgement resolves');
    await setting;
    assert.equal(f.close(), true); assert.equal(f.close(), true);
    assert.deepEqual(f.messages, [['workshop:service-close-blocked'], ['workshop:service-close-blocked']]);
    await assert.rejects(f.invoke(false, { ...f.event, senderFrame: {} }), /only available/);
    assert.equal(f.isActive(), true); assert.equal(f.close(), true);
    assert.deepEqual(await f.invoke(false), { active: false });
    const sent = f.messages.length;
    assert.equal(f.close(), false); assert.equal(f.messages.length, sent);
  } finally { f.closed(); }
});

test('renderer notification failure or destruction cannot silently release an active service', async () => {
  const f = fixture();
  try {
    await f.invoke(true);
    f.contents.send = () => { throw new Error('Renderer unreachable'); };
    assert.equal(f.close(), true); assert.equal(f.isActive(), true);
    f.destroyRenderer();
    await assert.rejects(f.invoke(false), /only available/);
    assert.equal(f.close(), true); assert.equal(f.isActive(), true);
  } finally { f.closed(); }
});

test('closing the owning window removes the IPC handler and rejects captured callbacks', async () => {
  const f = fixture(), captured = f.handlers.get('workshop:service-active');
  await f.invoke(true);
  f.closed(); f.closed();
  assert.equal(f.handlers.size, 0); assert.equal(f.isActive(), false);
  assert.equal(f.window.listenerCount('close'), 0); assert.equal(f.window.listenerCount('closed'), 0);
  await assert.rejects(captured(f.event, true), /only available/);
  assert.equal(f.close(), false);
});
