const esc = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const goals = [{id:'boost', label:'Boost', detail:'Pressure targets and turbo control'}, {id:'ignition', label:'Timing', detail:'Spark advance and ignition corrections'}, {id:'fuel', label:'Fuel / lambda', detail:'Mixture targets and fuelling'}];

export function createTuningGoals({getProject, getAssessment, onSelectMap, onInspect, onOpenFile, getFuelDisplay=()=> 'lambda', onFuelDisplay=()=>{}}) {
  const section = document.createElement('section'); section.id = 'tuning-goals'; section.className = 'tuning-goals'; section.setAttribute('aria-label', 'Boost, timing and fuel maps');
  document.querySelector('#mode-banner').before(section);
  section.addEventListener('click', event => {
    const mapButton = event.target.closest('[data-goal-map]');
    if (mapButton) onSelectMap(mapButton.dataset.goalMap);
    if (event.target.closest('[data-goal-open]')) onOpenFile();
    if (event.target.closest('[data-goal-inspect]')) onInspect();
    const tools=event.target.closest('[data-goal-tools]');
    if(tools){const open=document.querySelector('#tuning-workspace').classList.toggle('show-file-tools');tools.setAttribute('aria-expanded',String(open));}
  });
  section.addEventListener('change',event=>{if(event.target.id==='fuel-display-unit')onFuelDisplay(event.target.value);});
  return { render() {
    const project = getProject(), assessment = getAssessment(), maps = project.maps;
    const matched = assessment?.status === 'matched';
    document.querySelector('#tuning-workspace').classList.toggle('with-known-calibration',matched);
    section.innerHTML = `<div class="tuning-goals-heading"><div><span class="eyebrow">YOUR TUNING WORKSPACE</span><h2>Boost, timing and fuel</h2><p>${esc(matched ? assessment.label+' · Offline candidates · Checksum unverified' : project.synthetic ? 'Open your original ECU file to start.' : assessment?.message || 'Use definitions established for this exact ECU image.')}</p></div><div class="tuning-goal-actions"><button type="button" data-goal-open>Open ECU file</button>${matched?`<button type="button" data-goal-tools aria-expanded="${document.querySelector('#tuning-workspace').classList.contains('show-file-tools')}">File tools</button>`:''}</div></div>
      <div class="tuning-goal-grid">${goals.map(goal => {
        const selected = maps.filter(map => map.category === goal.id), candidates = selected.filter(map => map.definitionStatus === 'candidate');
        const status = project.synthetic ? 'Synthetic examples' : selected.length ? `${selected.length} ${candidates.length === selected.length ? 'candidate' : 'editable'} map${selected.length === 1 ? '' : 's'}` : 'Identification in progress';
        return `<article class="tuning-goal"><div class="section-heading"><h3>${goal.label}</h3><span>${status}</span></div>${goal.id==='boost'&&matched&&selected.every(map=>map.id==='500x-boost-pressure')?'<p class="hint">Boost command inputs are still being traced. This table controls a pressure monitor reference.</p>':''}${selected.map(map => `<button type="button" data-goal-map="${esc(map.id)}">Open ${esc(map.name)}</button>`).join('') || `<p class="hint">${goal.id === 'ignition' && matched ? 'The base ignition table is still being traced.' : 'No matching definition has been established for this image.'}</p>`}</article>`;
      }).join('')}</div>
      ${matched&&assessment.stoichiometricAfr?`<label class="fuel-view-control">Fuel display <select id="fuel-display-unit"><option value="lambda" ${getFuelDisplay()==='lambda'?'selected':''}>Lambda</option><option value="afr" ${getFuelDisplay()==='afr'?'selected':''}>AFR</option></select><span>AFR uses this calibration's stoichiometric ratio ${assessment.stoichiometricAfr.toFixed(4)}:1.</span></label>`:''}
      ${matched ? `<details class="tuning-identification"><summary>What the app has established</summary><p>${esc(assessment.message)}</p><ul><li>${assessment.matchKind==='same-code-layout'?'ECU code, hardware and axis fingerprints match; calibration values differ from the reference original.':'Exact original-image match.'} Addresses are specific to this established layout.</li><li>ECU code establishes table geometry, byte order, axis locations and principal unit encodings.</li><li>Requested-boost correction and ceiling feed the desired-pressure output. The pressure monitor reference is separate.</li><li>Ignition degrees are linked to reported spark; lambda is linked to commanded-mixture diagnostics and the fuel calculation. Exact modes and some axis meanings remain qualified.</li></ul><p>Choose a map, select cells in its table or graph, then preview and apply an offline edit. On Requested boost correction, Absolute-pressure request % adjusts the divisor in the correct direction before other limits. Pressure maps support bar/psi; lambda and AFR are display choices.</p></details>` : project.payloadInfo ? '<button type="button" data-goal-inspect>Inspect unmatched table patterns</button>' : ''}`;
  }};
}
