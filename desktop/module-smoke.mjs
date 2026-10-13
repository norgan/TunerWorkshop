import {getFiatModuleProfile} from '../fiat-modules.mjs';

// Renderer verification uses synthetic events and intercepted requests only.
export async function runModuleSmoke(contents,session){
  const check=script=>contents.executeJavaScript(`(async()=>{const $=s=>document.querySelector(s),assert=(v,m)=>{if(!v)throw new Error(m);},until=async p=>{const end=Date.now()+5000;while(!p()&&Date.now()<end)await new Promise(r=>setTimeout(r,20));assert(p(),'Module UI did not update');};${script}})()`);
  const profile=getFiatModuleProfile('fiat-body');
  const fixture={status:'streaming',transport:'serial',profileId:profile.id,sessionId:'synthetic-body',ecu:profile.connection.responseId,selectedSensors:profile.defaultChannels,supportedSensors:profile.defaultChannels,channels:profile.channels.filter(c=>profile.defaultChannels.includes(c.key)),values:{},sampleTimes:{},quality:{},error:null};
  session.emit('status',{...session.snapshot(),status:'disconnected',profileId:'generic-obd'});
  try{
    await check(`
      await until(()=>!$('#diagnostic-profile').disabled);$('#diagnostics-nav').click();
      assert($('#diagnostic-target').options.length===27,'Expanded controller selector missing');
      const choose=id=>{$('#diagnostic-target').value=id;$('#diagnostic-target').dispatchEvent(new Event('change'));};
      choose('fiat-body');assert($('#service-tool').options.length===28&&$('#diagnostic-coverage').textContent.includes('28 actuator'),'Body actuator catalogue incomplete');
      assert($('#service-run').disabled,'Disconnected body actuator enabled');
      choose('fiat-climate-auto');assert($('#service-tool').options.length===11&&$('#diagnostic-coverage').textContent.includes('A5 blue'),'Climate controls or lead missing');
      choose('fiat-abs');assert($('#service-tool').options.length===21&&$('#diagnostic-coverage').textContent.includes('A6 grey'),'ABS lead or catalogue missing');
      const unavailable=[...$('#service-tool').options].find(o=>o.textContent.includes('Not yet available'));assert(unavailable,'Incomplete mechanical procedures hidden');
      $('#service-tool').value=unavailable.value;$('#service-tool').dispatchEvent(new Event('change'));assert($('#service-run').disabled&&$('#service-availability').textContent.length>20,'Unavailable actuator can run');
      choose('fiat-proxi');$('#diagnostic-setup').click();assert($('#profile-description').textContent.includes('not implemented')&&$('#connect-sensors').disabled,'PROXI presented as a sensor connection');
      $('#diagnostics-nav').click();choose('fiat-body');$('#diagnostic-setup').click();
      assert($('#diagnostic-profile').value==='fiat-body'&&document.querySelectorAll('#sensor-selection-list input').length===50,'Body sensor list missing');
      $('#sensor-search').value='door';$('#sensor-search').dispatchEvent(new Event('input'));assert(document.querySelectorAll('#sensor-selection-list input').length>0&&$('#sensor-selection-list').textContent.toLowerCase().includes('door'),'Module sensor search failed');
      $('#sensor-search').value='';$('#sensor-search').dispatchEvent(new Event('input'));
      window.__moduleSmoke={fetch:window.fetch,requests:[]};const test=window.__moduleSmoke;
      window.fetch=async(url,options)=>{
        if(url==='/api/sensors/connect')throw new Error('Module smoke must never open an adapter');
        if(url!=='/api/diagnostics/run')return test.fetch(url,options);
        const input=JSON.parse(options.body);test.requests.push(input);const common={profileId:'fiat-body',sessionId:input.sessionId,ecu:'18DAF140',capturedAt:new Date().toISOString()};
        if(input.action==='read-faults')return Response.json({...common,kind:'faults',groups:[{name:'Body faults',status:'positive',faults:[]}]});
        if(input.action==='clear-faults')return Response.json({...common,kind:'cleared',acknowledged:true});
        return Response.json({...common,kind:'service',success:true,message:'Synthetic body test acknowledged.',result:{status:'completed'}});
      };
    `);
    session.emit('status',fixture);
    await check(`
      await until(()=>$('#diagnostic-connection').textContent.includes('18DAF140'));$('#diagnostics-nav').click();
      assert(!$('#service-run').disabled,'Connected module actuator unavailable');
      $('#diagnostic-read-faults').click();await until(()=>!$('#diagnostic-clear-faults').disabled);
      $('#diagnostic-clear-faults').click();assert(!$('#diagnostic-conditions').hidden&&$('#diagnostic-confirm-yes').disabled,'Module condition review missing');
      $('#diagnostic-engine-stopped').click();assert($('#diagnostic-confirm-yes').disabled,'One condition bypassed stationary review');$('#diagnostic-stationary').click();$('#diagnostic-confirm-yes').click();
      await until(()=>$('#diagnostic-message').textContent.includes('acknowledged fault clearing'));
      const clear=window.__moduleSmoke.requests.at(-1);assert(clear.engineStoppedConfirmed&&clear.stationaryConfirmed&&clear.sessionId==='synthetic-body','Module conditions lost in request');
      $('#service-run').click();assert($('#diagnostic-confirm-yes').disabled&&!$('#diagnostic-engine-stopped').checked,'Previous confirmation silently reused');
      $('#diagnostic-confirm-no').click();const count=window.__moduleSmoke.requests.length;
      $('#diagnostic-target').value='fiat-climate-auto';$('#diagnostic-target').dispatchEvent(new Event('change'));
      assert($('#service-run').disabled&&$('#diagnostic-read-faults').disabled,'Different controller actions remained enabled');
      await new Promise(r=>setTimeout(r,1100));assert($('#diagnostic-target').value==='fiat-climate-auto','Status refresh undid catalogue browsing');
      $('#diagnostic-setup').click();assert($('#diagnostic-message').textContent.includes('Disconnect'),'Switch-controller setup did not explain disconnect');
      assert(window.__moduleSmoke.requests.length===count,'Browsing sent a vehicle operation');
      $('#diagnostic-target').value='fiat-body';$('#diagnostic-target').dispatchEvent(new Event('change'));
      $('#service-run').click();$('#diagnostic-engine-stopped').click();$('#diagnostic-stationary').click();$('#diagnostic-confirm-yes').click();
      await until(()=>$('#service-result').textContent.includes('Synthetic body test acknowledged'));
      assert(window.__moduleSmoke.requests.at(-1).toolId.startsWith('fiat-body-'),'Actuator lost module binding');
    `);
    return {expandedModuleCatalog:true,moduleLeadGuidance:true,moduleSensorSearch:true,unavailableProceduresExplained:true,moduleConditionsExplicit:true,moduleConfirmationNotReused:true,moduleBrowseDoesNotChangeConnection:true,moduleActuatorBinding:true};
  }finally{
    await check(`const test=window.__moduleSmoke;if(test){window.fetch=test.fetch;delete window.__moduleSmoke;}if($('#diagnostic-confirm').open)$('#diagnostic-confirm').close();`);
    session.emit('status',{...session.snapshot(),status:'disconnected',profileId:'generic-obd'});
  }
}
