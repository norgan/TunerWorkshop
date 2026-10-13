export async function runPressureSmoke(contents,session){
  await contents.executeJavaScript(`(async()=>{
    const $=s=>document.querySelector(s),assert=(x,m)=>{if(!x)throw new Error('Pressure smoke: '+m);};
    const until=async f=>{for(let i=0;i<400;i++){if(f())return;await new Promise(r=>setTimeout(r,25));}throw new Error('Pressure smoke timeout');};
    const {saveSettings,getSettings}=await import('./settings-client.mjs');
    const {CalibrationProject}=await import('./core.mjs');
    const {getSelectedTuningContext}=await import('./app.mjs');
    const {pressureToDisplay}=await import('./pressure-units.mjs');
    for(const d of document.querySelectorAll('dialog[open]'))d.close();
    const confirm=window.confirm;window.confirm=()=>true;
    try{
      await saveSettings({pressureUnit:'bar'});
      const fixture=new CalibrationProject(Uint8Array.from([3,232,7,208,5,220,9,196]),{name:'Synthetic pressure conversion check',synthetic:true,maps:[{id:'pressure-test',name:'Synthetic pressure',address:0,rows:2,cols:2,type:'uint16',endian:'big',factor:1,unit:'mbar',category:'boost'}]});
      const input=$('#file-input'),click=input.click;input.click=()=>{};try{$('#open-project').click();}finally{input.click=click;}
      const dt=new DataTransfer();dt.items.add(new File([JSON.stringify(await fixture.serialize())],'pressure.tuneworkshop.json'));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));
      await until(()=>$('#map-name').textContent==='Synthetic pressure');$('#tuning-nav').click();$('[data-view="table"]').click();
      assert($('[data-cell="0"]').textContent==='1','mbar did not display as bar');
      $('#pressure-unit').value='psi';$('#pressure-unit').dispatchEvent(new Event('change'));
      await until(()=>getSettings().pressureUnit==='psi'&&!$('#pressure-unit').disabled);
      assert(Math.abs(Number($('[data-cell="0"]').textContent)-14.50377377)<1e-5,'psi cell display wrong');
      assert(getSelectedTuningContext().map.unit==='psi'&&getSelectedTuningContext().map.encoding.sourceUnit==='mbar','context units unclear');
      assert(getSelectedTuningContext().project.changedBytes===0,'unit toggle changed bytes');
      assert(!$('#save-project').textContent.includes('•'),'unit toggle dirtied project');
      $('[data-cell="0"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
      const edit=$('[data-cell="0"] input');edit.value=String(pressureToDisplay(1500,'mbar','psi'));edit.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
      assert(Math.abs(getSelectedTuningContext().map.cells[0].modified-pressureToDisplay(1500,'mbar','psi'))<1e-10,'psi edit encoded incorrectly');$('#undo').click();
      assert(getSelectedTuningContext().project.changedBytes===0,'pressure undo failed');
      $('#edit-operation').value='add';$('#edit-value').value=String(pressureToDisplay(100,'mbar','psi'));$('#edit-value').dispatchEvent(new Event('input'));
      assert($('#edit-preview').textContent.includes('psi'),'edit preview unit missing');$('#apply-edit').click();
      assert(Math.abs(getSelectedTuningContext().map.cells[0].modified-pressureToDisplay(1100,'mbar','psi'))<1e-10,'psi add wrong');$('#undo').click();
      for(const view of ['curve','surface']){$('[data-view="'+view+'"]').click();assert(!$('#plot-view').hidden,'pressure plot hidden');}
      await (await import('./settings-ui.mjs')).openSettings();assert($('#settings-pressureUnit').value==='psi','settings selector out of sync');$('#settings-cancel').click();
      assert((await window.workshopDesktop.readSettings()).pressureUnit==='psi','native preference not persisted');
    }finally{window.confirm=confirm;}
    $('#live-nav').click();
  })()`);
  const now=new Date().toISOString();
  session.emit('status',{...session.snapshot(),status:'streaming',transport:'serial',profileId:'generic-obd',sessionId:'synthetic-pressure-session',ecu:'7E8',selectedSensors:['mapPressure'],supportedSensors:['mapPressure'],values:{mapPressure:100},sampleTimes:{mapPressure:now},quality:{},channels:[{key:'mapPressure',staleAfterMs:30000}]});
  try{
    await contents.executeJavaScript(`(async()=>{
      const $=s=>document.querySelector(s);for(let i=0;i<200&&$('#sensor-mapPressure .sensor-value')?.textContent!=='14.50';i++)await new Promise(r=>setTimeout(r,25));
      if($('#sensor-mapPressure .sensor-value')?.textContent!=='14.50'||$('#sensor-mapPressure .sensor-unit')?.textContent!=='psi absolute')throw new Error('Pressure sensor conversion failed');
      if(!$('[data-strip="mapPressure"]').parentElement.textContent.includes('psi absolute'))throw new Error('Pressure strip unit failed');
      await (await import('./settings-client.mjs')).saveSettings({pressureUnit:'bar'});
      if($('#sensor-mapPressure .sensor-value').textContent!=='1.000')throw new Error('Pressure did not return to bar');
    })()`);
  }finally{session.emit('status',{...session.snapshot(),status:'disconnected',profileId:'generic-obd'});}
  return {pressureDisplayAndEdits:true,pressureUnitsPreserveBytes:true,pressureNativePreference:true,pressureLiveConversion:true};
}
