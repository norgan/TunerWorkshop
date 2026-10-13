/** Renderer-only diagnostics checks; all operation requests are intercepted.
 * The supplied session emits synthetic events and never opens an adapter. */
export async function runDiagnosticsSmoke(contents, session) {
  const check=script=>contents.executeJavaScript(`(async()=>{const $=s=>document.querySelector(s),assert=(v,m)=>{if(!v)throw new Error(m);},until=async p=>{const end=Date.now()+5000;while(!p()&&Date.now()<end)await new Promise(r=>setTimeout(r,20));assert(p(),'Diagnostics UI did not update');};${script}})()`);
  const engine={status:'streaming',transport:'serial',profileId:'fiat-8gmk',sessionId:'synthetic-diagnostics',ecu:'18DAF110',selectedSensors:['mes-10500'],supportedSensors:['mes-10500'],channels:[{key:'mes-10500',staleAfterMs:15000}],values:{},sampleTimes:{},quality:{},error:null};
  const instrument={...engine,profileId:'fiat-service',sessionId:'synthetic-instrument',ecu:'18DAF160',selectedSensors:['service-coupons','service-rpm'],supportedSensors:['service-coupons','service-rpm'],channels:[{key:'service-coupons'},{key:'service-rpm'}]};
  const event=fixture=>session.emit('status',fixture);
  event({...session.snapshot(),status:'disconnected'});
  try {
    await check(`
      await until(()=>!$('#diagnostic-profile').disabled);
      if($('#settings-dialog').open)$('#settings-dialog').close();
      if(!$('#assistant-panel').hidden)$('#assistant-close').click();
      $('#diagnostics-nav').click();
      assert($('#diagnostic-read-faults').disabled&&$('#service-run').disabled,'Disconnected diagnostics can run');
      window.__diagnosticsSmoke={fetch:window.fetch,createObjectURL:URL.createObjectURL,requests:[],pending:null};
      const test=window.__diagnosticsSmoke;
      URL.createObjectURL=function(blob){test.lastBlob=blob;return test.createObjectURL.call(URL,blob);};
      window.fetch=async(url,options)=>{
        if(url==='/api/sensors/connect')throw new Error('No adapter may be opened by diagnostics smoke');
        if(url==='/api/diagnostics/stop'){test.stopped=JSON.parse(options.body);test.pending?.();return Response.json({stopping:true});}
        if(url!=='/api/diagnostics/run')return test.fetch(url,options);
        const input=JSON.parse(options.body);test.requests.push(input);
        const meta={profileId:input.sessionId==='synthetic-instrument'?'fiat-service':'fiat-8gmk',ecu:input.sessionId==='synthetic-instrument'?'18DAF160':'18DAF110',sessionId:input.sessionId,capturedAt:new Date().toISOString()};
        if(input.action==='read-faults')return Response.json({...meta,kind:'faults',groups:[{name:'Engine faults',status:'positive',faults:[{id:'013312',code:'P0133-12',description:'Synthetic fault for UI verification',active:true,stored:true}]}]});
        if(input.action==='read-identification')return Response.json({...meta,kind:'identity',fields:[{label:'Hardware number',value:'SYNTHETIC'},{label:'VIN',value:'TEST1234567890123'}]});
        if(input.action==='read-freeze-frame')return Response.json({...meta,kind:'snapshot',code:'P0133-12',complete:false,fields:[{label:'Engine speed',value:800,unit:'rpm'},{label:'Internal value',value:1,hidden:true}]});
        if(input.action==='clear-faults')return Response.json({...meta,kind:'cleared',acknowledged:true});
        if(input.toolId==='fan-low'){await new Promise(resolve=>{test.pending=resolve;});return Response.json({...meta,kind:'service',success:false,message:'Test cancelled; control returned to ECU.',result:{status:'cancelled'}});}
        if(input.toolId==='service-interval-reset')return Response.json({...meta,kind:'service',success:true,message:'Service reminder values changed.',result:{status:'verified',before:{'service-coupons':4,'service-days-remaining':2},after:{'service-coupons':3,'service-days-remaining':365}}});
        return Response.json({...meta,kind:'service',success:true,message:'Both oil-change resets acknowledged.',instructions:'Switch the ignition off and wait at least 60 seconds before starting the engine or reconnecting.',result:{status:'completed'}});
      };
    `);
    event(engine);
    await check(`
      await until(()=>!$('#diagnostic-read-faults').disabled);
      assert($('#diagnostic-clear-faults').disabled,'Fault clearing offered before a current report');
      assert($('#service-tool').options.length===34,'Engine service catalog is incomplete');
      assert($('#service-tool').value==='oil-change','Default service procedure is not the oil-change reset');
      $('#diagnostic-read-faults').click();await until(()=>$('#diagnostic-faults').textContent.includes('Synthetic fault')&&!$('#diagnostic-identify').disabled);
      assert(!$('#diagnostic-clear-faults').disabled,'Current engine report did not enable clearing');
      $('#diagnostic-faults button').click();await until(()=>!$('#diagnostic-snapshot').hidden&&!$('#diagnostic-identify').disabled);
      assert($('#diagnostic-snapshot-fields').textContent.includes('800 rpm')&&!$('#diagnostic-snapshot-fields').textContent.includes('Internal'),'Freeze-frame field visibility failed');
      assert($('#diagnostic-snapshot-note').textContent.includes('could not'),'Partial snapshot was presented as complete');
      assert(window.__diagnosticsSmoke.requests.at(-1).dtcId==='013312','Snapshot lost its fault binding');
      $('#diagnostic-identify').click();await until(()=>$('#diagnostic-identity').textContent.includes('TEST123')&&!$('#diagnostic-identify').disabled);
      $('#diagnostic-clear-faults').click();assert($('#diagnostic-confirm').open,'Clear had no confirmation');
      $('#diagnostic-confirm-no').click();
      assert(!window.__diagnosticsSmoke.requests.some(r=>r.action==='clear-faults'),'Cancel sent a clear command');
      $('#diagnostic-clear-faults').click();$('#diagnostic-confirm-yes').click();await until(()=>$('#diagnostic-message').textContent.includes('acknowledged fault clearing'));
      assert(window.__diagnosticsSmoke.requests.at(-1).confirmation==='clear-faults','Clear confirmation was not passed');
      $('#service-run').click();assert($('#diagnostic-confirm-text').textContent.includes('Complete the engine oil change')&&$('#diagnostic-confirm-text').textContent.includes('60 seconds'),'Oil procedure requirements missing');
      $('#diagnostic-confirm-yes').click();await until(()=>$('#service-result').textContent.includes('60 seconds')&&!$('#service-run').disabled);
      const action=window.__diagnosticsSmoke.requests.at(-1);
      assert(action.toolId==='oil-change'&&action.acknowledged===true&&action.sessionId==='synthetic-diagnostics','Service review lost action binding');
      $('#service-tool').value='alternator-replacement';$('#service-tool').dispatchEvent(new Event('change'));
      assert($('#service-run').disabled&&$('#service-availability').textContent.includes('result'),'Unavailable procedure can run');
      $('#service-tool').value='fan-low';$('#service-tool').dispatchEvent(new Event('change'));
      $('#service-run').click();assert($('#diagnostic-confirm-text').textContent.includes('clear of the fan'),'Actuator-specific conditions missing');$('#diagnostic-confirm-yes').click();
      await until(()=>window.__diagnosticsSmoke.pending);
    `);
    event({...engine,diagnosticOperation:{action:'run-service',message:'Actuator active'}});
    await check(`
      await until(()=>!$('#service-stop').hidden);
      assert($('#diagnostic-read-faults').disabled&&$('#service-tool').disabled,'Concurrent UI actions remained enabled');
      $('#service-stop').click();await until(()=>$('#service-result').textContent.includes('control returned'));
      assert(window.__diagnosticsSmoke.stopped.sessionId==='synthetic-diagnostics','Stop used a different session');
    `);
    event(engine);
    await check(`
      await until(()=>!$('#service-run').disabled);
      $('#service-run').click();window.__diagnosticsSmoke.beforeChanged=window.__diagnosticsSmoke.requests.length;
    `);
    event({...engine,sessionId:'replacement-session'});
    await check(`
      await until(()=>$('#diagnostic-clear-faults').disabled);
      $('#diagnostic-confirm-yes').click();
      assert(window.__diagnosticsSmoke.requests.length===window.__diagnosticsSmoke.beforeChanged,'Old confirmation executed in a new session');
      assert($('#diagnostic-message').textContent.includes('connection changed'),'Changed-session instruction missing');
    `);
    event({...session.snapshot(),status:'disconnected',profileId:'generic-obd'});
    await check(`
      await until(()=>!$('#diagnostic-profile').disabled);
      $('#diagnostic-target').value='fiat-service';$('#diagnostic-setup').click();
      assert(!$('#live-workspace').hidden&&$('#diagnostic-profile').value==='fiat-service','Service reminder setup chose wrong profile');
      assert(document.querySelectorAll('#sensor-selection-list input').length===11,'Instrument service readings are missing');
    `);
    event(instrument);
    await check(`
      await until(()=>$('#diagnostic-connection').textContent.includes('18DAF160'));$('#diagnostics-nav').click();
      assert($('#service-tool').options.length===1&&$('#service-tool').value==='service-interval-reset','Dashboard reset mixed with engine procedures');
      assert($('#diagnostic-read-faults').disabled&&!$('#service-run').disabled,'Instrument action availability incorrect');
      assert($('#diagnostic-identity').textContent.includes('IAW 8GMK')&&$('#diagnostic-identity').textContent.includes('18DAF110'),'Retained engine identity lost its original controller label');
      $('#service-run').click();
      assert($('#diagnostic-confirm-text').textContent.includes('service is complete'),'Service-completed confirmation missing');
      $('#diagnostic-confirm-yes').click();await until(()=>$('#service-result').textContent.includes('4 → 3'));
      assert($('#service-result').textContent.includes('2 → 365'),'Service readback not displayed');
      $('#diagnostic-export').click();await until(()=>window.__diagnosticsSmoke.lastBlob);
      const report=JSON.parse(await window.__diagnosticsSmoke.lastBlob.text());
      assert(report.service.profileId==='fiat-service'&&report.service.result.status==='verified','Export lost service result or source');
      assert(report.faults.sessionId==='synthetic-diagnostics'&&report.identity.fields.some(f=>f.label==='VIN'),'Export relabelled earlier ECU results');
    `);
    return {diagnosticFaultsAndSnapshots:true,diagnosticIdentification:true,clearConfirmation:true,engineServiceCatalog:true,oilChangeAftercare:true,actuatorConditionsAndStop:true,changedSessionBlocksActions:true,instrumentServiceSetup:true,serviceReadback:true,diagnosticReportExport:true};
  } finally {
    await check(`
      const test=window.__diagnosticsSmoke;if(test){test.pending?.();window.fetch=test.fetch;URL.createObjectURL=test.createObjectURL;delete window.__diagnosticsSmoke;}
      if($('#diagnostic-confirm').open)$('#diagnostic-confirm').close();
    `);
    event({...session.snapshot(),status:'disconnected'});
  }
}
