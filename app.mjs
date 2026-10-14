import { CalibrationProject, createDemoProject, sha256, TYPES, LIMITS } from './core.mjs';
import { parseMesLog } from './mes-log.mjs';
import { parseHexBytes, formatEngineeringNumber } from './formats.mjs';
import {getSettings,settingsReady,saveSettings,subscribeSettings} from './settings-client.mjs';
import {pressureDisplay,pressureFromDisplay} from './pressure-units.mjs';
import { createPayloadInspector } from './dimsport-ui.mjs';
import { createMapWorkbench } from './map-workbench.mjs';
import { createMapReferences } from './map-references.mjs';
import { MAP_CATEGORIES, MAP_ROLES, DEFINITION_STATES, selectionEditPreview, requestedBoostFactorChange } from './map-workbench-model.mjs';
import { inspectWinolsProject } from './winols-project.mjs';
import { createMapCatalogue } from './map-catalogue.mjs';
import { inspectFiatCalibration, attachFiatCalibration } from './fiat-calibration-profile.mjs';
import { createTuningGoals } from './tuning-goals.mjs';

await settingsReady;

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const hex = (n, width = 6) => n.toString(16).toUpperCase().padStart(width, '0');
const number = formatEngineeringNumber;
let project = createDemoProject(), mapId = project.maps[0].id, view = getSettings().defaultMapView;
let selection = new Set([0]), anchor = 0, hexOffset = 0, dirty = false, revision = 0, busy = false;
let originalHash = '', toastTimer, selectedLog = null, fileAction = '', hexScope = 'file', exportTarget = null;
let plotPoints = [];
let calibrationAssessment = null;
let fuelDisplay = 'lambda';
const boostRequestOption=document.createElement('option');boostRequestOption.value='boost-request-percent';boostRequestOption.textContent='Absolute-pressure request %';boostRequestOption.hidden=true;boostRequestOption.disabled=true;$('#edit-operation').append(boostRequestOption);
const tuningGoals = createTuningGoals({getProject: () => project, getAssessment: () => calibrationAssessment,
  getFuelDisplay:()=>fuelDisplay,onFuelDisplay:value=>{const map=currentMap(),operation=$('#edit-operation').value,text=$('#edit-value').value,stored=map&&operation!=='percent'&&text.trim()?Number(text)/mapDisplay(map).factor:null;fuelDisplay=value;if(map&&stored!==null&&Number.isFinite(stored))$('#edit-value').value=String(stored*mapDisplay(map).factor);render();},
  onSelectMap: id => { const map=project.maps.find(map=>map.id===id);if(!map)return; mapId=id; view='table'; selection=new Set([0]); anchor=0; $('#map-search').value=''; $('#map-filter').value='all'; $('#show-original').checked=false; $('#edit-operation').value=id==='500x-boost-request'?'boost-request-percent':map.category==='ignition'?'add':'set';$('#edit-value').value=id==='500x-boost-request'||map.category==='ignition'?'0':String(project.readMap(id)[0]*mapDisplay(map).factor);render(); $('.editor-heading').scrollIntoView({block:'start'}); },
  onInspect: () => $('#find-candidates').click(), onOpenFile: () => $('#load-binary').click()});
const payloadInspector = createPayloadInspector({ getProject: () => project, inspectHex: inspectPayloadHex, openCandidate: openRawCandidate, requestExport, download, filename, toast });
const mapWorkbench = createMapWorkbench({ getProject: () => project, getCurrentMap: currentMap, onSaved: map => { mapId=map.id; view='table'; selection=new Set([0]); anchor=0; $('#map-search').value=''; $('#map-filter').value='all'; markDirty(); render(); }, toast });
const mapCatalogue = createMapCatalogue({onSelect:()=>{mapId=null;selection=new Set();anchor=0;view='catalogue';render();},onPageChange:renderSidebar});
createMapReferences({ openDefinition: seed => mapWorkbench.open(null, seed) });

