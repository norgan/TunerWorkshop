import { app, BrowserWindow, Menu, dialog, shell, ipcMain } from 'electron';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, mkdtemp, readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createWorkshopServer } from '../server.mjs';
import { SensorSession, availability, listSerialPorts } from '../elm.mjs';
import { createAssistant, createAssistantStorage } from '../assistant.mjs';
import { allowExternalLink, isLocalPage } from './policy.mjs';
import {installBluetoothPicker} from './bluetooth.mjs';
import {createSettingsStore,installSettings} from './settings.mjs';
import {installServiceLifecycle} from './service-lifecycle.mjs';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const smokeArg=process.argv.find(value=>value.startsWith('--smoke-test='));
const smokeOutput=smokeArg?resolve(smokeArg.slice('--smoke-test='.length)):null;
if(smokeOutput)app.setPath('userData',await mkdtemp(join(tmpdir(),'tune-workshop-desktop-test-')));
app.setName('Tune Workshop');
app.setAppUserModelId('au.tuneworkshop.desktop');
app.enableSandbox();
let window,server,sensors,assistant,origin,quitting=false,shutdownPromise,smokeDownloads=0;
const renderErrors=[];

async function shutdown(){
  if(shutdownPromise)return shutdownPromise;
  shutdownPromise=(async()=>{
    assistant?.close();
    await sensors?.disconnect().catch(()=>{});
    if(server){server.closeAllConnections();await new Promise(done=>server.close(done));}
  })();
  return shutdownPromise;
}
function openExternal(url){if(allowExternalLink(url))shell.openExternal(url).catch(()=>dialog.showErrorBox('Unable to open link',url==='ms-settings:bluetooth'?'Open Windows Settings, then Bluetooth & devices.':'Open your default browser and try the sign-in link again.'));}
function installMenu(){
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label:'File',submenu:[{label:'Exit',accelerator:'Alt+F4',click:()=>window?.close()}]},
    {label:'Edit',submenu:[{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'},{type:'separator'},{label:'Settings…',accelerator:'Ctrl+,',click:()=>window?.webContents.send('workshop:open-settings')}]},
    {label:'View',submenu:[{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{type:'separator'},{role:'togglefullscreen'}]},
    {label:'Help',submenu:[{label:'About Tune Workshop',click:()=>dialog.showMessageBox(window,{type:'info',title:'Tune Workshop',message:`Tune Workshop ${app.getVersion()}`,detail:'Windows calibration editor, Fiat engine diagnostics, service procedures, sensor monitor and tuning assistant. Vehicle validation of the new diagnostic procedures is pending. Calibration flashing and checksum correction remain unimplemented.'})}]}
  ]));
}
async function main(){
  await app.whenReady();
  const token=randomBytes(32).toString('hex');
  sensors=new SensorSession();
  assistant=createAssistant({storage:createAssistantStorage(join(app.getPath('userData'),'account'))});
  server=createWorkshopServer({session:sensors,availability,listSerialPorts,assistantStatus:assistant.assistantStatus,beginAssistantSignIn:assistant.beginAssistantSignIn,disconnectAssistant:assistant.disconnectAssistant,askAssistant:assistant.askAssistant,accessToken:token});
  await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});
  origin=`http://127.0.0.1:${server.address().port}`;
  window=new BrowserWindow({width:1440,height:1000,minWidth:900,minHeight:650,title:'Tune Workshop',backgroundColor:'#11161b',show:false,icon:join(root,'build','icon.ico'),webPreferences:{preload:join(root,'desktop','preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false,devTools:!app.isPackaged}});
  const contents=window.webContents,ses=contents.session;
  ses.setPermissionRequestHandler((_contents,permission,callback)=>callback(['clipboard-sanitized-write','bluetooth'].includes(permission)&&_contents===contents&&isLocalPage(_contents.getURL(),origin)));
  ses.setPermissionCheckHandler((_contents,permission)=>['clipboard-sanitized-write','bluetooth'].includes(permission)&&_contents===contents&&isLocalPage(_contents.getURL(),origin));
  installBluetoothPicker({contents,session:ses,ipcMain,origin});
  installSettings({contents,ipcMain,origin,store:createSettingsStore({filePath:join(app.getPath('userData'),'settings.json')})});
  const serviceLifecycle=installServiceLifecycle({window,contents,ipcMain,origin});
  ses.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!(details.url.startsWith(origin+'/')||details.url.startsWith('blob:'+origin+'/')||details.url.startsWith('devtools:')&&!app.isPackaged)}));
  ses.webRequest.onBeforeSendHeaders((details,callback)=>{
    if(details.webContentsId===contents.id&&details.url.startsWith(origin+'/'))details.requestHeaders['X-Tune-Desktop']=token;
    callback({requestHeaders:details.requestHeaders});
  });
  contents.setWindowOpenHandler(({url})=>{openExternal(url);return {action:'deny'};});
  contents.on('will-navigate',(event,url)=>{if(!isLocalPage(url,origin)){event.preventDefault();openExternal(url);}});
  contents.on('will-attach-webview',event=>event.preventDefault());
  contents.on('will-prevent-unload',event=>{
    if(serviceLifecycle.isActive()){contents.send('workshop:service-close-blocked');return;}
    if(smokeOutput)return;
    const choice=dialog.showMessageBoxSync(window,{type:'question',buttons:['Keep working','Close without saving'],defaultId:0,cancelId:0,message:'You have unsaved work.',detail:'Save your project or recording before closing. Closing disconnects the sensor session.'});
    if(choice===1)event.preventDefault();
  });
  contents.on('console-message',(_event,...args)=>{const entry=args[0];if(typeof entry==='object'){if(entry.level==='error')renderErrors.push(entry.message);}else if(entry>=3)renderErrors.push(args[1]);});
  contents.on('render-process-gone',()=>{if(!smokeOutput)dialog.showErrorBox('Tune Workshop stopped','The window stopped unexpectedly. Unsaved changes could not be recovered. Close and reopen the app.');void shutdown();});
  ses.on('will-download',(event,item)=>{
    const url=item.getURL(),notify=state=>{if(!contents.isDestroyed())contents.send('workshop:download-finished',{url,state});};
    item.once('done',(_event,state)=>notify(state));
    if(smokeOutput){
      // Test cancellation and a completed save using only the synthetic demo.
      if(smokeDownloads++===0){event.preventDefault();notify('cancelled');return;}
      const testName=item.getFilename();
      item.setSavePath(join(app.getPath('userData'),testName.endsWith('.ECU-IMAGE.UNVERIFIED-DRAFT.bin')?'synthetic-payload.bin':testName.endsWith('.inspection.json')?'synthetic-inspection.json':testName.startsWith('sensor-recording-')?'synthetic-recording.json':testName.startsWith('diagnostics-')?'synthetic-diagnostics.json':'synthetic-save.tuneworkshop.json'));return;
    }
    item.setSaveDialogOptions({title:'Save Tune Workshop file',defaultPath:join(app.getPath('downloads'),item.getFilename())});
  });
  window.on('closed',()=>{window=null;void shutdown().finally(()=>{quitting=true;app.quit();});});
  installMenu();
  await window.loadURL(origin+'/');
  if(smokeOutput){await runSmoke(contents,token);return;}
  window.show();
}
async function runSmoke(contents,token){
  // Explicit test mode exercises the packaged renderer and backend without any
  // vehicle connection, account sign-in or user document access.
  const {runRendererSmoke}=await import('./smoke.mjs');
  const checks=await runRendererSmoke(contents);
  const {runSettingsSmoke}=await import('./settings-smoke.mjs');
  Object.assign(checks,await runSettingsSmoke(contents));
  for(const reason of ['Access denied opening COM-TEST.','ELM327 response timed out for ATZ. Session stopped.','No vehicle connection detected. Connect the adapter to the car and switch the ignition on, then retry. Adapter reported: UNABLE TO CONNECT.']){
    sensors.emit('status',{...sensors.snapshot(),status:'error',path:'COM-TEST',baudRate:115200,error:reason});
    sensors.emit('fault',{message:'The operation could not be completed.'});
    await contents.executeJavaScript(`(async()=>{
      const reason=${JSON.stringify(reason)},end=Date.now()+5000;
      while(document.querySelector('#connection-status-detail').textContent!==reason&&Date.now()<end)await new Promise(r=>setTimeout(r,20));
      if(document.querySelector('#connection-status-detail').hidden||document.querySelector('#connection-status-detail').textContent!==reason)throw new Error('Connection failure was hidden');
      if(document.querySelector('#live-error').textContent!==reason)throw new Error('A generic fault replaced the adapter failure');
      if(reason.includes('ATZ')&&document.querySelector('#connection-troubleshooting').hidden)throw new Error('Adapter timeout help was missing');
    })()`);
  }
  sensors.emit('status',{...sensors.snapshot(),status:'streaming'});
  await contents.executeJavaScript(`(async()=>{
    const end=Date.now()+5000;while(!document.querySelector('#connection-status-detail').hidden&&Date.now()<end)await new Promise(r=>setTimeout(r,20));
    if(!document.querySelector('#connection-status-detail').hidden||!document.querySelector('#live-error').hidden)throw new Error('Recovered connection kept the previous failure');
  })()`);
  sensors.emit('status',sensors.snapshot());
  checks.connectionFailureReasonAndRecovery=true;
  const selected=new Promise(resolve=>contents.emit('select-bluetooth-device',{preventDefault(){}},[{deviceId:'synthetic-test-device',deviceName:'Synthetic BLE adapter'}],resolve));
  await contents.executeJavaScript(`(async()=>{const end=Date.now()+5000;while(!document.querySelector('#ble-device-dialog').open&&Date.now()<end)await new Promise(r=>setTimeout(r,20));const button=document.querySelector('#ble-device-list button');if(!button)throw new Error('Native BLE picker did not render');button.click();})()`);
  if(await selected!=='synthetic-test-device')throw new Error('Native BLE selection bridge failed.');checks.nativeBlePicker=true;
  const {CalibrationProject,sha256}=await import('../core.mjs');
  const saved=await CalibrationProject.fromJSON(await readFile(join(app.getPath('userData'),'synthetic-save.tuneworkshop.json'),'utf8'));
  if(!saved.synthetic||saved.bytes[0]!==0xa5||saved.bytes[1]!==0x5a)throw new Error('Native project save did not preserve edited bytes.');
  checks.nativeSavedFileReopens=true;
  // Save the synthetic test edits and recording before exercising a reload.
  await contents.executeJavaScript(`(async()=>{
    const save=document.querySelector('#save-project');save.click();
    while(save.disabled)await new Promise(r=>setTimeout(r,20));
    const recording=document.querySelector('#record-export');recording.click();
    while(recording.disabled)await new Promise(r=>setTimeout(r,20));
  })()`);
  await contents.loadURL(origin+'/');
  await contents.executeJavaScript(`(async()=>{
    const end=Date.now()+10000;
    while((!document.querySelector('#settings-dialog')||document.querySelector('#diagnostics-workspace').hidden)&&Date.now()<end)await new Promise(r=>setTimeout(r,25));
    if(document.querySelector('#diagnostics-workspace').hidden)throw new Error('Starting workspace did not survive reload');
    document.querySelector('#tuning-nav').click();
    if(document.querySelector('[data-view="curve"]').getAttribute('aria-selected')!=='true')throw new Error('Default map view did not survive reload');
    const {getSettings}=await import('./settings-client.mjs');
    if(getSettings().chatTextSize!==16||getSettings().chartHistorySeconds!==120)throw new Error('Settings did not survive reload');
    await (await import('./settings-ui.mjs')).openSettings();
  })()`);
  checks.settingsReload=true;checks.startupWorkspaceAndMapView=true;
  const {runDimsportSmoke}=await import('./dimsport-smoke.mjs');
  Object.assign(checks,await runDimsportSmoke(contents));
  const savedPayloadProject=await CalibrationProject.fromJSON(await readFile(join(app.getPath('userData'),'synthetic-save.tuneworkshop.json'),'utf8'));
  if(savedPayloadProject.payloadInfo?.fileOffset!==351||savedPayloadProject.readMap(savedPayloadProject.maps[0].id)[0]!==801||savedPayloadProject.changedByteCount!==1)throw new Error('Saved Dimsport candidate project did not preserve its structure and edit.');
  if(savedPayloadProject.original[351+0x101]!==0x20||savedPayloadProject.bytes[351+0x101]!==0x21)throw new Error('Saved Dimsport byte coordinates changed.');
  for(let i=0;i<351;i++)if(savedPayloadProject.original[i]!==savedPayloadProject.bytes[i])throw new Error('Candidate edit changed the container header.');
  checks.dimsportOriginalAndWrapperPreserved=true;
  const exportedPayload=await readFile(join(app.getPath('userData'),'synthetic-payload.bin'));
  if(exportedPayload.length!==4194304||exportedPayload[0x101]!==0x21)throw new Error('Native payload export does not contain the edited image.');
  const inspection=JSON.parse(await readFile(join(app.getPath('userData'),'synthetic-inspection.json'),'utf8'));
  if(inspection.workingPayloadSha256!==await sha256(new Uint8Array(exportedPayload))||inspection.originalContainerSha256!==await sha256(savedPayloadProject.original))throw new Error('Inspection report hashes do not match saved artifacts.');
  checks.nativePayloadExportAndInspectionHashes=true;
  const {runLiveProfileSmoke}=await import('./live-profile-smoke.mjs');
  Object.assign(checks,await runLiveProfileSmoke(contents,sensors));
  const {runMapWorkbenchSmoke}=await import('./map-workbench-smoke.mjs');
  Object.assign(checks,await runMapWorkbenchSmoke(contents));
  const native=await availability();
  if(!native.available)throw new Error('Bundled USB serial driver failed to load.');
  const local=await fetch(origin+'/api/status',{headers:{'X-Tune-Workshop':'1','X-Tune-Desktop':token}});
  if(!local.ok)throw new Error('Packaged local API failed.');
  const denied=await fetch(origin+'/api/status',{headers:{'X-Tune-Workshop':'1'}});
  if(denied.status!==403)throw new Error('Private desktop session was not enforced.');
  const state=await local.json();
  if(state.sensors.status!=='disconnected'||state.assistant.connected)throw new Error('Unexpected external connection in test.');
  if(renderErrors.length)throw new Error('Renderer reported an error: '+renderErrors.join('; '));
  await mkdir(dirname(smokeOutput),{recursive:true});
  await contents.executeJavaScript(`document.querySelector('#edit-map-definition').click();document.querySelector('#map-dialog').scrollTop=0;`);
  await contents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await writeFile(smokeOutput.replace(/\.json$/i,'')+'-map-setup.png',(await contents.capturePage()).toPNG());
  await contents.executeJavaScript(`document.querySelector('#cancel-map').click();document.querySelector('#browse-map-references').click();document.querySelector('#map-reference-dialog').scrollTop=0;`);
  await contents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await writeFile(smokeOutput.replace(/\.json$/i,'')+'-references.png',(await contents.capturePage()).toPNG());
  await contents.executeJavaScript(`document.querySelector('#close-map-references').click();`);
  await contents.executeJavaScript(`document.querySelector('[data-view="surface"]').click();window.scrollTo(0,0);`);
  await contents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,150))))');
  await mkdir(dirname(smokeOutput),{recursive:true});
  await writeFile(smokeOutput.replace(/\.json$/i,'')+'.png',(await contents.capturePage()).toPNG());
  const {runOlsCatalogueSmoke}=await import('./ols-catalogue-smoke.mjs');
  const referenceArg=process.argv.find(value=>value.startsWith('--ols-reference='));
  let reference=null;
  if(referenceArg){
    const path=resolve(referenceArg.slice('--ols-reference='.length));
    const bytes=await readFile(path);
    if(bytes.length>32*1024*1024)throw new Error('OLS smoke reference exceeds file limit.');
    reference={base64:bytes.toString('base64'),name:path.split(/[\\/]/).at(-1)};
  }
  Object.assign(checks,await runOlsCatalogueSmoke(contents,reference));
  await contents.executeJavaScript('window.scrollTo(0,0);new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await writeFile(smokeOutput.replace(/\.json$/i,'')+'-identified-maps.png',(await contents.capturePage()).toPNG());
  if(renderErrors.length)throw new Error('Renderer reported an error: '+renderErrors.join('; '));
  const {runPressureSmoke}=await import('./pressure-smoke.mjs');
  Object.assign(checks,await runPressureSmoke(contents,sensors));
  await writeFile(smokeOutput.replace(/\.json$/i,'')+'-pressure.png',(await contents.capturePage()).toPNG());
  if(renderErrors.length)throw new Error('Renderer reported an error: '+renderErrors.join('; '));
  const {runDiagnosticsSmoke}=await import('./diagnostics-smoke.mjs');
  Object.assign(checks,await runDiagnosticsSmoke(contents,sensors));
  await contents.executeJavaScript('window.workshopDesktop.setServiceActive(true)');
  window.close();
  if(window.isDestroyed())throw new Error('Closing the app abandoned the renderer service guard.');
  await contents.executeJavaScript(`(async()=>{
    const end=Date.now()+5000;
    while(!document.querySelector('#diagnostic-message').textContent.includes('Bluetooth service action')&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,20));
    if(!document.querySelector('#diagnostic-message').textContent.includes('Bluetooth service action'))throw new Error('The service close guard did not explain how to stop.');
    await window.workshopDesktop.setServiceActive(false);
  })()`);
  checks.bluetoothServiceCloseGuard=true;
  await contents.executeJavaScript('window.scrollTo(0,0);new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await writeFile(smokeOutput.replace(/\.json$/i,'')+'-diagnostics.png',(await contents.capturePage()).toPNG());
  if(renderErrors.length)throw new Error('Renderer reported an error: '+renderErrors.join('; '));
  const report={ok:true,version:app.getVersion(),packaged:app.isPackaged,executable:process.execPath,runtime:{electron:process.versions.electron,node:process.versions.node,chrome:process.versions.chrome},renderer:checks,usbNativeDriver:native.available,privateApi:true,accountStoreEncrypted:process.platform==='win32',vehicleConnected:false,accountConnected:false,renderErrors};
  const prefs=contents.getLastWebPreferences();report.isolation={sandbox:prefs.sandbox,contextIsolation:prefs.contextIsolation,nodeIntegration:prefs.nodeIntegration};
  const endpoint=origin;
  await shutdown();
  let closed=false;try{await fetch(endpoint+'/');}catch{closed=true;}
  report.localServiceClosed=closed;if(!closed)throw new Error('Desktop local service did not close.');
  await writeFile(smokeOutput,JSON.stringify(report,null,2));
  quitting=true;app.exit(0);
}
app.on('before-quit',event=>{if(!quitting&&window){event.preventDefault();window.close();}});
app.on('window-all-closed',()=>{void shutdown().finally(()=>{quitting=true;app.quit();});});
app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.show();window.focus();}});
if(!app.requestSingleInstanceLock()){app.exit(0);}else{
  main().catch(async error=>{
    if(smokeOutput){await mkdir(dirname(smokeOutput),{recursive:true});await writeFile(smokeOutput,JSON.stringify({ok:false,error:error.message,stack:error.stack},null,2));}
    else dialog.showErrorBox('Tune Workshop could not start','The desktop app could not initialise. Restart the app. If the problem persists, keep your saved projects and reinstall the application.');
    await shutdown();quitting=true;app.exit(1);
  });
}
