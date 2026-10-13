import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, mkdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { SETTINGS_DEFAULTS, normalizeSettings, validateSettings, SettingsValidationError } from '../settings-schema.mjs';
import { createSettingsStore } from '../desktop/settings.mjs';

const preferences = overrides => ({ ...normalizeSettings(), ...overrides });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tune-workshop-settings-test-'));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    assert.ok(directory.includes('tune-workshop-settings-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  const filePath = join(directory, 'profile', 'settings.json');
  return { filePath, directory, store: createSettingsStore({ filePath }) };
}

test('settings recover valid known preferences and default malformed or missing fields', () => {
  const clean = normalizeSettings({ sendOnEnter: false, chatTextSize: '18', startupWorkspace: 'live', token: 'not a preference', connection: { transport: 'ble', port: 80, notify: 'FFF1', anything: true } });
  assert.equal(clean.sendOnEnter, false);
  assert.equal(clean.startupWorkspace, 'live');
  assert.equal(clean.chatTextSize, SETTINGS_DEFAULTS.chatTextSize);
  assert.equal(clean.connection.transport, 'ble');
  assert.equal(clean.connection.port, SETTINGS_DEFAULTS.connection.port);
  assert.equal(clean.connection.notify, 'FFF1');
  assert.equal('token' in clean, false);
  assert.equal('anything' in clean.connection, false);
  for (const malformed of [null, [], false, 'text', 12]) assert.deepEqual(normalizeSettings(malformed), SETTINGS_DEFAULTS);
  clean.connection.host = 'changed';
  assert.equal(normalizeSettings().connection.host, '');
});

test('strict settings updates reject unknown fields, incomplete objects and invalid types or ranges', () => {
  for (const value of [
    {}, { ...preferences(), surprise: true }, preferences({ sendOnEnter: 1 }),
    preferences({ chartHistorySeconds: 600 }), preferences({ preferredModel: 'invalid model\n' }),
    preferences({ defaultMapView: 'unsupported' }), preferences({ connection: [] }),
    preferences({ connection: { ...SETTINGS_DEFAULTS.connection, port: 35000.5 } }),
    preferences({ connection: { ...SETTINGS_DEFAULTS.connection, filePath: 'other.json' } }),
    preferences({ connection: { ...SETTINGS_DEFAULTS.connection, service: 'not a UUID' } }),
    preferences({ connection: { ...SETTINGS_DEFAULTS.connection, path: 'x'.repeat(512) } }),
  ]) assert.throws(() => validateSettings(value), SettingsValidationError);
  assert.equal(validateSettings(preferences({ preferredModel: 'gpt-6-astra' })).preferredModel, 'gpt-6-astra');
  assert.equal(validateSettings(preferences({ connection: { ...SETTINGS_DEFAULTS.connection, service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e' } })).connection.service, '6e400001-b5a3-f393-e0a9-e50e24dcca9e');
});

test('turning off remembering removes the model and connection from persisted preferences', async t => {
  const { store, filePath } = await fixture(t);
  const saved = await store.save(preferences({ rememberModel: false, preferredModel: 'gpt-6-astra', rememberConnection: false, connection: { ...SETTINGS_DEFAULTS.connection, transport: 'wifi', host: '192.168.0.10', path: 'COM6' } }));
  assert.equal(saved.preferredModel, '');
  assert.deepEqual(saved.connection, SETTINGS_DEFAULTS.connection);
  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), saved);
});

test('settings persist across fresh store instances independently of the loopback port', async t => {
  const { store, filePath } = await fixture(t);
  assert.deepEqual(await store.read(), SETTINGS_DEFAULTS);
  const desired = preferences({ sendOnEnter: false, chatTextSize: 18, startupWorkspace: 'live', connection: { ...SETTINGS_DEFAULTS.connection, transport: 'bluetooth', path: 'COM6' } });
  await store.save(desired);
  assert.deepEqual(await createSettingsStore({ filePath }).read(), desired);
});

test('queued writes preserve invocation order and copy caller input before waiting', async t => {
  const { store, filePath } = await fixture(t);
  const first = preferences({ chatTextSize: 16 });
  const final = preferences({ chatTextSize: 18, startupWorkspace: 'diagnostics' });
  const firstWrite = store.save(first);
  const finalWrite = store.save(final);
  final.chatTextSize = 14;
  final.connection.host = 'mutated after save';
  const readAfterWrites = store.read();
  await Promise.all([firstWrite, finalWrite]);
  const result = await readAfterWrites;
  assert.equal(result.chatTextSize, 18);
  assert.equal(result.connection.host, '');
  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), result);
  assert.deepEqual(await readdir(join(filePath, '..')), ['settings.json']);
});

test('corrupt and oversized saved files fall back safely and a later save repairs them', async t => {
  const { store, filePath } = await fixture(t);
  await mkdir(join(filePath, '..'), { recursive: true });
  for (const body of ['{broken', 'x'.repeat(16385), '[]', 'null']) {
    await writeFile(filePath, body);
    assert.deepEqual(await store.read(), SETTINGS_DEFAULTS);
  }
  await store.save(preferences({ autoScrollChat: false }));
  assert.equal((await store.read()).autoScrollChat, false);
});

test('failed validation and filesystem writes do not poison the settings queue', async t => {
  const { store, filePath } = await fixture(t);
  await assert.rejects(store.save({ secret: 'not allowed' }), SettingsValidationError);
  await mkdir(filePath, { recursive: true });
  await assert.rejects(store.save(preferences()), /^Error: Your settings could not be saved\. Try again\.$/);
  assert.deepEqual(await readdir(join(filePath, '..')), ['settings.json']);
  await rm(filePath, { recursive: true });
  await store.save(preferences({ showSensorStrip: false }));
  assert.equal((await store.read()).showSensorStrip, false);
});
