import { CalibrationProject, sha256 } from './core.mjs';

// Independently reconstructed layout facts. No ECU bytes are bundled here.
// Roles/physical units remain hypotheses; see docs/500x-map-identification.md.
export const FIAT_CALIBRATION_PROFILES = Object.freeze([Object.freeze({
  id: '500x-8gmk-v862mh97', label: 'Fiat 500X · IAW 8GMK · V862MH97',
  hardware: 'MM8GMKHW670', software: 'V862MH97', imageBytes: 4194304,
  imageSha256: 'a965a7dc59021ddbdb53475db4daaeb1fbad7cccb244b0e668de59993a176adf',
  containerSha256: '64b58c559ef193679ecc3d067444b0c0a49675b2f91d4fec040119761f49e584',
  codeBytes: 0x380000, codeSha256: 'a89091f1a4bce78875b6240d831a218ed60fc28cd2959dcf6d51994136e5637f',
  wrapperSha256: '756241a56529e6b1c514255731982b5e404bf1a5c62b6ac3368221a986182bd2',
  hardwareOffset: 0x3ffe42, softwareOffset: 0x3ffe1e,
  axisSignatures: Object.freeze([
    Object.freeze({address:0x38135a,count:14,sha256:'e60dd69e339773f77697380b5b6044d16d618acb09e3b46b46b171fdf092c0f7'}),
    Object.freeze({address:0x380904,count:20,sha256:'48bba3e42a2cd093926cdf8af3c8da299c96cfaca528a26a0d58e265f00e0c39'}),
    Object.freeze({address:0x38092c,count:16,sha256:'a57de3d9df6148dbd1d85724fbe0410475628ecf0d89cda3da235cede026fd81'}),
    Object.freeze({address:0x381786,count:16,sha256:'a321fef55f169305d90bd30092b79687a6c0d5db84c6eb3b7906b0cb95142fdf'}),
    Object.freeze({address:0x38e1a0,count:16,sha256:'fbdb251d6bffb2e7b14bd35b96808edc4e2b024974c3b514fdd7609d5da5ecb4'}),
    Object.freeze({address:0x38f848,count:10,sha256:'bd497d4722bbdd2f4f7b211ab54bd88fd07bba79289495083ea521c36946c247'}),
    Object.freeze({address:0x38f5ec,count:24,sha256:'51f3afd2de8c37d75d39c6484cebf9a6b61f1b069442ddb17ecf814b121aeffb'}),
  ]),
  maps: Object.freeze([
    Object.freeze({id:'500x-boost-request',name:'Requested boost correction',category:'boost',role:'correction',address:0x38f3d0,rows:16,cols:16,type:'uint16',endian:'big',factor:1/16384,unit:'factor',xAddress:0x38e1a0,xFactor:1,yAddress:0x38092c,yFactor:1,xLabel:'Pressure request (mbar absolute)',yLabel:'Filtered engine speed (rpm)',call:'0x90B84',interpolator:'0x13C580',scalingNote:'Direct command path to desired-pressure DID 1959. The pressure request is divided by this Q14 factor before mode filters and caps. Lowering the factor raises the pre-limit absolute-pressure request; increasing it lowers the request. Zero is invalid for this division. This is not a gauge-boost percentage or a guarantee of achieved pressure.'}),
    Object.freeze({id:'500x-boost-ceiling',name:'Requested boost ratio ceiling',category:'boost',role:'limiter',address:0x38f630,rows:24,cols:10,type:'uint16',endian:'big',factor:1/16384,unit:'ratio',xAddress:0x38f848,xFactor:1,yAddress:0x38f5ec,yFactor:1,xLabel:'Controller coordinate X (raw)',yLabel:'Controller coordinate Y (raw)',call:'0x9071C',interpolator:'0x13C580',scalingNote:'Direct requested-pressure cap path. The lookup is multiplied by the controller pressure base and shifted right 14; corrections and limits then form the cap applied to desired pressure. Output ratio scale is traced. Physical meanings of both controller-coordinate axes remain unresolved.'}),
    Object.freeze({ id: '500x-boost-pressure', name: 'Boost pressure monitor reference (candidate)', category: 'boost', address: 0x38ed9c, rows: 16, cols: 14, type: 'uint16', endian: 'big', factor: 1, unit: 'mbar', xAddress: 0x38135a, xFactor: 1 / 16384, yAddress: 0x38092c, yFactor: 1, call: '0x91266', interpolator: '0x13C580', scalingNote: 'This table forms a pressure-error reference consumed by monitoring code, not the requested-boost command. Millibar scale and absolute pressure interpretation remain proposed.' }),
    Object.freeze({ id: '500x-ignition-a', name: 'Baseline ignition candidate A', category: 'ignition', address: 0x392e7a, rows: 20, cols: 16, type: 'int16', endian: 'big', factor: 1 / 256, unit: 'deg.', xAddress: 0x381786, xFactor: 1 / 16384, yAddress: 0x380904, yFactor: 1, call: '0xA2F22', interpolator: '0x13C51C', scalingNote: 'The signed table result is shifted right by four into the Q4 ignition calculation. The output chain reaches spark diagnostic DID 1812, corroborating stored degrees at 1/256. On the original zero-valued mode flag, the A-derived baseline supplies the ignition path. Exact OEM naming and other mode conditions remain unresolved.' }),
    Object.freeze({ id: '500x-ignition-b', name: 'Alternate ignition candidate B', category: 'ignition', address: 0x39297a, rows: 20, cols: 16, type: 'int16', endian: 'big', factor: 1 / 256, unit: 'deg.', xAddress: 0x381786, xFactor: 1 / 16384, yAddress: 0x380904, yFactor: 1, call: '0xA357A', interpolator: '0x13C51C', scalingNote: 'This alternative signed table shares the traced axes and Q8-to-Q4 conversion; its output reaches spark diagnostic DID 1812. Stored degrees at 1/256 are corroborated. Calibration byte 0x3957BC is zero in the original; this branch skips the B-derived result and uses the A baseline. Other mode conditions remain unresolved.' }),
    Object.freeze({ id: '500x-fuel-main', name: 'Lambda target A', category: 'fuel', role:'target', address: 0x3b7054, rows: 20, cols: 14, type: 'uint16', endian: 'big', factor: 1 / 1024, unit: 'lambda', xAddress: 0x38135a, xFactor: 1 / 16384, yAddress: 0x380904, yFactor: 1, call: '0x7DA7A', interpolator: '0x13C580', scalingNote: 'Physical lambda and Q10 scale are linked through the fuel calculation and the reciprocal OBD PID 44 output. Selected when runtime state [r13-0x2C1B] equals 3. That mode has not been independently named; later corrections and limits affect the final target.' }),
    Object.freeze({ id: '500x-fuel-alternate', name: 'Lambda target B', category: 'fuel', role:'target', address: 0x3b7bf2, rows: 20, cols: 14, type: 'uint16', endian: 'big', factor: 1 / 1024, unit: 'lambda', xAddress: 0x38135a, xFactor: 1 / 16384, yAddress: 0x380904, yFactor: 1, call: '0x7DA90', interpolator: '0x13C580', scalingNote: 'Physical lambda and Q10 scale are linked through the fuel calculation and reciprocal OBD PID 44. Selected when runtime state [r13-0x2C1B] does not equal 3. Exact OEM mode naming and all final corrections remain qualified.' }),
    Object.freeze({ id: '500x-fuel-cold', name: 'Lambda blending target', category: 'fuel', role:'correction', address: 0x3b7284, rows: 20, cols: 14, type: 'uint16', endian: 'big', factor: 1 / 1024, unit: 'lambda', xAddress: 0x38135a, xFactor: 1 / 16384, yAddress: 0x380904, yFactor: 1, call: '0x7DC3C', interpolator: '0x13C580', scalingNote: 'Physical lambda and Q10 scale are linked to the final fuel calculation. Below a state threshold, this table can blend the earlier target toward a lower lambda. The state is not independently named as coolant temperature, so this is not advertised as a verified cold map.' }),
  ])
})]);

