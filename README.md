# Tune Workshop

Tune Workshop 0.9.2 is a Windows desktop calibration editor, saved-diagnostics viewer, generic OBD and Fiat IAW 8GMK sensor monitor and ChatGPT account assistant for the Fiat 500X project. The editor supports explicit map definitions, table and graph views, direct byte editing, comparison, reversible edits and saved projects. It now automatically reads saved map definitions from the observed WinOLS schema 597 layout and groups source-labelled boost, ignition and fuel controls. Numeric values in the supplied MiTo OLS remain undecoded; its catalogue is inspectable but cannot yet supply editable tuning tables. It starts with clearly labelled synthetic example maps. All imported files remain byte-editable, including the supplied Dimsport GEN_FILE container. Editing container bytes does not establish ECU map addresses, checksum correctness or a valid flash procedure.

The requested destination is an approachable tuning application with the full range of MultiECUScan diagnostic functions. The capability plan records that scope without presenting planned controls as working vehicle functions.

## Windows executable

The Windows build produces two x64 executables in `dist`:

- `Tune-Workshop-0.9.2-Windows-x64.exe`: portable executable. Run it directly; installation is unnecessary.
- `Tune-Workshop-0.9.2-Setup-x64.exe`: per-user installer with Start menu and optional desktop shortcut. It does not require an administrator install and does not run the app automatically after setup.

Build both with `npm run build:win`. Generated executables are not stored in Git. Both include Electron, Chromium, Node.js and the USB serial library. No separate Node installation or manually started server is needed. The app owns a private loopback service on an available port, so it can coexist with the earlier browser preview. Closing the desktop window stops sensor polling and its local service. Unsaved project/recording changes trigger a close confirmation. Cancelling a Windows Save dialog keeps the unsaved state; only a completed save clears it, provided no further changes or samples arrived during the save.

Desktop account credentials are encrypted for the current Windows user and stored under `%APPDATA%\Tune Workshop\account`. Browser-preview credentials, if present, are not copied into the desktop app. The application opens official ChatGPT sign-in links in your default browser. Project files are opened and exported using Windows file dialogs; originals are never overwritten automatically.

These local builds are not publisher-signed. They are a development preview, not a verified ECU flashing product.

## Run from source or use the browser preview

Use Node.js 20 or newer and a current browser. Run `npm ci` once after cloning the repository. The pinned dependencies are `jose` for verified account sign-in and the optional `serialport` USB driver; Wi-Fi uses Node's TCP library.

For source development, use `npm run desktop` to open the desktop app, or `npm run build:win` to rebuild both Windows executables. Electron's runtime setup must be enabled during dependency installation; if npm skips package scripts, run `node node_modules/electron/install.js` explicitly. The SerialPort package includes a Windows x64 Node-API binary; the packaged-app self-test verifies it can load under Electron.

For the optional browser preview, run `Start-Tune-Workshop.ps1` from this directory. It starts the local server and opens the application. Alternatively, run:

```powershell
npm start
```

