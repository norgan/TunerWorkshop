# AlfaOBD investigation: Fiat 500X

Reviewed on 13 October 2026 against the official AlfaOBD PC 2.5.7.0 portable artifact. This is an offline investigation of the next diagnostic gaps after the Tuner Workshop 0.11.0 baseline. It does not enable additional vehicle commands or establish physical vehicle acceptance.

## What is now established

The diagnostic catalogue is readable with the shipped database reader. Its schema contains 35 tables covering ECU selection, parameter labels and units, diagnostic procedures, configuration, fault descriptions and identity. The application was not launched to obtain these results. The original archive, database, extracted program, reconstructed source and database-opening material remain in ignored local research storage.

The model-selection code maps Fiat model index **65** to **500X (Type 334)**. Joining that selection to the diagnostic catalogue establishes these investigation targets:

| Controller | AlfaOBD family | Catalogue Device ID |
| --- | --- | --- |
| 1.4 MultiAir engine | MARELLI8GMK_CAN | 9272 |
| Body / PROXI | BCDELPHI | 8585 |
| ABS / parking brake | ABS_TRW_CAN | 9269 |
| Instrument panel | MARELLI_DASH_EP | 8865 |
| DDCT transmission alternative | MARELLI_DDCT | 8960 |

These are selection/catalogue bindings. The fitted controller and supported procedures must still be established from the vehicle's current identity. A procedure belonging to another AlfaOBD family cannot be enabled merely because its label sounds appropriate.

## Engine sensors

The IAW 8GMK catalogue contains **108 numeric parameter entries**. This is not directly comparable to Tuner Workshop's existing 105 mixed numeric/status definitions. Match requests, byte positions, lengths, equations and ECU variants before treating a different label as a new sensor. The useful expansion area includes MultiAir valve-control feedback as well as the boost, ignition and mixture readings needed for tuning assessment.

The request-level comparison finds **59 entries sharing a DID with existing definitions** and **49 entries using 37 DIDs absent from the current engine catalogue**. The latter are expansion candidates, not 49 newly implemented or vehicle-verified sensors. Multiple readings can share one DID, particularly the four-cylinder MultiAir feedback values.

Useful candidate groups include boost-actuator duty, additional lambda current/voltage/temperature readings, modelled catalyst temperature, throttle-track voltages, desired MultiAir valve-opening/closing angles, valve-solenoid temperatures and per-cylinder switching-time feedback. Overlapping requests still need equation and byte-layout reconciliation.

Focused decoder tracing establishes byte-layout/equation candidates for **47 of the 49 new entries, across 35 DIDs**. Two catalogue entries still lack a matching decoder branch: control-module voltage ADC (`1205`) and clutch-pedal potentiometer ADC (`1999`). Keep those unresolved.

Of the 59 overlapping entries, 54 meet the comparison criteria after unit conversion and a 0.1% coefficient-rounding tolerance. This is a bounded static comparison, not proof of identical output for every input. Five require deliberate reconciliation: coolant-temperature field width (`1003`), an oil-temperature signed boundary (`1302`), lambda ADC scaling (`1A26`), exhaust-temperature scaling (`18BA`) and MultiAir angle piecewise/signed interpretation (`1988`). The existing definitions were not silently replaced.

## PROXI

The body8585 branch is a coordinated operation across participating modules and networks:

- Read the original configuration and the separate network-status record. The reviewed CUSW branch uses configuration identifier `2023` and status identifier `40A2`.
- Decode five 16-byte status masks. The stored configuration contains two 16-byte masks at data offsets25 and41. All positions are relative to DID data after the three-byte positive-response header.
- Select participating nodes from their status bits, then order them by network and route. Network changes can require a physical adapter change when the interface cannot switch internally.
- For the reviewed family, compute reflected CRC16 with polynomial `0x8408`, initial value0, over configuration bytes from offset25. Store it as five zero-padded ASCII decimal digits at offsets6–10 before constructing the configuration write.
- Connect and write per node, record its reply, and restore the original body/adapter selection during cleanup.

