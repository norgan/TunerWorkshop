# Fiat 500X diagnostic coverage

This document tracks progress towards MultiECUScan-style diagnostics for the **Fiat 500X (334), 1.4 MultiAir, Marelli IAW 8GMK**. It describes Tune Workshop **0.10.0**, reviewed on **13 October 2026**. Source implementation, packaged-release checks and physical vehicle acceptance are separate milestones.

The **105 engine parameters** belong to one engine profile. They are not all-car diagnostic coverage, and the app does not yet replace MultiECUScan.

## Current source coverage

| Capability | Implemented in the app | Evidence and remaining checks |
| --- | --- | --- |
| Standard OBD sensors | Six measurements, supported-PID discovery, charts and recording | USB readings have been observed on a vehicle. That does not verify every adapter or manufacturer function. |
| IAW 8GMK engine parameters | 105 definitions, numeric/status decoding, search, presets and 1–32 selected readings | The entire catalogue was checked against static reference definitions; the first 26 names were also compared with Simulation. Physical manufacturer-session acceptance remains pending. |
| Engine identification | Reads identity before manufacturer polling and rejects an unexpected profile | This is part of the engine connection, not a vehicle-wide module scan. |
| Connection options | USB, Bluetooth Classic COM, BLE and private-network Wi-Fi TCP | Automated transport checks exist. BLE service discovery and a listed COM port do not establish device compatibility. |
| Saved diagnostic sessions | Imports supported English MES logs and displays recorded faults and parameter samples | Historical information remains separate from current vehicle status. |
| Engine fault workflow | Reads IAW 8GMK fault codes/statuses and supported detail records; explicit fault clearing | Uses the bound engine session. Unknown snapshot layouts remain incomplete instead of being guessed. Physical acceptance is pending. |
| Standard OBD diagnostics | Stored, pending and permanent faults, readiness, vehicle identification and supported freeze-frame readings | CAN transport only; these are distinct from manufacturer diagnostics. Generic fault clearing is not enabled. |
| Engine actuator tests | 21 defined test workflows, including cooling fans, relays, valves, heaters, injectors and ignition coils | Fixed requests and timing, fresh stopped-engine/stationary checks, and explicit return of ECU control. Acknowledgement does not establish the physical component response. |
| Engine adjustments | Nine workflows, including oil-change adaptation resets and throttle learning | Four catalogue entries remain unavailable: alternator replacement, clutch learning, neutral/first-gear learning and performance-limit deactivation. Physical acceptance is pending. |
| Dashboard service reminder | Separate service profile with 11 readings and an explicit reminder reset | Strict cluster identity, fresh motion checks, one reset request and counter readback. Lost/mismatched responses remain an unknown outcome; the write is not automatically repeated. Physical acceptance is pending. |
| Other modules and PROXI | Not implemented | The service profile does not establish general instrument-panel, body, gearbox, ABS or airbag coverage. |

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

The local module linkage distinguishes the A5 body-network transport from the direct/A6 transport. Software must select the correct network and adapter lead; it cannot establish support by changing the engine's address. The [official A5 diagram](https://www.multiecuscan.net/images/OBDAdapter5.png) and [official A6 diagram](https://www.multiecuscan.net/images/OBDAdapter6.png) describe the physical adapters.

Some late-2017 and 2018+ 500X vehicles have a security gateway which can block clearing faults and running procedures. Gateway presence on a particular vehicle must be determined, not inferred from successful sensor readings. Tune Workshop has no gateway-unlock implementation. [MES gateway guidance](https://www.multiecuscan.net/SupportedVehiclesList.aspx).

## Next acceptance and coverage priorities

1. **Verify the engine and service workflows on the vehicle.** Establish live identity and read-only readings first, then compare faults and snapshots. Keep generic OBD faults distinguishable from manufacturer faults. Record each explicit service operation's acknowledgement and resulting state separately.
2. **Add module discovery and read access.** Start with the body computer and instrument panel, then address the applicable gearbox, ABS and airbag. Show which adapter is needed before connecting and explain unsupported modules without attempting guessed commands.
3. **Complete remaining service operations individually.** Each needs explicit inputs, preconditions, progress, a definite result and interrupted-operation handling. The four unavailable engine adjustments require further protocol and workflow evidence.
4. **Accept actuator operations individually.** Verify start, stop, timeout and loss-of-connection behavior as well as the normal response. Static operation names and synthetic tests alone do not establish a physical result.
5. **Implement PROXI as its own workflow.** Read configuration and participating modules, preserve the original configuration, validate changes, and handle partial completion. A generic write button is not PROXI support.

Module coverage is separate from application conveniences such as multi-signal graphs, reusable parameter selections, recording markers, automatic session reports and additional languages. Track these independently against the [MES feature list](https://www.multiecuscan.net/Default.aspx).

## Checks that establish support

- **Protocol:** correct target/session, expected identity, complete multi-frame replies, pending responses, refusals, truncated data, wrong-module replies, disconnects and bounded retries. Never turn an unavailable response into zero or a previous value.
- **Engine parameters:** compare representative pressure, temperature, signed ignition, injection and categorical readings with the reference tool on the same vehicle; record which of the 105 channels are actually supported. Separate unsupported channels from decoding failures.
- **Faults:** distinguish no faults from failed reads; preserve status and module attribution; verify long lists, unknown descriptions and detail records. Fault clearing requires a separate deliberate action and a fresh read afterwards.
- **Operations:** retain the pre-operation report, verify required vehicle conditions, exercise completion/error/cancellation paths, and verify resulting state. A positive transport response alone may not mean the procedure completed.
- **Vehicle acceptance:** record app version, module identity, adapter/lead, operation, expected result and observed result. Automated fixtures and Simulation remain separate from physical acceptance.

## Evidence boundary

Public source pointers: the `fiat-8gmk`, `fiat-diagnostics`, `obd-diagnostics`, `instrument-service`, `service-tools`, `sensor-session`, `can-diagnostics` and `diagnostic-catalog` modules, the diagnostics/live UI and their tests. The diagnostic catalogue validates metadata and session attribution; it does not enable commands.

Private static research was used to check module linkage and the engine catalogue. The installed reference was MES 4.7R3; the official coverage inventory was MES 5.4. Older static definitions cannot establish every newer module or function. Original program/database files, decompilations, customer logs, vehicle files and account information are excluded from the public repository. ECU calibration reading, checksum correction and flashing remain a separate compatibility effort.
