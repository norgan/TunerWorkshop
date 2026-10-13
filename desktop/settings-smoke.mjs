// Runs only in the isolated desktop smoke profile. Assistant replies are local
// fixtures; this check never signs in, shares project data, or connects a car.
export async function runSettingsSmoke(contents) {
  return contents.executeJavaScript(`(${settingsSmokeInRenderer.toString()})()`);
}

async function settingsSmokeInRenderer() {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const $ = selector => document.querySelector(selector);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (predicate, message) => {
    const deadline = Date.now() + 5000;
    while (!predicate() && Date.now() < deadline) await pause(20);
    assert(predicate(), message);
  };
  const { settingsReady, getSettings, saveSettings } = await import('./settings-client.mjs');
  const { SETTINGS_DEFAULTS } = await import('./settings-schema.mjs');
  await settingsReady;
  assert(window.workshopDesktop?.readSettings && window.workshopDesktop?.saveSettings, 'Native settings bridge unavailable');
  const open = async () => { $('#open-settings').click(); await until(() => $('#settings-dialog').open, 'Settings did not open'); };
  const saveDialog = async () => {
    $('#settings-save').click();
    await until(() => !$('#settings-dialog').open, 'Settings save did not close the dialog');
  };
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // Establish a known baseline, including any connection preference changed by
  // the earlier synthetic sensor check. Reset must remain a draft until Save.
  await saveSettings({});
  const beforeReset = await window.workshopDesktop.readSettings();
  await open(); $('#settings-reset').click();
  assert(equal(await window.workshopDesktop.readSettings(), beforeReset), 'Reset wrote preferences before Save');
  await saveDialog();
  assert(equal(await window.workshopDesktop.readSettings(), SETTINGS_DEFAULTS), 'Reset did not persist the default preferences');

  await open();
  $('#settings-sendOnEnter').checked = false;
  $('#settings-chatTextSize').value = '18';
  $('#settings-cancel').click();
  assert(!$('#settings-dialog').open, 'Cancel left Settings open');
  assert(getSettings().sendOnEnter && getSettings().chatTextSize === 14, 'Cancel applied draft settings');
  assert(equal(await window.workshopDesktop.readSettings(), SETTINGS_DEFAULTS), 'Cancel changed stored preferences');

  await open();
  $('#settings-chatTextSize').value = '16';
  $('#settings-startupWorkspace').value = 'diagnostics';
  $('#settings-defaultMapView').value = 'curve';
  $('#settings-chartHistorySeconds').value = '120';
  await saveDialog();
  const saved = await window.workshopDesktop.readSettings();
  assert(saved.chatTextSize === 16 && saved.startupWorkspace === 'diagnostics' && saved.defaultMapView === 'curve' && saved.chartHistorySeconds === 120, 'Saved display preferences did not reach native storage');
  assert(getComputedStyle($('#assistant-question')).fontSize === '16px', 'Chat text size did not reach the message composer');
  await open();
  assert($('#settings-chatTextSize').value === '16' && $('#settings-startupWorkspace').value === 'diagnostics', 'Reopening Settings lost saved choices');
  $('#settings-reset').click(); $('#settings-cancel').click();
  assert(getSettings().chatTextSize === 16 && (await window.workshopDesktop.readSettings()).chatTextSize === 16, 'Cancelling Reset discarded saved preferences');

  const originalFetch = window.fetch;
  const originalScroll = Element.prototype.scrollIntoView;
  const account = {
    connected: true, configured: true, sharing: true, signingIn: false,
    message: 'Connected. Using ChatGPT plan.',
    models: [{ id: 'settings-smoke-a', name: 'Settings test A' }, { id: 'settings-smoke-b', name: 'Settings test B' }],
  };
  const requests = [];
  let holdNext = false, releaseReply = null, chatScrollCalls = 0, sensorConnectRequests = 0;
  window.fetch = async (url, options) => {
    if (url === '/api/sensors/connect') {
      sensorConnectRequests++;
      return new Response(JSON.stringify({ error: 'Settings smoke blocked an unexpected sensor connection.' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    }
    if (url === '/api/assistant/status') return new Response(JSON.stringify(account), { headers: { 'Content-Type': 'application/json' } });
    if (url === '/api/assistant/message') {
      const body = JSON.parse(options.body);
      assert(body.context === undefined, 'Settings keyboard test unexpectedly shared vehicle context');
      requests.push(body);
      if (holdNext) { holdNext = false; await new Promise(resolve => { releaseReply = resolve; }); }
      return new Response(JSON.stringify({ text: `Settings test reply ${requests.length}.` }), { headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch(url, options);
  };
  Element.prototype.scrollIntoView = function (...args) {
    if (this.classList?.contains('chat-message')) chatScrollCalls++;
    return originalScroll.apply(this, args);
  };
  const key = options => {
    const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, ...options });
    $('#assistant-question').dispatchEvent(event);
    return event;
  };
  const waitForReply = async count => {
    await until(() => requests.length === count && !$('#assistant-send').disabled, `Chat keyboard request ${count} did not finish`);
  };
  try {
    if ($('#assistant-panel').hidden) $('#assistant-toggle').click(); else $('#assistant-refresh').click();
    await until(() => !$('#assistant-send').disabled && $('#assistant-model').options.length === 2, 'Synthetic account did not reach the assistant');
    $('#assistant-include-context').checked = false;
    $('#assistant-question').value = 'Enter should send once';
    const enter = key();
    assert(enter.defaultPrevented, 'Enter-to-send did not prevent a newline');
    await waitForReply(1); await pause(30);
    assert(requests.length === 1, 'Enter sent a duplicate message');
    assert(getComputedStyle($('#assistant-messages .chat-message p')).fontSize === '16px', 'Saved chat text size did not reach messages');

    for (const [label, modifiers] of [
      ['Shift+Enter', { shiftKey: true }], ['composition', { isComposing: true }],
      ['repeat', { repeat: true }], ['Alt+Enter', { altKey: true }],
    ]) {
      $('#assistant-question').value = `${label} should not send`;
      const event = key(modifiers);
      await pause(30);
      assert(requests.length === 1, `${label} unexpectedly sent a message`);
      assert(!event.defaultPrevented, `${label} was incorrectly consumed by the send shortcut`);
    }
    $('#assistant-question').value = '   '; key(); await pause(30);
    assert(requests.length === 1, 'Empty message used the chat connection');

    await saveSettings({ sendOnEnter: false });
    $('#assistant-question').value = 'Plain Enter remains a newline';
    assert(!key().defaultPrevented, 'Enter remained a submit shortcut after disabling it');
    await pause(30); assert(requests.length === 1, 'Disabled Enter-to-send still sent a message');
    $('#assistant-question').value = 'Control Enter should send'; key({ ctrlKey: true }); await waitForReply(2);
    $('#assistant-question').value = 'Command Enter should send'; key({ metaKey: true }); await waitForReply(3);

    await saveSettings({ sendOnEnter: true, autoScrollChat: false });
    chatScrollCalls = 0;
    $('#assistant-question').value = 'Auto-scroll is disabled'; key(); await waitForReply(4);
    assert(chatScrollCalls === 0, 'Chat scrolled with auto-scroll disabled');
    await saveSettings({ autoScrollChat: true });
    $('#assistant-question').value = 'Auto-scroll is enabled'; key(); await waitForReply(5);
    assert(chatScrollCalls > 0, 'Chat failed to scroll with auto-scroll enabled');

    holdNext = true; $('#assistant-question').value = 'Keep this request pending'; key();
    await until(() => requests.length === 6 && typeof releaseReply === 'function', 'Pending request was not created');
    $('#assistant-question').value = 'Do not send twice while busy'; key(); await pause(40);
    assert(requests.length === 6, 'Busy chat accepted a second keyboard request');
    releaseReply(); releaseReply = null; await waitForReply(6);

    $('#assistant-model').value = 'settings-smoke-b'; $('#assistant-model').dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => getSettings().preferredModel === 'settings-smoke-b', 'Selected chat model was not remembered');
    assert((await window.workshopDesktop.readSettings()).preferredModel === 'settings-smoke-b', 'Selected model was not persisted natively');
    await saveSettings({ rememberModel: false });
    assert(getSettings().preferredModel === '' && (await window.workshopDesktop.readSettings()).preferredModel === '', 'Disabling model memory retained the saved model');
    await open();
    assert(!$('#settings-rememberModel').checked, 'Model memory toggle did not reflect the saved preference');
    $('#settings-rememberModel').checked = true; await saveDialog();
    assert(getSettings().rememberModel && getSettings().preferredModel === 'settings-smoke-b', 'Re-enabling model memory did not capture the selected model');
    assert((await window.workshopDesktop.readSettings()).preferredModel === 'settings-smoke-b', 'Re-enabled model memory did not persist the current model');

    await saveSettings({ rememberConnection: false });
    $('#connection-setup').click();
    for (const [id, value] of [['adapter-transport', 'wifi'], ['wifi-host', '192.168.0.10'], ['wifi-port', '35000']]) {
      $('#' + id).value = value;
      $('#' + id).dispatchEvent(new Event('change', { bubbles: true }));
    }
    await pause(40);
    assert(equal((await window.workshopDesktop.readSettings()).connection, SETTINGS_DEFAULTS.connection), 'Connection details were saved while adapter memory was disabled');
    await open();
    assert(!$('#settings-rememberConnection').checked, 'Adapter memory toggle did not reflect the saved preference');
    $('#settings-rememberConnection').checked = true; await saveDialog();
    const rememberedConnection = await window.workshopDesktop.readSettings();
    assert(rememberedConnection.rememberConnection && rememberedConnection.connection.transport === 'wifi' && rememberedConnection.connection.host === '192.168.0.10' && rememberedConnection.connection.port === 35000, 'Re-enabling adapter memory did not capture the current setup');
    await pause(40);
    assert(sensorConnectRequests === 0 && $('#live-status').textContent === 'Disconnected', 'Remembering adapter setup unexpectedly started a vehicle connection');

    Object.assign(account, { configured: false, connected: false, models: [], message: 'Synthetic disconnected account.' });
    $('#assistant-refresh').click();
    await until(() => $('#assistant-send').disabled, 'Disconnected test state did not disable chat');
    $('#assistant-question').value = 'Disconnected chat must not submit'; key(); await pause(40);
    assert(requests.length === 6, 'Disconnected chat accepted a keyboard request');
    $('#assistant-question').value = ''; $('#assistant-clear').click();
  } finally {
    releaseReply?.();
    window.fetch = originalFetch;
    Element.prototype.scrollIntoView = originalScroll;
  }

  // Leave an intentional startup preference for the main-process reload check.
  // The profile is temporary, so this does not change the user's real settings.
  await saveSettings({ sendOnEnter: true, autoScrollChat: true, rememberModel: true, preferredModel: '', startupWorkspace: 'diagnostics', defaultMapView: 'curve' });
  const syntheticStatus = $('#assistant-status').textContent;
  $('#assistant-refresh').click();
  await until(() => $('#assistant-send').disabled && $('#assistant-status').textContent !== syntheticStatus, 'Original disconnected assistant state was not restored');
  return {
    settingsDialog: true, settingsSaveCancelReset: true, nativeSettingsPersistence: true,
    chatTextSize: true, chatEnterToSend: true, chatShiftEnterNewline: true,
    chatModifiedEnter: true, chatCompositionRepeatAndAltGuards: true,
    chatEmptyBusyAndDisconnectedGuards: true, chatAutoScrollPreference: true,
    preferredModelPersistence: true, rememberedModelReenabled: true,
    rememberedConnectionReenabled: true, rememberedConnectionDoesNotConnect: true,
    startupPreferencesSaved: true,
  };
}
