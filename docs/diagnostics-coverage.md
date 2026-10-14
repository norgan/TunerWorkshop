# Fiat 500X diagnostic coverage

This document tracks progress towards MultiECUScan-style diagnostics for the **Fiat 500X (334), 1.4 MultiAir, Marelli IAW 8GMK**. It describes Tuner Workshop **0.12.0**, reviewed on **14 October 2026**. Source implementation, packaged-release checks and physical vehicle acceptance are separate milestones.

Version 0.11.0 adds **23 usable controller/variant profiles**, **581 readable parameter definitions** and **82 actuator workflows** beyond the existing engine and service-reminder profiles. The selector includes all 26 reference controller/variant entries plus Standard OBD. These include alternative engines and optional equipment, not 26 modules confirmed fitted to one car. The app does not yet replace every MultiECUScan function.

**0.11.1 follow-up:** the [AlfaOBD investigation](alfaobd-investigation.md) adds 47 independently decoded engine readings and establishes the instrument self-test's explicit return-of-control sequence for both supported cluster identities. The engine profile now has **152** readings. Non-engine executable actuator workflows total **83**, with **23** mechanical procedures still unavailable. The new sensor definitions retain the original 105 readings and eight-channel default. Two unresolved additional sensor decoders and five conflicting overlaps remain excluded from the expansion. Physical vehicle acceptance remains pending.

## Current source coverage

| Capability | Implemented in the app | Evidence and remaining checks |
| --- | --- | --- |
| Standard OBD sensors | Six measurements, supported-PID discovery, charts and recording | USB readings have been observed on a vehicle. That does not verify every adapter or manufacturer function. |
| IAW 8GMK engine parameters | 152 definitions, numeric/status decoding, search, presets and Enable all or individual readings | The entire catalogue was checked against static reference definitions; the first 26 names were also compared with Simulation. Physical manufacturer-session acceptance remains pending. |
| Engine identification | Reads identity before manufacturer polling and rejects an unexpected profile | This is part of the engine connection, not a vehicle-wide module scan. |
| Connection options | USB, Bluetooth Classic COM, BLE and private-network Wi-Fi TCP | Automated transport checks exist. BLE service discovery and a listed COM port do not establish device compatibility. |
| Saved diagnostic sessions | Imports supported English MES logs and displays recorded faults and parameter samples | Historical information remains separate from current vehicle status. |
| Engine fault workflow | Reads IAW 8GMK fault codes/statuses and supported detail records; explicit fault clearing | Uses the bound engine session. Unknown snapshot layouts remain incomplete instead of being guessed. Physical acceptance is pending. |
| Standard OBD diagnostics | Stored, pending and permanent faults, readiness, vehicle identification and supported freeze-frame readings | CAN transport only; these are distinct from manufacturer diagnostics. Generic fault clearing is not enabled. |
| Engine actuator tests | 21 defined test workflows, including cooling fans, relays, valves, heaters, injectors and ignition coils | Fixed requests and timing, fresh stopped-engine/stationary checks, and explicit return of ECU control. Acknowledgement does not establish the physical component response. |
| Engine adjustments | Nine workflows, including oil-change adaptation resets and throttle learning | Four catalogue entries remain unavailable: alternator replacement, clutch learning, neutral/first-gear learning and performance-limit deactivation. Physical acceptance is pending. |
| Dashboard service reminder | Separate service profile with 11 readings and an explicit reminder reset | Strict cluster identity, fresh motion checks, one reset request and counter readback. Lost/mismatched responses remain an unknown outcome; the write is not automatically repeated. Physical acceptance is pending. |
| Other module sensors | 23 additional profiles with 581 readable definitions | Covers body, instrument, gearbox, ABS, airbag, steering, parking, climate and other optional controllers. Each uses its own identity, address, network and decoder. Physical acceptance is pending. |
| Other module faults and identity | Module-specific fault reading/clearing, identification and supported snapshots | Definitions include 2,580 fault descriptions across the reference module families. Fixed-offset snapshots are explicitly partial; unknown codes retain their module attribution. Clear requires fresh identity and conditions. |
| Other module actuator tests | 83 executable workflows; all 106 recovered non-engine actuator entries shown | Body 28, instrument 21, climate 19 across two variants, comfort 3, ABS indicators 5, radar 3, blind-spot lamps 2 and RF-hub alternatives 2. Controller acknowledgements do not establish component operation. |
| Remaining actuator procedures | 23 entries unavailable with individual reasons | 13 hydraulic brake tests, three parking-brake motor operations, seven DDCT mechanical operations need complete setup/completion/return-control evidence. |
| PROXI and unresolved readings | PROXI unavailable; two radar angles unavailable | 80 PROXI node descriptors are not ordinary sensors. Two four-byte radar angle formats have a signedness conflict in the reference. |

