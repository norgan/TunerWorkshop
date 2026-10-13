import {DiagnosticError} from './diagnostic-actions.mjs';
import {getModuleDiagnostics,decodeModuleFaults,decodeModuleIdentification,buildModuleSnapshotRequest,decodeModuleSnapshot,decodeModuleClear} from './module-diagnostics.mjs';
import {getModuleServiceTools,moduleServiceRequests,runModuleServiceTool,runModulePreflight,modulePreflightRequests} from './module-service.mjs';

export function validateModuleAction(profileId, options) {
  const metadata=getModuleDiagnostics(profileId);
  const capability=({'read-faults':'readFaults','read-identification':'identification','read-freeze-frame':'snapshot','clear-faults':'clearFaults'})[options.action];
  if(!metadata||capability&&!metadata.capabilities[capability])throw new DiagnosticError('This diagnostic action is not available for the selected controller.','unsupported');
  if(options.action==='run-service'){
    const tool=getModuleServiceTools(profileId).find(t=>t.id===options.toolId);
    if(!tool)throw new DiagnosticError('This procedure does not belong to the connected controller.','invalid_request');
    if(!tool.available)throw new DiagnosticError(tool.unavailableReason,'unsupported');
  }
  return metadata;
}

/** Commands remain fixed definitions; callers cannot supply raw vehicle bytes. */
export async function runModuleAction({options,state,command,allow,wait,signal,onProgress}) {
  const profileId=state.profileId,metadata=validateModuleAction(profileId,options);
  const common={profileId,ecu:state.ecu,sessionId:state.sessionId,capturedAt:new Date().toISOString()};
  const terminal=result=>{if(result.status!=='positive')throw new DiagnosticError(result.message||'The controller did not complete this request.','ecu_response');return result;};
  const read=async request=>{allow(request);return command(request);};
  if(options.action==='read-identification'){
    const fields=[];
    for(const definition of metadata.identification){
      try{const result=decodeModuleIdentification(profileId,definition.key,await read(definition.request));fields.push(result.status==='positive'?result:{label:definition.label,status:'unavailable',message:result.message});}
      catch(error){if(error.code!=='unavailable')throw error;fields.push({label:definition.label,status:'unavailable',message:error.message});}
    }
    return {...common,kind:'identity',fields};
  }
  if(options.action==='read-faults'){
    const result=terminal(decodeModuleFaults(profileId,await read(metadata.requests.readDtc)));
    return {...common,kind:'faults',groups:[{name:'Controller faults',status:'positive',faults:result.dtcs}],availabilityMask:result.availabilityMask};
  }
  if(options.action==='read-freeze-frame'){
    const id=options.dtcId?.toUpperCase(),request=buildModuleSnapshotRequest(profileId,id);
    return {...common,kind:'snapshot',...terminal(decodeModuleSnapshot(profileId,id,await read(request)))};
  }
  const context={...common,status:'connected',acknowledged:true,engineStoppedConfirmed:options.engineStoppedConfirmed===true,stationaryConfirmed:options.stationaryConfirmed===true};
  if(options.action==='clear-faults'){
    modulePreflightRequests(profileId).forEach(allow);
    onProgress({message:'Checking controller identity and vehicle conditions…'});
    const preflight=await runModulePreflight(profileId,{command,context,signal});
    try{terminal(decodeModuleClear(profileId,await read(metadata.requests.clearDtc)));}
    catch(error){throw new DiagnosticError('Fault clearing was not confirmed. It may already have taken effect; read faults again before retrying. '+error.message,'outcome_unknown');}
    return {...common,kind:'cleared',acknowledged:true,preflight};
  }
  moduleServiceRequests(options.toolId).forEach(allow);
  const result=await runModuleServiceTool(options.toolId,{command,wait,signal,onProgress,context});
  return {...common,kind:'service',result,success:result.status==='completed',message:result.message,instructions:result.aftercare,requiresDisconnect:result.requiresDisconnect};
}
