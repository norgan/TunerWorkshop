import { isLocalPage } from './policy.mjs';

const CHANNEL = 'workshop:service-active';
const BLOCKED_CHANNEL = 'workshop:service-close-blocked';

/**
 * Keep the owning renderer alive while its BLE service sequence can still need
 * an ECU return-control command. Only its local main frame can release the
 * guard, after awaiting service cancellation/cleanup.
 */
export function installServiceLifecycle({ window, contents, ipcMain, origin }) {
  let active = false, disposed = false;
  const trusted = event => !disposed && !contents.isDestroyed()
    && event?.sender === contents && event.senderFrame === contents.mainFrame
    && isLocalPage(contents.getURL(), origin);
  ipcMain.handle(CHANNEL, async (event, value, ...extra) => {
    if (!trusted(event)) throw new Error('Service protection is only available in the Tune Workshop window.');
    if (typeof value !== 'boolean' || extra.length) throw new Error('Service activity must be a boolean.');
    active = value;
    return { active };
  });
  const onClose = event => {
    if (!active || disposed) return;
    event.preventDefault();
    // If rendering has failed, retain protection instead of assuming that the
    // vehicle received a stop command. Normal notification failures cannot
    // turn an active close request into permission to destroy the renderer.
    if (!contents.isDestroyed()) {
      try { contents.send(BLOCKED_CHANNEL); } catch { /* Keep the close blocked. */ }
    }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true; active = false;
    ipcMain.removeHandler(CHANNEL);
    window.off('close', onClose);
    window.off('closed', dispose);
  };
  window.on('close', onClose);
  window.once('closed', dispose);
  return { isActive: () => active && !disposed };
}
