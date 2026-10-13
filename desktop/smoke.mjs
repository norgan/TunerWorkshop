export async function runRendererSmoke(contents){
  return contents.executeJavaScript(`(async()=>{
    const assert=(value,message)=>{if(!value)throw new Error(message);};
    const {CalibrationProject}=await import('./core.mjs');
    const {parseHexBytes}=await import('./formats.mjs');
    assert(document.title==='Tuner Workshop','Wrong desktop title');
    assert(document.querySelectorAll('[data-cell]').length===48,'Editor module did not render');
    const input=new TextEncoder().encode('GEN_FILE\\0V862MH97\\0MM8GMKHW670\\0');
    const p=new CalibrationProject(input,{name:'Synthetic container test'});
    p.addMap({id:'test',address:12,rows:1,cols:2,type:'uint8'});
    p.editBytes(0,parseHexBytes('44 46'),'Test byte editing');
    assert(p.diff().length===2,'Container header changes missing');
    p.undo();assert(p.changedByteCount===0,'Byte undo failed');p.redo();
    const reopened=await CalibrationProject.fromJSON(await p.serialize());
    assert(reopened.bytes[0]===0x44&&reopened.original[0]===0x47,'Original/reopen integrity failed');
    document.querySelector('[data-view="hex"]').click();
    document.querySelector('#hex-edit-offset').value='0x0';
    document.querySelector('#hex-edit-values').value='A5 5A';
    document.querySelector('#hex-edit-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
    assert(document.querySelector('#changed-count').textContent==='2 bytes changed','Byte edit control failed');
    document.querySelector('#undo').click();
    assert(document.querySelector('#changed-count').textContent==='0 bytes changed','Undo control failed');
    assert(window.workshopDesktop,'Desktop save bridge unavailable');
    document.querySelector('#redo').click();
    const save=document.querySelector('#save-project');
    const waitForSave=async()=>{const end=Date.now()+10000;while(save.disabled&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,25));assert(!save.disabled,'Save did not finish');};
    save.click();await waitForSave();
    assert(save.textContent.includes('•'),'Cancelling save discarded unsaved state');
    save.click();await waitForSave();
    assert(!save.textContent.includes('•'),'Completed save did not clear unsaved state');
    document.querySelector('#undo').click();
    document.querySelector('#live-nav').click();
    assert(!document.querySelector('#live-workspace').hidden,'Live workspace unavailable');
    document.querySelector('#adapter-transport').value='wifi';
    document.querySelector('#adapter-transport').dispatchEvent(new Event('change',{bubbles:true}));
    assert(!document.querySelector('#wifi-host-field').hidden,'Wi-Fi fields unavailable');
    const status=await fetch('/api/status',{headers:{'X-Tune-Workshop':'1'}}).then(r=>r.json());
    assert(status.sensors.status==='disconnected','Unexpected vehicle session');
    document.querySelector('#tuning-nav').click();document.querySelector('[data-view="table"]').click();
    document.querySelector('#assistant-toggle').click();
    const deadline=Date.now()+5000;while(document.querySelector('#assistant-status').textContent==='Checking connection…'&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
    assert(document.querySelector('#assistant-send').disabled,'Disconnected assistant send should be disabled');
    assert(!document.querySelector('#tuning-workspace').hidden&&!document.querySelector('#assistant-panel').hidden,'Desktop navigation failed');
    const originalFetch=window.fetch;
    const testAccount={connected:true,configured:true,sharing:true,signingIn:true,message:'Finish signing in with ChatGPT in the browser.',models:[]};
    let testFailure=true,testStatusRequests=0;
    const waitForAssistant=async predicate=>{const end=Date.now()+5000;while(!predicate()&&Date.now()<end)await new Promise(r=>setTimeout(r,20));assert(predicate(),'Assistant UI did not update');};
    window.fetch=async(url,options)=>{
      if(url==='/api/assistant/status'){testStatusRequests++;await new Promise(r=>setTimeout(r,100));return new Response(JSON.stringify(testAccount),{headers:{'Content-Type':'application/json'}});}
      if(url==='/api/assistant/message'){
        assert(JSON.parse(options.body).context===undefined,'Default chat unexpectedly shared app context');
        return new Response(JSON.stringify(testFailure?{error:'ChatGPT plan usage is temporarily unavailable. Try again later.'}:{text:'Synthetic assistant reply.'}),{status:testFailure?503:200,headers:{'Content-Type':'application/json'}});
      }
      return originalFetch(url,options);
    };
    try{
      document.querySelector('#assistant-login-link').href='https://auth.openai.com/test';document.querySelector('#assistant-login-link').hidden=false;
      document.querySelector('#assistant-refresh').click();document.querySelector('#assistant-refresh').click();
      await waitForAssistant(()=>document.querySelector('#assistant-model').textContent.includes('Waiting'));
      assert(testStatusRequests===1,'Repeated refresh requests were not shared');
      assert(!document.querySelector('#assistant-login-link').hidden,'Reconnect hid a pending sign-in link');
      assert(document.querySelector('#assistant-model').textContent.includes('Waiting'),'Pending model state is unclear');
      Object.assign(testAccount,{signingIn:false,message:'Connected. Using ChatGPT plan.',models:[{id:'synthetic-model',name:'Synthetic model'}]});
      document.querySelector('#assistant-refresh').click();await waitForAssistant(()=>!document.querySelector('#assistant-send').disabled);
      assert(document.querySelector('#assistant-login-link').hidden,'Completed sign-in retained a stale link');
      document.querySelector('#assistant-question').value='Hi';document.querySelector('#assistant-send').click();
      await waitForAssistant(()=>!!document.querySelector('.chat-message.error'));
      assert(document.querySelector('.chat-message.error').textContent.includes('temporarily unavailable'),'Assistant failure lost its useful message');
      assert(document.querySelector('#assistant-question').value==='Hi','Failed prompt was not restored');
      testFailure=false;document.querySelector('#assistant-send').click();
      await waitForAssistant(()=>document.querySelector('#assistant-messages').textContent.includes('Synthetic assistant reply.'));
      assert(document.querySelector('#assistant-status').textContent==='Connected. Using ChatGPT plan.','Successful retry retained an old connection error');
      document.querySelector('#assistant-clear').click();
    }finally{window.fetch=originalFetch;}
    document.querySelector('#assistant-refresh').click();await waitForAssistant(()=>document.querySelector('#assistant-send').disabled);
    document.querySelector('#assistant-close').click();document.querySelector('#connection-setup').click();
    const transport=document.querySelector('#adapter-transport');transport.value='bluetooth';transport.dispatchEvent(new Event('change',{bubbles:true}));
    assert(document.querySelector('#serial-port-label').textContent==='Paired Bluetooth COM port','Classic Bluetooth controls missing');
    transport.value='ble';transport.dispatchEvent(new Event('change',{bubbles:true}));
    assert(navigator.bluetooth?.requestDevice,'Windows BLE API unavailable');
    assert(document.querySelector('#usb-port-field').hidden&&!document.querySelector('#ble-profile-field').hidden,'BLE controls missing');
    const savedBluetooth=Object.getOwnPropertyDescriptor(navigator,'bluetooth'),sent=[];
    const service='0000ffe0-0000-1000-8000-00805f9b34fb',uart=new EventTarget(),device=new EventTarget();
    Object.assign(uart,{uuid:'0000ffe1-0000-1000-8000-00805f9b34fb',properties:{write:true,notify:true},startNotifications:async()=>uart,writeValueWithResponse:async bytes=>{
      const cmd=new TextDecoder().decode(bytes).trim();sent.push(cmd);
      const text=cmd==='ATZ'?'ELM327 v2.3\\r>':cmd==='ATDPN'?'A6\\r>':cmd.startsWith('AT')?'OK\\r>':cmd==='0100'?'7E8 06 41 00 00 10 00 00\\r>':'7E8 04 41 0C 1A F8\\r>';
      queueMicrotask(()=>{uart.value=new DataView(new TextEncoder().encode(text).buffer);uart.dispatchEvent(new Event('characteristicvaluechanged'));});
    }});
    device.name='Synthetic BLE ELM';device.gatt={connected:false,async connect(){this.connected=true;return this;},disconnect(){this.connected=false;device.dispatchEvent(new Event('gattserverdisconnected'));},async getPrimaryService(id){if(id!==service)throw new DOMException('Not found','NotFoundError');return {getCharacteristics:async()=>[uart]};}};
    Object.defineProperty(navigator,'bluetooth',{configurable:true,value:{requestDevice:async()=>device}});
    const until=async predicate=>{const end=Date.now()+5000;while(!predicate()&&Date.now()<end)await new Promise(r=>setTimeout(r,25));assert(predicate(),'BLE UI operation timed out');};
    try{
      document.querySelector('#connect-sensors').click();await until(()=>document.querySelector('#sensor-rpm .sensor-value').textContent==='1726');
      assert(document.querySelector('#vehicle-connection').textContent.includes('BLE'),'BLE connection was mislabelled');
      document.querySelector('#record-start').click();await until(()=>!document.querySelector('#record-count').textContent.startsWith('0 '));document.querySelector('#record-stop').click();
      document.querySelector('#disconnect-sensors').click();await until(()=>document.querySelector('#live-status').textContent==='Disconnected');
      const count=sent.length;await new Promise(r=>setTimeout(r,150));assert(sent.length===count&&!device.gatt.connected,'BLE disconnect failed');
    }finally{if(savedBluetooth)Object.defineProperty(navigator,'bluetooth',savedBluetooth);else delete navigator.bluetooth;}
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    return {editor:true,containerMapEditing:true,hexEditing:true,undoRedo:true,originalPreserved:true,workspaceRoundtrip:true,nativeSave:true,cancelledSavePreservesChanges:true,liveControls:true,apiFromRenderer:true,bleApiAvailable:true,bluetoothClassicControls:true,simulatedBleReadings:true,simulatedBleRecording:true,simulatedBleDisconnect:true,assistantSignInStates:true,assistantErrorAndRetry:true};
  })()`);
}