The next implementation should begin with a **read-only PROXI assessment**: preserve the original configuration, show the node-state differences, explain required adapters and export a source-attributed report. Alignment writes require a separate implementation and acceptance pass.

Two details in the reference make independent validation particularly important:

1. One consistency check compares sums of bitmap bytes. Different node bits can produce the same sum. Tuner Workshop should compare the actual bytes and display the differing nodes.
2. The send path advances the node counter before the response and resets a failure counter for each node. A final successful response is insufficient to prove all earlier nodes succeeded. Tuner Workshop needs a retained result for every node, explicit unknown outcomes and a final configuration/status readback.

Pending replies, timeouts, interrupted sessions, strict reply-to-request matching, partial completion and recovery remain implementation work. This investigation does not establish atomic rollback or that an unconfirmed write can be repeated safely.

## Actuator result implemented in source

The instrument-panel **self-test** is now enabled in source for the two already supported DASHX1 identities. AlfaOBD's catalogue, selector routing, start path and stop path agree on this narrow workflow: activate the self-test for ten seconds, then explicitly return control to the controller. The existing runner performs fresh identity, stopped-engine and stationary checks before activation and attempts return of control when cancelled.

New checks cover both accepted identities, rejection of a different cluster identity, exact timing and request sequence, cancellation and an unconfirmed release. A missing release acknowledgement ends with an unknown stop outcome and requires disconnection; it cannot report completion or silently repeat the command. Physical component operation remains unverified.

This increases source coverage from 82 to **83 non-engine actuator workflows**. It does not change the installed 0.11.0 binary. The source follow-up passed **47 focused automated tests** covering module profiles, diagnostics, sessions and service operations. No packaged rebuild was performed as part of this investigation.

The ABS and DDCT procedures remain separately scoped. The exact 500X ABS family is TRW; nearby brake-bleed methods for other families are not evidence for this controller. Reference differences in some gearbox actuator values also require reconciliation before enabling them.

## Evidence and reconstruction limits

The inspected executable is bound to SHA-256 `098fb9224abbe6d723b923296a5ace045aff52a69567bf59610c3ab374209be6`, MVID `ad090e54-259b-4cd6-af83-863cbcd9ee48`. REA artifact Evidence is `ev_dbe6a3519ec9da76dd83a88fe2d88c6deebfb56f4ada252e491013c04fbd85ff`; member Evidence is `ev_fadc91d51e5b295b2c08f4a7c5e631eb53b2373c1068d4bf22803ed423abd730`. The member parser reports partial coverage; the complete retained record was saved locally when it exceeded the tool-response budget.

Existing ILSpy tooling reconstructed selected methods without executing the application. Static string reconstruction and the shipped symbol map provided readable private evidence. Relevant build-local methods include alignment preparation `060009E6`, node dispatch `0600058A`, reply handling `060009E7`, prerequisite parsing `060009E4` and the CRC16 class. Overloaded symbol names must be resolved using signatures and tokens, not name alone.

Language text uses array position after sorting the TNAMES table by ID; an arbitrary database ID is not necessarily the application text index. This translation must be checked before assigning labels to masks, results or procedure steps.

The loader binding has been verified for the selected PROXI text. Its report distinguishes configured, present, new, removed and inactive nodes, EOL membership, nodes requiring programming and EOL success/failure. The finish instruction asks the operator to inspect failed nodes and complete the ignition-off/power-latch stage; a finish dialog is not an all-nodes-success assertion.

No real ECU, adapter or physical actuator was exercised. Installed-release capability counts remain those recorded in [diagnostic coverage](diagnostics-coverage.md). The next useful implementation is the additional engine readings with verified byte layouts and equations, followed by the read-only PROXI assessment. Keep calibration-file decoding and ECU flashing separate from this diagnostic investigation.
