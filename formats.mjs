/** Conservative file classification. Recognition never establishes tuning compatibility. */
export function formatEngineeringNumber(value) {
  return Number.isInteger(value)||!Number.isFinite(value)?String(value):String(Number(value.toPrecision(15)));
}

export function parseHexBytes(value) {
  if(typeof value!=='string'||value.length>196608)throw new Error('Enter at most 65,536 hexadecimal bytes.');
  const compact=value.replace(/\s/g,'');
  if(!compact.length||compact.length%2||!/^[0-9a-f]+$/i.test(compact)||compact.length>131072)throw new Error('Use complete hexadecimal bytes, for example: DE AD BE EF.');
  return Uint8Array.from(compact.match(/../g),pair=>parseInt(pair,16));
}

function inspectGenFilePayload(bytes) {
  // This is the single observed GEN_FILE layout, not a general Dimsport parser.
  // Its 327-byte header-length field plus 24 bytes places a 4 MiB candidate at
  // offset 351. Other variants, extra trailers and truncated images are left
  // unclassified rather than having 351 bytes stripped unconditionally.
  if (bytes.length < 24) return null;
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (header.getUint32(8, true) !== 0x03010020 || header.getUint32(12, true) !== 327) return null;
  const fileOffset = 24 + header.getUint32(12, true);
  const byteLength = bytes.length - fileOffset;
  if (byteLength !== 4 * 1024 * 1024) return null;
  return {
    fileOffset, byteLength, headerByteLength: fileOffset,
    layout: 'gen-file-03010020-327', confidence: 'candidate', checksumStatus: 'unverified',
    reason: 'This observed GEN_FILE layout contains a 4 MiB candidate after its 351-byte header. Extraction does not validate firmware, map addresses or checksums.',
  };
}

export function inspectBinaryFormat(input) {
  const bytes=input instanceof Uint8Array?input:new Uint8Array(input);
  const prefix=String.fromCharCode(...bytes.subarray(0,24));
  let format='raw-or-unknown',name='Raw or unrecognised binary',readOnly=false,reason='Map addresses and scaling must be supplied and verified for this exact file.';
  if(prefix.startsWith('GEN_FILE')) { format='gen-file-container';name='GEN_FILE container';readOnly=true;reason='Container layout and checksums are not validated. Inspection is available; map editing and draft export are disabled until a verified payload importer is implemented.'; }
  else if(prefix.includes('WinOLS File')){format='winols-project';name='WinOLS project container';readOnly=true;reason='WinOLS project parsing is not implemented. Import a supported raw binary and matching map definitions.';}
  else if(bytes[0]===0x50&&bytes[1]===0x4b&&[3,5,7].includes(bytes[2])&&[4,6,8].includes(bytes[3])){format='zip-container';name='ZIP container';readOnly=true;reason='Archive members must be identified and extracted before calibration editing.';}
  else if(bytes[0]===0x4d&&bytes[1]===0x5a){format='executable';name='Windows executable';readOnly=true;reason='This is an executable container, not an identified raw ECU image.';}
  const identifiers={};
  // Only constrained ECU family/software markers are exposed; arbitrary printable
  // strings, VINs and device serial numbers are not retained or surfaced.
  const text=new TextDecoder('latin1').decode(bytes);
  for(const [key,pattern]of [['software',/V862[A-Z0-9]{4}(?![A-Z0-9])/g],['hardware',/MM8GMKHW[0-9]{3}(?![A-Z0-9])/g],['homologation',/8GMKF[0-9]{3}(?![A-Z0-9])/g]]){
    const matches=[];for(const m of text.matchAll(pattern)){matches.push({value:m[0],fileOffset:m.index});if(matches.length===16)break;}if(matches.length)identifiers[key]=matches;
  }
  const requiresValidation = readOnly;
  if(requiresValidation)reason='Container structure and checksums are unverified. Full byte editing is enabled; map addresses are file offsets, and exports preserve the container as an unverified draft.';
  const candidatePayload = format === 'gen-file-container' ? inspectGenFilePayload(bytes) : null;
  return {format,name,readOnly:false,requiresValidation,reason,byteLength:bytes.length,identifiers,...(candidatePayload ? {candidatePayload} : {})};
}