Pressure display can use bar or psi. Changing display units preserves the original measurement and calibration units. An absolute pressure reading stays absolute.

The **dashboard service reminder** and **engine oil-change adaptation reset** are separate operations on different controllers. The service profile resets the reminder after completed maintenance; it does not change the configured interval, coupon count or odometer. Instrument helper/session tests cover addressing, identity rejection, measurement byte lengths, one reset with readback, stationary conditions, pending replies, session mismatch and resumed polling using simulated adapter replies. They do not run on the vehicle.

## Vehicle modules to cover

The reference inventory contains **26 module/variant entries** for the 1.4 selection: 13 direct connections, five using A6 and eight using A5. Alternatives include different transmissions, climate systems and keyless configurations; these are not 26 modules confirmed fitted to one car. The coverage classes are identification, faults, fault details, parameters, actuator tests and adjustments. Each module needs its own implementation and acceptance evidence. [MES supported vehicles](https://www.multiecuscan.net/SupportedVehiclesList.aspx).

| Module or variant group | Connection | Functions listed in the reference inventory |
| --- | --- | --- |
| IAW 8GMK engine | Direct | Identification, faults/details, parameters, actuators, adjustments |
| Alternative LPG engine | Direct | Same classes; a different engine profile |
| DDCT gearbox / ZF automatic gearbox | Direct | Identification, faults/details, parameters, adjustments; actuators listed for DDCT |
| Electronic gear selector | Direct | Identification, faults/details, parameters |
| AWD controller | Direct | Identification, faults/details, parameters, adjustments |
| Instrument panel | Direct | Identification, faults/details, parameters, actuators, adjustments |
| Service interval | Direct | Identification, faults, parameters, adjustments |
| Body computer | Direct | Identification, faults/details, parameters, actuators, adjustments |
| PROXI / CAN configuration | Direct | Identification and adjustment workflow |
| RF hub, with or without keyless | Direct | Identification, faults/details, parameters, actuators, adjustments |
| Driver-assistance radar | Direct | Identification, faults/details, parameters, actuators |
| ABS / ESP / parking brake | A6 grey | Identification, faults/details, parameters, actuators, adjustments |
| Airbag | A6 grey | Identification, faults/details, parameters |
| Electric steering / parking control | A6 grey | Identification, faults/details, parameters, adjustments |
| Lane camera | A6 grey | Identification, faults/details, parameters |
| Audio amplifier | A5 blue | Identification, faults, parameters |
| Radio / navigation, two variants | A5 blue | Identification, faults, parameters, adjustments |
| Seat and wheel comfort | A5 blue | Identification, faults/details, parameters, actuators |
| Climate control, manual or automatic | A5 blue | Identification, faults/details, parameters, actuators, adjustments |
| Left / right blind-spot sensors | A5 blue | Identification, faults/details, parameters, actuators |

The local module linkage distinguishes the A5 body-network transport from the direct/A6 transport. The app configures BHCAN29 at 125 kbit/s and CCAN29 at 500 kbit/s, with the recovered session fallback rules. Protocol B uses temporary `ATPB0104` parameters rather than changing stored adapter defaults. The [ELM327 datasheet, pages 24 and 76](https://www.elmelectronics.com/wp-content/uploads/2020/05/ELM327DSL.pdf) defines this runtime configuration. The [official A5 diagram](https://www.multiecuscan.net/images/OBDAdapter5.png) and [official A6 diagram](https://www.multiecuscan.net/images/OBDAdapter6.png) describe the physical adapters; software cannot reroute a physical lead.

Use **Diagnostics → What do you want to work on?** to browse a controller's sensor count and actuator catalogue, then **Set up connection** to select its readings and adapter. Browsing another controller never changes an active connection. Disconnect before changing controller or adapter lead. On **Live sensors**, search its complete list and enable all available readings or choose individual readings. Requests remain sequential; enabling more readings lengthens each polling cycle.

Additional actuator workflows use the recovered fixed requests, pulse durations and return-control commands. They include fresh controller identity checks, raw-zero motion checks where the controller supplies those readings, and explicit user confirmations where it does not. Every result records whether its conditions were measured or user-confirmed. Stop attempts each potentially active output's established release, including both outputs of paired lamps. An unconfirmed release is reported and ends the connection. Writes are never automatically replayed.

Some late-2017 and 2018+ 500X vehicles have a security gateway which can block clearing faults and running procedures. Gateway presence on a particular vehicle must be determined, not inferred from successful sensor readings. Tuner Workshop has no gateway-unlock implementation. [MES gateway guidance](https://www.multiecuscan.net/SupportedVehiclesList.aspx).

## Next acceptance and coverage priorities

1. **Verify the engine and service workflows on the vehicle.** Establish live identity and read-only readings first, then compare faults and snapshots. Keep generic OBD faults distinguishable from manufacturer faults. Record each explicit service operation's acknowledgement and resulting state separately.
2. **Accept each added controller on the vehicle.** Compare its identity, selected readings, fault report and snapshot against the reference. Automatic fitted-module discovery remains separate from selecting one of the implemented profiles.
3. **Complete remaining service operations individually.** Each needs explicit inputs, preconditions, progress, a definite result and interrupted-operation handling. The four unavailable engine adjustments require further protocol and workflow evidence.
4. **Accept actuator operations individually.** Verify start, stop, timeout and loss-of-connection behavior as well as the normal response. Static operation names and synthetic tests alone do not establish a physical result.
5. **Implement PROXI as its own workflow.** Read configuration and participating modules, preserve the original configuration, validate changes, and handle partial completion. A generic write button is not PROXI support.

Module coverage is separate from application conveniences such as multi-signal graphs, reusable parameter selections, recording markers, automatic session reports and additional languages. Track these independently against the [MES feature list](https://www.multiecuscan.net/Default.aspx).

## Checks that establish support

- **Protocol:** correct target/session, expected identity, complete multi-frame replies, pending responses, refusals, truncated data, wrong-module replies, disconnects and bounded retries. Never turn an unavailable response into zero or a previous value.
- **Engine parameters:** compare representative pressure, temperature, signed ignition, injection and categorical readings with the reference tool on the same vehicle; record which of the 152 channels are actually supported. Separate unsupported channels from decoding failures.
- **Faults:** distinguish no faults from failed reads; preserve status and module attribution; verify long lists, unknown descriptions and detail records. Fault clearing requires a separate deliberate action and a fresh read afterwards.
- **Operations:** retain the pre-operation report, verify required vehicle conditions, exercise completion/error/cancellation paths, and verify resulting state. A positive transport response alone may not mean the procedure completed.
- **Vehicle acceptance:** record app version, module identity, adapter/lead, operation, expected result and observed result. Automated fixtures and Simulation remain separate from physical acceptance.

## Additional reference: AlfaOBD

AlfaOBD is a second diagnostic reference for the remaining work. Its [supported-vehicle list](https://www.alfaobd.com/supported_cars.html) includes the Fiat 500X from 2015. Its [published features](https://www.alfaobd.com/) include active diagnostics, service resets, ABS bleeding, transmission calibration, body configuration and PROXI alignment. These are product-wide feature statements; the exact 500X ECU variant and procedure still need verification.

The [Windows help](https://www.alfaobd.com/AlfaOBD_Help.pdf), Active Diag section, describes detecting the connected ECU modification and adding procedures specific to that modification after identification. The reference comparison should therefore check variant-specific applicability alongside each procedure's requests, inputs, preconditions, duration, completion and stop handling. A family-level label alone does not establish support for every member of that family.

| Comparison priority | Evidence to recover before implementation |
| --- | --- |
| PROXI and body configuration | Original configuration, participating nodes, variant/layout matching, per-node completion and interrupted alignment handling |
| Remaining ABS and parking-brake procedures | Mechanical setup, measured conditions, exact activation/release sequence and recovery after interruption |
| Gearbox and remaining engine learning | Applicable ECU variants, required temperatures/states, inputs, completion criteria and aftercare |
| Sensors and actuator completeness | Exact 500X variant catalogue, scaling, status meanings and distinctions between unavailable readings and failed requests |
| Adapter support | Physical bus routing and interface-specific switching; the official guidance distinguishes the grey lead for the second high-speed CAN bus and interfaces that can switch the other buses internally |

On 13 October 2026, the local `AlfaOBDsetup.exe` reports version 2.3.1. The [official download page](https://www.alfaobd.com/download.html) lists PC version 2.5.7.0. Keep observations from the older installer, the current portable archive and the published documentation attributed to their respective versions. Adding AlfaOBD as a reference does not change Tuner Workshop's implemented or vehicle-accepted coverage counts.

## Evidence boundary

Public source pointers: the `fiat-8gmk`, `fiat-modules`, `module-transport`, `module-diagnostics`, `module-service`, `module-session-actions`, `fiat-diagnostics`, `obd-diagnostics`, `instrument-service`, `service-tools`, `sensor-session`, `can-diagnostics` and `diagnostic-catalog` modules, the diagnostics/live UI and their tests. The diagnostic catalogue validates metadata and session attribution; it does not itself enable commands.

Private static research was used to check all 26 module bindings, sensor formats, identification/fault layouts and actuator sequences. The installed reference was MES 4.7R3; the official coverage inventory was MES 5.4. Older static definitions cannot establish every newer module or function. Original program/database files, decompilations, customer logs, vehicle files and account information are excluded from the public repository. ECU calibration reading, checksum correction and flashing remain a separate compatibility effort.