function toast(message, error = false) {
  $('#toast').textContent = message; $('#toast').className = error ? 'error' : ''; $('#toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, error ? 9000 : 4500);
}
function guard(fn) { return (...args) => { try { const result = fn(...args); if (result?.catch) result.catch(e => toast(e.message, true)); } catch(e) { toast(e.message, true); } }; }
function currentMap() { return project.maps.find(m => m.id === mapId); }
function markDirty() { dirty = true; revision++; }
function mayReplace() { return !dirty || confirm('This project has unsaved work. Continue without saving it?'); }
function filename(suffix, target = project) { return target.synthetic ? `synthetic-demo${suffix}` : `${target.name.replace(/[^a-zA-Z0-9_.-]/g,'_').slice(0,80)}${suffix}`; }
export async function download(name, content, type = 'application/json') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  const saved=window.workshopDesktop?.waitForDownload(url);
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  if(saved){try{return await saved;}finally{URL.revokeObjectURL(url);}}
  setTimeout(() => URL.revokeObjectURL(url), 30000);return true;
}
async function updateHash() {
  const target = project; $('#digest').textContent = 'Calculating…'; originalHash = '';
  const hash = await sha256(target.original);
  if (project === target) { originalHash = hash; $('#digest').textContent = hash; }
}
function installProject(next, assessment = null) {
  const addedMaps = attachFiatCalibration(next, assessment);
  calibrationAssessment = assessment;
  const catalogue = inspectWinolsProject(next.original);
  project = next; mapId = next.maps[0]?.id; selection = new Set(mapId ? [0] : []); anchor = 0;
  dirty = addedMaps.length > 0; revision++; hexOffset = 0; hexScope = 'file'; $('#map-search').value = ''; $('#map-filter').value='all'; view = mapId ? getSettings().defaultMapView : 'hex';
  mapCatalogue.install(next,catalogue);
  if(catalogue){mapId=null;selection=new Set();view='catalogue';}
  $('#show-original').checked = false; render(); guard(updateHash)();
}
function renderSidebar() {
  const term = $('#map-search').value.toLowerCase();
  const filter = $('#map-filter').value, maps = project.maps;
  const editable = Object.entries(MAP_CATEGORIES).map(([category, label]) => {
    const group=maps.filter(m=>(m.category||'other')===category&&(filter==='all'||filter===category)&&`${m.name} ${m.notes||''} ${m.evidence||''}`.toLowerCase().includes(term));
    if(!group.length)return '';
    return `<section class="map-group"><h2>${esc(label)} <span>${group.length}</span></h2>${group.map(m=>`<button class="map-item ${m.id===mapId?'active':''}" data-map="${esc(m.id)}" aria-pressed="${m.id===mapId}"><span aria-hidden="true">▦</span><span><strong>${esc(m.name)}</strong><small>${m.rows} × ${m.cols} · ${esc(mapUnit(m)||'raw units')} · ${esc(DEFINITION_STATES[m.definitionStatus]||'User defined')}</small><small>${esc(MAP_ROLES[m.role]||MAP_ROLES.unknown)}</small></span></button>`).join('')}</section>`;
  }).join('');
  $('#map-list').innerHTML = mapCatalogue.info ? mapCatalogue.sidebar({search:term,category:filter,shapeFilter:$('#catalogue-shape').value,active:!currentMap()}) + (maps.length ? `<section class="editable-map-list" aria-label="Editable map definitions"><h2 class="editable-map-heading">Editable definitions</h2>${editable || '<p class="hint">No editable definitions match this search.</p>'}</section>` : '') : editable || `<p class="hint">${maps.length ? 'No maps match this category or search.' : 'No maps defined yet. Find table candidates, define a map, or import definitions for this software.'}</p>`;
  $('#project-name').textContent = project.name;
  $('#file-size').textContent = `${project.byteLength.toLocaleString()} bytes · ${mapCatalogue.info ? `${mapCatalogue.count.toLocaleString()} source definitions · ${project.maps.length} editable maps` : `${project.maps.length} maps`}`;
}
function render() {
  renderSidebar(); payloadInspector.render(); tuningGoals.render(); const map = currentMap(), original = $('#show-original').checked;
  if(map&&view!=='hex'){try{project.readMap(map.id);}catch{view='hex';toast('These bytes cannot be decoded by the selected map. Use Hex, Undo or Restore bytes.',true);}}
  const fileInfo=project.fileInfo;
  for(const id of ['add-map','import-defs','export-binary'])$(`#${id}`).disabled=fileInfo.readOnly;
  $('#mode-text').textContent = mapCatalogue.info ? `WINOLS SOURCE CATALOGUE · ${mapCatalogue.info.message || 'Saved map names and definitions are available. Calibration values have not been decoded.'} Byte edits apply to the native project file.` : fileInfo.requiresValidation ? `${fileInfo.name.toUpperCase()} · ${fileInfo.reason}` : project.synthetic ? 'SYNTHETIC DEMO · These example maps are for trying the editor. They are not Fiat calibration data.' : 'FULL FILE EDITING · Map definitions and ECU checksums are unverified. All byte offsets are editable; live ECU writes are unavailable.';
  $('#map-category').textContent = fileInfo.requiresValidation ? 'FULL FILE EDITING · CONTAINER' : project.synthetic ? 'DEMONSTRATION MAP' : 'CALIBRATION MAP';
  $('#map-name').textContent = map?.name || 'Binary workspace';
  $('#map-details').textContent = map ? `${mapOffsetDescription(map)}  ·  ${map.rows} × ${map.cols}  ·  ${map.type} ${map.endian === 'little' ? 'LE' : 'BE'}  ·  value = raw × ${map.factor} + ${map.offset}` : fileInfo.requiresValidation ? `${fileInfo.byteLength.toLocaleString()} container bytes · ${Object.entries(fileInfo.identifiers).flatMap(([k,v])=>v.map(x=>`${k}: ${x.value}`)).join(' · ')}` : 'Edit any bytes below or define a map using explicit file offsets.';
  if(mapCatalogue.info&&!map){
    const record=mapCatalogue.current();
    $('#map-category').textContent=view==='catalogue'?'WINOLS SOURCE MAP · SAVED DEFINITION':'WINOLS PROJECT · FILE BYTES';
    $('#map-name').textContent=view==='catalogue'?(record?mapCatalogue.title(record):'Source map catalogue'):'WinOLS project bytes';
    $('#map-details').textContent=view==='catalogue'?(record?`${record.symbol || 'No saved symbol'} · ${mapCatalogue.shape(record)} · Numeric values not decoded`:'The original project is preserved. Unsupported catalogue layouts can still be inspected in Hex.'):'Hex uses native project file offsets. Saved map addresses are not mapped into these bytes.';
  }
  $('#undo').disabled = !project.canUndo; $('#redo').disabled = !project.canRedo;
  $('#undo').title = project.history.undo.at(-1) || 'No edits to undo';
  $('#redo').title = project.history.redo.at(-1) || 'No edits to redo';
  $$('[data-view]').forEach(b => { b.classList.toggle('selected', b.dataset.view === view); b.setAttribute('aria-selected', b.dataset.view === view); b.disabled = b.dataset.view==='catalogue'?!mapCatalogue.info:!map && b.dataset.view !== 'hex'; });
  $('#empty-state').hidden = !!map || view === 'hex' || !!mapCatalogue.info;
  mapCatalogue.renderPanel(view==='catalogue');
  $('.editor-panel>.legend').hidden = view==='catalogue';
  $('#table-view').hidden = !map || view !== 'table';
  $('#plot-view').hidden = !map || !['curve','surface'].includes(view);
  $('#hex-view').hidden = view !== 'hex';
  $('#edit-tools').hidden = !map;
  boostRequestOption.hidden=boostRequestOption.disabled=map?.id!=='500x-boost-request';
  if(boostRequestOption.disabled&&$('#edit-operation').value==='boost-request-percent')$('#edit-operation').value='percent';
  $('#show-original').disabled = !map || view === 'hex';
  $('#export-csv').disabled = !map;
  $('#analyse-table').disabled = !map && !(view==='catalogue'&&mapCatalogue.current());
  $('#analyse-table').textContent = view==='catalogue'?'Ask AI about this map':'Ask AI about this table';
  $('#edit-map-definition').disabled = !map;
  $('#map-definition-info').hidden = !map;
  $('#map-definition-info').textContent = map ? `${MAP_CATEGORIES[map.category]||'Unsorted'} · ${MAP_ROLES[map.role]||MAP_ROLES.unknown} · ${DEFINITION_STATES[map.definitionStatus]||'User defined'}${map.evidence ? ' · '+map.evidence : ''}${map.notes ? ' — '+map.notes : ''}` : '';
  for (const id of ['apply-edit','restore-cells']) $(`#${id}`).disabled = !map || original || !selection.size;
  $('#selection-count').textContent = map ? `${selection.size} cell${selection.size === 1 ? '' : 's'} selected${original ? ' · viewing original' : ''}` : '';
  if (map && view === 'table') renderTable(map);
  if (map && ['curve','surface'].includes(view)) renderPlot(map);
  if (view === 'hex') renderHex();
  renderEditPreview();
  renderChanges();
  $('#save-project').textContent = dirty ? 'Save project •' : 'Save project';
  $('#footer-state').textContent = `${dirty ? 'Unsaved work' : 'Workspace ready'} · Live ECU writes unavailable`;
}
function mapOffsetDescription(map) {
  let result = `File 0x${hex(map.address)}`;
  if (project.payloadInfo) {
    try { result += ` · Image 0x${hex(project.fileToPayloadOffset(map.address, map.rows * map.cols * TYPES[map.type].bytes))}`; } catch { /* Map is outside the inferred image. */ }
  }
  return result;
}
function inspectPayloadHex() {
  if (!project.payloadInfo) return;
  hexScope = 'payload'; hexOffset = project.payloadInfo.fileOffset; view = 'hex'; render();
  $('#hex-view').scrollIntoView({ block: 'nearest' });
}
function openRawCandidate(candidate) {
  const address = project.payloadToFileOffset(candidate.offset, candidate.count * 2);
  const id = `candidate-${candidate.encoding}-${candidate.offset.toString(16)}`;
  const existing = project.maps.find(map => map.id === id);
  if (existing && (existing.address !== address || existing.rows !== candidate.rows || existing.cols !== candidate.cols || existing.type !== 'uint16' || existing.endian !== candidate.endian || existing.factor !== 1 || existing.offset !== 0 || existing.unit !== '')) throw new Error('A different definition already uses this candidate ID. Use a different ID for that definition before adding this raw candidate.');
  if (!existing) {
    project.addMap({ id, name: `Candidate raw series 0x${hex(candidate.offset)}`, address, rows: candidate.rows, cols: candidate.cols, type: 'uint16', endian: candidate.endian, factor: 1, offset: 0, unit: '', xLabel: 'Sample index', yLabel: 'Unverified raw series', definitionStatus:'candidate', evidence:'Monotonic raw sequence; table role, units, dimensions and axis relationships are unverified.' });
    markDirty();
  }
  mapId = id; selection = new Set([0]); anchor = 0; hexOffset = address; hexScope = 'payload'; view = 'table'; $('#show-original').checked = false; $('#map-search').value = ''; $('#map-filter').value='all'; render();
  $('.editor-heading').scrollIntoView({ block: 'nearest' });
  toast('Raw candidate opened. Its purpose, units and scaling remain unverified.');
}
const mapDisplay=map=>map.category==='fuel'&&map.unit==='lambda'&&fuelDisplay==='afr'&&calibrationAssessment?.stoichiometricAfr?{converted:true,factor:calibrationAssessment.stoichiometricAfr,unit:'AFR'}:pressureDisplay(map.unit,getSettings().pressureUnit);
function editAdjustment(map,operation,input){
  if(operation==='boost-request-percent'){
    if(map.id!=='500x-boost-request')throw new Error('Requested-pressure adjustment is available on its traced correction table only.');
    if([...selection].some(index=>project.readMap(map.id)[index]<=0))throw new Error('Selected divisor factors must be positive.');
    return {operation:'percent',amount:requestedBoostFactorChange(input)};
  }
  if(!String(input).trim()||!Number.isFinite(Number(input)))throw new Error('Adjustment must be a number.');
  return {operation,amount:operation==='percent'?Number(input):Number(input)/mapDisplay(map).factor};
}
const mapUnit=map=>mapDisplay(map).unit;
const displayed=(map,values)=>values.map(value=>value*mapDisplay(map).factor);
const mapNumber=(map,value)=>number(map.id.startsWith('500x-')?Number(value.toFixed(3)):mapDisplay(map).converted?Number(value.toPrecision(7)):value);
function displayValues(map) { return displayed(map,$('#show-original').checked ? project.readOriginalMap(map.id) : project.readMap(map.id)); }
function colour(value, lo, hi) { const t = hi === lo ? .5 : (value - lo) / (hi - lo); return `hsl(${220 - t * 70} 39% ${23 + t * 7}%)`; }
function renderTable(map) {
  const values = displayValues(map), originals = displayed(map,project.readOriginalMap(map.id)), working = displayed(map,project.readMap(map.id));
  const lo = Math.min(...values), hi = Math.max(...values), firstSelected = Math.min(...selection);
  const columns = map.xAxis || Array.from({length:map.cols}, (_,i) => i);
  const rows = map.yAxis || Array.from({length:map.rows}, (_,i) => i);
  let html = `<table class="map-table" aria-label="${esc(map.name)}"><caption>${esc(map.yLabel)} ↓ &nbsp; / &nbsp; ${esc(map.xLabel)} → &nbsp; · &nbsp; ${esc(mapUnit(map) || 'raw units')}</caption><thead><tr><th scope="col">${esc(mapUnit(map) || 'Index')}</th>${columns.map(v=>`<th scope="col" title="${esc(number(v))}">${esc(map.id.startsWith('500x-')?number(Number(v.toFixed(2))):number(v))}</th>`).join('')}</tr></thead><tbody>`;
  for (let r=0;r<map.rows;r++) {
    html += `<tr><th class="row-heading" scope="row">${esc(number(rows[r]))}</th>`;
    for (let c=0;c<map.cols;c++) {
      const i=r*map.cols+c, changed=working[i]!==originals[i];
      html += `<td data-cell="${i}" tabindex="${selection.has(i) && i === firstSelected ? '0' : '-1'}" class="${selection.has(i)?'selected ':''}${changed?'changed':''}" style="background:${colour(values[i],lo,hi)}" title="Row ${esc(rows[r])}, column ${esc(columns[c])}; current ${esc(String(values[i]))}; original ${esc(String(originals[i]))} ${esc(mapUnit(map))}${changed ? '; modified' : ''}" aria-label="Row ${esc(rows[r])}, column ${esc(columns[c])}, ${esc(String(values[i]))} ${esc(mapUnit(map))}${changed ? ', changed' : ''}">${esc(mapNumber(map,values[i]))}</td>`;
    }
    html += '</tr>';
  }
  $('#table-view').innerHTML = html + '</tbody></table>';
  $('#table-view table').style.minWidth=`${(map.cols+1)*90}px`;
}
function selectCell(index, shift=false, toggle=false) {
  const map=currentMap(); if (!map) return;
  if(shift) {
    const r0=Math.floor(anchor/map.cols), c0=anchor%map.cols, r1=Math.floor(index/map.cols), c1=index%map.cols;
    selection=new Set();
    for(let r=Math.min(r0,r1);r<=Math.max(r0,r1);r++) for(let c=Math.min(c0,c1);c<=Math.max(c0,c1);c++) selection.add(r*map.cols+c);
  } else if(toggle) { selection.has(index)?selection.delete(index):selection.add(index); anchor=index; }
  else {selection=new Set([index]); anchor=index;}
  const firstSelected=Math.min(...selection);
  $$('[data-cell]').forEach(cell=>{const i=Number(cell.dataset.cell);cell.classList.toggle('selected',selection.has(i));cell.tabIndex=i===firstSelected?0:-1;});
  $('#selection-count').textContent=`${selection.size} cell${selection.size===1?'':'s'} selected${$('#show-original').checked?' · viewing original':''}`;
  for(const id of ['apply-edit','restore-cells']) $(`#${id}`).disabled=$('#show-original').checked||!selection.size;
  const cell=$(`[data-cell="${index}"]`); if(cell&&view==='table') cell.focus({preventScroll:true});
  if(['curve','surface'].includes(view))renderPlot(map);
  renderEditPreview();
}
function editCell(index, initial) {
  if($('#show-original').checked) return toast('Switch off Show original to edit.');
  const cell=$(`[data-cell="${index}"]`), map=currentMap(); if(!cell || cell.querySelector('input')) return;
  const input=document.createElement('input'); input.type='text'; input.inputMode='decimal';
  const initialText=String(displayed(map,project.readMap(map.id))[index]); input.value=initial ?? initialText; input.setAttribute('aria-label',`Cell value ${mapUnit(map)}`); cell.replaceChildren(input);
  input.focus(); if(initial===undefined) input.select(); let done=false;
  const finish=(commit)=>{
    if(done)return; done=true;
    if(commit && input.value !== initialText) {
      try { if(!input.value.trim())throw new Error('Enter a numeric value.'); const value=Number(input.value)/mapDisplay(map).factor; if(project.editCells(map.id,[{index,value}],`Edit ${map.name}`))markDirty(); }
      catch(e){toast(e.message,true);}
    }
    render(); $(`[data-cell="${index}"]`)?.focus({preventScroll:true});
  };
  input.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Enter'){e.preventDefault();finish(true);}if(e.key==='Escape'){e.preventDefault();finish(false);}});
  input.addEventListener('blur',()=>finish(true));
}
function renderChanges() {
  const changes=project.diff(100), count=project.changedByteCount; $('#changed-count').textContent=`${count.toLocaleString()} bytes changed`;
  $('#changes').innerHTML=changes.length ? changes.slice(0,100).map(d=>`<div class="change-row"><span>0x${hex(d.offset)}</span><span>${hex(d.original,2)}</span><span>→ ${hex(d.modified,2)}</span></div>`).join('')+(count>100?'<p>Showing the first 100 changed bytes. Export the report for the full list.</p>':'') : '<p>No byte changes. Select cells above to start editing.</p>';
  if(!count&&!currentMap())$('#changes').innerHTML='<p>No byte changes. Select a hex byte or enter a byte range to edit.</p>';
}
function renderHex() {
  const payload = project.payloadInfo;
  if (!payload) hexScope = 'file';
  const base = hexScope === 'payload' ? payload.fileOffset : 0, length = hexScope === 'payload' ? payload.byteLength : project.byteLength, end = base + length;
  hexOffset=base+Math.max(0,Math.min(Math.floor((hexOffset-base)/16)*16,Math.floor((length-1)/16)*16));
  const windowLength=Math.min(256,end-hexOffset), bytes=project.readBytes(hexOffset,windowLength), original=project.readBytes(hexOffset,windowLength,{original:true});
  $('#hex-scope-field').hidden = !payload; $('#hex-scope').value = hexScope; $('#hex-offset-label').textContent = hexScope === 'payload' ? 'Image offset' : 'File offset';
  $('#hex-coordinate-note').hidden = !payload;
  $('#hex-coordinate-note').textContent = hexScope === 'payload' ? `Image 0x${hex(hexOffset-base)} = file 0x${hex(hexOffset)}. Byte edits below use file offsets; the wrapper is retained in your project.` : 'Whole-file offsets include the wrapper. Choose ECU image to use offsets relative to the inferred image.';
  $('#hex-offset').value='0x'+hex(hexOffset-base); let lines=[`${hexScope === 'payload' ? 'IMAGE ' : 'FILE  '}     00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F     ASCII`];
  for(let offset=hexOffset;offset<Math.min(end,hexOffset+256);offset+=16){
    let row=hex(offset-base)+'     ',ascii='';
    for(let j=0;j<16;j++) {const i=offset+j-hexOffset;if(i>=bytes.length){row+='   ';continue;}const v=hex(bytes[i],2),cell=`<button type="button" class="hex-byte" data-byte="${offset+j}" aria-label="Edit byte 0x${hex(offset+j)} value ${v}">${v}</button>`;row+=(bytes[i]!==original[i]?`<mark>${cell}</mark>`:cell)+' ';ascii+=bytes[i]>=32&&bytes[i]<=126?String.fromCharCode(bytes[i]):'.';}
    lines.push(row+'    '+esc(ascii));
  }
  $('#hex-data').innerHTML=lines.join('\n'); $('#hex-prev').disabled=hexOffset===base; $('#hex-next').disabled=hexOffset+256>=end;
}
function plotSetup(canvas) {
  const rect=canvas.getBoundingClientRect(), ratio=devicePixelRatio||1;
  canvas.width=Math.max(1,Math.round(rect.width*ratio));canvas.height=Math.max(1,Math.round(rect.height*ratio));
  const ctx=canvas.getContext('2d');ctx.scale(ratio,ratio);return {ctx,w:rect.width,h:rect.height};
}
function renderEditPreview() {
  const map=currentMap(), output=$('#edit-preview');
  output.hidden=!map; if(!map)return;
  if($('#show-original').checked){output.textContent='Viewing original values. Switch off Show original to edit the working copy.';return;}
  if(!selection.size){output.textContent='Select cells in the table or graph to preview an adjustment.';return;}
  try {
    const op=$('#edit-operation').value;
    const adjustment=editAdjustment(map,op,$('#edit-value').value);
    const result=selectionEditPreview(project,map,selection,adjustment.operation,adjustment.amount);
    const range=values=>{const low=Math.min(...values),high=Math.max(...values);return low===high?number(low):`${number(low)}–${number(high)}`;};
    output.textContent=`Preview · ${result.count} cell${result.count===1?'':'s'} · ${range(displayed(map,result.before))} → ${range(displayed(map,result.after))} ${mapUnit(map)||'raw units'} · ${result.changedBytes} byte${result.changedBytes===1?'':'s'} would change. Nothing applied yet.${op==='boost-request-percent'?' Changes the absolute-pressure request at fixed input before other limits; this is not a gauge-boost percentage.':''}`;
    output.classList.remove('invalid');$('#apply-edit').disabled=false;
  } catch(error){output.textContent=error.message;output.classList.add('invalid');$('#apply-edit').disabled=true;}
}
function renderPlot(map) {
  plotPoints=[];
  const selectedForPlot=[...selection][0];
  const previous=Number.isSafeInteger(selectedForPlot)?Math.floor(selectedForPlot/map.cols):(Number($('#plot-row').value)||0);
  $('#plot-row').innerHTML=Array.from({length:map.rows},(_,i)=>`<option value="${i}">${esc(number(map.yAxis?.[i]??i))} ${esc(map.yLabel)}</option>`).join('');
  $('#plot-row').value=String(Math.min(previous,map.rows-1));
  $('#curve-option').hidden=view!=='curve';$('#rotate-option').hidden=view!=='surface';
  $('#plot-description').textContent=view==='curve'?'Click a point to select · dashed original':'Click a point to select · rotate to inspect';
  const values=displayValues(map), originals=displayed(map,project.readOriginalMap(map.id)), {ctx,w,h}=plotSetup($('#plot'));
  ctx.clearRect(0,0,w,h);ctx.font='11px system-ui';ctx.lineWidth=1;
  if(view==='curve'){
    const r=Number($('#plot-row').value), v=values.slice(r*map.cols,(r+1)*map.cols), o=originals.slice(r*map.cols,(r+1)*map.cols);
    const x=map.xAxis||v.map((_,i)=>i); plotPoints=drawCurve(ctx,w,h,v,o,x,map.xLabel,mapUnit(map)).map((point,i)=>({...point,index:r*map.cols+i}));
  } else {
    const lo=Math.min(...values),hi=Math.max(...values),span=hi-lo||1, angle=Number($('#rotation').value)*Math.PI/180;
    const coordinate=(axis,count)=>{
      if(!axis||axis.length<2)return {at:i=>i/Math.max(1,count-1)-.5,scaled:false};
      const direction=Math.sign(axis[1]-axis[0]);
      if(!direction||axis.some((v,i)=>i&&Math.sign(v-axis[i-1])!==direction))return {at:i=>i/Math.max(1,count-1)-.5,scaled:false};
      const low=Math.min(...axis),span=Math.max(...axis)-low;return {at:i=>(axis[i]-low)/span-.5,scaled:true};
    };
    const xCoord=coordinate(map.xAxis,map.cols),yCoord=coordinate(map.yAxis,map.rows);
    const size=Math.min(w*.36,h*.7), projectPoint=(r,c,v)=>{
      const x=xCoord.at(c),y=yCoord.at(r);
      const rx=x*Math.cos(angle)-y*Math.sin(angle),ry=x*Math.sin(angle)+y*Math.cos(angle);
      return [w*.5+rx*size*1.5,h*.72+ry*size*.5-((v-lo)/span)*h*.4];
    };
    const polygons=[];
    for(let r=0;r<map.rows-1;r++)for(let c=0;c<map.cols-1;c++){
      const cells=[[r,c],[r,c+1],[r+1,c+1],[r+1,c]],points=cells.map(([rr,cc])=>projectPoint(rr,cc,values[rr*map.cols+cc]));
      const depth=(xCoord.at(c)+xCoord.at(c+1))/2*Math.sin(angle)+(yCoord.at(r)+yCoord.at(r+1))/2*Math.cos(angle);
      polygons.push({points,depth,mean:cells.reduce((s,[rr,cc])=>s+values[rr*map.cols+cc],0)/4});
    }
    polygons.sort((a,b)=>a.depth-b.depth);
    for(const p of polygons){ctx.beginPath();p.points.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.closePath();ctx.fillStyle=colour(p.mean,lo,hi);ctx.fill();ctx.strokeStyle='#8ce1c980';ctx.stroke();}
    if(map.rows===1||map.cols===1){ctx.strokeStyle='#6cd5c5';ctx.beginPath();values.forEach((v,i)=>{const p=projectPoint(Math.floor(i/map.cols),i%map.cols,v);i?ctx.lineTo(...p):ctx.moveTo(...p);});ctx.stroke();}
    ctx.fillStyle='#b9c6d3';ctx.fillText(`${map.xLabel} →`,25,h-25);ctx.textAlign='right';ctx.fillText(`${map.yLabel} ↗`,w-25,h-25);ctx.textAlign='left';ctx.fillText(`${mapNumber(map,lo)} to ${mapNumber(map,hi)} ${mapUnit(map)}`,25,28);
    ctx.fillStyle='#82909f';ctx.fillText(`X spacing: ${xCoord.scaled?'breakpoint values':'column index'} · Y spacing: ${yCoord.scaled?'breakpoint values':'row index'}`,25,h-7);
    plotPoints=values.map((value,index)=>{const [x,y]=projectPoint(Math.floor(index/map.cols),index%map.cols,value);return {x,y,index};});
    ctx.fillStyle='#a4ddd5';for(const point of plotPoints){ctx.beginPath();ctx.arc(point.x,point.y,2,0,Math.PI*2);ctx.fill();}
  }
  for(const point of plotPoints)if(selection.has(point.index)){ctx.beginPath();ctx.arc(point.x,point.y,5,0,Math.PI*2);ctx.fillStyle='#efb557';ctx.fill();ctx.strokeStyle='#11151a';ctx.lineWidth=1.5;ctx.stroke();}
  const selected=[...selection][0];
  $('#plot-edit-cell').disabled=$('#show-original').checked||!Number.isSafeInteger(selected);
  if(Number.isSafeInteger(selected))$('#plot-edit-cell').title=`Row ${Math.floor(selected/map.cols)+1}, column ${selected%map.cols+1}`;
}
function drawCurve(ctx,w,h,values,originals,xAxis,xLabel,unit){
  const right=w-30,top=28,bottom=h-55, all=[...values,...(originals||[])];
  let lo=Math.min(...all),hi=Math.max(...all);if(lo===hi){lo-=1;hi+=1;}const pad=(hi-lo)*.12;lo-=pad;hi+=pad;
  const ticks=Array.from({length:6},(_,i)=>number(Number((hi-i*(hi-lo)/5).toPrecision(6))));
  const left=Math.max(65,...ticks.map(label=>ctx.measureText(label).width+24));
  const xMin=Math.min(...xAxis),xMax=Math.max(...xAxis),x=i=>left+(xAxis[i]-xMin)/(xMax-xMin||1)*(right-left),y=v=>bottom-(v-lo)/(hi-lo)*(bottom-top);
  ctx.textAlign='right';ctx.fillStyle='#9caaba';ctx.strokeStyle='#35404d';
  for(let i=0;i<=5;i++){const yy=top+i*(bottom-top)/5;ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(right,yy);ctx.stroke();ctx.fillText(ticks[i],left-12,yy+4);}
  ctx.textAlign='center';const step=Math.max(1,Math.ceil(values.length/10));
  for(let i=0;i<values.length;i+=step)ctx.fillText(number(xAxis[i]),x(i),bottom+23);
  const line=(data,colour,dash)=>{ctx.strokeStyle=colour;ctx.lineWidth=2;ctx.setLineDash(dash);ctx.beginPath();data.forEach((v,i)=>i?ctx.lineTo(x(i),y(v)):ctx.moveTo(x(i),y(v)));ctx.stroke();ctx.setLineDash([]);};
  if(originals)line(originals,'#a5acb6',[5,5]);line(values,'#6cd5c5',[]);
  ctx.fillStyle='#6cd5c5';values.forEach((v,i)=>{ctx.beginPath();ctx.arc(x(i),y(v),3,0,Math.PI*2);ctx.fill();});
  ctx.fillStyle='#aebdcb';ctx.fillText(xLabel,w/2,h-10);ctx.textAlign='left';ctx.fillText(unit,12,15);
  return values.map((value,index)=>({x:x(index),y:y(value)}));
}
function askFile(action,accept) {if(busy)return toast('A file is still loading.');fileAction=action;$('#file-input').value='';$('#file-input').accept=accept;$('#file-input').click();}
async function handleFile(file){
  if(!file)return;
  const action=fileAction;
  const limit=action==='project'?LIMITS.fileBytes*3+2*1024*1024:action==='binary'?LIMITS.fileBytes:5*1024*1024;
  if(file.size>limit)throw new Error(`File is too large for ${action} import.`);
  if(['binary','project'].includes(action)&&!mayReplace())return;
  busy=true; const target=project,at=revision;
  const checkUnchanged=()=>{if(project!==target||revision!==at)throw new Error('The workspace changed while reading the file. Import cancelled; your current work was preserved.');};
  try{
    if(action==='binary'){const next=new CalibrationProject(new Uint8Array(await file.arrayBuffer()),{name:file.name});const assessment=await inspectFiatCalibration(next);checkUnchanged();installProject(next,assessment);}
    if(action==='project'){const next=/\.ols$/i.test(file.name)?new CalibrationProject(new Uint8Array(await file.arrayBuffer()),{name:file.name}):await CalibrationProject.fromJSON(await file.text());const assessment=await inspectFiatCalibration(next);checkUnchanged();installProject(next,assessment);}
    if(action==='definitions'){
      const content=JSON.parse(await file.text()),defs=Array.isArray(content)?content:content.maps;
      if(!Array.isArray(defs)||!defs.length)throw new Error('Definition JSON must be an array of map definitions, or an object with maps.');
      if(content.originalSha256 && content.originalSha256!==await sha256(project.original))throw new Error('Definitions do not match this original binary SHA-256.');
      // Validate the complete set on a disposable project before mutating the working project.
      checkUnchanged();new CalibrationProject(project.original,{maps:[...project.maps,...defs]});
      new CalibrationProject(project.bytes,{maps:defs});
      defs.forEach(def=>project.addMap(def));mapId=defs[0].id;selection=new Set([0]);anchor=0;view='table';markDirty();render();
      toast(`${defs.length} map definitions imported. Addresses and units still require verification.`);
    }
    if(action==='log'){selectedLog=parseMesLog(await file.text());renderLog();showWorkspace('diagnostics');toast('Saved diagnostic log imported.');}
  }finally{busy=false;}
}
export function showWorkspace(workspace){for(const name of ['tuning','diagnostics','live']){$(`#${name}-workspace`).hidden=name!==workspace;$(`#${name}-nav`).classList.toggle('active',name===workspace);}if(workspace==='tuning')render();else if(workspace==='diagnostics'&&selectedLog)renderLogChart();window.dispatchEvent(new CustomEvent('workspace-changed',{detail:workspace}));}
function renderLog(){
  const log=selectedLog;if(!log)return;
  $('#log-empty').hidden=true;$('#log-content').hidden=false;
  $('#log-summary').textContent=`${log.vehicle || 'Vehicle unrecorded'} · ${log.module || 'Module unrecorded'} · ${log.date || 'Date unrecorded'}`;
  $('#log-identity').innerHTML=Object.entries(log.identity).map(([k,v])=>`<div><small>${esc(k.replace(/([A-Z])/g,' $1'))}</small><strong>${esc(v)}</strong></div>`).join('');
  $('#log-limitations').textContent=log.limitations.join(' ');
  $('#log-faults').textContent=log.faults.length?log.faults.map(f=>`${f.code}: ${f.description}`).join(' · '):'No fault entries were found in this saved log. This is not a current fault-code check.';
  $('#log-channel').innerHTML=log.channels.map((c,i)=>`<option value="${i}">${esc(c.name)}${c.unit?' · '+esc(c.unit):''} (${c.samples.length})</option>`).join('');
  $('#log-controls').hidden=!log.channels.length;renderLogChart();
}
function renderLogChart(){
  if(!selectedLog||$('#diagnostics-workspace').hidden)return;
  const channel=selectedLog.channels[Number($('#log-channel').value)];
  $('#log-chart').hidden=!channel;$('#log-samples').innerHTML='';if(!channel)return;
  const numeric=channel.samples.filter(s=>typeof s.value==='number'&&Number.isFinite(s.value));
  $('#log-chart').hidden=!numeric.length;
  if(numeric.length){const {ctx,w,h}=plotSetup($('#log-chart'));ctx.font='11px system-ui';drawCurve(ctx,w,h,numeric.map(s=>s.value),null,numeric.map((_,i)=>i+1),'Recorded sample order (timing unavailable)',channel.unit);}
  $('#log-samples').innerHTML=`<thead><tr><th>Recorded sample</th><th>${esc(channel.name)} ${esc(channel.unit)}</th></tr></thead><tbody>${channel.samples.slice(0,100).map((s,i)=>`<tr><td>${i+1}</td><td>${esc(s.value)}</td></tr>`).join('')}</tbody>`;
  $('#log-sample-note').textContent=channel.samples.length>100?`Showing the first 100 of ${channel.samples.length} samples in the table.`:'';
}

