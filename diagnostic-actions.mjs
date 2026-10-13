export class DiagnosticError extends Error {
  constructor(message,code='diagnostic_failed'){super(message);this.name='DiagnosticError';this.code=code;}
}
const keysByAction=Object.freeze({
  'read-faults':['action','sessionId'],
  'read-identification':['action','sessionId'],
  'read-freeze-frame':['action','sessionId','dtcId'],
  'clear-faults':['action','sessionId','confirmation'],
  'run-service':['action','sessionId','confirmation','toolId','acknowledged'],
});
export function validateDiagnosticAction(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||!Object.hasOwn(keysByAction,input.action))throw new DiagnosticError('Choose a supported diagnostic action.','invalid_request');
  if(Object.keys(input).some(key=>!keysByAction[input.action].includes(key)))throw new DiagnosticError('This diagnostic action includes unsupported options.','invalid_request');
  if(typeof input.sessionId!=='string'||input.sessionId.length<1||input.sessionId.length>100)throw new DiagnosticError('Connect to the vehicle before running diagnostics.','invalid_request');
  if(input.action==='clear-faults'&&input.confirmation!=='clear-faults')throw new DiagnosticError('Confirm fault clearing before continuing.','confirmation_required');
  if(input.action==='run-service'&&(input.confirmation!=='run-service'||input.acknowledged!==true||typeof input.toolId!=='string'||!/^[a-z0-9-]{1,80}$/.test(input.toolId)))throw new DiagnosticError('Review and confirm the selected service procedure.','confirmation_required');
  if(input.dtcId!==undefined&&(typeof input.dtcId!=='string'||!/^[0-9A-Fa-f]{6}$/.test(input.dtcId)))throw new DiagnosticError('Select a valid fault for its snapshot.','invalid_request');
  return {...input};
}
