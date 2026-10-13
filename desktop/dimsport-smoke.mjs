/** Isolated synthetic fixture: never reads a user tune or connects hardware. */
export async function runDimsportSmoke(contents) {
  return contents.executeJavaScript(`(async()=>{
    const $=selector=>document.querySelector(selector);
    const assert=(condition,message)=>{if(!condition)throw new Error(message);};
    const wait=async predicate=>{const end=Date.now()+15000;while(!predicate()&&Date.now()<end)await new Promise(r=>setTimeout(r,25));assert(predicate(),'Dimsport UI did not settle');};
    if($('#settings-dialog').open)$('#settings-dialog').close();
    $('#tuning-nav').click();
    assert($('#payload-inspection').hidden,'Demo has an invented ECU payload');
    const bytes=new Uint8Array(4194304+351).fill(255);
    bytes.set(new TextEncoder().encode('GEN_FILE'));
    const v=new DataView(bytes.buffer);v.setUint32(8,0x03010020,true);v.setUint32(12,327,true);
    for(let i=0;i<16;i++)v.setUint16(351+0x100+i*2,800+i*200,false);
    const input=$('#file-input'),click=input.click;input.click=()=>{};
    try{$('#load-binary').click();}finally{input.click=click;}
    const transfer=new DataTransfer();transfer.items.add(new File([bytes],'synthetic-dimsport.ORI'));
    input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    await wait(()=>!$('#payload-inspection').hidden);
    assert($('#payload-boundary').textContent.includes('351'),'Wrong wrapper length shown');
    assert($('#payload-summary').textContent.includes('4 MiB'),'Wrong image size shown');
    $('#inspect-payload').click();
    assert($('#hex-scope').value==='payload','Image inspection did not change coordinate scope');
    assert($('#hex-offset').value==='0x000000','Image origin has a file offset');
    assert($('#hex-data [data-byte="351"]'),'Image byte zero is not mapped to file byte351');
    $('#find-candidates').click();
    await wait(()=>$('#candidate-dialog').open&&$('[data-candidate-index]'));
    assert($('#candidate-warning').textContent.includes('unverified'),'Candidates lack status');
    $('[data-candidate-index]').click();
    assert($('#map-name').textContent.includes('Candidate'),'Candidate lost its label');
    assert(document.querySelectorAll('[data-cell]').length===16,'Candidate dimensions wrong');
    assert($('[data-cell="0"]').textContent==='800','Candidate decoded with wrong byte order');
    assert($('#map-details').textContent.includes('000100')&&$('#map-details').textContent.includes('00025F'),'Image/file offsets disagree');
    $('#edit-operation').value='set';$('#edit-value').value='801';$('#apply-edit').click();
    assert($('#changed-count').textContent==='1 bytes changed','Raw candidate edit changed unexpected bytes');
    $('#undo').click();assert($('#changed-count').textContent==='0 bytes changed','Candidate undo failed');
    $('#redo').click();assert($('#changed-count').textContent==='1 bytes changed','Candidate redo failed');
    document.querySelector('[data-view="curve"]').click();assert(!$('#plot-view').hidden,'Candidate curve unavailable');
    document.querySelector('[data-view="surface"]').click();assert(!$('#plot-view').hidden,'Candidate surface unavailable');
    document.querySelector('[data-view="table"]').click();
    $('#payload-details').open=true;$('#export-payload').click();
    assert($('#export-dialog').open&&$('#export-detail').textContent.includes('4,194,304'),'Image export has the wrong length');
    $('#cancel-export').click();$('#export-binary').click();
    assert($('#export-detail').textContent.includes('4,194,655'),'Container export lost its wrapper');
    $('#cancel-export').click();$('#export-payload').click();
    $('#export-ack').checked=true;$('#export-ack').dispatchEvent(new Event('change'));$('#confirm-export').click();
    await wait(()=>$('#toast').textContent==='Draft binary saved. ECU checksum remains unverified.');
    $('#export-inspection-report').click();
    await wait(()=>$('#toast').textContent==='Inspection report saved with original and working image hashes.');
    $('#payload-details').open=false;
    $('#save-project').click();await wait(()=>!$('#save-project').disabled);
    assert(!$('#save-project').textContent.includes('•'),'Candidate project did not save');
    assert(!$('#candidate-dialog').open&&!$('#export-dialog').open,'An inspection dialog remained open');
    const originalFetch=window.fetch;let sent=0;
    window.fetch=(url,...rest)=>{if(url==='/api/assistant/message'){sent++;throw new Error('Table analysis must not send automatically');}return originalFetch(url,...rest);};
    try{
      $('#assistant-question').value='';$('#assistant-include-context').checked=false;
      $('#analyse-table').click();
      assert(!$('#assistant-panel').hidden&&$('#assistant-question').value.includes('Separate observations from guesses'),'Table analysis did not prepare a question');
      assert(!$('#assistant-include-context').checked,'Analysis enabled context sharing without a choice');
      const tuning=(await import('./app.mjs')).getSelectedTuningContext();
      assert(tuning.map.cells.length===16&&tuning.map.encoding.fileOffset===0x25F&&tuning.map.encoding.imageOffset===0x100,'Analysis context lost table values or coordinates');
      $('#assistant-question').value='My existing question';$('#assistant-include-context').checked=true;
      $('#analyse-table').click();
      assert($('#assistant-question').value==='My existing question'&&$('#assistant-include-context').checked,'Analysis overwrote an existing draft or preference');
      const preview=JSON.parse($('#assistant-context-preview').textContent);
      assert(preview.tuning.map.encoding.type==='uint16'&&preview.tuning.map.cells[0].modified===801,'Table context preview is incorrect');
      assert(sent===0,'Table analysis sent a request automatically');
    }finally{window.fetch=originalFetch;$('#assistant-question').value='';$('#assistant-include-context').checked=false;$('#assistant-close').click();}
    window.scrollTo(0,0);
    return {dimsportImageDetected:true,imageCoordinates:true,rawCandidateDiscovery:true,rawCandidateTableAndGraphs:true,candidateEditUndoRedo:true,imageAndContainerExportScopes:true,dimsportNativeSave:true,tableAnalysisDraftAndPrivacy:true};
  })()`);
}
