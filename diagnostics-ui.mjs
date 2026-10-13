import {SERVICE_TOOLS} from './service-tools.mjs';
import {DIAGNOSTIC_PROFILES,getDiagnosticProfile} from './fiat-8gmk.mjs';
import {getModuleServiceTools} from './module-service.mjs';
import {getModuleDiagnostics} from './module-diagnostics.mjs';
import {download} from './app.mjs';
const $=s=>document.querySelector(s);
const node=(tag,text,className)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;};
const localTime=value=>new Date(value).toLocaleString();
export function createDiagnosticsWorkspace({run,stop,getSnapshot,onSetup}){
  let busy=false,lastReport=null,lastIdentity=null,lastService=null,selectedTool=null,confirmAction=null,sessionId=null,profileId=null;
  const message=(text,error=false)=>{const n=$('#diagnostic-message');n.textContent=text;n.classList.toggle('diagnostic-error',error);};
  const target=$('#diagnostic-target');target.replaceChildren();
  for(const p of DIAGNOSTIC_PROFILES){const option=node('option',p.label);option.value=p.id;target.append(option);}target.value='fiat-8gmk';
  const coverage=node('p',undefined,'hint');coverage.id='diagnostic-coverage';$('.diagnostic-toolbar').after(coverage);
  const profile=()=>target.value;
  const attribution=report=>`${getDiagnosticProfile(report.profileId).label} · ECU ${report.ecu} · ${localTime(report.capturedAt)}`;
  const isModule=()=>!['generic-obd','fiat-8gmk','fiat-service'].includes(profile());
  const capabilities=()=>isModule()?getModuleDiagnostics(profile())?.capabilities||{}:{identification:true,readFaults:profile()!=='fiat-service',clearFaults:profile()==='fiat-8gmk',snapshot:profile()!=='fiat-service'};
  function tools(){return profile()==='fiat-service'?[{id:'service-interval-reset',name:'Reset dashboard service reminder',category:'adjustment',available:true,description:'Reset the instrument panel service reminder after completing the scheduled service.',conditions:['Confirm that the scheduled service is complete.','Ignition on, engine stopped; vehicle stationary.','One service coupon is used. Existing interval settings are retained.'],evidence:'Recovered service procedure; physical validation on this vehicle is pending.'}]:profile()==='fiat-8gmk'?SERVICE_TOOLS:profile()==='generic-obd'?[]:getModuleServiceTools(profile());}
  function procedureText(tool){
    if(!tool)return '';
    return [tool.description,...(tool.conditions||[]),tool.aftercare].filter(Boolean).join('\n');
  }
  function selectTool(){
    selectedTool=tools().find(tool=>tool.id===$('#service-tool').value);
    $('#service-title').textContent=selectedTool?.name||selectedTool?.label||'Choose a procedure';
    $('#service-description').textContent=procedureText(selectedTool);
    $('#service-availability').textContent=selectedTool?(selectedTool.available===false?(selectedTool.unavailableReason||'The complete procedure has not been verified yet.'):selectedTool.evidence||'Review the procedure before starting.'):'Select the connected vehicle profile to see its tools.';
    updateControls();
  }
  function renderTools(){
    const select=$('#service-tool'),previous=select.value,search=$('#service-search').value.trim().toLowerCase();select.replaceChildren();
    const p=getDiagnosticProfile(profile()),catalog=tools(),available=catalog.filter(t=>t.available!==false);
    coverage.textContent=p.available===false?p.unavailableReason:`${p.channels.length} sensor and status definitions · ${available.filter(t=>(t.category||t.kind)==='actuator').length} actuator tests · ${available.filter(t=>(t.category||t.kind)==='adjustment').length} service actions${catalog.length>available.length?` · ${catalog.length-available.length} procedures awaiting implementation`:''}. ${p.connection?.adapterLabel||'Direct OBD connection'}. Select only equipment fitted to your vehicle.`;
    for(const [category,label]of [['adjustment','Service & adjustments'],['actuator','Actuator tests']]){
      const group=node('optgroup');group.label=label;
      for(const tool of tools().filter(t=>(t.category||t.kind)===category&&`${t.name||t.label} ${t.description||''}`.toLowerCase().includes(search))){
        const option=node('option',(tool.name||tool.label)+(tool.available===false?' · Not yet available':''));option.value=tool.id;group.append(option);
      }
      if(group.children.length)select.append(group);
    }
    if([...select.options].some(o=>o.value===previous))select.value=previous;
    else if([...select.options].some(o=>o.value==='oil-change'))select.value='oil-change';
    selectTool();
  }
  function updateControls(){
    const s=getSnapshot(),connected=s.status==='streaming'&&s.profileId===profile(),active=busy||!!s.diagnosticOperation,caps=capabilities();
    $('#diagnostic-read-faults').disabled=!connected||active||!caps.readFaults;
    $('#diagnostic-identify').disabled=!connected||active||!caps.identification;
    $('#diagnostic-clear-faults').disabled=!connected||active||!caps.clearFaults||!lastReport||lastReport.sessionId!==s.sessionId;
    $('#diagnostic-export').disabled=!lastReport&&!lastIdentity&&!lastService;
    $('#service-run').disabled=!connected||active||!selectedTool||selectedTool.available===false;
    $('#service-stop').hidden=!s.diagnosticOperation||s.diagnosticOperation.action!=='run-service';
    $('#service-tool').disabled=active;$('#service-search').disabled=active;
    $('#diagnostic-setup').disabled=active;$('#diagnostic-target').disabled=active;
    $('#diagnostic-connection').textContent=connected?`${getDiagnosticProfile(profile()).label} connected · ECU ${s.ecu}`:s.status==='streaming'?'Another controller is connected. Disconnect it on Live sensors before connecting this controller.':'Connect to this controller to read faults or use its tools.';
    const progress=s.diagnosticOperation;
    $('#service-progress').textContent=progress?progress.message||'Working…':'';
    for(const button of $('#diagnostic-faults').querySelectorAll('button'))button.disabled=!connected||active||!caps.snapshot||lastReport?.sessionId!==s.sessionId;
  }
  function update(){
    const s=getSnapshot();
    if(sessionId!==s.sessionId||profileId!==s.profileId){
      const changedSession=sessionId!==s.sessionId,hadReport=!!(lastReport||lastIdentity||lastService);sessionId=s.sessionId;profileId=s.profileId;
      if(changedSession&&hadReport&&!busy)message('Previous results are retained below with their controller and time. Read again for the current connection.');
      if(s.status==='streaming')$('#diagnostic-target').value=profileId;
      renderTools();
    }
    updateControls();
  }
  function renderFields(container,fields){
    container.replaceChildren();const list=node('dl',undefined,'diagnostic-fields');
    for(const field of fields){list.append(node('dt',field.label),node('dd',field.status==='unavailable'?field.message||'Unavailable':`${field.value??'—'}${field.unit?' '+field.unit:''}`));}container.append(list);
  }
  function renderFaults(report){
    const container=$('#diagnostic-faults');container.replaceChildren();
    $('#diagnostic-report-time').textContent=attribution(report);
    for(const group of report.groups||[]){
      const section=node('section',undefined,'fault-group');section.append(node('h3',group.name));
      if(group.status!=='positive')section.append(node('p',group.message||'This ECU did not provide this result.','hint'));
      else if(!group.faults.length)section.append(node('p','No faults reported in this group.'));
      for(const fault of group.faults||[]){
        const row=node('article',undefined,'fault-row');row.append(node('strong',fault.code),node('span',fault.description||fault.label||'Description not available'));
        const states=[fault.active?'Present':null,fault.stored?'Stored':null,fault.pending?'Pending':null,fault.warningIndicatorRequested?'Warning lamp requested':null].filter(Boolean);
        if(states.length)row.append(node('small',states.join(' · ')));
        const button=node('button','View freeze frame');button.type='button';button.addEventListener('click',()=>perform({action:'read-freeze-frame',...(fault.id?{dtcId:fault.id}:{})}));row.append(button);section.append(row);
      }
      container.append(section);
    }
    if(report.readiness){
      container.append(node('h3',`Check engine lamp: ${report.readiness.mil?'On':'Off'}`));
      const list=node('ul');for(const monitor of report.readiness.monitors.filter(m=>m.supported))list.append(node('li',`${monitor.name}: ${monitor.complete?'Complete':'Not complete'}`));container.append(list);
    }
    if(report.readinessUnavailable)container.append(node('p','Readiness: '+report.readinessUnavailable,'hint'));
  }
  async function perform(options){
    if(busy)return;busy=true;message('Working…');updateControls();
    try{
      const s=getSnapshot(),result=await run({...options,sessionId:options.sessionId||s.sessionId});
      if(result.kind==='faults'){lastReport=result;renderFaults(result);message('Fault-code reading complete.');}
      else if(result.kind==='identity'){lastIdentity=result;renderFields($('#diagnostic-identity'),result.fields);$('#diagnostic-identity').prepend(node('p',attribution(result),'hint'));message('ECU information read. VIN stays local unless you export this report.');}
      else if(result.kind==='snapshot'){
        $('#diagnostic-snapshot').hidden=false;$('#diagnostic-snapshot-title').textContent=result.code?`Freeze frame · ${result.code}`:'Freeze frame';
        renderFields($('#diagnostic-snapshot-fields'),(result.fields||[]).filter(f=>!f.hidden));
        $('#diagnostic-snapshot-note').textContent=attribution(result)+' · '+(result.message||result.layoutNote||(result.complete===false?'Some fields could not be decoded. Exported results retain the available data.':'Recorded when the ECU stored this fault; these are not current sensor readings.'));
        if(lastReport)lastReport.snapshots=[...(lastReport.snapshots||[]),result].slice(-32);message('Freeze-frame reading complete.');
      }else if(result.kind==='cleared'){message('The ECU acknowledged fault clearing. Read faults again to check the result.');}
      else if(result.kind==='service'){
        lastService=result;message(result.message||'Procedure finished. Follow the instructions below before reconnecting.',result.success===false);
        $('#service-result').textContent=[attribution(result),result.instructions,result.message].filter(Boolean).join('\n');
        if(result.result?.before&&result.result?.after){
          const values=Object.entries(result.result.before).map(([key,before])=>({label:key.replace(/^service-/,'').replaceAll('-',' '),value:`${before} → ${result.result.after[key]}`}));
          const readings=node('div');renderFields(readings,values);$('#service-result').append(readings);
        }
      }
    }catch(error){message(error.message,true);}
    finally{busy=false;update();}
  }
  function confirm(options){
    if(busy)return;confirmAction={...options,sessionId:getSnapshot().sessionId,targetProfile:profile()};
    const clear=options.action==='clear-faults';
    $('#diagnostic-confirm-title').textContent=clear?'Clear this controller’s faults?':selectedTool?.name||selectedTool?.label||'Start this procedure?';
    $('#diagnostic-confirm-text').textContent=clear?'This erases stored fault information and freeze frames in the selected controller. Export your report first if you need it. Clearing faults does not repair their cause. Keep the engine stopped and the vehicle stationary.':procedureText(selectedTool);
    $('#diagnostic-conditions').hidden=!isModule();$('#diagnostic-engine-stopped').checked=false;$('#diagnostic-stationary').checked=false;$('#diagnostic-confirm-yes').disabled=isModule();
    $('#diagnostic-confirm-yes').textContent=clear?'Clear faults':selectedTool.id==='service-interval-reset'?'Service complete · reset reminder':selectedTool.id==='oil-change'?'Oil changed · run reset':'Start procedure';$('#diagnostic-confirm').showModal();
  }
  $('#diagnostic-setup').addEventListener('click',()=>{try{onSetup($('#diagnostic-target').value);}catch(error){message(error.message,true);}});
  target.addEventListener('change',()=>{$('#service-search').value='';renderTools();});
  $('#diagnostic-read-faults').addEventListener('click',()=>perform({action:'read-faults'}));
  $('#diagnostic-identify').addEventListener('click',()=>perform({action:'read-identification'}));
  $('#diagnostic-clear-faults').addEventListener('click',()=>confirm({action:'clear-faults',confirmation:'clear-faults'}));
  $('#service-run').addEventListener('click',()=>confirm({action:'run-service',toolId:selectedTool.id,confirmation:'run-service',acknowledged:true}));
  $('#diagnostic-confirm-no').addEventListener('click',()=>$('#diagnostic-confirm').close());
  $('#diagnostic-confirm-yes').addEventListener('click',()=>{
    $('#diagnostic-confirm').close();const action=confirmAction;confirmAction=null;
    if(action?.sessionId!==getSnapshot().sessionId||action?.targetProfile!==getSnapshot().profileId){message('The connection changed. Review the procedure again.',true);return;}
    if(action){delete action.targetProfile;if(!$('#diagnostic-conditions').hidden){action.engineStoppedConfirmed=$('#diagnostic-engine-stopped').checked;action.stationaryConfirmed=$('#diagnostic-stationary').checked;if(!action.engineStoppedConfirmed||!action.stationaryConfirmed)return;}void perform(action);}
  });
  for(const id of ['diagnostic-engine-stopped','diagnostic-stationary'])$('#'+id).addEventListener('change',()=>{$('#diagnostic-confirm-yes').disabled=!$('#diagnostic-engine-stopped').checked||!$('#diagnostic-stationary').checked;});
  $('#service-stop').addEventListener('click',async()=>{try{await stop({sessionId:getSnapshot().sessionId});message('Stop requested. Active tests will return control where possible. Completed resets cannot be undone.');}catch(error){message(error.message,true);}});
  $('#service-search').addEventListener('input',renderTools);$('#service-tool').addEventListener('change',selectTool);
  $('#diagnostic-export').addEventListener('click',()=>{
    const report={format:'tuneworkshop-diagnostic-report',version:1,exportedAt:new Date().toISOString(),identity:lastIdentity,faults:lastReport,service:lastService};
    void download(`diagnostics-${new Date().toISOString().replace(/[:.]/g,'-')}.json`,JSON.stringify(report,null,2)).catch(error=>message(error.message,true));
  });
  renderTools();update();return {update};
}
