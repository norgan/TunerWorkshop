import { TYPES } from './core.mjs';
import { formatEngineeringNumber as number } from './formats.mjs';
import { MAP_CATEGORIES, MAP_ROLES, DEFINITION_STATES, definitionFromFields, readOriginalAxis, previewDefinition } from './map-workbench-model.mjs';

const $ = selector => document.querySelector(selector);
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const options = values => Object.entries(values).map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('');
const types = Object.fromEntries(Object.keys(TYPES).map(value => [value, value]));
const guides = {
  boost: 'Identify pressure targets, limiters and wastegate control separately. Record whether pressure is absolute or relative, and the actual stored unit.',
  ignition: 'Distinguish base spark advance from temperature, knock and other corrections. Confirm the sign and degree scaling for each table.',
  fuel: 'Distinguish target lambda or AFR from injection and enrichment tables. AFR depends on the fuel’s stoichiometric ratio; units are never converted automatically.',
  other: 'Record the table’s purpose, dimensions, axes and conversion using evidence for this software version.',
};

export function createMapWorkbench({ getProject, getCurrentMap, onSaved, toast }) {
  const dialog = $('#map-dialog');
  dialog.innerHTML = `<form id="map-form">
    <div class="dialog-heading"><h2 id="map-dialog-title">Map setup</h2><button type="button" id="close-map" aria-label="Close map setup">×</button></div>
    <p>Turn an identified table into named values and axes. Previewing or saving a definition leaves the tune bytes unchanged.</p>
    <div class="form-grid">
      <label class="wide">Map name<input name="name" required maxlength="200" placeholder="Name supported by your reference"></label>
      <label>System<select name="category">${options(MAP_CATEGORIES)}</select></label>
      <label>Table role<select name="role">${options(MAP_ROLES)}</select></label>
    </div><p id="map-family-guide" class="map-guide"></p>
    <details class="map-stage" open><summary>1 · Location and table shape</summary><div class="form-grid">
      <label>Offsets<select name="addressSpace"><option value="file">Whole file</option><option value="payload">ECU image (without wrapper)</option></select></label>
      <label>Table starts at<input name="address" required placeholder="0x381000"></label>
      <label>Rows (Y)<input name="rows" type="number" min="1" max="64" required></label>
      <label>Columns (X)<input name="cols" type="number" min="1" max="64" required></label>
      <label>Stored values<select name="type">${options(types)}</select></label>
      <label>Byte order<select name="endian"><option value="little">Little endian</option><option value="big">Big endian</option></select></label>
    </div></details>
    <details class="map-stage" open><summary>2 · Values and units</summary><div class="form-grid">
      <label>Unit<input name="unit" maxlength="40" placeholder="e.g. kPa absolute, °BTDC, λ"></label>
      <label>Scale factor<input name="factor" type="number" step="any" required></label>
      <label>Value offset<input name="offset" type="number" step="any" required></label>
      <label>Definition basis<select name="definitionStatus">${options(DEFINITION_STATES)}</select></label>
    </div><p class="hint">Displayed value = stored value × scale factor + value offset. The category does not set units or scaling.</p></details>
    <details class="map-stage" open><summary>3 · Axes and breakpoints</summary><div class="form-grid">
      <label>X axis label<input name="xLabel" maxlength="80"></label><label>Y axis label<input name="yLabel" maxlength="80"></label>
      <label class="wide">X breakpoints · one per column<input name="xAxis" placeholder="Comma separated; blank uses column indices"></label>
      <label class="wide">Y breakpoints · one per row<input name="yAxis" placeholder="Comma separated; blank uses row indices"></label>
    </div><details class="axis-reader"><summary>Read breakpoints from the original image</summary><div class="form-grid">
      <label>Axis<select id="axis-target"><option value="xAxis">X · columns</option><option value="yAxis">Y · rows</option></select></label>
      <label>Axis starts at<input id="axis-address" value="0x0"></label>
      <label>Stored values<select id="axis-type">${options(types)}</select></label>
      <label>Byte order<select id="axis-endian"><option value="big">Big endian</option><option value="little">Little endian</option></select></label>
      <label>Scale factor<input id="axis-factor" type="number" step="any" value="1"></label>
      <label>Value offset<input id="axis-offset" type="number" step="any" value="0"></label>
    </div><p class="hint">Uses the offset system above. Copies original values into this definition; changing these breakpoints does not edit the ECU’s axis bytes.</p><button type="button" id="read-axis">Read original breakpoints</button></details></details>
    <details class="map-stage"><summary>4 · Evidence and notes</summary><div class="form-grid">
      <label class="wide">Evidence / source<input name="evidence" maxlength="1000" placeholder="Exact software, reference symbol, observations"></label>
      <label class="wide">Notes<textarea name="notes" rows="3" maxlength="2000" placeholder="What is known and what still needs checking"></textarea></label>
    </div><p class="hint">A reference definition or your label is not automatic verification for this ECU.</p></details>
    <section class="map-preview" aria-label="Definition preview"><div class="section-heading"><span>PREVIEW · WORKING VALUES</span><button type="button" id="preview-map">Refresh preview</button></div><p id="map-preview-summary" role="status"></p><div id="map-preview-table"></div></section>
    <p id="map-error" role="alert"></p><div class="dialog-actions"><button type="button" id="cancel-map">Cancel</button><button type="submit" class="primary" id="save-map-definition">Save definition</button></div>
  </form>`;
  const form = $('#map-form');
  let target = null, base = null, capturedMap = null, timer;
  const field = name => form.elements.namedItem(name);
  const fields = () => Object.fromEntries(new FormData(form));
  function ensureCurrent() {
    if (getProject() !== target) throw new Error('The project changed. Reopen map setup.');
    if (capturedMap && JSON.stringify(target.maps.find(map => map.id === base.id)) !== capturedMap) throw new Error('The definition changed. Reopen map setup.');
  }
  function draft() { ensureCurrent(); return definitionFromFields(target, fields(), base); }
  function preview() {
    clearTimeout(timer);
    try {
      const result = previewDefinition(target, draft(), capturedMap ? base.id : undefined), { map, values } = result;
      $('#map-error').textContent = '';
      $('#save-map-definition').disabled = false;
      $('#map-preview-summary').textContent = `${map.rows} rows × ${map.cols} columns · ${number(result.min)} to ${number(result.max)} ${map.unit || 'raw units'} · file 0x${map.address.toString(16).toUpperCase()}–0x${(result.end - 1).toString(16).toUpperCase()}${map.rows > 8 || map.cols > 10 ? ' · first 8 rows / 10 columns shown' : ''}`;
      let html = `<table><caption>${esc(map.yLabel)} ↓ / ${esc(map.xLabel)} →</caption><thead><tr><th>${esc(map.unit || 'Raw')}</th>`;
      for (let c = 0; c < Math.min(map.cols, 10); c++) html += `<th>${esc(number(map.xAxis?.[c] ?? c))}</th>`;
      html += '</tr></thead><tbody>';
      for (let r = 0; r < Math.min(map.rows, 8); r++) {
        html += `<tr><th>${esc(number(map.yAxis?.[r] ?? r))}</th>`;
        for (let c = 0; c < Math.min(map.cols, 10); c++) html += `<td>${esc(number(values[r * map.cols + c]))}</td>`;
        html += '</tr>';
      }
      $('#map-preview-table').innerHTML = html + '</tbody></table>';
      return result;
    } catch (error) {
      $('#map-error').textContent = error.message; $('#map-preview-summary').textContent = 'Complete the definition to preview its values.';
      $('#map-preview-table').replaceChildren(); $('#save-map-definition').disabled = true;
      return null;
    }
  }
  function open(map = null, seed = {}) {
    target = getProject(); base = map ? structuredClone(map) : { id: `map-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}` };
    capturedMap = map ? JSON.stringify(map) : null;
    form.reset();
    const defaults = { name: '', address: '0x0', addressSpace: target.payloadInfo ? 'payload' : 'file', rows: 8, cols: 8, type: 'uint16', endian: 'big', unit: '', factor: 1, offset: 0, xLabel: 'Column', yLabel: 'Row', category: 'other', role: 'unknown', definitionStatus: 'candidate', notes: '', evidence: '', ...map, ...seed };
    if (map) {
      defaults.addressSpace = 'file';
      if (target.payloadInfo) { try { defaults.address = target.fileToPayloadOffset(map.address, map.rows * map.cols * TYPES[map.type].bytes); defaults.addressSpace = 'payload'; } catch { /* This map is outside the candidate payload. */ } }
    }
    defaults.address = defaults.address === '' ? '' : `0x${Number(defaults.address).toString(16).toUpperCase()}`;
    for (const [key, value] of Object.entries(defaults)) { const input = field(key); if (input) input.value = Array.isArray(value) ? value.map(String).join(', ') : String(value); }
    field('addressSpace').querySelector('[value="payload"]').disabled = !target.payloadInfo;
    $('#axis-type').value = defaults.type; $('#axis-endian').value = defaults.endian;
    $('#map-dialog-title').textContent = map ? 'Refine map definition' : 'Define a map';
    $('#map-family-guide').textContent = guides[defaults.category];
    $('#map-error').textContent = ''; dialog.showModal(); preview(); field('name').focus();
  }
  form.addEventListener('input', () => { $('#map-family-guide').textContent = guides[field('category').value]; clearTimeout(timer); timer = setTimeout(preview, 180); });
  form.addEventListener('change', () => { $('#map-family-guide').textContent = guides[field('category').value]; preview(); });
  $('#preview-map').addEventListener('click', preview);
  $('#read-axis').addEventListener('click', () => {
    try {
      ensureCurrent(); const key = $('#axis-target').value;
      const values = readOriginalAxis(target, { address: $('#axis-address').value, addressSpace: field('addressSpace').value, count: field(key === 'xAxis' ? 'cols' : 'rows').value, type: $('#axis-type').value, endian: $('#axis-endian').value, factor: $('#axis-factor').value, offset: $('#axis-offset').value });
      field(key).value = values.map(String).join(', '); preview();
    } catch (error) { $('#map-error').textContent = error.message; }
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    try {
      ensureCurrent(); const result = preview(); if (!result) return;
      const saved = capturedMap ? target.updateMap(base.id, result.map) : target.addMap(result.map);
      dialog.close(); onSaved(saved); toast('Definition saved. Tune bytes unchanged; use Table, 2D curve or 3D surface to inspect it.');
    } catch (error) { $('#map-error').textContent = error.message; }
  });
  for (const id of ['close-map', 'cancel-map']) $(`#${id}`).addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => clearTimeout(timer));
  $('#add-map').addEventListener('click', () => open()); $('#empty-define').addEventListener('click', () => open());
  $('#edit-map-definition').addEventListener('click', () => { const map = getCurrentMap(); if (map) open(map); });
  return { open };
}
