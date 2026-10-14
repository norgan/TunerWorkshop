# Fiat 500X calibration identification

Tuner Workshop 0.12.0 adds automatic, local recognition of the supplied IAW 8GMK / MM8GMKHW670 / V862MH97 original. It opens eight code-linked definitions directly under Boost, Timing and Fuel. The generated definitions support table, 2D and 3D views, original comparison, offline edits, undo, saved projects and optional assistant context. Principal control paths and unit encodings are traced. Candidate status retains the remaining qualifications around exact OEM names, mode conditions and some axes; calibration checksums and ECU flashing are unresolved.

## Exact source binding

The supplied GEN_FILE is 4,194,655 bytes with SHA-256 `64b58c559ef193679ecc3d067444b0c0a49675b2f91d4fec040119761f49e584`. The observed 351-byte wrapper leaves a readable 4 MiB image, SHA-256 `a965a7dc59021ddbdb53475db4daaeb1fbad7cccb244b0e668de59993a176adf`. Matching uses the preserved original bytes and their hashes. A filename, vehicle label or similar hardware ID does not authorize applying these addresses to a different image. A changed wrapper is not treated as the inspected original container.

Opening this exact original, its exact raw image, or a saved workspace retaining that original attaches definitions without changing firmware bytes. Changed calibration values can also retain recognition when the hardware identity, complete code region and all established axis fingerprints match. A code or axis change rejects that layout. Modified containers must retain the inspected wrapper fingerprint. Matching does not depend on the tuner or filename. Existing user definitions are preserved. Image and container offsets remain distinct; this is not a general Dimsport repackaging contract.

## Code-linked candidates

All offsets below are into the 4 MiB image; add 351 for offsets in the supplied container. Tables are big-endian with columns contiguous. Names, operating modes and engineering scales have separate evidence from their geometry.

| Proposed role | Image offset | Rows × columns | Cell encoding | Proposed scale |
| --- | --- | --- | --- | --- |
| Requested boost correction | `0x38F3D0` | 16 × 16 | unsigned 16-bit | divisor factor ×1/16384 |
| Requested boost ratio ceiling | `0x38F630` | 24 × 10 | unsigned 16-bit | pressure ratio ×1/16384 |
| Boost pressure monitor reference | `0x38ED9C` | 16 × 14 | unsigned 16-bit | millibar ×1 |
| Ignition angle A | `0x392E7A` | 20 × 16 | signed 16-bit | degrees ×1/256 |
| Ignition angle B | `0x39297A` | 20 × 16 | signed 16-bit | degrees ×1/256 |
| Lambda target A | `0x3B7054` | 20 × 14 | unsigned 16-bit | lambda ×1/1024 |
| Lambda target B | `0x3B7BF2` | 20 × 14 | unsigned 16-bit | lambda ×1/1024 |
| Lambda blending target | `0x3B7284` | 20 × 14 | unsigned 16-bit | lambda ×1/1024 |

The pressure table at `0x38ED9C` forms a clipped error stored at `[r13+0xB60]`. Its two direct consumers, `0x13EF24` and `0x13FB16`, use that error in threshold/monitoring paths. It remains separately labelled as a monitor reference.

The actual requested-pressure correction is at `0x38F3D0`. Its pressure-request column axis starts at `0x38E1A0` and its RPM row axis at `0x38092C`, both 16 points. Lookup `0x90B84` feeds the division `(request << 14) / tableResult`, then mode/filtering logic, `[r13+0xBA8]`, the final pressure state, `[r13+0xB50]` and desired-pressure diagnostic DID `1959`. Lower factors raise the calculated absolute-pressure request at fixed input before the other limits. All original factors are one.

The **Absolute-pressure request %** operation applies `newFactor = oldFactor / (1 + percent/100)`, previews the stored Q14 result, and rejects a singular change of -100% or less. It is a percentage of the pre-limit absolute request, not a gauge-boost percentage or a guarantee of achieved pressure. Other torque, air, thermal, feedback and pressure limits continue to affect the ECU result.

The ratio ceiling at `0x38F630` is multiplied by the controller pressure base with a right shift of 14. Its result forms the cap applied to desired pressure through controller state offsets `0xE` and `0x10`. Its 10-point X axis at `0x38F848` and 24-point Y axis at `0x38F5EC` remain native coordinates because their physical normalization is unresolved. The editor preserves that distinction instead of labelling them RPM/load.

