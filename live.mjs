import { showWorkspace, getSelectedTuningContext, download } from './app.mjs';
import { prepareConversation } from './chat-history.mjs';
import {portsForTransport,serialPortLabel} from './ports.mjs';
import {BleSensorSession} from './ble.mjs';
import {installBluetoothDialogs} from './bluetooth-ui.mjs';
import {getSettings,saveSettings,subscribeSettings} from './settings-client.mjs';
import {isChatSubmitKey} from './chat-keyboard.mjs';
import {validateSettings} from './settings-schema.mjs';
import {DIAGNOSTIC_PROFILES} from './fiat-8gmk.mjs';
import {pressureDisplay} from './pressure-units.mjs';
import {createDiagnosticsWorkspace} from './diagnostics-ui.mjs';

const $=s=>document.querySelector(s);
let selectedProfileId='generic-obd';
const profileSelections=new Map(DIAGNOSTIC_PROFILES.map(profile=>[profile.id,new Set(profile.defaultChannels)]));
const currentProfile=()=>DIAGNOSTIC_PROFILES.find(profile=>profile.id===selectedProfileId);
const selectedKeys=()=>profileSelections.get(selectedProfileId);
let sensors=currentProfile().channels.filter(channel=>selectedKeys().has(channel.key)).map(channel=>({...channel,name:channel.label}));
let snapshot={status:'disconnected',values:{},sampleTimes:{},supportedSensors:[]},serialAvailable=false;
let recording=false,recordingUnsaved=false,exportingRecording=false,recorded=[],recordingMetadata=null,history=Object.fromEntries(sensors.map(s=>[s.key,[]]));
let accountStatus=null,chatMessages=[],chatBusy=false,assistantPoll=null,serverOnline=false,streamAbort=null;
let assistantStatusRevision=0;
let assistantStatusRequest=null;
let serialOperation=false,streamRetryTimer=null;
let bleSession=null,portList=[],portsLoaded=false,portsLoading=false;
let preferredPort=getSettings().connection.path;
const MAX_RECORDED=20000;
let diagnosticsWorkspace=null;
let bleServicePending=false;

