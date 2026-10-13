/** Synthetic native/file-save renderer coverage. An optional caller-supplied
 * reference is opened only by the explicit desktop smoke harness. */
export async function runOlsCatalogueSmoke(contents, reference = null) {
  return contents.executeJavaScript(`(${olsCatalogueSmokeInRenderer.toString()})(${JSON.stringify(reference)})`);
}

async function olsCatalogueSmokeInRenderer(reference) {
  const $ = selector => document.querySelector(selector), all = selector => [...document.querySelectorAll(selector)];
  const assert = (condition,message) => { if (!condition) throw new Error('OLS catalogue smoke: '+message); };
  const until = async (predicate,message) => { const end=Date.now()+15000;while(!predicate()&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,25));assert(predicate(),message); };
  const {createOlsSmokeFixture} = await import('./desktop/ols-smoke-fixture.mjs');
  const {inspectWinolsProject} = await import('./winols-project.mjs');
  const {CalibrationProject} = await import('./core.mjs');
  const {getSelectedTuningContext} = await import('./app.mjs');
  const fixture=createOlsSmokeFixture(),inspection=inspectWinolsProject(fixture),fixtureName='Synthetic source catalogue.ols';
  assert(inspection.records.length===115,'fixture did not contain 115 recovered definitions');
  const boost=inspection.records.find(record=>record.symbol==='TBDPREUTHDYN'),fuel=inspection.records.find(record=>record.symbol==='PQLAMMP');
  const displayTitle=record=>record.displayName||record.name||record.symbol;
  const originalConfirm=window.confirm,originalCreateURL=URL.createObjectURL,originalFetch=window.fetch,downloads=[];
  let sentMessages=0;
  window.confirm=()=>true;
  URL.createObjectURL=function(blob){const url=originalCreateURL.call(URL,blob);downloads.push(blob);return url;};
  window.fetch=(url,options)=>{if(url==='/api/assistant/message'){sentMessages++;throw new Error('Smoke must never submit an assistant message');}return originalFetch(url,options);};
  const change=(selector,value)=>{$(selector).value=value;$(selector).dispatchEvent(new Event('change',{bubbles:true}));};
  const search=value=>{$('#map-search').value=value;$('#map-search').dispatchEvent(new Event('input',{bubbles:true}));};
  const inject = async (content,name,action,expectedName) => {
    // Distinct old state ensures the predicate proves completion of the async import.
    $('#project-name').textContent='Loading synthetic smoke input…';
    const input=$('#file-input'),click=input.click;input.click=()=>{};
    try{$(action==='binary'?'#load-binary':'#open-project').click();}finally{input.click=click;}
    const transfer=new DataTransfer();transfer.items.add(new File([content],name));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    await until(()=>$('#project-name').textContent===expectedName&&!$('#save-project').textContent.includes('•'),'file import did not finish');
  };
  const save = async () => {
    const before=downloads.length;$('#save-project').click();
    await until(()=>!$('#save-project').disabled&&downloads.length>before,'native project save did not complete');
    assert(!$('#save-project').textContent.includes('•'),'native project save was cancelled');
    return JSON.parse(await downloads.at(-1).text());
  };
  try {
    for(const dialog of all('dialog[open]'))dialog.close();
    if(!$('#assistant-panel').hidden)$('#assistant-close').click();
    $('#assistant-include-context').checked=false;$('#assistant-include-context').dispatchEvent(new Event('change'));
    $('#tuning-nav').click();
    await inject(fixture,fixtureName,'project',fixtureName);
    assert(!$('#catalogue-view').hidden&&$('#catalogue-tab').getAttribute('aria-selected')==='true','native OLS did not open its catalogue automatically');
    assert($('#map-name').textContent===displayTitle(boost)&&$('#catalogue-view').textContent.includes(boost.name),'initial useful boost table or original source name was not selected');
    assert($('#source-catalogue-heading').textContent.includes('115')&&all('[data-source-map]').length===60,'catalogue was missing or not paginated');
    assert(all('.source-map-group').length===4,'source definitions were not grouped by purpose');
    assert($('#ols-source-name').textContent===fixtureName&&$('#ols-source-vehicle').textContent.includes('match to this car has not been established'),'source project was presented as the connected Fiat');
    assert($('#table-view').hidden&&$('#plot-view').hidden&&$('[data-view="surface"]').disabled&&$('[data-view="curve"]').disabled,'undecoded data was offered as a graph');
    assert($('#catalogue-view').textContent.includes('Map values are not decoded yet')&&$('#catalogue-view').textContent.includes('Engine speed')&&$('#catalogue-view').textContent.includes('Engine load'),'source definition or unresolved-value state missing');
    assert($('#catalogue-view').textContent.includes('2 × 3')&&$('#catalogue-view').textContent.includes('0x100'),'shape and stored address were lost');
    $('[data-catalogue-page="1"]').click();
    assert(all('[data-source-map]').length===55&&$('#catalogue-page-status').textContent.includes('61–115'),'catalogue next page is wrong');
    $('[data-catalogue-page="-1"]').click();
    change('#map-filter','ignition');
    const duplicates=all('[data-source-map]');
    assert(duplicates.length===2&&duplicates[0].dataset.sourceMap!==duplicates[1].dataset.sourceMap,'duplicate symbols were merged into one record');
    const alternate=inspection.records.find(record=>record.id===duplicates[1].dataset.sourceMap);
    duplicates[1].click();assert($('#map-name').textContent===displayTitle(alternate)&&getSelectedTuningContext().sourceMetadata.name===alternate.name&&$('#catalogue-view').textContent.includes('Synthetic base spark advance alternate'),'second source record selected the first duplicate');
    change('#map-filter','all');search('PQLAMMP');
    assert(all('[data-source-map]').length===1,'symbol search did not find the lambda definition');
    $('[data-source-map]').click();
    assert($('#map-name').textContent===displayTitle(fuel)&&$('#catalogue-view').textContent.includes(fuel.name)&&$('#catalogue-view').textContent.includes('0.0009765625'),'source label or scaling was lost');
    search('');change('#catalogue-shape','scalar');
    assert(all('[data-source-map]').length===0&&$('#catalogue-page-status').textContent.includes('No source maps'),'constant filter retained tables');
    change('#catalogue-shape','table');assert(all('[data-source-map]').length===60,'table filter lost the fixture tables');
    change('#catalogue-shape','all');
    const beforeContext=getSelectedTuningContext();
    assert(beforeContext.map===null&&beforeContext.sourceMetadata.valuesAvailable===false&&beforeContext.sourceMetadata.addressSpace==='project-image-unresolved','source metadata was exposed as editable numeric cells');
    assert(!beforeContext.ecu.hardware&&!beforeContext.ecu.software&&!beforeContext.vehicle.includes('Fiat'),'source context inherited historical Fiat identifiers');
    $('#assistant-question').value='';$('#analyse-table').click();
    assert(!$('#assistant-panel').hidden&&!$('#assistant-include-context').checked,'source analysis silently enabled context sharing');
    assert($('#assistant-question').value.includes('numeric calibration values and axis breakpoints have not been decoded')&&$('#assistant-context-preview').textContent.includes('Context sharing is off'),'source analysis prompt misrepresented available values');
    $('#assistant-include-context').checked=true;$('#assistant-include-context').dispatchEvent(new Event('change'));
    const preview=JSON.parse($('#assistant-context-preview').textContent).tuning;
    assert(preview.map===null&&preview.sourceMetadata.symbol==='PQLAMMP'&&preview.sourceMetadata.axes.length===2&&!('cells' in preview.sourceMetadata),'source context contained fabricated cells or omitted axes');
    $('#assistant-question').value='Keep my existing draft';$('#analyse-table').click();
    assert($('#assistant-question').value==='Keep my existing draft'&&sentMessages===0,'source analysis replaced a draft or sent a message');
    $('#assistant-include-context').checked=false;$('#assistant-include-context').dispatchEvent(new Event('change'));$('#assistant-question').value='';$('#assistant-close').click();
    $('[data-view="hex"]').click();
    assert(!$('#hex-view').hidden&&$('#catalogue-view').hidden&&Number($('#hex-offset').value)===0,'stored image address was treated as native file offset');
    assert(!getSelectedTuningContext().sourceMetadata,'Hex retained selected source metadata in assistant context');
    $('#hex-offset').value='0x200';$('#hex-go').click();
    $('#catalogue-tab').click();change('#map-filter','ignition');$('[data-source-map]').click();$('[data-view="hex"]').click();
    assert(Number($('#hex-offset').value)===0x200,'selecting a source definition navigated Hex to its unmapped address');
    $('#hex-edit-offset').value='0x10';$('#hex-edit-values').value='56';$('#hex-edit-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
    assert(getSelectedTuningContext().project.changedBytes===1,'native byte edit was unavailable');
    $('#undo').click();assert(getSelectedTuningContext().project.changedBytes===0,'native byte undo failed');$('#redo').click();
    $('#catalogue-tab').click();assert($('#source-catalogue-heading').textContent.includes('115'),'working header edit changed immutable source catalogue');
    const saved=await save(),reopened=await CalibrationProject.fromJSON(saved);
    assert(reopened.original[16]===0x55&&reopened.bytes[16]===0x56&&reopened.changedByteCount===1&&reopened.maps.length===0,'saved OLS changed original bytes or created invented editable maps');
    await inject(JSON.stringify(saved),'Synthetic source roundtrip.tuneworkshop.json','project',saved.name);
    assert(!$('#catalogue-view').hidden&&$('#source-catalogue-heading').textContent.includes('115')&&getSelectedTuningContext().project.changedBytes===1,'saved workspace did not reconstruct catalogue from original bytes');
    await inject(fixture,fixtureName,'binary',fixtureName);
    assert(!$('#catalogue-view').hidden&&$('#map-name').textContent===displayTitle(boost),'raw binary opener did not recognize the native OLS project');
    // Existing explicit maps remain independent and editable alongside source definitions.
    const withMap=new CalibrationProject(fixture,{name:'Synthetic source with editable map.ols'});
    withMap.addMap({id:'explicit-byte-test',name:'Synthetic explicit byte map',address:0,rows:1,cols:2,type:'uint8',endian:'little',factor:1,offset:0});
    await inject(JSON.stringify(await withMap.serialize()),'Synthetic source with map.json','project',withMap.name);
    assert(!$('#catalogue-view').hidden&&$('[data-map="explicit-byte-test"]'),'saved explicit map displaced the catalogue');
    $('[data-map="explicit-byte-test"]').click();
    assert(!$('#table-view').hidden&&all('#table-view [data-cell]').length===2&&!getSelectedTuningContext().sourceMetadata,'explicit editable map was mixed with catalogue metadata');
    $('#catalogue-tab').click();assert(getSelectedTuningContext().map===null&&getSelectedTuningContext().sourceMetadata,'catalogue tab did not restore metadata mode');
    await inject(new Uint8Array(64),'Unidentified reference.bin','binary','Unidentified reference.bin');
    const rawContext=getSelectedTuningContext();
    assert(!rawContext.vehicle.includes('Fiat')&&!rawContext.ecu.hardware&&!rawContext.ecu.software&&!rawContext.ecu.model,'raw reference inherited historical Fiat identity');
    await inject(fixture,fixtureName,'project',fixtureName);
    let referenceResult=null;
    if(reference){
      assert(typeof reference.base64==='string'&&typeof reference.name==='string','invalid optional reference');
      const raw=atob(reference.base64),bytes=Uint8Array.from(raw,char=>char.charCodeAt(0)),parsed=inspectWinolsProject(bytes);
      assert(parsed?.records.length>0,'optional reference has no supported catalogue');
      await inject(bytes,reference.name,'binary',reference.name);
      assert(!$('#catalogue-view').hidden&&$('#catalogue-tab').getAttribute('aria-selected')==='true'&&$('[data-view="surface"]').disabled&&$('#table-view').hidden,'reference exposed undecoded calibration values');
      assert($('#source-catalogue-heading').textContent.includes(parsed.records.length.toLocaleString()),'actual reference catalogue count differs from parser');
      referenceResult={counts:parsed.counts,displayedTitle:$('#map-name').textContent,valuesAvailable:false,sourceProject:reference.name};
    }
    window.scrollTo(0,0);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    return {olsAutomaticCatalogue:true,olsGroupedSourceNames:true,olsPaginationAndSearch:true,olsDuplicateSymbolsPreserved:true,olsShapeFilter:true,olsMetadataOnlyViews:true,olsAddressSeparation:true,olsOriginalCatalogueAfterByteEdit:true,olsWorkspaceRoundtrip:true,olsEditableMapsSeparate:true,olsAssistantMetadataOptIn:true,olsSourceVehicleSeparation:true,rawSourceVehicleSeparation:true,...(referenceResult?{olsActualReference:referenceResult}:{})};
  } finally {
    window.confirm=originalConfirm;URL.createObjectURL=originalCreateURL;window.fetch=originalFetch;
    $('#assistant-include-context').checked=false;$('#assistant-include-context').dispatchEvent(new Event('change'));
    if(!$('#assistant-panel').hidden)$('#assistant-close').click();
  }
}
