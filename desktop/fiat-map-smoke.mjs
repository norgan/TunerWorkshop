/** The optional reference is an explicitly supplied local original; never fetched. */
export async function runFiatMapSmoke(contents, reference = null) {
  return contents.executeJavaScript(`(async()=>{
    const $=s=>document.querySelector(s), assert=(value,message)=>{if(!value)throw new Error(message);};
    $('#tuning-nav').click();
    assert($('#tuning-goals')&&document.querySelectorAll('.tuning-goal').length===3,'Boost/timing/fuel entry points missing');
    const reference=${JSON.stringify(reference)};
    if(!reference)return {tuningGoalNavigation:true};
    const input=$('#file-input'),click=input.click,confirm=window.confirm;input.click=()=>{};window.confirm=()=>true;
    try{$('#load-binary').click();}finally{input.click=click;}
    const bytes=Uint8Array.from(atob(reference.base64),char=>char.charCodeAt(0)),transfer=new DataTransfer();
    transfer.items.add(new File([bytes],reference.name));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    const end=Date.now()+20000;while(!$('#tuning-goals').textContent.includes('V862MH97')&&Date.now()<end)await new Promise(r=>setTimeout(r,30));
    try{
      assert($('#tuning-goals').textContent.includes('V862MH97'),'Exact 500X original did not match');
      const boost=$('[data-goal-map="500x-boost-pressure"]'),fuel=$('[data-goal-map="500x-fuel-main"]');
      assert(boost&&fuel,'Code-linked candidates were not attached');boost.click();
      assert(document.querySelectorAll('[data-cell]').length===224,'Boost geometry is incorrect');
      assert($('#map-name').textContent.includes('candidate')&&$('#map-definition-info').textContent.includes('not fully verified'),'Candidate confidence was hidden');
      assert($('#changed-count').textContent==='0 bytes changed','Identification changed original ECU bytes');
      const first=$('[data-cell="0"]').textContent;
      $('#edit-operation').value='percent';$('#edit-value').value='1';$('#apply-edit').click();
      assert($('#changed-count').textContent!=='0 bytes changed','Offline boost candidate edit failed');
      $('#undo').click();assert($('#changed-count').textContent==='0 bytes changed'&&$('[data-cell="0"]').textContent===first,'Boost edit undo failed');
      $('[data-view="curve"]').click();assert(!$('#plot-view').hidden,'Candidate 2D curve unavailable');
      $('[data-view="surface"]').click();assert(!$('#plot-view').hidden,'Candidate 3D surface unavailable');
      $('[data-goal-map="500x-fuel-main"]').click();assert(document.querySelectorAll('[data-cell]').length===280,'Fuel geometry is incorrect');
      assert($('#map-details').textContent.includes('0.0009765625'),'Proposed lambda scale lost');
      const fuelUnit=$('#fuel-display-unit');fuelUnit.value='afr';fuelUnit.dispatchEvent(new Event('change',{bubbles:true}));
      const stoich=new DataView(bytes.buffer).getUint16(351+0x380a70,false)/1024;
      const firstLambda=new DataView(bytes.buffer).getUint16(351+0x3b7054,false)/1024;
      assert(Math.abs(Number($('[data-cell="0"]').textContent)-firstLambda*stoich)<0.001,'AFR display did not use the calibration ratio');
      assert($('#changed-count').textContent==='0 bytes changed','AFR display changed calibration bytes');
      $('#edit-operation').value='set';$('#edit-value').value='12.5';$('#apply-edit').click();
      assert(Math.abs(Number($('[data-cell="0"]').textContent)-12.5)<0.008,'AFR edit was not converted back to stored lambda');
      $('#undo').click();assert($('#changed-count').textContent==='0 bytes changed','AFR edit undo failed');
      $('#fuel-display-unit').value='lambda';$('#fuel-display-unit').dispatchEvent(new Event('change',{bubbles:true}));
      $('[data-goal-map="500x-boost-request"]').click();
      assert(document.querySelectorAll('[data-cell]').length===256&&$('#edit-operation').value==='boost-request-percent','Requested boost editor missing');
      $('#edit-value').value='10';$('#edit-value').dispatchEvent(new Event('input'));$('#apply-edit').click();
      assert(Number($('[data-cell="0"]').textContent)<1,'Positive boost request increased the divisor');
      assert(Math.abs(Number($('[data-cell="0"]').textContent)-1/1.1)<0.001,'Boost inverse edit did not match its preview');
      $('#undo').click();assert($('#changed-count').textContent==='0 bytes changed','Boost request undo failed');
      $('#edit-value').value='-100';$('#edit-value').dispatchEvent(new Event('input'));assert($('#apply-edit').disabled,'Singular boost request was allowed');
      $('[data-goal-map="500x-ignition-a"]').click();
      assert(document.querySelectorAll('[data-cell]').length===320,'Ignition candidate geometry is incorrect');
      assert($('#map-details').textContent.includes('0.00390625')&&$('#map-details').textContent.includes('int16'),'Ignition candidate signed encoding or proposed scale lost');
      assert(document.querySelectorAll('[data-goal-map]').length===8,'Goal map choices missing');
      return {tuningGoalNavigation:true,exact500xOriginalRecognition:true,codeLinkedCandidatesEditable:true,realBoostFuelAndTimingGeometry:true,originalCandidateBytesPreserved:true,requestedBoostInverseEdit:true,calibrationSpecificAfrViewAndEdit:true};
    }finally{window.confirm=confirm;}
  })()`);
}