Then open [Tune Workshop](http://localhost:8765/). The server binds only to `127.0.0.1`. When running in a terminal, stop it with Ctrl+C. The PowerShell launcher starts a hidden Node process; closing the browser does not stop that process.

## Editing workflow

Use **Boost / pressure** in the vehicle bar, or **Settings → Boost / pressure units**, to switch between **bar** and **psi**. The choice is saved and applies to recognised pressure maps, tables, graphs, edit previews, map CSV exports, assistant context and live readings. Enter edits in the displayed unit; the editor converts them back into the map's declared storage units. Switching units alone never changes calibration bytes. Absolute and gauge references stay as declared by the definition; the unit switch does not subtract atmospheric pressure. Sensor recording files retain their original measurement units.

1. Explore **Load synthetic demo** to try the table, 2D curve, 3D surface and hex editor. Its fuel, ignition and lambda labels, addresses, axes and values are fabricated examples; they are not Fiat calibration definitions.
2. Use **Open ECU binary** for any binary file. Source bytes are preserved separately from the working copy. Known GEN_FILE, WinOLS, ZIP and executable containers remain editable and display their unverified-format status. For the observed Dimsport GEN_FILE layout, the editor exposes an inferred ECU image and can search its original bytes for raw sequence candidates. Candidate names, units and scaling are not identified tuning definitions. All addresses are offsets into the imported file, including any header.
3. Use **Define a map** or **Import definitions** with addresses, storage types, byte order, scaling and dimensions established for that exact original binary. Review `engineering value = raw value × factor + offset` and integer rounding when changing values.
4. Select cells, apply a value/addition/percentage change, inspect the original and review changed bytes. Undo, redo and restore-original controls operate on edits. The core retains up to 100 edit operations.
5. Use **Save project** and keep the downloaded file. Use **Open project** to resume it. There is no automatic recovery after closing the tab or browser. Saved projects contain original/modified bytes and map definitions; session undo history and imported diagnostic logs are not included.
6. Export a numeric map CSV or change report for review. **Export draft binary** produces an unverified draft: ECU checksum correction, ECU software matching and vehicle acceptance have not been established. The SHA-256 identifies the original file; it is not an ECU checksum.

For direct edits, select **Hex**, click a byte or enter **Start offset**, enter complete hexadecimal byte pairs such as `DE AD BE EF`, then select **Apply bytes**. One operation supports up to 65,536 existing bytes. **Restore bytes** replaces a specified range with its original bytes; Undo/Redo apply to both map and byte edits. Direct byte editing can change container headers and bytes outside map definitions. It preserves file length. If raw edits make a float map undecodable, the app falls back to Hex without discarding the edit. Projects explicitly record when raw-byte editing has been used so these changes survive save/reopen.

Projects use the custom `tuneworkshop-workspace` JSON format, downloaded with `.tuneworkshop.json`. Opening the supplied MiTo `.ols` now loads its saved definition catalogue automatically. Boost, ignition and fuel categories follow explicit source labels and known reference symbols; ambiguous entries remain under Other. Names, symbols, saved dimensions, units, axis descriptions and scales are shown without requiring manual address entry. Source definitions remain separate from editable maps: their stored image addresses are not offsets into the OLS container or established Fiat 8GMK locations. Saving and reopening a project reconstructs its source catalogue from preserved original bytes, even after raw edits.

The importer recovered 5,019 metadata records from the supplied MiTo file (81 boost, 61 ignition, 252 fuel, 4,625 other) and rejected 47 records outside the supported string/record layout. These counts include constants and curves as well as tables. Duplicate symbols retain separate records; search, category filters and pagination keep the catalogue manageable. The selected definition can be discussed with the assistant through the existing opt-in context preview. No whole OLS or ECU file is uploaded. The numeric Original-version payload and axis breakpoints remain unresolved, so the catalogue does not fabricate table values, graphs, editable map offsets or a raw ECU export. Other WinOLS layouts are explicitly unsupported. This is not complete WinOLS project compatibility or automatic semantic identification of arbitrary raw firmware.

Editable map imports accept JSON arrays or an object with a `maps` array; they do not parse native DAMOS, A2L or XDF files. An optional top-level `originalSha256` binds an imported JSON definition set to the open original binary.

This definition describes **only a synthetic 16-byte sample**: eight unsigned 16-bit values at byte address zero. It is not a Fiat map and must not be applied to an ECU image as a tuning definition.

```json
{
  "maps": [
    {
      "id": "synthetic-16-byte-example",
      "name": "Synthetic sample values",
      "address": 0,
      "rows": 2,
      "cols": 4,
      "type": "uint16",
      "endian": "little",
      "factor": 1,
      "offset": 0,
      "unit": "sample units",
      "xLabel": "Synthetic column",
      "yLabel": "Synthetic row",
      "xAxis": [0, 1, 2, 3],
      "yAxis": [0, 1],
      "min": 0,
      "max": 65535,
      "synthetic": true
    }
  ]
}
```

Supported storage types are `uint8`, `int8`, `uint16`, `int16`, `uint32`, `int32` and `float32`. The core rejects overlapping maps, out-of-file ranges and invalid writes. Limits are 32 MiB per binary, 256 maps, 64 rows/columns and 4,096 cells per map. Map bounds are supplied constraints, not proof that values are suitable for an engine.

## Saved MultiECUScan sessions

In **Diagnostics**, use **Import MES log** for an English `FESLog` text file. The viewer shows allowed ECU identification fields, historical fault occurrences, parameter names/units, numeric charts and categorical values. Parameter samples retain their recorded order. The supported logs have no sample timestamps, so the charts use sample order rather than seconds.

Importing a saved log makes no vehicle connection. It does not execute commands or establish present fault status. Fault freeze frames are not merged into parameter streams. The parser omits VIN, licensing, serial/security fields and odometer readings; it does not retain the raw text. Limits are 5 MiB, 100,000 lines, 50,000 samples, 256 channels and 200 distinct fault descriptions. Combined sessions and unsupported input fail explicitly.

Files are read locally in the browser. The server has no binary-upload endpoint. Work remains in memory until the user downloads a project or export; imported diagnostics must be imported again after a reload.

## USB, Bluetooth and Wi-Fi live sensors

Select **Set up connection** in the top bar, or open **Live sensors**. The Connection list has four choices:

- **USB / serial**: refresh ports, choose the adapter and set its baud rate.
- **Bluetooth Low Energy (BLE)**: for the user's BLE ELM-style adapter, enable Bluetooth and power the adapter, leave **BLE serial services** on **Detect automatically**, then select **Find BLE adapter**. Choose the advertised adapter name in the device picker. BLE does not use a COM port or serial baud rate. Pairing confirmation or PIN entry appears only if Windows requests it.
- **Bluetooth Classic / COM**: pair the adapter in Windows, identify its outgoing COM port, refresh the port list and select that port. Bluetooth serial ports are labelled separately from USB ports; unidentified ports remain available. A COM-port entry alone does not prove it belongs to an OBD adapter or identify its direction.
- **Wi-Fi / TCP**: join the adapter's Wi-Fi network and enter its private IPv4 address and TCP port. The default 35000 is a starting value, not a detected setting.

Bluetooth modes include setup instructions and a link to Windows Bluetooth settings. Discovery and connection require the user's explicit action. The app does not automatically select the first nearby device or accept a pairing request. Close other apps that already hold the adapter connection.

BLE uses Electron's Web Bluetooth support. Automatic service detection checks FFE0/FFE1, FFF0/FFF2-write/FFF1-notify, and Nordic UART UUIDs. These are candidate layouts, not verified adapter-model compatibility claims. Discovery verifies actual write/notify properties; an unambiguous alternative pair in a candidate service is accepted. **Custom services** accepts a service UUID and explicit write/notification characteristic UUIDs from the adapter supplier. Unsupported services produce a clear error and disconnect before sending ELM commands. Native device selection and PIN/confirmation replies are restricted to this app's current main window and pending request.

All four transports share the same diagnostic session engine. **Standard OBD sensors** uses Mode 01 supported-PID discovery for engine speed, coolant temperature, manifold absolute pressure, intake-air temperature, throttle position and control-module voltage. **Fiat 500X · IAW 8GMK · 105 parameters** uses the recovered manufacturer profile described below. Responses stay attributed to one ECU; malformed frames, timeouts and disconnections stop the session. BLE notifications may arrive in fragments, and GATT writes are serialized even when a reply arrives before its write acknowledgement. The user supplied a screenshot showing successful generic USB readings on COM4 at 38400 baud. Manufacturer-specific communication and physical BLE/Wi-Fi compatibility remain unverified.

Readings continue alongside offline editing. Generic measurements appear in the compact strip; the Fiat profile uses its named cards and charts. Numeric readings can be charted; categorical states retain their labels. Freshness follows the channel and polling group (5 seconds for generic defaults, 15–30 seconds for manufacturer polling). Recordings hold at most 20,000 samples and export selected readings, profile, ECU source and session attribution to JSON. Unsaved recordings trigger a close prompt. Disconnect stops polling. BLE belongs to the app window and disconnects when it closes. In browser-preview mode, USB/Classic/Wi-Fi belong to the separate server and require Disconnect or stopping the server.

ECU flashing, live calibration writes, checksum correction, fault clearing, actuator tests and service routines remain unimplemented. The manufacturer sensor profile is implemented with static and simulated-response validation; real-vehicle acceptance is still required.

Implementation references: [Electron device access](https://www.electronjs.org/docs/latest/tutorial/devices), [Windows Bluetooth profiles](https://learn.microsoft.com/en-us/windows-hardware/drivers/bluetooth/bluetooth-host-radio-support), and [Windows settings links](https://learn.microsoft.com/en-us/windows/apps/develop/launch/launch-settings).

## ChatGPT account assistant

Open **Assistant** and select **Connect ChatGPT**. The Windows app opens the system browser; complete the account permission flow yourself. **Continue sign-in in browser** remains available if you need to reopen it (the browser preview requires that separate click). This uses OpenAI's official Sign in with ChatGPT support for local personal projects. Available models come from the connected account. Preview eligibility and granting plan usage determine whether inference is available; successful identity sign-in alone is insufficient. See the [official sign-in guide](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) and [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

The Windows app stores its account registration and tokens under `%APPDATA%\Tune Workshop\account\assistant-state.dpapi`; the optional browser preview uses `.local/assistant-state.dpapi`. Both are encrypted for the current Windows user. Neither reads another app's credentials. **Sign out** removes the active session's tokens and attempts remote revocation. The local server exposes only explicitly listed frontend assets and requires same-origin API requests. The desktop service additionally requires a per-launch token injected by the desktop host.

Context sharing starts off. If enabled, the preview shows exactly what the next request will include: up to 64 selected map cells, original-file identity/hash and current readings with freshness labels. The full ECU binary and MES text are never sent. Sending shares the displayed conversation and optional selected context with OpenAI. Responses are advisory text; the assistant has no tools to edit maps, change files or command the vehicle. Chat stays in browser memory and is not saved with the tuning project. The official Responses endpoint is called with `store:false`.

Version 0.4.1 fixes successful ChatGPT plan responses that omit the Content-Type header: the bounded response stream must still contain a valid completion event and text. Recognized assistant errors now retain their useful message and status through the local API, while unknown exceptions and upstream prose remain private. Pending reconnection no longer hides its sign-in link, stale status requests cannot overwrite newer state, and failed prompts remain available to retry.

Account flow, cryptographic validation and response handling have automated mock tests. A separate local connection test completed without sending tune files or sensor data. Private account verification artifacts are not included in this repository; that observation does not establish future account or model availability.

## Engineering handoff

- `core.mjs`: `CalibrationProject`, `TYPES`, `LIMITS`, `sha256`, `createDemoProject`. Relevant methods include `readMap(id)`, `readOriginalMap(id)`, `readBytes(address, length, { original })`, `editCells(id, cells)`, `editBytes(address, values)`, `restoreBytes(address, length)`, `restoreCells(id, indices)`, `diff(limit)`, `undo()`, `redo()`, `serialize()` and `CalibrationProject.fromJSON(input)`. Byte getters return copies. Project reopening verifies the original hash; raw-byte changes are explicitly marked, while older map-only projects retain their validation rules.
- `desktop/main.mjs`: isolated desktop window, native menus/download dialogs, per-user encrypted account storage, private-service lifetime and shutdown.
- `electron-builder.cjs`: explicit package contents and Windows x64 portable/installer targets. Proprietary reference programs, ECU originals, research payloads and credentials are excluded.
- `mes-log.mjs`: browser-compatible `parseMesLog(text)` and `MES_LOG_LIMITS`. Samples are `{ time: null, value: number|string }`. The result explicitly labels saved historical evidence.




Run `npm test` for the automated checks. The automated suite covers editor integrity, unrestricted file-byte editing, bounded formats/log parsing, simulated serial/TCP sessions, HTTP/SSE boundaries, desktop navigation and mocked account/inference flows. BLE checks simulate GATT discovery, notifications, timeouts, cancellation, readouts, recording and the native device picker; they do not establish hardware compatibility. Desktop release checks use `--smoke-test=<absolute report.json>` with synthetic data and an isolated temporary profile. They exercise native save completion/cancellation and do not open a vehicle port or authorize an account. Physical manufacturer-profile operation remains unverified; generic USB readings and a plain ChatGPT response have separate evidence described above.

The historical engine target is IAW 8GMK / `MM8GMKHW670` / `V862MH97`. The observed Dimsport sample is 4,194,655 bytes, starts with `GEN_FILE`, and contains a candidate 4 MiB image at offset 351. Its exact acquisition device/read mode and ECU checksum correctness remain unverified. Firmware samples, private logs and reverse-engineering artifacts are not included in this repository.

Diagnostic access does not establish flash access. The 105-parameter Fiat engine read profile is implemented; flash transport, security access and other Fiat diagnostic operations remain unimplemented.

Product references: [EVC WinOLS](https://www.evc.de/en/product/ols/software/), [MultiECUScan functions](https://www.multiecuscan.net/Default.aspx) and [MultiECUScan vehicle support](https://www.multiecuscan.net/VehicleSupportCheck.aspx). They establish reference-product scope, not implementation coverage in Tune Workshop.

## Settings (0.5.0)

Open **Settings** in the top bar or **Edit → Settings** (Ctrl+,). Save applies the preferences; Cancel discards the form. Reset defaults is also a draft until Save.

- Chat: Enter sends by default, Shift+Enter makes a new line, and Ctrl+Enter sends with either setting. Composition and held-key events never submit. Choose 14, 16 or 18 px chat text, automatic scrolling and whether to remember the selected model.
- Startup/editor: choose the starting workspace and default Table, 2D, 3D or Hex view for launch and newly opened projects.
- Sensors: show/hide the live readings bar and choose 30, 60 or 120 seconds of chart history. Recordings retain their samples independently of the chart window.
- Connection: remember adapter fields between launches. COM selections require a fresh port listing; BLE device selection and connecting remain manual. Disabling remembering clears stored details.

The Windows app keeps these preferences in its user-data settings.json through a restricted native bridge, so random local server ports do not reset preferences. Browser preview uses origin-local storage. The preference file contains no account credentials, chat history or vehicle readings. Chat context sharing remains an explicit per-session choice.

## Connection feedback (0.5.1)

An adapter connected only to USB can answer its own identity commands, while no vehicle ECU is available. Failed initial discovery (UNABLE TO CONNECT or NO DATA) now tells you to connect the adapter to the car and switch the ignition on. A0/0 protocol replies mean no vehicle protocol is selected; they are no longer labelled an unsupported vehicle protocol. Unsupported or malformed protocol replies still stop the session.

## Dimsport ECU image inspection (0.6.0)

The observed Dimsport sample has a 351-byte wrapper followed by a directly readable 4 MiB candidate image. Recognition is deliberately restricted to the observed GEN_FILE variant and exact size. It is not a universal Dimsport decryptor. EVC documents Dimsport Master import/export as removing/restoring a prepended header: https://www.evc.de/en/product/ols/importer_dimsport_master_files.asp . Independent comparison with the different-software DCF in the local research workspace corroborates the boundary; that DCF is not used as a replacement tune.

Open the original file and use its ECU image inspection controls to view the image, search raw numeric sequences and open candidates in the table/curve editor. Candidates have raw values and index axes, with no inferred fuel, ignition or boost labels. The file/image coordinate selector translates offsets by the preserved 351-byte wrapper; neither coordinate is a proven ECU runtime address. Maps, changes and saved projects keep canonical full-file offsets. The entire container remains editable, and save/reopen preserves both the complete original and the working copy.

**Export raw ECU image** saves the inferred 4 MiB image without its wrapper. Export controls distinguish the complete container draft from the candidate ECU image draft. Neither corrects ECU checksums or establishes a flashable file. The inspection report includes hashes, boundary evidence and allowed software/hardware identifiers without copying arbitrary header text. The scanner is an exploratory aid and may find unrelated numeric data or miss structures; it does not reconstruct 2D map layouts or engineering units.

Private study projects and extracted firmware candidates stay local and are excluded from this repository and release binaries. Synthetic fixtures exercise payload preservation, roundtrips and reversible edits without distributing vehicle firmware.


**Ask AI about this table** opens a reviewable question in the existing ChatGPT assistant. For a table of up to 64 cells it selects the whole table; larger tables retain the current selection. Encoding, scaling, file offset and optional image offset are included only through the existing context-sharing control. The action preserves an existing draft and the user's sharing choice, and never sends automatically. Identifiers observed in the imported image are labelled as file evidence, not a fresh ECU identification. AI interpretations remain hypotheses unless supported by independent definitions; this does not enable automatic boost/timing controls or vehicle writes.

## Fiat manufacturer parameters (0.7.0)

In **Live sensors**, select **Fiat 500X · IAW 8GMK · 105 parameters**. Open **Choose parameters** to search the complete 105-row Parameters catalogue recovered from the installed MultiECUScan 4.7R3 IAW8GMK6 profile. Select 1–32 readings, or use a preset such as Air and boost, then connect through your chosen adapter. More selected requests reduce the refresh rate per reading. Disconnect before changing the profile or selection. Status parameters are shown as text rather than invented numeric chart values. Only the selected readings are polled, recorded and included in an explicitly enabled assistant context.

The manufacturer transport uses 29-bit CAN at 500 kbit/s, transmit 18DA10F1 and receive 18DAF110, a diagnostic session and allowlisted ReadDataByIdentifier requests. It first reads ECU ISO, hardware and software identification. Polling requires ISO 00 01 50 A8 15 and hardware MM8GMKHW670; a different or missing identity stops the session. These live identification fields are distinct from saved historical logs. An unsupported parameter is labelled unavailable while other selected readings continue.

All 105 labels, units, data offsets and decoder rules were recovered statically and independently compared against the installed database. The first 26 catalogue entries also match the program’s Simulation screen in order. Signed numbers, scaling, bit-mask status rules, multi-frame responses, source attribution, session handling and typed recording/context have automated synthetic tests. This does **not** establish that every parameter is available on the user’s ECU or that this new session works with the physical adapter. Use the standard profile if the manufacturer connection fails, and retain **Copy connection details** for diagnosis.

The installer includes the new functional profile and independently implemented decoders. It excludes the installed MES executable/database, the WinOLS demo, research decompilations, original tune files and account data. Private research evidence is excluded from this repository. The recovered 21 actuator and 13 adjustment definition rows are research inventory only; their operations, other vehicle modules, DTC routines and PROXI are not enabled. Native WinOLS project/map-pack decoding and native plug-ins remain unsupported.

## Map workbench and priority references (0.8.0)

The map catalogue groups **Boost**, **Ignition timing**, **Fuel / AFR**, then Unsorted. Each definition can record its role (target, limiter, correction or unknown), basis (candidate, user defined or reference), evidence and notes. These labels describe your definition; none automatically verifies it against an ECU.

Use **Map setup** to refine a selected definition or **+** to create one. Enter its file/image offset, dimensions, storage type, byte order, conversion, units and explicit breakpoints. The preview decodes working values before Save. **Read original breakpoints** copies values from an explicitly identified axis in the original image; those copied breakpoints are definition metadata, and editing them does not change ECU axis bytes. Refining a definition preserves the original and working bytes and existing byte-edit history. Definition metadata changes are not part of byte Undo/Redo.

Both graphs support mouse point selection and keyboard arrows. Enter or **Edit selected cell** opens the table cell editor. The 2D curve follows the selected row; monotonic 3D axes use their actual breakpoint spacing. Selection adjustments preview the stored, rounded before/after values and number of bytes that would change. Apply remains explicit. **Export definitions** includes the source SHA-256, canonical full-file offsets and metadata so matching projects can import it without changing tune bytes.

**Browse MiTo references** shows ten prioritized metadata leads recovered from the supplied ALFA/MiTo IAW 8GMF WinOLS project: six pressure/wastegate/compressor leads, base spark advance and three lambda leads. Research establishes candidate record structure and two UI-correlated spark addresses; the records do not establish corresponding locations in the Fiat IAW 8GMK image. Dimension orientation, encoding and conversion meanings still need corroboration. No numeric table or breakpoint arrays were recovered from the reference, so no reference surface is invented. Starting a matching definition copies only its name, category and research note; target address, shape, encoding and scaling must be supplied independently.

These changes provide an editing and identification workflow, not automatic identification of the car's boost/timing/fuel maps. There are still no verified Fiat boost/timing definitions, ECU checksum correction or flashing functions. The narrow observed-layout Dimsport payload extraction remains available. Full native WinOLS project/map-pack import and plug-in compatibility remain unsupported. The new reference catalogue is a small derived set of metadata; the source OLS and broad research catalogue are excluded from releases.
