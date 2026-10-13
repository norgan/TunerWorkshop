import { getSettings, getSettingsError, saveSettings, settingsReady } from './settings-client.mjs';
import { SETTINGS_DEFAULTS } from './settings-schema.mjs';
import {captureRememberedSettings} from './live.mjs';

const dialog = document.createElement('dialog');
dialog.id = 'settings-dialog';
dialog.className = 'settings-dialog';
dialog.setAttribute('aria-labelledby', 'settings-title');
dialog.setAttribute('aria-describedby', 'settings-description');
dialog.innerHTML = `
  <form id="settings-form">
    <header class="settings-heading">
      <div><span class="eyebrow">TUNER WORKSHOP</span><h2 id="settings-title">Settings</h2></div>
      <button id="settings-close" type="button" aria-label="Close settings">×</button>
    </header>
    <p id="settings-description" class="settings-intro">Make the workspace feel right for you. Saved preferences are kept on this computer.</p>
    <fieldset class="settings-section">
      <legend>Chat</legend>
      <label class="settings-check" for="settings-sendOnEnter">
        <input id="settings-sendOnEnter" type="checkbox">
        <span><strong>Enter sends a message</strong><small>Shift+Enter starts a new line. Ctrl+Enter or ⌘+Enter always sends.</small></span>
      </label>
      <label class="settings-check" for="settings-autoScrollChat">
        <input id="settings-autoScrollChat" type="checkbox">
        <span><strong>Scroll to new chat messages</strong><small>Keep the latest question and reply in view.</small></span>
      </label>
      <label class="settings-select" for="settings-chatTextSize">
        <span><strong>Chat text size</strong><small>Applies to messages and the message box.</small></span>
        <select id="settings-chatTextSize"><option value="14">Standard · 14 px</option><option value="16">Larger · 16 px</option><option value="18">Largest · 18 px</option></select>
      </label>
      <label class="settings-check" for="settings-rememberModel">
        <input id="settings-rememberModel" type="checkbox">
        <span><strong>Remember my chosen model</strong><small>Use it next time if it is available on your account.</small></span>
      </label>
    </fieldset>
    <fieldset class="settings-section">
      <legend>Startup &amp; editor</legend>
      <label class="settings-select" for="settings-startupWorkspace">
        <span><strong>Starting workspace</strong><small>Shown the next time you open the app.</small></span>
        <select id="settings-startupWorkspace"><option value="tuning">Tuning</option><option value="diagnostics">Diagnostics</option><option value="live">Live sensors</option></select>
      </label>
      <label class="settings-select" for="settings-defaultMapView">
        <span><strong>Default map view</strong><small>Used on launch and when you open a project.</small></span>
        <select id="settings-defaultMapView"><option value="table">Table</option><option value="curve">2D curve</option><option value="surface">3D surface</option><option value="hex">Hex</option></select>
      </label>
      <label class="settings-select" for="settings-pressureUnit">
        <span><strong>Boost / pressure units</strong><small>Use bar or psi for pressure maps, edits and live readings. Absolute and gauge references stay as supplied.</small></span>
        <select id="settings-pressureUnit"><option value="bar">bar</option><option value="psi">psi</option></select>
      </label>
    </fieldset>
    <fieldset class="settings-section">
      <legend>Live sensors &amp; connection</legend>
      <label class="settings-check" for="settings-showSensorStrip">
        <input id="settings-showSensorStrip" type="checkbox">
        <span><strong>Show the live readings bar</strong><small>Keep readings visible above the workspace while connected.</small></span>
      </label>
      <label class="settings-select" for="settings-chartHistorySeconds">
        <span><strong>Live chart history</strong><small>Changes the visible chart window. Recordings keep all their samples.</small></span>
        <select id="settings-chartHistorySeconds"><option value="30">Last 30 seconds</option><option value="60">Last 60 seconds</option><option value="120">Last 2 minutes</option></select>
      </label>
      <label class="settings-check" for="settings-rememberConnection">
        <input id="settings-rememberConnection" type="checkbox">
        <span><strong>Remember adapter setup</strong><small>Keep the connection type, port and adapter details. Choose Connect to start a session; Bluetooth LE still asks you to select a device.</small></span>
      </label>
    </fieldset>
    <p class="settings-apply-note">Chat and display changes apply when you save.</p>
    <p id="settings-message" role="status" aria-live="polite" aria-atomic="true"></p>
    <footer class="settings-actions">
      <button id="settings-reset" type="button">Reset defaults</button>
      <div><button id="settings-cancel" type="button">Cancel</button><button id="settings-save" class="primary" type="submit">Save settings</button></div>
    </footer>
  </form>`;