async function api(path,body,timeout=30000){
  const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'X-Tune-Workshop':'1',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(timeout)});
  const result=await response.json();if(!response.ok)throw new Error(result.error||result.message||`Request failed (${response.status}).`);return result;
}
function error(message){$('#live-error').textContent=message;$('#live-error').hidden=!message;}
function safely(fn){return async(...args)=>{try{await fn(...args);}catch(e){error(e.message);}};}
const sensorDisplay=sensor=>pressureDisplay(sensor.key==='mapPressure'&&sensor.unit==='kPa'?'kPa absolute':sensor.unit,getSettings().pressureUnit);
function format(value,sensor){const display=sensorDisplay(sensor);return sensor.valueType==='text'&&typeof value==='string'?value:typeof value==='number'&&Number.isFinite(value)?(value*display.factor).toFixed(display.converted?(getSettings().pressureUnit==='bar'?3:2):sensor.digits??2):'—';}
function stale(key){const t=Date.parse(snapshot.sampleTimes?.[key]||''),sensor=snapshot.channels?.find(sensor=>sensor.key===key)||sensors.find(sensor=>sensor.key===key),period=Math.max(sensor?.staleAfterMs??5000,sensors.length*750);return !serverOnline||snapshot.status!=='streaming'||!Number.isFinite(t)||Date.now()-t>period||['unavailable','decode-error'].includes(snapshot.quality?.[key]);}
function selectionLocked(){return serialOperation||['connecting','streaming'].includes(snapshot.status);}
function initProfiles(){
  for(const profile of DIAGNOSTIC_PROFILES){const option=document.createElement('option');option.value=profile.id;option.textContent=profile.label;$('#diagnostic-profile').append(option);}
  $('#diagnostic-profile').value=selectedProfileId;renderParameterChoices();
}
function renderParameterChoices(){
  const profile=currentProfile(),selection=selectedKeys(),query=$('#sensor-search').value.trim().toLowerCase();
  const focusedKey=$('#sensor-selection-list').contains(document.activeElement)?document.activeElement.value:null;
  $('#sensor-selected-count').textContent=`${selection.size} of ${profile.channels.length} selected`;
  $('#profile-description').textContent=profile.id==='generic-obd'?'Standard OBD measurements. Available readings depend on what the ECU reports.':profile.id==='fiat-service'?'Dashboard service counters and reminder reset. Use the direct OBD connection; turn the ignition on with the engine stopped.':`${profile.channels.length} Fiat IAW 8GMK parameter definitions. Faults and service tools are on the Diagnostics page. Live validation on this ECU is pending.`;
  $('#sensor-selection-list').replaceChildren();
  const matches=profile.channels.filter(channel=>`${channel.label} ${channel.unit}`.toLowerCase().includes(query));
  for(const channel of matches){
    const label=document.createElement('label');label.className='parameter-choice';
    const input=document.createElement('input');input.type='checkbox';input.value=channel.key;input.checked=selection.has(channel.key);input.disabled=selectionLocked();
    const description=document.createElement('span'),name=document.createElement('strong'),detail=document.createElement('small');name.textContent=channel.label;detail.textContent=channel.valueType==='text'?'Status':channel.unit||'Numeric reading';description.append(name,detail);label.append(input,description);$('#sensor-selection-list').append(label);
  }
  if(!matches.length){const empty=document.createElement('p');empty.className='hint';empty.textContent='No parameters match this search.';$('#sensor-selection-list').append(empty);}
  if(focusedKey)[...$('#sensor-selection-list').querySelectorAll('input')].find(input=>input.value===focusedKey)?.focus({preventScroll:true});
}
function syncSelectedSensors({resetHistory=false}={}){
  sensors=currentProfile().channels.filter(channel=>selectedKeys().has(channel.key)).map(channel=>({...channel,name:channel.label}));
  history=Object.fromEntries(sensors.map(sensor=>[sensor.key,resetHistory?[]:history[sensor.key]||[]]));
  initCards();renderParameterChoices();
}
function initCards(){
  const previous=$('#live-channel').value;$('#sensor-cards').replaceChildren();$('#live-channel').replaceChildren();
  for(const sensor of sensors){
    const article=document.createElement('article');article.className='sensor-card';article.id=`sensor-${sensor.key}`;
    const name=document.createElement('span');name.className='eyebrow';name.textContent=sensor.name;
    const value=document.createElement('strong');value.className=`sensor-value${sensor.valueType==='text'?' sensor-status-value':''}`;value.textContent='—';
    const unit=document.createElement('small');unit.className='sensor-unit';unit.textContent=sensorDisplay(sensor).unit;
    const state=document.createElement('small');state.className='sensor-state';state.style.display='block';state.style.marginTop='9px';state.textContent='Waiting for connection';
    article.append(name,value,unit,state);$('#sensor-cards').append(article);
    if(sensor.valueType!=='text'){const option=document.createElement('option');option.value=sensor.key;option.textContent=sensor.name;$('#live-channel').append(option);}
  }
  if(sensors.some(sensor=>sensor.key===previous&&sensor.valueType!=='text'))$('#live-channel').value=previous;
  $('#live-channel').disabled=!sensors.some(sensor=>sensor.valueType!=='text');
  if(!sensors.length){const empty=document.createElement('p');empty.className='hint';empty.textContent='Choose at least one parameter before connecting.';$('#sensor-cards').append(empty);}
}
function renderSensors(){
  const active=serverOnline&&snapshot.status==='streaming',connecting=snapshot.status==='connecting';
  const type=$('#adapter-transport').value,wifi=type==='wifi',ble=type==='ble',bluetooth=type==='bluetooth',busy=connecting||active||serialOperation;
  const locked=selectionLocked();$('#diagnostic-profile').disabled=locked;
  for(const input of document.querySelectorAll('#sensor-selection-list input'))input.disabled=locked;
  for(const button of document.querySelectorAll('[data-sensor-preset]'))button.disabled=locked;
  $('#sensor-selection-note').textContent=locked?'Disconnect before changing the diagnostic profile or selected parameters.':`Choose 1–32 parameters. Only selected parameters will be requested.${sensors.length>12?' More parameters reduce the refresh rate for each reading.':''}`;
  $('#usb-port-field').hidden=wifi||ble;$('#usb-baud-field').hidden=wifi||ble;$('#refresh-ports').hidden=wifi||ble;
  $('#wifi-host-field').hidden=!wifi;$('#wifi-port-field').hidden=!wifi;
  $('#ble-profile-field').hidden=!ble;$('#ble-custom').hidden=!ble||$('#ble-profile').value!=='custom';
  $('#serial-port-label').textContent=bluetooth?'Paired Bluetooth COM port':'USB ELM interface';
  $('#bluetooth-help').hidden=!bluetooth&&!ble;$('#port-summary').hidden=wifi||ble;
  $('#ble-profile').disabled=busy;for(const id of ['ble-service','ble-write','ble-notify'])$('#'+id).disabled=busy;
  $('#serial-note').textContent=ble?'Select Find BLE adapter, then choose your device. A COM port and baud rate are not needed.':bluetooth?'Pair the adapter in Windows, then refresh and choose its outgoing COM port.':wifi?'Join the adapter’s Wi-Fi network and enter the IPv4 address and TCP port from its manual.':'Refresh ports, choose your USB interface and set its baud rate to match the adapter.';
  $('#connect-sensors').textContent=ble?'Find BLE adapter':'Connect sensors';
  $('#live-status').textContent=!serverOnline?'Local server unavailable':snapshot.status==='streaming'?`Connected · ECU ${snapshot.ecu||'identified'}`:snapshot.status==='connecting'?'Connecting…':snapshot.status==='error'?'Connection stopped':'Disconnected';
  $('#live-status').classList.toggle('connected',active);
  $('#connection-status-detail').hidden=snapshot.status!=='error';
  $('#connection-status-detail').textContent=snapshot.status==='error'?(snapshot.error||'The connection stopped before readings were available. Copy the connection details below to help diagnose it.'):'';
  $('#connection-troubleshooting').hidden=snapshot.status!=='error'||!snapshot.error?.includes('ATZ');
  $('#connection-troubleshooting').textContent='The adapter did not answer its reset command, before ECU communication began. Check adapter power and the baud rate, close other OBD apps, and confirm the interface is ELM327-compatible.';
  $('#connect-sensors').disabled=!serverOnline||busy||!sensors.length||sensors.length>32||(ble?!navigator.bluetooth?.requestDevice:wifi?!$('#wifi-host').value.trim():!serialAvailable||!$('#serial-port').value||portsLoading);
  $('#disconnect-sensors').disabled=!serverOnline||snapshot.status==='disconnected';
  $('#serial-port').disabled=busy||portsLoading;$('#serial-baud').disabled=busy;
  $('#adapter-transport').disabled=busy;$('#wifi-host').disabled=busy;$('#wifi-port').disabled=busy;
  $('#refresh-ports').disabled=busy||portsLoading||!serverOnline;
  $('#record-start').disabled=!active||recording;$('#record-stop').disabled=!recording;$('#record-export').disabled=!recorded.length||exportingRecording;
  $('#record-count').textContent=`${recorded.length.toLocaleString()} samples${recording?' · Recording':''}`;
  $('#sensor-strip').hidden=selectedProfileId!=='generic-obd'||!getSettings().showSensorStrip||(!active&&!connecting);
  const transport=({wifi:'Wi-Fi',bluetooth:'Bluetooth',ble:'BLE'})[snapshot.transport]||'USB';
  $('#vehicle-connection').textContent=active?`${transport} ELM · ${selectedProfileId==='fiat-service'?'Service interval':selectedProfileId==='fiat-8gmk'?'Fiat engine':'Standard OBD'}`:connecting?`Connecting to ${transport} ELM…`:'No vehicle connected';
  let anyStale=false;
  for(const strip of document.querySelectorAll('[data-strip]'))strip.textContent='—';
  for(const sensor of sensors){
    const value=snapshot.values?.[sensor.key],isStale=stale(sensor.key),quality=snapshot.quality?.[sensor.key],card=$(`#sensor-${sensor.key}`);
    card.querySelector('.sensor-value').textContent=format(value,sensor);card.querySelector('.sensor-unit').textContent=sensorDisplay(sensor).unit;card.classList.toggle('stale',isStale);
    card.querySelector('.sensor-state').textContent=quality==='decode-error'?'Could not decode this reply':quality==='unavailable'?'Not available in this reply':value===undefined||value===null?(active?(selectedProfileId==='fiat-8gmk'||snapshot.supportedSensors?.includes(sensor.key)?'Awaiting first reading':'Not reported by this ECU'):'Waiting for connection'):(isStale?'Last reading · stale':'Live reading');
    const strip=$(`[data-strip="${sensor.key}"]`);if(strip)strip.textContent=isStale?'—':format(value,sensor);
    if(value!==undefined&&isStale)anyStale=true;
  }
  const mapStrip=$('[data-strip="mapPressure"]');if(mapStrip?.nextSibling?.nodeType===Node.TEXT_NODE)mapStrip.nextSibling.textContent=' '+pressureDisplay('kPa absolute',getSettings().pressureUnit).unit;
  $('#sensor-strip').classList.toggle('stale',anyStale);$('#strip-status').textContent=anyStale?'Some readings are stale':'Read-only OBD';
  if(snapshot.error)error(snapshot.error);
  diagnosticsWorkspace?.update();
}
function applySnapshot(next){
  const was=snapshot.status,previousProfile=snapshot.profileId,previousSession=snapshot.sessionId;let selectionChanged=false;
  const receivedProfile=DIAGNOSTIC_PROFILES.find(profile=>profile.id===(next.profileId||'generic-obd'));
  if(receivedProfile&&['connecting','streaming'].includes(next.status)){
    if(selectedProfileId!==receivedProfile.id){selectedProfileId=receivedProfile.id;$('#diagnostic-profile').value=selectedProfileId;selectionChanged=true;}
    if(Array.isArray(next.selectedSensors)&&next.selectedSensors.length>=1&&next.selectedSensors.length<=32){const allowed=receivedProfile.channels.filter(channel=>next.selectedSensors.includes(channel.key)).map(channel=>channel.key);if(allowed.length&&allowed.length===next.selectedSensors.length&&(allowed.length!==selectedKeys().size||allowed.some(key=>!selectedKeys().has(key)))){profileSelections.set(selectedProfileId,new Set(allowed));selectionChanged=true;}}
  }
  snapshot=next;
  if(receivedProfile&&receivedProfile.id!==selectedProfileId&&!['connecting','streaming'].includes(next.status))snapshot={...next,values:{},sampleTimes:{},quality:{}};
  if(selectionChanged)syncSelectedSensors({resetHistory:true});
  if(next.status!==was&&['connecting','streaming','disconnected'].includes(next.status))error('');
  const sessionChanged=previousSession&&next.sessionId&&previousSession!==next.sessionId;
  if(sessionChanged||next.status==='connecting'&&(was!=='connecting'||previousProfile!==next.profileId)){history=Object.fromEntries(sensors.map(s=>[s.key,[]]));}
  if((next.status!=='streaming'||sessionChanged)&&recording)recording=false;
  renderSensors();drawLiveChart();
}
function consumeEvent(event){
  serverOnline=true;
  if(event.type==='status'){applySnapshot(event.data);return;}
  if(event.type==='fault'){error(snapshot.error||event.data.message||'The sensor session stopped.');return;}
  if(event.type!=='sample')return;
  const sample=event.data,t=Date.parse(sample.timestamp);if(!Number.isFinite(t))return;
  if((sample.profileId||'generic-obd')!==selectedProfileId||!['connecting','streaming'].includes(snapshot.status))return;
  if(snapshot.sessionId&&sample.sessionId!==snapshot.sessionId)return;
  if(sample.ecu&&snapshot.ecu&&sample.ecu!==snapshot.ecu)return;
  const acceptedValues={},acceptedQuality={};
  for(const [key,value]of Object.entries(sample.values||{})){
    const sensor=sensors.find(sensor=>sensor.key===key);if(!sensor||!history[key])continue;
    if(t<Date.parse(snapshot.sampleTimes?.[key]||''))continue;
    const quality=sample.quality?.[key]??(value===null?'unavailable':'valid');
    if(!['valid','unavailable','decode-error'].includes(quality))continue;
    if(quality==='valid'?(sensor.valueType==='text'?typeof value!=='string'||value.length>160:typeof value!=='number'||!Number.isFinite(value)):value!==null)continue;
    acceptedValues[key]=value;acceptedQuality[key]=quality;
    snapshot.values={...snapshot.values,[key]:value};snapshot.quality={...snapshot.quality,[key]:quality};snapshot.sampleTimes={...snapshot.sampleTimes,[key]:sample.timestamp};snapshot.lastSampleAt=sample.timestamp;
    if(quality==='valid'&&typeof value==='number'){history[key].push({time:t,value});if(history[key].length>600)history[key].shift();}
  }
  if(recording&&Object.keys(acceptedValues).length){recorded.push({timestamp:sample.timestamp,ecu:sample.ecu,profileId:selectedProfileId,...(sample.sessionId?{sessionId:sample.sessionId}:{}),values:acceptedValues,quality:acceptedQuality});recordingUnsaved=true;if(recorded.length>=MAX_RECORDED){recording=false;error('Recording reached 20,000 samples and stopped. Export it before starting another recording.');}}
  renderSensors();drawLiveChart();
}
async function eventStream(attempt=0){
  clearTimeout(streamRetryTimer);streamAbort?.abort();const controller=new AbortController();streamAbort=controller;
  try{
    const response=await fetch('/api/events',{headers:{'X-Tune-Workshop':'1'},signal:controller.signal});
    if(!response.ok||!response.body)throw new Error('Live status stream unavailable.');
    serverOnline=true;const reader=response.body.getReader(),decoder=new TextDecoder();let text='';
    while(true){const {value,done}=await reader.read();if(done)break;text+=decoder.decode(value,{stream:true});if(text.length>256*1024)throw new Error('Invalid live status stream.');let boundary;while((boundary=text.indexOf('\n\n'))!==-1){const frame=text.slice(0,boundary);text=text.slice(boundary+2);const line=frame.split('\n').find(s=>s.startsWith('data:'));if(line&&!bleSession)consumeEvent(JSON.parse(line.slice(5)));}}
    throw new Error('Live status connection closed.');
  }catch(e){
        if(controller.signal.aborted)return;serverOnline=false;recording=false;renderSensors();
    streamRetryTimer=setTimeout(()=>eventStream(Math.min(attempt+1,5)),Math.min(15000,1000*2**attempt));
  }
}
function renderPorts(){
  const previous=$('#serial-port').value||preferredPort,type=$('#adapter-transport').value,ports=portsForTransport(portList,type);
  $('#serial-port').replaceChildren();const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent=!portsLoaded?'Refresh to find ports':ports.length?'Choose your adapter’s port':'No matching COM ports found';$('#serial-port').append(placeholder);
  for(const port of ports){const option=document.createElement('option');option.value=port.path;option.textContent=serialPortLabel(port);$('#serial-port').append(option);}
  if(ports.some(port=>port.path===previous))$('#serial-port').value=previous;
  $('#port-summary').textContent=!portsLoaded?'':ports.length?`${ports.length} available port${ports.length===1?'':'s'}. A port listing does not identify the connected vehicle or verify the adapter.`:type==='bluetooth'?'No Bluetooth COM port found. Pair the adapter in Windows and check its outgoing COM port, then refresh.':'No USB serial port found. Connect the adapter and check its Windows driver, then refresh.';
}
async function refreshPorts(){
  if(portsLoading)return;portsLoading=true;error('');renderSensors();
  try{const result=await api('/api/serial/ports');portList=result.ports;portsLoaded=true;renderPorts();}
  finally{portsLoading=false;renderSensors();}
}
function updateConnectionType(){
  const ble=$('#adapter-transport').value==='ble';
  $('#bluetooth-help-title').textContent=ble?'Connect your BLE OBD adapter':'Connect a Bluetooth Classic adapter';
  const steps=ble?['Power the OBD adapter and enable Bluetooth on this laptop.','Leave BLE serial services on Detect automatically, then select Find BLE adapter.','Choose your adapter’s advertised name. The app checks its ELM identity and reads supported sensors.']:['Pair the OBD adapter in Windows Bluetooth settings. Use the PIN from its supplier if asked.','In Windows Bluetooth COM-port settings, identify the outgoing port for that adapter.','Refresh ports here, choose that port and its baud rate, then select Connect sensors.'];
  $('#bluetooth-steps').replaceChildren(...steps.map(text=>{const li=document.createElement('li');li.textContent=text;return li;}));
  $('#bluetooth-detail').textContent=ble?'BLE does not use a COM port or baud rate. Automatic detection tries FFE0, FFF0 and Nordic UART services; adapters with another layout need Custom services. Close any other app using the adapter.':'This option uses Bluetooth Classic Serial Port Profile (SPP). For a BLE adapter, choose Bluetooth Low Energy above. Windows may list incoming ports or unrelated devices; choose your adapter’s outgoing port.';
  renderPorts();renderSensors();
}
async function connect(){
  const transport=$('#adapter-transport').value,path=$('#serial-port').value;
  if(['serial','bluetooth'].includes(transport)&&!path)throw new Error('Choose the adapter’s COM port first.');
  const options=transport==='ble'?{transport,profile:$('#ble-profile').value,service:$('#ble-service').value,write:$('#ble-write').value,notify:$('#ble-notify').value}:transport==='wifi'?{transport,host:$('#wifi-host').value.trim(),port:Number($('#wifi-port').value)}:{transport,path,baudRate:Number($('#serial-baud').value)};
  if(!sensors.length||sensors.length>32)throw new Error('Select between 1 and 32 parameters.');
  options.profileId=selectedProfileId;options.channels=sensors.map(sensor=>sensor.key);
  void rememberConnection();
  serialOperation=true;error('');renderSensors();
  try{
    if(bleSession){void bleSession.disconnect();bleSession=null;}
    if(transport==='ble'){
      const session=new BleSensorSession({cancelPicker:()=>window.workshopDesktop?.cancelBluetoothRequest()});bleSession=session;
      for(const type of ['status','sample','fault'])session.on(type,data=>{if(bleSession===session)consumeEvent({type,data});});
      await session.connect(options);
    }else applySnapshot(await api('/api/sensors/connect',options,90000));
  }catch(failure){
    // Status contains the adapter's specific failure. A generic HTTP rejection
    // must not hide it if the event stream is delayed or temporarily offline.
    if(transport!=='ble')try{const latest=await api('/api/sensors',undefined,3000);if(latest.status==='error')applySnapshot(latest);}catch{}
    throw new Error(snapshot.error||failure.message);
  }finally{serialOperation=false;renderSensors();}
}
async function disconnect(){if(bleSession){const session=bleSession;await session.disconnect();bleSession=null;}else applySnapshot(await api('/api/sensors/disconnect',{}));recording=false;renderSensors();}
function drawLiveChart(){
  if($('#live-workspace').hidden)return;
  const sensor=sensors.find(s=>s.key===$('#live-channel').value&&s.valueType!=='text')||sensors.find(sensor=>sensor.valueType!=='text');
  $('#live-chart').hidden=!sensor;
  if(!sensor){$('#live-chart-title').textContent=sensors.length?'Status readings':'Sensor history';$('#live-chart-note').textContent=sensors.length?'Selected parameters report text statuses. Their current values appear in the cards and are retained in recordings.':'Choose parameters to display their readings.';return;}
  const allPoints=history[sensor.key]||[],seconds=getSettings().chartHistorySeconds;
  const display=sensorDisplay(sensor),since=(allPoints.at(-1)?.time||0)-seconds*1000,points=allPoints.filter(point=>point.time>=since).map(point=>({...point,value:point.value*display.factor}));
  $('#live-chart-title').textContent=sensor.name;$('#live-chart-note').textContent=points.length?`${points.length} readings · last ${seconds} seconds of available data · elapsed seconds from this chart’s first sample · ${display.unit}`:'Waiting for real sensor readings. No simulated data is displayed.';
  const canvas=$('#live-chart'),rect=canvas.getBoundingClientRect(),dpr=devicePixelRatio||1;canvas.width=rect.width*dpr;canvas.height=rect.height*dpr;
  const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);const w=rect.width,h=rect.height,L=65,R=w-20,T=25,B=h-45;
  ctx.font='11px system-ui';ctx.strokeStyle='#35404d';ctx.fillStyle='#9aaabb';
  if(!points.length){ctx.textAlign='center';ctx.fillText('Connect to show live data',w/2,h/2);return;}
  const vals=points.map(p=>p.value);let lo=Math.min(...vals),hi=Math.max(...vals);if(lo===hi){lo-=1;hi+=1;}const range=(hi-lo)*.15;lo-=range;hi+=range;
  const start=points[0].time,end=points.at(-1).time,X=t=>L+(t-start)/Math.max(1000,end-start)*(R-L),Y=v=>B-(v-lo)/(hi-lo)*(B-T);
  ctx.textAlign='right';for(let i=0;i<=4;i++){const y=T+i*(B-T)/4;ctx.beginPath();ctx.moveTo(L,y);ctx.lineTo(R,y);ctx.stroke();ctx.fillText((hi-i*(hi-lo)/4).toFixed(display.converted?(getSettings().pressureUnit==='bar'?3:2):sensor.digits),L-10,y+4);}
  ctx.textAlign='center';for(let i=0;i<=4;i++){const t=start+i*(end-start)/4;ctx.fillText(((t-start)/1000).toFixed(1),X(t),B+22);}
  ctx.strokeStyle='#6cd5c5';ctx.lineWidth=2;ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(X(p.time),Y(p.value)):ctx.moveTo(X(p.time),Y(p.value)));ctx.stroke();ctx.fillText('Elapsed seconds',w/2,h-6);
}
async function exportRecording(){
  if(exportingRecording||!recorded.length)return;
  const target=recorded,count=recorded.length;exportingRecording=true;renderSensors();
  const data={format:'tuneworkshop-sensor-recording',version:1,...recordingMetadata,readOnly:true,samples:recorded};
  try{
    const saved=await download(`sensor-recording-${new Date().toISOString().replace(/[:.]/g,'-')}.json`,JSON.stringify(data,null,2));
    if(saved&&recorded===target&&recorded.length===count)recordingUnsaved=false;
    if(!saved)error('Save cancelled or incomplete. The recording is still unsaved.');
  }finally{exportingRecording=false;renderSensors();}
}
function makeContext(){
  const sameProfile=(snapshot.profileId||'generic-obd')===selectedProfileId;
  const identity=sameProfile&&snapshot.identity?.source==='live-manufacturer'?Object.fromEntries(['source','ecuIsoCode','hardwareNumber','softwareNumber'].filter(key=>typeof snapshot.identity[key]==='string').map(key=>[key,snapshot.identity[key]])):null;
  return {tuning:getSelectedTuningContext(),sensors:{source:snapshot.status==='streaming'&&serverOnline?(selectedProfileId!=='generic-obd'?'live-manufacturer':'live-obd'):'disconnected',profileId:selectedProfileId,...(sameProfile&&snapshot.ecu?{ecu:snapshot.ecu}:{}),...(identity?{identity}:{}),capturedAt:new Date().toISOString(),values:sensors.filter(s=>Object.hasOwn(snapshot.values||{},s.key)).map(s=>({name:s.name,value:typeof snapshot.values[s.key]==='number'?snapshot.values[s.key]*sensorDisplay(s).factor:snapshot.values[s.key],unit:sensorDisplay(s).unit,capturedAt:snapshot.sampleTimes[s.key],stale:stale(s.key),...(snapshot.quality?.[s.key]?{quality:snapshot.quality[s.key]}:{})}))}};
}
function updateContext(){if($('#assistant-panel').hidden)return;$('#assistant-context-preview').textContent=$('#assistant-include-context').checked?JSON.stringify(makeContext(),null,2):'Context sharing is off. Only this chat will be sent.';}
function appendMessage(role,text,failed=false){
  $('.assistant-welcome')?.remove();const div=document.createElement('div');div.className=`chat-message ${role}${failed?' error':''}`;
  const label=document.createElement('small');label.textContent=failed?'CONNECTION MESSAGE':role==='user'?'YOU':'ASSISTANT';
  const p=document.createElement('p');p.textContent=text;div.append(label,p);$('#assistant-messages').append(div);scrollChat(div);return div;
}
async function refreshAssistant(){
  const revision=assistantStatusRevision;
  const request=assistantStatusRequest?.revision===revision?assistantStatusRequest.promise:api('/api/assistant/status');
  assistantStatusRequest={revision,promise:request};
  let status;
  try{status=await request;}finally{if(assistantStatusRequest?.promise===request)assistantStatusRequest=null;}
  if(revision!==assistantStatusRevision)return status;
  accountStatus=status;
  $('#assistant-status').textContent=status.message || (status.connected?`Connected to ChatGPT${status.account?.label?' · '+status.account.label:''}`:status.signingIn?'Complete sign-in in your browser':'Connect your ChatGPT account to start.');
  $('#assistant-login').textContent=status.connected?'Reconnect ChatGPT':'Connect ChatGPT';$('#assistant-login').disabled=!!status.signingIn;
  $('#assistant-disconnect').hidden=!status.connected&&!status.signingIn;$('#assistant-disconnect').disabled=chatBusy;
  $('#assistant-send').disabled=chatBusy||status.signingIn||!status.configured||!status.models?.length;
  $('#assistant-manage-usage').hidden=!status.connected;
  const previous=$('#assistant-model').value||getSettings().preferredModel;$('#assistant-model').replaceChildren();
  if(status.models?.length){for(const m of status.models){const option=document.createElement('option');option.value=m.id;option.textContent=m.name||m.id;$('#assistant-model').append(option);}if(status.models.some(m=>m.id===previous))$('#assistant-model').value=previous;else if(status.models.some(m=>m.id===status.model))$('#assistant-model').value=status.model;}
  else{const option=document.createElement('option');option.value='';option.textContent=status.signingIn?'Waiting for browser sign-in…':status.connected?(status.sharing?'No models available — select Refresh':'ChatGPT plan permission required'):'Available after sign-in';$('#assistant-model').append(option);}
  $('#assistant-model').disabled=!!status.signingIn||!status.models?.length;
  if(!status.signingIn){$('#assistant-login-link').hidden=true;$('#assistant-login-link').removeAttribute('href');clearInterval(assistantPoll);assistantPoll=null;}
  return status;
}
async function openAssistant(){
  $('#assistant-panel').hidden=false;document.body.classList.add('assistant-open');$('#assistant-toggle').setAttribute('aria-expanded','true');updateContext();
  try{await refreshAssistant();}catch(e){$('#assistant-status').textContent=e.message;$('#assistant-send').disabled=true;}
}
function prepareTableAnalysis(){
  const question=$('#assistant-question'),hasDraft=!!question.value.trim(),sourceMetadata=getSelectedTuningContext().sourceMetadata;
  if(!hasDraft&&!chatBusy)question.value=sourceMetadata?'Help me understand this saved WinOLS map definition using the context I choose to include. Explain its saved name and symbol, likely role, units, shape, axis definitions and scaling. Separate source labels from independently verified behavior. The numeric calibration values and axis breakpoints have not been decoded, and the saved addresses are not confirmed file offsets or ECU addresses. Do not invent values or assume this project matches the connected Fiat. Explain what evidence is still needed before editing calibration values. If source metadata is missing, ask me to include it.':'Help me understand this table using the context I choose to include. Explain what the values and encoding show, then consider possible axis, curve or map interpretations with evidence for and against each. Separate observations from guesses. Identify what is missing to verify its purpose, units and scaling, and suggest the next local checks. Do not assign fuel, boost or ignition labels without supporting evidence. If table context is missing, ask me to include it before drawing conclusions.';
  let note=$('#assistant-table-note');
  if(!note){note=document.createElement('p');note.id='assistant-table-note';note.className='assistant-table-note';note.setAttribute('role','status');$('#assistant-form').prepend(note);}
  const draftStatus=hasDraft?'Your existing message is preserved.':chatBusy?'The current request is still running; your message box is unchanged.':'An analysis prompt is ready to review.';
  note.textContent=`${draftStatus} ${sourceMetadata?($('#assistant-include-context').checked?'Review the source map metadata below, then choose Send. Numeric values are unavailable.':'Enable the context checkbox to share this source map metadata, review the preview, then choose Send. Numeric values are unavailable.'):($('#assistant-include-context').checked?'Review the selected table context below, then choose Send.':'Check “Include selected map cells and latest sensor readings” to share the table, review the context, then choose Send.')}`;
  note.hidden=false;$('#assistant-context-details').open=true;
  void openAssistant();
  question.focus({preventScroll:true});
}
async function beginSignIn(){
  ++assistantStatusRevision;
  $('#assistant-login').disabled=true;$('#assistant-status').textContent='Preparing secure ChatGPT sign-in…';
  try{
    const result=await api('/api/assistant/sign-in',{},60000);const url=new URL(result.authorizationUrl);
    if(url.protocol!=='https:'||!['auth.openai.com','auth0.openai.com'].includes(url.hostname))throw new Error('The server returned an unexpected sign-in address.');
    $('#assistant-login-link').href=url.href;$('#assistant-login-link').hidden=false;$('#assistant-login-link').textContent='Continue sign-in in browser';
    $('#assistant-status').textContent='Open the sign-in link and complete authorization in your browser.';
    clearInterval(assistantPoll);assistantPoll=setInterval(()=>refreshAssistant().catch(e=>{$('#assistant-status').textContent=e.message;}),3000);
    // Electron handles this link in the system browser. Keep the visible link
    // as a fallback, and leave browser-preview opening to a user click.
    if(window.workshopDesktop)$('#assistant-login-link').click();
  }catch(e){$('#assistant-status').textContent=e.message;$('#assistant-login').disabled=false;}
}
async function sendMessage(event){
  event.preventDefault();if(chatBusy||$('#assistant-send').disabled)return;const text=$('#assistant-question').value.trim();if(!text)return;
  if(!accountStatus?.configured){$('#assistant-status').textContent='Connect your ChatGPT account and enable plan usage before sending.';return;}
  const context=$('#assistant-include-context').checked?makeContext():undefined;
  if(context)$('#assistant-context-preview').textContent=JSON.stringify(context,null,2);
  const {messages:submitted,truncated}=prepareConversation(chatMessages,text);
  $('#assistant-history-note').hidden=!truncated;
  appendMessage('user',text);$('#assistant-question').value='';chatBusy=true;$('#assistant-send').disabled=true;
  const pending=appendMessage('assistant','Thinking…');
  try{
    const result=await api('/api/assistant/message',{messages:submitted,...($('#assistant-model').value?{model:$('#assistant-model').value}:{}),...(context?{context}:{})},150000);
    pending.querySelector('p').textContent=result.text;chatMessages=[...submitted,{role:'assistant',content:result.text}].slice(-12);
    $('#assistant-status').textContent='Connected. Using ChatGPT plan.';
  }catch(e){pending.classList.add('error');pending.querySelector('small').textContent='CONNECTION MESSAGE';pending.querySelector('p').textContent=e.message;$('#assistant-status').textContent=e.message;$('#assistant-question').value=text;}
  finally{chatBusy=false;$('#assistant-send').disabled=!!accountStatus?.signingIn||!accountStatus?.configured||!accountStatus?.models?.length;scrollChat(pending);}
}
function scrollChat(message){if(getSettings().autoScrollChat&&!$('#assistant-panel').hidden)message.scrollIntoView({block:'nearest'});}
function applyPreferences(settings){
  $('#assistant-panel').style.setProperty('--chat-text-size',`${settings.chatTextSize}px`);
  $('#assistant-keyboard-hint').textContent=settings.sendOnEnter?'Enter to send · Shift+Enter for a new line':'Enter for a new line · Ctrl+Enter to send';
  if(!settings.rememberConnection)preferredPort='';
  renderSensors();drawLiveChart();
}
function restoreConnection(){
  const c=getSettings().connection;
  for(const [id,key]of Object.entries({'adapter-transport':'transport','serial-baud':'baudRate','wifi-host':'host','wifi-port':'port','ble-profile':'profile','ble-service':'service','ble-write':'write','ble-notify':'notify'}))$('#'+id).value=String(c[key]);
  // The COM port is restored only after a fresh listing contains it. BLE device
  // choice and the Connect button always remain explicit actions.
}
function connectionPreferences(){
  return {transport:$('#adapter-transport').value,path:$('#serial-port').value||preferredPort,baudRate:Number($('#serial-baud').value),host:$('#wifi-host').value.trim(),port:Number($('#wifi-port').value),profile:$('#ble-profile').value,service:$('#ble-service').value.trim(),write:$('#ble-write').value.trim(),notify:$('#ble-notify').value.trim()};
}
export function captureRememberedSettings(patch){
  const previous=getSettings(),next={...patch};
  if(!previous.rememberModel&&next.rememberModel&&!Object.hasOwn(next,'preferredModel')){
    const model=$('#assistant-model').value;
    if(accountStatus?.models?.some(m=>m.id===model))next.preferredModel=model;
  }
  if(!previous.rememberConnection&&next.rememberConnection&&!Object.hasOwn(next,'connection')){
    const connection=connectionPreferences();
    try{validateSettings({...previous,...next,connection});next.connection=connection;}
    catch{$('#connection-preference-note').textContent='Some adapter details are incomplete. Correct them to remember this setup.';}
  }
  return next;
}
async function rememberConnection(){
  if(!getSettings().rememberConnection)return;
  try{await saveSettings({connection:connectionPreferences()});$('#connection-preference-note').textContent='';}
  catch{$('#connection-preference-note').textContent='Adapter setup could not be remembered. Check the entered details and try again.';}
}
$('#assistant-question').addEventListener('keydown',event=>{
  if(!isChatSubmitKey(event,getSettings().sendOnEnter))return;
  event.preventDefault();
  if(!chatBusy&&!$('#assistant-send').disabled&&$('#assistant-question').value.trim())$('#assistant-form').requestSubmit();
});
$('#assistant-model').addEventListener('change',()=>{
  const model=$('#assistant-model').value;
  if(getSettings().rememberModel&&accountStatus?.models?.some(m=>m.id===model))void saveSettings({preferredModel:model}).catch(()=>{$('#assistant-status').textContent='Your model is selected for this session, but could not be remembered.';});
});
for(const id of ['adapter-transport','serial-port','serial-baud','wifi-host','wifi-port','ble-profile','ble-service','ble-write','ble-notify'])$('#'+id).addEventListener('change',()=>{
  if(id==='serial-port')preferredPort=$('#serial-port').value;
  // Let the transport change handler update its controls before capturing them.
  queueMicrotask(()=>void rememberConnection());
});
$('#live-nav').addEventListener('click',()=>{showWorkspace('live');drawLiveChart();});
$('#connection-setup').addEventListener('click',()=>{showWorkspace('live');$('#adapter-transport').focus();});
$('#return-to-map').addEventListener('click',()=>showWorkspace('tuning'));
$('#refresh-ports').addEventListener('click',safely(refreshPorts));$('#serial-port').addEventListener('change',renderSensors);
$('#adapter-transport').addEventListener('change',updateConnectionType);$('#wifi-host').addEventListener('input',renderSensors);$('#ble-profile').addEventListener('change',renderSensors);
$('#connect-sensors').addEventListener('click',safely(connect));$('#disconnect-sensors').addEventListener('click',safely(disconnect));$('#strip-disconnect').addEventListener('click',safely(disconnect));
$('#copy-connection-details').addEventListener('click',async()=>{
  const details=['Tune Workshop connection details',`Status: ${snapshot.status}`,`Connection: ${snapshot.transport||$('#adapter-transport').value}`,`Port: ${snapshot.path||'not opened'}`,`Baud rate: ${snapshot.baudRate||'not applicable'}`,`Wi-Fi: ${snapshot.host?`${snapshot.host}:${snapshot.port}`:'not applicable'}`,`Reason: ${snapshot.error||$('#live-error').textContent||'No failure reported'}`].join('\n');
  try{await navigator.clipboard.writeText(details);$('#connection-copy-status').textContent='Connection details copied.';}
  catch{$('#connection-copy-status').textContent=details;}
});
$('#live-channel').addEventListener('change',drawLiveChart);
$('#diagnostic-profile').addEventListener('change',()=>{
  if(selectionLocked()){$('#diagnostic-profile').value=selectedProfileId;return;}
  const profile=DIAGNOSTIC_PROFILES.find(profile=>profile.id===$('#diagnostic-profile').value);if(!profile)return;
  selectedProfileId=profile.id;snapshot={...snapshot,values:{},sampleTimes:{},quality:{},supportedSensors:[]};
  $('#sensor-search').value='';error('');syncSelectedSensors({resetHistory:true});renderSensors();drawLiveChart();updateContext();
});
$('#sensor-search').addEventListener('input',renderParameterChoices);
$('#sensor-selection-list').addEventListener('change',event=>{
  const input=event.target.closest('input[type="checkbox"]');if(!input)return;
  if(selectionLocked()){input.checked=selectedKeys().has(input.value);return;}
  if(input.checked&&selectedKeys().size>=32){input.checked=false;error('Select at most 32 parameters. Deselect one before adding another.');return;}
  if(input.checked)selectedKeys().add(input.value);else selectedKeys().delete(input.value);
  error('');syncSelectedSensors();renderSensors();drawLiveChart();updateContext();
});
for(const button of document.querySelectorAll('[data-sensor-preset]'))button.addEventListener('click',()=>{
  if(selectionLocked())return;
  const preset=button.dataset.sensorPreset,profile=currentProfile();let keys=[];
  if(preset==='default')keys=profile.defaultChannels;
  if(preset==='engine')keys=profile.channels.filter(channel=>/engine speed|coolant|intake air temperature|throttle|battery voltage|control module voltage|spark advance/i.test(channel.label)).slice(0,12).map(channel=>channel.key);
  if(preset==='air')keys=profile.channels.filter(channel=>/boost|air pressure|manifold|air temperature|air flow|throttle|turbo/i.test(channel.label)).slice(0,16).map(channel=>channel.key);
  profileSelections.set(selectedProfileId,new Set(keys));$('#sensor-search').value='';error('');syncSelectedSensors();renderSensors();drawLiveChart();updateContext();
});
$('#record-start').addEventListener('click',()=>{
  if(recordingUnsaved&&!confirm('Start a new recording and replace the previous unsaved recording?'))return;
  recorded=[];recordingUnsaved=false;
  recordingMetadata={source:selectedProfileId!=='generic-obd'?'live-manufacturer':'live-obd',profileId:selectedProfileId,profileLabel:currentProfile().label,...(snapshot.sessionId?{sessionId:snapshot.sessionId}:{}),selectedSensors:sensors.map(sensor=>sensor.key),units:Object.fromEntries(sensors.map(sensor=>[sensor.key,sensor.unit])),channels:sensors.map(({key,name,unit,valueType})=>({key,name,unit,valueType}))};
  recording=true;renderSensors();
});
$('#record-stop').addEventListener('click',()=>{recording=false;renderSensors();});$('#record-export').addEventListener('click',safely(exportRecording));
$('#assistant-toggle').addEventListener('click',()=>$('#assistant-panel').hidden?openAssistant():$('#assistant-close').click());$('#live-assistant').addEventListener('click',openAssistant);
window.addEventListener('workshop:analyse-table',prepareTableAnalysis);
$('#assistant-close').addEventListener('click',()=>{$('#assistant-panel').hidden=true;document.body.classList.remove('assistant-open');$('#assistant-toggle').setAttribute('aria-expanded','false');$('#assistant-toggle').focus();});
$('#assistant-refresh').addEventListener('click',()=>refreshAssistant().catch(e=>{$('#assistant-status').textContent=e.message;}));
$('#assistant-login').addEventListener('click',beginSignIn);$('#assistant-form').addEventListener('submit',sendMessage);
$('#assistant-disconnect').addEventListener('click',async()=>{try{++assistantStatusRevision;await api('/api/assistant/disconnect',{});clearInterval(assistantPoll);assistantPoll=null;$('#assistant-login-link').hidden=true;await refreshAssistant();}catch(e){$('#assistant-status').textContent=e.message;}});
$('#assistant-include-context').addEventListener('change',updateContext);$('#assistant-context-details').addEventListener('toggle',updateContext);
$('#assistant-clear').addEventListener('click',()=>{if(chatBusy)return;chatMessages=[];$('#assistant-messages').replaceChildren();});
window.addEventListener('resize',drawLiveChart);window.addEventListener('workspace-changed',drawLiveChart);
window.addEventListener('pagehide',()=>{void bleSession?.disconnect();streamAbort?.abort();clearTimeout(streamRetryTimer);clearInterval(assistantPoll);});
window.addEventListener('beforeunload',event=>{if(recordingUnsaved||bleServicePending){event.preventDefault();event.returnValue='';}});
window.workshopDesktop?.onServiceCloseBlocked?.(()=>{
  showWorkspace('diagnostics');
  $('#diagnostic-message').textContent='A Bluetooth service action is still running. Choose Stop action or wait for it to finish before closing the app.';
});
installBluetoothDialogs();initProfiles();initCards();restoreConnection();updateConnectionType();applyPreferences(getSettings());subscribeSettings(applyPreferences);
diagnosticsWorkspace=createDiagnosticsWorkspace({
  getSnapshot:()=>({...snapshot,profileId:selectedProfileId,...(!serverOnline?{status:'unavailable'}:{})}),
  run:async options=>{
    const session=bleSession;
    if(!session)return api('/api/diagnostics/run',options,150000);
    if(options.action!=='run-service')return session.diagnose(options);
    if(!window.workshopDesktop?.setServiceActive)throw new Error('Use the Windows app for Bluetooth service actions so it can keep the connection open until the action stops.');
    bleServicePending=true;
    try{
      await window.workshopDesktop.setServiceActive(true);
      return await session.diagnose(options);
    }finally{
      bleServicePending=false;
      await window.workshopDesktop.setServiceActive(false);
    }
  },
  stop:options=>bleSession?bleSession.stopService(options):api('/api/diagnostics/stop',options),
  onSetup:profileId=>{
    if(selectionLocked()&&selectedProfileId!==profileId)throw new Error('Disconnect the current controller on Live sensors, then choose this connection.');
    if(!selectionLocked()){
      $('#diagnostic-profile').value=profileId;$('#diagnostic-profile').dispatchEvent(new Event('change'));
    }
    showWorkspace('live');$('#adapter-transport').focus();
  },
});
api('/api/status').then(status=>{serverOnline=true;serialAvailable=!!status.serial.available;if(!serialAvailable)$('#serial-note').textContent=status.serial.reason||'USB and Bluetooth Classic support is unavailable. Install this app’s optional serialport dependency.';if(!bleSession)applySnapshot(status.sensors);accountStatus=status.assistant;}).catch(()=>{serverOnline=false;renderSensors();});
eventStream();setInterval(()=>{renderSensors();updateContext();},1000);