Boost and fuel share the 14-point column axis at `0x38135A`. The ignition candidates use a separate 16-point column axis at `0x381786`. The 20-point RPM axis begins at `0x380904`; boost uses the 16-point RPM axis at `0x38092C`. Proposed load scaling is 1/16384. Exact axis values are read from the immutable original and preserved in the workspace. Rounded table headings are display-only; hover text and stored values retain precision.

Static PowerPC VLE analysis establishes the one-past-end axis pointer convention and the bilinear table-address formula. Unsigned interpolation is at `0x13C580`; signed interpolation is at `0x13C51C`. Boost calls the unsigned routine at `0x91266`, main fuel at `0x7DA7A` and cold fuel at `0x7DC3C`. The ignition candidates call the signed routine at `0xA2F22` and `0xA357A`.

The ignition table result is shifted right by four before angle corrections and a Q4-like limited domain. The output chain reaches spark DID `1812`, whose diagnostic scale is 1/16 degree, corroborating a stored calibration scale of 1/256 degree. The MiTo reference's 1/16 table scale would be incorrect here. Calibration byte `0x3957BC` is zero in the supplied original, selecting the A-derived baseline; a nonzero value selects the B-derived angle on the inspected branch. The current selector is included in generated notes. Exact OEM naming and every dynamic operating condition remain qualified.

The fuel tables pass Q10 correction/blending stages into `[r13+0x6B0]`. The actual Mode 01 PID 44 dispatcher exports its reciprocal as `floor(1024 * 65535 / (2 * target))`. A separate fuel calculation divides air/load-related input by this target and by the stoichiometric A/F scalar. These independent paths establish internal lambda = raw/1024. Target A is selected when runtime state `[r13-0x2C1B]` equals 3, B otherwise; the state's OEM mode name is unresolved. The blending table can lower the target below another state threshold, whose physical identity is not independently named.

Lambda/AFR display conversion uses the original calibration scalar at `0x380A70`: `14909/1024 = 14.5595703125`. The UI states this basis rather than assuming 14.7. AFR input is converted back to stored lambda before encoding; switching views changes no bytes. The scalar interpretation is corroborated by the fuel division and MiTo definition context, while its exact OEM symbol is unrecovered.

The ECU initializes its small-data base to `0x400082D8`. The table speed input at `[r13-0x3A18]` is RAM address `0x400048C0`, also selected by diagnostic DID `1000`. The diagnostic conversion multiplies this internal value by four before serialization; the existing sensor decoder divides the reply by four. This independently corroborates the RPM axis factor of one. Load interpretation, boost pressure reference, final control roles and all mode conditions remain separately qualified.

## Comparison evidence and limits

The supplied V862QH94 DCF reference shares the target's code before `0x38009C`, all three previously traced boost/fuel axes, the entire boost table and the entire cold-lambda table. The main-lambda values differ. It has another software identity and a 32 KiB suffix; it is not substituted for this car's original.

The MiTo IAW 8GMF reference supplies useful semantic comparison, but its addresses, axes and scales are not copied blindly. In particular, the target ignition scale differs. An exact match of a constant table or a smooth numerical surface alone does not prove its function.

Private input files, captured reference bytes, detailed disassembly and research scripts remain in ignored local storage. Public source contains reconstructed layout metadata and source digests, not firmware bytes. Source evidence is in `research/ols-image-recovery/fiat-axis-trace-*` and `research/500x-mapping-2026-10-14/`. No firmware or calibration file was uploaded during the investigation, and no live ECU operation was performed.

## Validation

Automated checks cover exact and code-layout matching, code/axis/wrapper mismatch rejection, synthetic provenance, big-endian layout, axis order, preservation of existing definitions and saved edits, workspace reopening, invalid axes and inverse boost-adjustment direction/quantization. Local checks against the supplied original verify all eight ranges and axes, confine an offline edit to the selected cell, undo it, and confirm the original file hash is unchanged. Desktop checks exercise original-file recognition, goal navigation, table/2D/3D access, requested-boost inverse editing, AFR view/edit conversion and signed ignition geometry. These checks establish editor behavior and static interpretation, not vehicle or flash acceptance.