document.body.append(dialog);

const savedStatus = document.createElement('div');
savedStatus.id = 'settings-saved-status';
savedStatus.className = 'settings-saved-status';
savedStatus.setAttribute('role', 'status');
savedStatus.setAttribute('aria-live', 'polite');
savedStatus.setAttribute('aria-atomic', 'true');
savedStatus.hidden = true;
document.body.append(savedStatus);

const keys = [
  'sendOnEnter', 'autoScrollChat', 'chatTextSize', 'rememberModel',
  'startupWorkspace', 'defaultMapView', 'pressureUnit', 'showSensorStrip',
  'chartHistorySeconds', 'rememberConnection',
];
const numericKeys = new Set(['chatTextSize', 'chartHistorySeconds']);
const form = dialog.querySelector('#settings-form');
const message = dialog.querySelector('#settings-message');
const saveButton = dialog.querySelector('#settings-save');
let busy = false;
let opening = false;
let resetPending = false;
let previousFocus = null;
let savedStatusTimeout;

function populate(settings) {
  for (const key of keys) {
    const input = dialog.querySelector(`#settings-${key}`);
    if (input.type === 'checkbox') input.checked = settings[key];
    else input.value = String(settings[key]);
  }
}

function readForm() {
  const patch = resetPending ? structuredClone(SETTINGS_DEFAULTS) : {};
  for (const key of keys) {
    const input = dialog.querySelector(`#settings-${key}`);
    patch[key] = input.type === 'checkbox' ? input.checked : numericKeys.has(key) ? Number(input.value) : input.value;
  }
  return patch;
}

function setMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle('settings-error', isError);
}

function setBusy(value) {
  busy = value;
  form.setAttribute('aria-busy', String(value));
  for (const control of form.querySelectorAll('input, select, button')) control.disabled = value;
  saveButton.textContent = value ? 'Saving…' : 'Save settings';
}

function closeSettings() {
  if (!busy) dialog.close();
}

export async function openSettings() {
  if (dialog.open || opening) return;
  opening = true;
  previousFocus = document.activeElement;
  resetPending = false;
  clearTimeout(savedStatusTimeout);
  savedStatus.hidden = true;
  let readFailed = false;
  try {
    await settingsReady;
  } catch {
    readFailed = true;
  } finally {
    opening = false;
  }
  // Wait for stored preferences before accepting edits so a late read cannot
  // replace choices made in the dialog.
  populate(getSettings());
  const readError = getSettingsError() || (readFailed ? 'Saved preferences could not be read. You can choose your settings and try saving again.' : '');
  setMessage(readError, Boolean(readError));
  dialog.showModal();
  dialog.querySelector('#settings-sendOnEnter').focus();
}

dialog.querySelector('#settings-close').addEventListener('click', closeSettings);
dialog.querySelector('#settings-cancel').addEventListener('click', closeSettings);
dialog.querySelector('#settings-reset').addEventListener('click', () => {
  if (busy) return;
  populate(SETTINGS_DEFAULTS);
  resetPending = true;
  setMessage('Defaults are ready to save. This also clears the remembered model and adapter setup. Cancel keeps your current settings.');
});
dialog.addEventListener('cancel', event => {
  if (busy) event.preventDefault();
});
dialog.addEventListener('close', () => {
  resetPending = false;
  if (previousFocus?.isConnected && typeof previousFocus.focus === 'function') previousFocus.focus();
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  const patch = captureRememberedSettings(readForm());
  setBusy(true);
  setMessage('Saving settings…');
  try {
    await saveSettings(patch);
    setBusy(false);
    dialog.close();
    savedStatus.textContent = 'Settings saved';
    savedStatus.hidden = false;
    savedStatusTimeout = setTimeout(() => { savedStatus.hidden = true; }, 4000);
  } catch {
    setBusy(false);
    setMessage('Settings could not be saved. Your choices are still here; try again.', true);
    saveButton.focus();
  }
});

document.querySelector('#open-settings')?.addEventListener('click', () => { void openSettings(); });
window.workshopDesktop?.onOpenSettings?.(() => { void openSettings(); });
