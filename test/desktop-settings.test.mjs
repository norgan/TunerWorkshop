import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { normalizeSettings } from '../settings-schema.mjs';
import { installSettings } from '../desktop/settings.mjs';

function fixture() {
  const contents = new EventEmitter(), handlers = new Map(), frame = {};
  let currentUrl = 'http://127.0.0.1:12345/', destroyed = false, reads = 0, writes = 0, saved = normalizeSettings();
  Object.assign(contents, { mainFrame: frame, isDestroyed: () => destroyed, getURL: () => currentUrl });
  const ipcMain = { handle(channel, handler) { assert.equal(handlers.has(channel), false); handlers.set(channel, handler); }, removeHandler(channel) { handlers.delete(channel); } };
  const store = { async read() { reads++; return saved; }, async save(value) { writes++; saved = structuredClone(value); return saved; } };
  const installed = installSettings({ contents, ipcMain, origin: 'http://127.0.0.1:12345', store });
  const event = { sender: contents, senderFrame: frame };
  return { contents, handlers, event, store, dispose: installed.dispose, count: () => ({ reads, writes }), navigate(url) { currentUrl = url; }, destroy() { destroyed = true; contents.emit('destroyed'); }, invoke(channel, eventOverride = event, value) { return handlers.get(`workshop:settings-${channel}`)(eventOverride, value); } };
}

test('native settings IPC rejects foreign windows, child frames and foreign pages before storage access', async () => {
  const f = fixture();
  try {
    for (const event of [{ ...f.event, sender: {} }, { ...f.event, senderFrame: {} }]) {
      await assert.rejects(f.invoke('read', event), /only available in the Tune Workshop window/);
      await assert.rejects(f.invoke('save', event, normalizeSettings()), /only available in the Tune Workshop window/);
    }
    for (const url of ['http://127.0.0.1:56789/', 'https://example.test/', 'http://127.0.0.1:12345/other.html']) {
      f.navigate(url);
      await assert.rejects(f.invoke('read'), /only available in the Tune Workshop window/);
      await assert.rejects(f.invoke('save', f.event, normalizeSettings()), /only available in the Tune Workshop window/);
    }
    assert.deepEqual(f.count(), { reads: 0, writes: 0 });
    f.navigate('http://127.0.0.1:12345/index.html');
    assert.deepEqual(await f.invoke('read'), normalizeSettings());
  } finally { f.dispose(); }
});

test('native settings IPC accepts only the fixed schema and hides filesystem error details', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.invoke('save', f.event, { ...normalizeSettings(), filePath: 'unrelated.json' }), /unknown setting/);
    assert.equal(f.count().writes, 0);
    const changed = { ...normalizeSettings(), sendOnEnter: false };
    assert.deepEqual(await f.invoke('save', f.event, changed), changed);
    assert.deepEqual(await f.invoke('read'), changed);
    f.store.save = async () => { throw new Error('EACCES private/path/credentials'); };
    await assert.rejects(f.invoke('save', f.event, changed), /^Error: Your settings could not be loaded or saved\. Try again\.$/);
  } finally { f.dispose(); }
});

test('destroying the owning window removes settings handlers and invalidates captured callbacks', async () => {
  const f = fixture();
  const read = f.handlers.get('workshop:settings-read');
  const save = f.handlers.get('workshop:settings-save');
  f.destroy();
  assert.equal(f.handlers.size, 0);
  await assert.rejects(read(f.event), /only available in the Tune Workshop window/);
  await assert.rejects(save(f.event, normalizeSettings()), /only available in the Tune Workshop window/);
  f.dispose();
  assert.deepEqual(f.count(), { reads: 0, writes: 0 });
});