function axis(bytes, address, count, factor) {
  if (!Number.isSafeInteger(address) || address < 0 || address + count * 2 > bytes.length) throw new Error('Calibration axis is outside the image.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = Array.from({length: count}, (_, index) => view.getUint16(address + index * 2, false) * factor);
  if (!values.every((value, index) => Number.isFinite(value) && (!index || value > values[index - 1]))) throw new Error('The calibration axis does not match the established increasing layout.');
  return values;
}

/** Local, exact-image matching. The optional catalogue is trusted caller metadata,
 * never an object read from a tune file or workspace. No filename-based matching. */
export async function inspectFiatCalibration(project, profiles = FIAT_CALIBRATION_PROFILES) {
  if (project.synthetic) return { status: 'synthetic', maps: [], message: 'Example tables are synthetic. Open your 500X original to identify its calibration.' };
  const original = project.original, payload = project.payloadInfo;
  if (!payload && original.length !== 4194304) return { status: 'unmatched', maps: [], message: 'No exact 500X calibration profile matched this file.' };
  const base = payload?.fileOffset ?? 0, image = original.subarray(base, base + (payload?.byteLength ?? original.length));
  const imageSha256 = await sha256(image);
  let profile = profiles.find(p => p.imageBytes === image.length && p.imageSha256 === imageSha256), matchKind = 'exact-original';
  if (!profile) for (const candidate of profiles) {
    if (!candidate.codeSha256 || candidate.imageBytes !== image.length || await sha256(image.subarray(0,candidate.codeBytes)) !== candidate.codeSha256) continue;
    if (!(await Promise.all(candidate.axisSignatures.map(a=>sha256(image.subarray(a.address,a.address+a.count*2)).then(hash=>hash===a.sha256)))).every(Boolean)) continue;
    if (candidate.hardwareOffset !== undefined && new TextDecoder('ascii').decode(image.subarray(candidate.hardwareOffset,candidate.hardwareOffset+candidate.hardware.length)) !== candidate.hardware) continue;
    profile = candidate; matchKind = 'same-code-layout'; break;
  }
  if (!profile) return { status: 'unmatched', maps: [], imageSha256, message: 'This image needs its own map identification. Addresses from another software version are not applied.' };
  if (payload && profile.containerSha256 && await sha256(original) !== profile.containerSha256 && (!profile.wrapperSha256 || await sha256(original.subarray(0,base)) !== profile.wrapperSha256)) return { status: 'unmatched', maps: [], imageSha256, message: 'The image matches, but this container differs from the inspected original. Its wrapper needs checking.' };
  const software = profile.softwareOffset === undefined ? profile.software : new TextDecoder('ascii').decode(image.subarray(profile.softwareOffset,profile.softwareOffset+8));
  if (!/^[A-Z0-9]{1,24}$/.test(software)) return {status:'unmatched',maps:[],imageSha256,message:'The image identity is not a supported calibration layout.'};
  const maps = profile.maps.map(source => ({
    id: source.id, name: source.name, address: base + source.address, rows: source.rows, cols: source.cols,
    type: source.type, endian: source.endian, factor: source.factor, offset: 0, unit: source.unit,
    xAxis: axis(image, source.xAddress, source.cols, source.xFactor),
    yAxis: axis(image, source.yAddress, source.rows, source.yFactor),
    xLabel: source.xLabel || 'Relative air load (proposed)', yLabel: source.yLabel || 'Engine speed (rpm)',
    category: source.category, role: source.role || 'unknown', definitionStatus: 'candidate',
    evidence: `${matchKind==='exact-original'?'Exact original image':'Same ECU code and axis layout'} match (${software}). ECU code at ${source.call} calls ${source.interpolator}; geometry, byte order, axes and row stride are traced. Exact OEM naming and all mode conditions are not fully verified.`,
    notes: `${source.scalingNote} ${source.category==='ignition'?`Current static selector 0x3957BC is ${image[0x3957bc]}; ${image[0x3957bc]===0?'A-derived baseline':'B-derived angle'} is selected on the traced branch. `:''}${source.yLabel?.includes('raw')?'Controller axes retain native coordinates.':'RPM is linked through the ECU diagnostic conversion path; load interpretation remains qualified.'} Offline draft edits; ECU checksums and flashing are unresolved. Payload offset 0x${source.address.toString(16).toUpperCase()}.`,
  }));
  // Validate the whole generated set before the caller installs any definition.
  new CalibrationProject(original, {maps});
  const stoichiometricAfr = new DataView(image.buffer,image.byteOffset,image.byteLength).getUint16(0x380a70,false)/1024;
  return { status: 'matched', matchKind, profileId: profile.id, label: profile.label.replace(profile.software,software), software, hardware: profile.hardware, imageSha256,
    stoichiometricAfr: stoichiometricAfr > 5 && stoichiometricAfr < 25 ? stoichiometricAfr : null,
    ignitionSelector: image[0x3957bc],
    maps, geometryVerified: true, physicalMeaningVerified: false, checksumVerified: false,
    message: `${maps.length} code-linked definitions match this ${matchKind==='exact-original'?'original image':'ECU code and axis layout'}. Command paths and principal unit encodings are traced; exact OEM modes and some axis meanings remain qualified.` };
}

/** Atomic metadata-only installation; never replaces user definitions or bytes. */
export function attachFiatCalibration(project, assessment) {
  if (assessment?.status !== 'matched') return [];
  const existing = project.maps, additions = [];
  for (const map of assessment.maps) {
    const sameId = existing.find(previous => previous.id === map.id);
    if (sameId) continue;
    if (existing.some(previous => map.address < previous.address + previous.rows * previous.cols * ({uint8:1,int8:1,uint16:2,int16:2,uint32:4,int32:4,float32:4}[previous.type]) && map.address + map.rows * map.cols * 2 > previous.address)) continue;
    additions.push(map);
  }
  new CalibrationProject(project.bytes, {maps: [...existing, ...additions]});
  additions.forEach(map => project.addMap(map));
  return additions.map(map => map.id);
}
