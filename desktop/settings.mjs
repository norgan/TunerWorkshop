import { open, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeSettings, validateSettings, SettingsValidationError } from '../settings-schema.mjs';
import { isLocalPage } from './policy.mjs';

const MAX_SETTINGS_BYTES = 16384;
const READ_CHANNEL = 'workshop:settings-read';
const SAVE_CHANNEL = 'workshop:settings-save';

export function createSettingsStore({ filePath }) {
  if (typeof filePath !== 'string' || !isAbsolute(filePath)) throw new Error('An absolute settings file path is required.');
  let queue = Promise.resolve();
  const enqueue = action => {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  };
  async function readFileBounded() {
    let handle;
    try {
      handle = await open(filePath, 'r');
      if ((await handle.stat()).size > MAX_SETTINGS_BYTES) return normalizeSettings();
      const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > MAX_SETTINGS_BYTES) return normalizeSettings();
      try { return normalizeSettings(JSON.parse(buffer.subarray(0, size).toString('utf8'))); }
      catch { return normalizeSettings(); }
    } catch (error) {
      if (error.code === 'ENOENT') return normalizeSettings();
      throw new Error('Your settings could not be read. Try reopening Tuner Workshop.');
    } finally { await handle?.close().catch(() => {}); }
  }
  return {
    read() { return enqueue(readFileBounded); },
    async save(value) {
      // Validate and copy before queuing, so a caller cannot mutate a pending write.
      const clean = validateSettings(value);
      const body = JSON.stringify(clean, null, 2) + '\n';
      if (Buffer.byteLength(body) > MAX_SETTINGS_BYTES) throw new SettingsValidationError('Settings exceed the size limit.');
      return enqueue(async () => {
        const temporary = `${filePath}.${randomUUID()}.tmp`;
        try {
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(temporary, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
          await rename(temporary, filePath);
          return clean;
        } catch { throw new Error('Your settings could not be saved. Try again.'); }
        finally { await rm(temporary, { force: true }).catch(() => {}); }
      });
    },
  };
}

export function installSettings({ contents, ipcMain, origin, store }) {
  let disposed = false;
  const trusted = event => !disposed && !contents.isDestroyed()
    && event.sender === contents && event.senderFrame === contents.mainFrame
    && isLocalPage(contents.getURL(), origin);
  const handle = action => async (event, value) => {
    if (!trusted(event)) throw new Error('Settings are only available in the Tuner Workshop window.');
    try { return await action(value); }
    catch (error) {
      if (error instanceof SettingsValidationError) throw new Error(error.message);
      throw new Error('Your settings could not be loaded or saved. Try again.');
    }
  };
  ipcMain.handle(READ_CHANNEL, handle(async () => normalizeSettings(await store.read())));
  ipcMain.handle(SAVE_CHANNEL, handle(async value => store.save(validateSettings(value))));
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    ipcMain.removeHandler(READ_CHANNEL);
    ipcMain.removeHandler(SAVE_CHANNEL);
    contents.off('destroyed', dispose);
  };
  contents.once('destroyed', dispose);
  return { dispose };
}
