// Display conversion only. Map encoding, recordings and pressure reference stay
// in their declared source units. One psi is exactly this many pascals.
const PASCALS = Object.freeze({pa:1,hpa:100,mbar:100,kpa:1000,mpa:1e6,bar:1e5,psi:6894.757293168});

export function pressureDisplay(sourceUnit, preference='bar') {
  if (!['bar','psi'].includes(preference)) throw new RangeError('Choose bar or psi.');
  const match=String(sourceUnit??'').match(/^\s*(mbar|hpa|kpa|mpa|pa|bar|psi)(\s+(?:absolute|abs|gauge|relative)|\s*\((?:absolute|abs|gauge|relative)\))?\s*$/i);
  if (!match) return {converted:false,factor:1,unit:sourceUnit??''};
  return {converted:true,factor:PASCALS[match[1].toLowerCase()]/PASCALS[preference],unit:preference+(match[2]||'')};
}

export const pressureToDisplay=(value,sourceUnit,preference)=>value*pressureDisplay(sourceUnit,preference).factor;
export const pressureFromDisplay=(value,sourceUnit,preference)=>value/pressureDisplay(sourceUnit,preference).factor;
export function pressureEditAmount(amount, operation, sourceUnit, preference) {
  // Percent changes are dimensionless; set and add are expressed in the UI unit.
  if (String(amount??'').trim()==='' || !Number.isFinite(Number(amount))) throw new Error('Adjustment must be a number.');
  return operation==='percent'?Number(amount):pressureFromDisplay(Number(amount),sourceUnit,preference);
}
