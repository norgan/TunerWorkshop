/** Isolated renderer checks. The supplied session is only an SSE event emitter;
 * the connection request is intercepted before it can access any adapter. */
export async function runLiveProfileSmoke(contents, session) {
  const check = script => contents.executeJavaScript(`(async()=>{const $=s=>document.querySelector(s),assert=(value,message)=>{if(!value)throw new Error(message);},until=async predicate=>{const end=Date.now()+5000;while(!predicate()&&Date.now()<end)await new Promise(r=>setTimeout(r,20));assert(predicate(),'Live profile UI did not update');};${script}})()`);
  const fixture = { status:'streaming',transport:'wifi',profileId:'fiat-8gmk',sessionId:'synthetic-profile-session',ecu:'18DAF110',selectedSensors:['mes-10500','mes-10155','mes-10246'],supportedSensors:['mes-10500','mes-10155','mes-10246'],values:{},sampleTimes:{},quality:{},channels:[{key:'mes-10500',staleAfterMs:30000},{key:'mes-10155',staleAfterMs:30000},{key:'mes-10246',staleAfterMs:30000}],identity:{source:'live-manufacturer',ecuIsoCode:'00 01 50 A8 15',hardwareNumber:'MM8GMKHW670',softwareNumber:'SYNTHETIC',vin:'SHOULD-NOT-BE-SHARED'},error:null };
  const sample = (values, quality={}, extra={}) => session.emit('sample',{timestamp:new Date().toISOString(),profileId:fixture.profileId,sessionId:fixture.sessionId,ecu:fixture.ecu,values,quality,...extra});
  session.emit('status',{...session.snapshot(),status:'disconnected',profileId:'generic-obd'});
  try {
    await check(`
      await until(()=>!$('#diagnostic-profile').disabled);
      $('#live-nav').click();
      if($('#settings-dialog').open)$('#settings-dialog').close();
      if(!$('#assistant-panel').hidden)$('#assistant-close').click();
      window.__liveProfileSmoke={fetch:window.fetch,confirm:window.confirm,createObjectURL:URL.createObjectURL,requests:[],fixture:${JSON.stringify(fixture)}};
      const test=window.__liveProfileSmoke;
      window.confirm=()=>true;
      window.fetch=async(url,options)=>{
        if(url==='/api/sensors/connect'){test.requests.push(JSON.parse(options.body));return new Response(JSON.stringify(test.fixture),{headers:{'Content-Type':'application/json'}});}
        if(url==='/api/sensors/disconnect')return new Response(JSON.stringify({...test.fixture,status:'disconnected'}),{headers:{'Content-Type':'application/json'}});
        return test.fetch(url,options);
      };
      URL.createObjectURL=function(blob){test.lastBlob=blob;return test.createObjectURL.call(URL,blob);};
      $('#diagnostic-profile').value='generic-obd';$('#diagnostic-profile').dispatchEvent(new Event('change'));
      $('[data-sensor-preset="default"]').click();
      assert($('#sensor-cards').children.length===6,'Generic six-sensor default changed');
      assert($('#diagnostic-profile').options.length===27,'Diagnostic profile options missing');
      $('#diagnostic-profile').value='fiat-8gmk';$('#diagnostic-profile').dispatchEvent(new Event('change'));
      assert(document.querySelectorAll('#sensor-selection-list input').length===105,'Full Fiat catalog is not selectable');
      assert($('#sensor-cards').children.length===8,'Fiat suggested selection not applied');
      assert($('#profile-description').textContent.includes('pending'),'Manufacturer verification state was hidden');
      $('#sensor-selection-details').open=true;
      $('#sensor-search').value='clutch';$('#sensor-search').dispatchEvent(new Event('input'));
      assert(document.querySelectorAll('#sensor-selection-list input').length>1&&document.querySelectorAll('#sensor-selection-list input').length<105,'Parameter search does not filter');
      $('#sensor-search').value='';$('#sensor-search').dispatchEvent(new Event('input'));
      $('[data-sensor-preset="clear"]').click();
      assert($('#connect-sensors').disabled,'Empty selection allowed a connection');
      const first33=[...document.querySelectorAll('#sensor-selection-list input')].slice(0,33).map(input=>input.value);
      for(const key of first33)document.querySelector('#sensor-selection-list input[value="'+key+'"]').click();
      assert(document.querySelectorAll('#sensor-selection-list input:checked').length===32,'Selection exceeded 32 parameters');
      assert(!document.querySelector('#sensor-selection-list input[value="'+first33[32]+'"]').checked,'The 33rd parameter was retained');
      assert($('#live-error').textContent.includes('at most 32'),'Selection limit did not explain how to continue');
      $('[data-sensor-preset="clear"]').click();
      document.querySelector('#sensor-selection-list input[value="mes-10246"]').click();
      assert($('#live-chart').hidden&&$('#live-channel').options.length===0,'Text-only parameters were offered as numeric graphs');
      for(const key of ['mes-10500','mes-10155'])document.querySelector('#sensor-selection-list input[value="'+key+'"]').click();
      assert($('#sensor-cards').children.length===3&&$('#live-channel').options.length===2,'Numeric and text parameter cards were not separated');
      assert(test.requests.length===0,'Changing selections opened an adapter');
      $('#adapter-transport').value='wifi';$('#adapter-transport').dispatchEvent(new Event('change'));
      $('#wifi-host').value='192.168.0.10';$('#wifi-host').dispatchEvent(new Event('input'));
      $('#connect-sensors').click();await until(()=>$('#diagnostic-profile').disabled&&test.requests.length===1);
      await until(()=>!$('#record-start').disabled);
      assert(test.requests[0].profileId==='fiat-8gmk'&&test.requests[0].channels.length===3&&test.requests[0].channels.every(key=>test.fixture.selectedSensors.includes(key)),'Connect did not carry exactly the selected profile channels');
      assert([...document.querySelectorAll('#sensor-selection-list input')].every(input=>input.disabled),'Selection changed during a live session');
      assert($('#sensor-strip').hidden,'Generic sensor strip represented manufacturer readings');
      assert(!$('#assistant-include-context').checked,'Live connection opted the user into assistant sharing');
      $('#record-start').click();
    `);
    sample({'mes-10500':900,'mes-10155':110.5,'mes-10246':'Pressed',rpm:9999},{'mes-10500':'valid','mes-10155':'valid','mes-10246':'valid'},{timestamp:new Date(Date.now()-20000).toISOString()});
    await check(`
      await until(()=>$('#sensor-mes-10246 .sensor-value').textContent==='Pressed');
      assert($('#sensor-mes-10500 .sensor-value').textContent==='900','Numeric manufacturer reading was lost');
      assert($('#sensor-mes-10246 .sensor-state').textContent==='Live reading','Text status was incorrectly stale');
      assert($('#record-count').textContent.startsWith('1 '),'Selected typed sample was not recorded');
      assert(!$('#sensor-rpm'),'Unselected generic parameter created a card');
    `);
    sample({'mes-10500':2222},{},{profileId:'generic-obd'});
    sample({'mes-10500':3333},{},{sessionId:'previous-session'});
    sample({'mes-10500':4444},{},{ecu:'18DAF111'});
    sample({'mes-10500':5555},{},{timestamp:new Date(Date.now()-30000).toISOString()});
    sample({'mes-10500':'wrong-type','mes-10246':12});
    await check(`
      await new Promise(resolve=>setTimeout(resolve,100));
      assert($('#sensor-mes-10500 .sensor-value').textContent==='900'&&$('#sensor-mes-10246 .sensor-value').textContent==='Pressed','A different source or invalid value changed the live readings');
      assert($('#record-count').textContent.startsWith('1 '),'Rejected source or type entered the recording');
    `);
    sample({'mes-10155':null},{'mes-10155':'decode-error'});
    await check(`
      await until(()=>$('#sensor-mes-10155 .sensor-state').textContent==='Could not decode this reply');
      assert($('#sensor-mes-10155 .sensor-value').textContent==='—','Decode failure displayed a usable number');
      $('#record-stop').click();$('#live-assistant').click();
      $('#assistant-include-context').checked=true;$('#assistant-include-context').dispatchEvent(new Event('change'));
      const context=JSON.parse($('#assistant-context-preview').textContent).sensors;
      assert(context.source==='live-manufacturer'&&context.profileId==='fiat-8gmk'&&context.ecu==='18DAF110','Assistant context lost source attribution');
      assert(context.values.length===3&&context.values.some(value=>value.value==='Pressed')&&context.values.some(value=>value.quality==='decode-error'&&value.value===null&&value.stale),'Assistant context lost typed status or quality');
      assert(context.identity.hardwareNumber==='MM8GMKHW670'&&!('vin' in context.identity),'Assistant identity was missing or included an extra field');
      $('#assistant-include-context').checked=false;$('#assistant-include-context').dispatchEvent(new Event('change'));$('#assistant-close').click();
      $('#disconnect-sensors').click();await until(()=>!$('#diagnostic-profile').disabled);
      $('#diagnostic-profile').value='generic-obd';$('#diagnostic-profile').dispatchEvent(new Event('change'));$('[data-sensor-preset="default"]').click();
      assert([...document.querySelectorAll('.sensor-value')].every(value=>value.textContent==='—'),'Switching profiles retained another profile’s values');
      $('#record-export').click();await until(()=>!$('#record-export').disabled);
      const recorded=JSON.parse(await window.__liveProfileSmoke.lastBlob.text());
      assert(recorded.profileId==='fiat-8gmk'&&recorded.source==='live-manufacturer'&&recorded.selectedSensors.length===3,'Switching profiles relabelled the completed recording');
      assert(recorded.samples.length===2&&recorded.samples[0].values['mes-10246']==='Pressed'&&!('rpm' in recorded.samples[0].values),'Recording lost status text or included unselected data');
      assert(recorded.samples[1].quality['mes-10155']==='decode-error'&&recorded.samples[1].values['mes-10155']===null,'Recording discarded an unavailable result');
    `);
    return {manufacturerCatalogPicker:true,selectedParameterLimit:true,numericAndTextCards:true,profileSelectionLocked:true,selectedConnectRequest:true,typedManufacturerRecording:true,manufacturerContextProvenance:true,perChannelStaleness:true,liveSourceIsolation:true,recordingProfilePreserved:true};
  } finally {
    await check(`
      const test=window.__liveProfileSmoke;
      if(test){window.fetch=test.fetch;window.confirm=test.confirm;URL.createObjectURL=test.createObjectURL;delete window.__liveProfileSmoke;}
      $('#assistant-include-context').checked=false;$('#assistant-include-context').dispatchEvent(new Event('change'));
      if(!$('#assistant-panel').hidden)$('#assistant-close').click();
      $('#sensor-selection-details').open=false;
    `);
    session.emit('status',{...session.snapshot(),status:'disconnected',profileId:'generic-obd'});
  }
}