$('#map-list').addEventListener('click',e=>{const b=e.target.closest('[data-map]');if(!b)return;mapId=b.dataset.map;selection=new Set([0]);anchor=0;hexOffset=currentMap().address;if(view==='catalogue')view='table';ensureHexScopeContains(hexOffset);render();});
$('#map-search').addEventListener('input',renderSidebar);
$('#map-filter').addEventListener('change',renderSidebar);
$('#catalogue-shape').addEventListener('change',renderSidebar);
$$('[data-view]').forEach(b=>b.addEventListener('click',()=>{view=b.dataset.view;if(view==='catalogue'){mapId=null;selection=new Set();}render();}));
$('#show-original').addEventListener('change',render);
$('#analyse-table').addEventListener('click',()=>{
  const map=currentMap();if(!map){if(view==='catalogue'&&mapCatalogue.current())window.dispatchEvent(new CustomEvent('workshop:analyse-table'));return;}
  if(map.rows*map.cols<=64){selection=new Set(Array.from({length:map.rows*map.cols},(_,index)=>index));anchor=0;render();}
  window.dispatchEvent(new CustomEvent('workshop:analyse-table'));
});
$('#table-view').addEventListener('click',e=>{if(e.target.tagName==='INPUT')return;const td=e.target.closest('[data-cell]');if(td)selectCell(Number(td.dataset.cell),e.shiftKey,e.ctrlKey||e.metaKey);});
$('#table-view').addEventListener('dblclick',e=>{const td=e.target.closest('[data-cell]');if(td)editCell(Number(td.dataset.cell));});
$('#table-view').addEventListener('keydown',e=>{
  if(e.target.tagName==='INPUT')return;const td=e.target.closest('[data-cell]'),map=currentMap();if(!td||!map)return;
  const i=Number(td.dataset.cell),moves={ArrowLeft:-1,ArrowRight:1,ArrowUp:-map.cols,ArrowDown:map.cols};
  if(e.key in moves){e.preventDefault();selectCell(Math.max(0,Math.min(map.rows*map.cols-1,i+moves[e.key])),e.shiftKey);}
  else if(e.key==='Enter'||e.key==='F2'){e.preventDefault();editCell(i);}
  else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='a'){e.preventDefault();selection=new Set(Array.from({length:map.rows*map.cols},(_,j)=>j));render();$(`[data-cell="${i}"]`)?.focus();}
  else if(!e.ctrlKey&&!e.metaKey&&/^[0-9.\-+]$/.test(e.key)){e.preventDefault();editCell(i,e.key);}
});
$('#table-view').addEventListener('paste',guard(e=>{
  if(e.target.tagName==='INPUT')return;const map=currentMap();if(!map||$('#show-original').checked)return;
  e.preventDefault();const raw=e.clipboardData.getData('text');if(raw.length>200000)throw new Error('Pasted table is too large.');
  const lines=raw.trim().split(/\r?\n/).map(line=>line.split(/\t|,/));const width=lines[0].length;
  if(!lines.length||lines.some(row=>row.length!==width))throw new Error('Paste a rectangular numeric table with tabs or commas.');
  const start=Math.min(...selection),row0=Math.floor(start/map.cols),col0=start%map.cols;
  if(!Number.isFinite(start)||row0+lines.length>map.rows||col0+width>map.cols)throw new Error('Pasted cells do not fit this map.');
  const cells=[];lines.forEach((row,r)=>row.forEach((value,c)=>{if(!value.trim())throw new Error('Pasted table contains a blank value.');cells.push({index:(row0+r)*map.cols+col0+c,value:Number(value)/mapDisplay(map).factor});}));
  if(project.editCells(map.id,cells,`Paste ${cells.length} cells`))markDirty();selection=new Set(cells.map(c=>c.index));render();toast('Table values pasted.');
}));
$('#apply-edit').addEventListener('click',guard(()=>{
  const map=currentMap();if(!map||!selection.size||$('#show-original').checked)return;
  const text=$('#edit-value').value;if(!text.trim())throw new Error('Enter an edit value.');const adjustment=editAdjustment(map,$('#edit-operation').value,text),op=adjustment.operation,n=adjustment.amount,values=project.readMap(map.id);
  const edits=[...selection].map(index=>({index,value:op==='set'?n:op==='add'?values[index]+n:values[index]*(1+n/100)}));
  if(project.editCells(map.id,edits,`${op} ${n} on ${edits.length} cells`))markDirty();render();toast('Edit applied. Stored values reflect the map’s encoding precision.');
}));
$('#edit-value').addEventListener('input',renderEditPreview);$('#edit-operation').addEventListener('change',renderEditPreview);
$('#restore-cells').addEventListener('click',guard(()=>{const map=currentMap();if(!map||$('#show-original').checked)return;if(project.restoreCells(map.id,[...selection],'Restore selected original values'))markDirty();render();}));
$('#copy-cells').addEventListener('click',guard(async()=>{
  const map=currentMap();if(!map||!selection.size)return;const values=displayValues(map),indices=[...selection];
  const rows=indices.map(i=>Math.floor(i/map.cols)),cols=indices.map(i=>i%map.cols),out=[];
  for(let r=Math.min(...rows);r<=Math.max(...rows);r++){const line=[];for(let c=Math.min(...cols);c<=Math.max(...cols);c++){const i=r*map.cols+c;if(!selection.has(i))throw new Error('Choose a rectangular selection to copy.');line.push(String(values[i]));}out.push(line.join('\t'));}
  await navigator.clipboard.writeText(out.join('\n'));toast('Selected cells copied as a table.');
}));
$('#undo').addEventListener('click',()=>{if(project.undo())markDirty();render();});$('#redo').addEventListener('click',()=>{if(project.redo())markDirty();render();});
document.addEventListener('keydown',e=>{if(['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName)||document.querySelector('dialog[open]'))return;if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();if(e.shiftKey?project.redo():project.undo())markDirty();render();}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();$('#save-project').click();}});
$('#plot-row').addEventListener('change',()=>{ const map=currentMap(); if(map) selectCell(Number($('#plot-row').value)*map.cols+(anchor%map.cols)); });$('#rotation').addEventListener('input',()=>renderPlot(currentMap()));
$('#plot').addEventListener('click',event=>{
  const rect=event.currentTarget.getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top;
  const point=plotPoints.map(p=>({...p,distance:Math.hypot(p.x-x,p.y-y)})).sort((a,b)=>a.distance-b.distance)[0];
  if(point&&point.distance<=24)selectCell(point.index,event.shiftKey,event.ctrlKey||event.metaKey);
});
function editPlottedCell(){const index=[...selection][0];if(!Number.isSafeInteger(index)||$('#show-original').checked)return;view='table';render();editCell(index);}
$('#plot-edit-cell').addEventListener('click',editPlottedCell);
$('#plot').addEventListener('keydown',event=>{const map=currentMap();if(!map)return;const moves={ArrowLeft:-1,ArrowRight:1,ArrowUp:-map.cols,ArrowDown:map.cols};if(event.key in moves){event.preventDefault();selectCell(Math.max(0,Math.min(map.rows*map.cols-1,([...selection][0]??0)+moves[event.key])),event.shiftKey);$('#plot').focus();}else if(event.key==='Enter'){event.preventDefault();editPlottedCell();}});
$('#hex-prev').addEventListener('click',()=>{hexOffset-=256;renderHex();});$('#hex-next').addEventListener('click',()=>{hexOffset+=256;renderHex();});
$('#hex-scope').addEventListener('change',()=>{hexScope=$('#hex-scope').value;if(hexScope==='payload'){const info=project.payloadInfo;if(info&&(hexOffset<info.fileOffset||hexOffset>=info.fileOffset+info.byteLength))hexOffset=info.fileOffset;}renderHex();});
$('#hex-go').addEventListener('click',guard(()=>{const input=$('#hex-offset').value.trim(),n=Number(input),payload=hexScope==='payload'?project.payloadInfo:null,length=payload?.byteLength??project.byteLength;if(!input||!Number.isSafeInteger(n)||n<0||n>=length)throw new Error(`Enter a byte offset within this ${payload?'image':'file'}.`);hexOffset=(payload?.fileOffset??0)+n;renderHex();}));
function ensureHexScopeContains(address){const info=project.payloadInfo;if(hexScope==='payload'&&(!info||address<info.fileOffset||address>=info.fileOffset+info.byteLength))hexScope='file';}
$('#hex-data').addEventListener('click',e=>{const cell=e.target.closest('[data-byte]');if(!cell)return;const address=Number(cell.dataset.byte);$('#hex-edit-offset').value='0x'+hex(address);$('#hex-edit-values').value=hex(project.readBytes(address,1)[0],2);$('#hex-restore-length').value='1';$('#hex-edit-values').focus();$('#hex-edit-values').select();});
$('#hex-edit-form').addEventListener('submit',guard(e=>{e.preventDefault();const raw=$('#hex-edit-offset').value.trim();if(!raw)throw new Error('Enter a byte offset.');const address=Number(raw),bytes=parseHexBytes($('#hex-edit-values').value);if(project.editBytes(address,bytes,'Hex edit at 0x'+hex(address)))markDirty();hexOffset=address;ensureHexScopeContains(address);$('#hex-restore-length').value=String(bytes.length);render();toast(`${bytes.length} byte${bytes.length===1?'':'s'} applied to working copy.`);}));
$('#hex-restore').addEventListener('click',guard(()=>{const raw=$('#hex-edit-offset').value.trim();if(!raw)throw new Error('Enter a byte offset.');const address=Number(raw),length=Number($('#hex-restore-length').value);if(project.restoreBytes(address,length))markDirty();hexOffset=address;ensureHexScopeContains(address);render();toast('Original bytes restored.');}));
$('#open-project').addEventListener('click',()=>askFile('project','.json,.tuneworkshop,.ols'));$('#load-binary').addEventListener('click',()=>askFile('binary',''));
$('#import-defs').addEventListener('click',()=>askFile('definitions','.json'));$('#file-input').addEventListener('change',guard(e=>handleFile(e.target.files[0])));
$('#export-defs').addEventListener('click',guard(async()=>{const target=project,maps=target.maps;if(!maps.length)throw new Error('Define a map before exporting definitions.');const hash=await sha256(target.original);await download(filename('.definitions.json',target),JSON.stringify({format:'tuneworkshop-map-definitions',version:1,originalSha256:hash,addressSpace:'file',maps},null,2));toast('Definitions exported for this exact original file.');}));
$('#demo').addEventListener('click',()=>{if(mayReplace())installProject(createDemoProject());});
$('#save-project').addEventListener('click',guard(async()=>{
  const target=project,at=revision,saveName=filename('.tuneworkshop.json',target);$('#save-project').disabled=true;
  try{const data=await target.serialize(),saved=await download(saveName,JSON.stringify(data));if(saved&&project===target&&revision===at)dirty=false;render();toast(saved?(window.workshopDesktop?'Project saved.':'Project download prepared. Keep the downloaded file to reopen your work.'):'Save cancelled or incomplete. Your work is still unsaved.');}finally{$('#save-project').disabled=false;}
}));
$('#export-csv').addEventListener('click',guard(()=>{const m=currentMap();if(!m)return;const v=displayValues(m),rows=[];for(let r=0;r<m.rows;r++)rows.push(v.slice(r*m.cols,(r+1)*m.cols).map(String).join(','));download(`${m.id}${$('#show-original').checked?'-original':''}${mapDisplay(m).converted?'-'+mapUnit(m).replace(/[^a-zA-Z0-9]/g,'-'):''}.csv`,rows.join('\r\n'),'text/csv');toast(`CSV exported in ${mapUnit(m)||'raw units'}, one map row per line.`);}));
$('#export-patch').addEventListener('click',guard(async()=>{
  const target=project,reportName=filename('.changes.json',target),maps=target.maps,changes=target.diff();const report={format:'tuneworkshop-change-report',version:1,project:target.name,synthetic:target.synthetic,ecuChecksum:'not-implemented',definitionValidation:'unverified',originalSha256:await sha256(target.original),maps,changes};
  download(reportName,JSON.stringify(report,null,2));
}));
function requestExport(scope = 'file') {
  const payload=scope==='payload'?project.payloadInfo:null;
  if(scope==='payload'&&!payload)return;
  exportTarget={project,revision,scope};
  $('#export-ack').checked=false;$('#confirm-export').disabled=true;
  $('#export-detail').textContent=payload?`${payload.byteLength.toLocaleString()} image bytes starting at file offset 0x${hex(payload.fileOffset)}. The ${payload.headerByteLength}-byte wrapper is excluded from this export and remains in your project. The image boundary and checksums are unverified.`:`${project.byteLength.toLocaleString()} bytes · ${project.changedByteCount} changed bytes${project.synthetic?' · Synthetic example data':''}${project.payloadInfo?' · Complete container, including its wrapper':''}`;
  $('#export-dialog').showModal();
}
$('#export-binary').addEventListener('click',()=>requestExport('file'));
$('#export-ack').addEventListener('change',()=>{$('#confirm-export').disabled=!$('#export-ack').checked;});$('#cancel-export').addEventListener('click',()=>$('#export-dialog').close());
$('#confirm-export').addEventListener('click',guard(async()=>{if(!$('#export-ack').checked||!exportTarget)return;if(project!==exportTarget.project||revision!==exportTarget.revision)throw new Error('The workspace changed. Reopen export to review the current draft.');const payload=exportTarget.scope==='payload',bytes=payload?project.exportPayload():project.exportBinary(),name=filename(payload?'.ECU-IMAGE.UNVERIFIED-DRAFT.bin':'.UNVERIFIED-DRAFT.bin');$('#export-dialog').close();exportTarget=null;const saved=await download(name,bytes,'application/octet-stream');toast(saved?'Draft binary saved. ECU checksum remains unverified.':'Draft export cancelled.');}));
$('#tuning-nav').addEventListener('click',()=>showWorkspace('tuning'));$('#diagnostics-nav').addEventListener('click',()=>showWorkspace('diagnostics'));
$('#import-log').addEventListener('click',()=>askFile('log','.txt,.log'));$('#log-channel').addEventListener('change',renderLogChart);
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
window.addEventListener('resize',()=>{if(['curve','surface'].includes(view)&&!$('#tuning-workspace').hidden&&currentMap())renderPlot(currentMap());if(selectedLog)renderLogChart();});
let displayedPressureUnit=getSettings().pressureUnit;
$('#pressure-unit').value=displayedPressureUnit;
$('#pressure-unit').addEventListener('change',guard(async()=>{
  const control=$('#pressure-unit');control.disabled=true;
  try{await saveSettings({pressureUnit:control.value});}
  finally{control.value=getSettings().pressureUnit;control.disabled=false;}
}));
subscribeSettings(settings=>{
  if(settings.pressureUnit===displayedPressureUnit)return;
  const map=currentMap(),text=$('#edit-value').value,op=$('#edit-operation').value;
  if(map&&op!=='percent'&&text.trim()&&Number.isFinite(Number(text))){
    const stored=pressureFromDisplay(Number(text),map.unit,displayedPressureUnit);
    $('#edit-value').value=String(stored*pressureDisplay(map.unit,settings.pressureUnit).factor);
  }
  displayedPressureUnit=settings.pressureUnit;$('#pressure-unit').value=displayedPressureUnit;
  render();window.dispatchEvent(new Event('workshop:display-units-changed'));
});
showWorkspace(getSettings().startupWorkspace);guard(updateHash)();

export function getSelectedTuningContext() {
  const map=currentMap();
  const markers={};
  for(const key of ['hardware','software']){const unique=[...new Set((project.fileInfo.identifiers[key]||[]).map(marker=>marker.value))];if(unique.length===1)markers[key]=unique[0];}
  const ecu=mapCatalogue.info?{source:'Loaded WinOLS project; ECU and vehicle compatibility are unverified'}:Object.keys(markers).length?{source:'identifiers observed in imported file; not verified against connected ECU',...markers}:{source:'Loaded calibration file; ECU identity unverified'};
  const context={vehicle:mapCatalogue.info?'Loaded WinOLS project; vehicle match unverified':'Loaded calibration file; vehicle match unverified',ecu,project:{name:project.name,synthetic:project.synthetic,originalSha256:originalHash,changedBytes:project.changedByteCount,checksumStatus:'unverified',definitionStatus:mapCatalogue.info&&!map?'Source catalogue only; numeric values unavailable':'unverified'},map:null};
  if(!map&&view==='catalogue'&&mapCatalogue.current()){
    const record=mapCatalogue.current();
    context.sourceMetadata={format:'winols-project',name:record.name||mapCatalogue.title(record),symbol:record.symbol,category:record.category,role:record.role,confidence:record.confidence,reason:record.reason,dimension1:record.dimension1,dimension2:record.dimension2,unit:record.unit,address:record.address,addressSpace:'project-image-unresolved',factor:record.factor,offset:record.offset,valuesAvailable:false,axes:record.axes.map(axis=>({label:axis.label,unit:axis.unit,count:axis.count,address:axis.address,factor:axis.factor,offset:axis.offset,source:axis.source}))};
  }
  if(map){try{
    const values=displayed(map,project.readMap(map.id)),original=displayed(map,project.readOriginalMap(map.id)),indices=[...selection].sort((a,b)=>a-b).slice(0,64);
    const encoding={type:map.type,endian:map.endian,factor:map.factor,offset:map.offset,sourceUnit:map.unit,displayScale:mapDisplay(map).factor,fileOffset:map.address,addressStatus:'file-offsets-not-ecu-addresses'};
    if(project.payloadInfo){try{encoding.imageOffset=project.fileToPayloadOffset(map.address,map.rows*map.cols*TYPES[map.type].bytes);}catch{/* Only map ranges entirely within the image receive an image offset. */}}
    context.map={name:map.name,unit:mapUnit(map),rows:map.rows,cols:map.cols,xLabel:map.xLabel,yLabel:map.yLabel,category:map.category,role:map.role,definitionStatus:map.definitionStatus,evidence:map.evidence,notes:map.notes,encoding,selectionTotal:selection.size,selectionTruncated:selection.size>64,cells:indices.map(index=>({row:Math.floor(index/map.cols),column:index%map.cols,x:map.xAxis?.[index%map.cols]??index%map.cols,y:map.yAxis?.[Math.floor(index/map.cols)]??Math.floor(index/map.cols),original:original[index],modified:values[index]}))};
  }catch{context.project.definitionStatus='Raw edits cannot be decoded by the selected map; numeric cells omitted.';}}
  return context;
}
