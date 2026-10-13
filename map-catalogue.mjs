const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const GROUPS = Object.freeze({boost:'Boost',ignition:'Ignition timing',fuel:'Fuel / AFR',other:'Other source maps'});
const PAGE_SIZE = 60;
const address = value => Number.isSafeInteger(value) && value >= 0 ? `0x${value.toString(16).toUpperCase()}` : 'Not recorded';
const number = value => typeof value === 'number' && Number.isFinite(value) ? String(value) : 'Not recorded';
const shape = record => record.dimension1 === 1 && record.dimension2 === 1 ? 'Scalar' : `${record.dimension1} × ${record.dimension2}`;
const title = record => record.displayName || record.name || record.symbol || 'Unnamed source map';
const categoryOf = record => Object.hasOwn(GROUPS,record.category) ? record.category : 'other';
const shapeOf = record => record.dimension1 > 1 && record.dimension2 > 1 ? 'table' : record.dimension1 > 1 || record.dimension2 > 1 ? 'curve' : 'scalar';
const priority = record => ({table:0,curve:2,scalar:4})[shapeOf(record)] + (record.role === 'target' ? 0 : 1);
const MAIN_SYMBOLS = new Set(['TBDPREUTHDYN','PQAV','PQLAMMP']);
const variantPriority = record => {
  const symbol = String(record.symbol || '').trim().toUpperCase();
  return MAIN_SYMBOLS.has(symbol) ? 0 : symbol.includes('CNG') || /\bCNG\b/i.test(record.name || '') ? 2 : 1;
};

/** Source definitions are metadata, never CalibrationProject maps or byte offsets. */
export function createMapCatalogue({onSelect,onPageChange}) {
  let info = null, sourceName = '', records = [], selectedId = null, page = 0, queryKey = '';
  const current = () => records.find(record => String(record.id) === selectedId) || records[0] || null;
  $('#map-list').addEventListener('click', event => {
    const item = event.target.closest('[data-source-map]');
    if (item && records.some(record => String(record.id) === item.dataset.sourceMap)) { selectedId = item.dataset.sourceMap; onSelect(current()); }
    const paging = event.target.closest('[data-catalogue-page]');
    if (paging && !paging.disabled) { page += Number(paging.dataset.cataloguePage); onPageChange(); $('#source-catalogue-heading')?.scrollIntoView({block:'nearest'}); }
  });
  function install(project, inspection) {
    info = inspection; sourceName = project.name; page = 0; queryKey = '';
    records = info ? Object.keys(GROUPS).flatMap(category => info.records.filter(record => categoryOf(record) === category).sort((a,b)=>priority(a)-priority(b)||variantPriority(a)-variantPriority(b))) : [];
    selectedId = records.length ? String(records[0].id) : null;
    $('#ols-source').hidden = !info;
    $('#catalogue-tab').hidden = !info;
    $('#catalogue-shape-field').hidden = !info;
    $('#catalogue-shape').value = 'all';
    $('#tuning-workspace').classList.toggle('with-source-catalogue',!!info);
    if (info) {
      $('#ols-source-name').textContent = sourceName;
      $('#ols-source-status').textContent = `WinOLS project · ${records.length.toLocaleString()} saved map definitions · ${info.supported ? 'Catalogue recovered' : 'Catalogue not supported'}`;
      $('#ols-source-vehicle').textContent = 'Loaded file identity is separate from the Fiat vehicle profile above. A match to this car has not been established.';
    }
  }
  function sidebar({search,category,active,shapeFilter='all'}) {
    if (!info) return '';
    const key = `${category}\0${search}\0${shapeFilter}`; if (key !== queryKey) { page = 0; queryKey = key; }
    const matching = records.filter(record => (category === 'all' || categoryOf(record) === category) && (shapeFilter === 'all' || shapeOf(record) === shapeFilter) && `${title(record)} ${record.name} ${record.symbol} ${record.unit}`.toLowerCase().includes(search));
    const pages = Math.max(1,Math.ceil(matching.length/PAGE_SIZE)); page = Math.max(0,Math.min(page,pages-1));
    const visible = matching.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE);
    const groups = Object.entries(GROUPS).map(([key,label]) => {
      const group = visible.filter(record => categoryOf(record) === key);
      if (!group.length) return '';
      const total = matching.filter(record => categoryOf(record) === key).length;
      return `<section class="map-group source-map-group"><h2>${escape(label)} <span>${total.toLocaleString()}</span></h2>${group.map(record => `<button class="map-item source-map-item ${active && String(record.id) === selectedId ? 'active' : ''}" data-source-map="${escape(record.id)}" aria-pressed="${active && String(record.id) === selectedId}"><span aria-hidden="true">▤</span><span><strong>${escape(title(record))}</strong><small>${escape(record.symbol || 'No saved symbol')}</small><small>${escape(shape(record))}${record.unit ? ` · ${escape(record.unit)}` : ''} · Saved definition</small></span></button>`).join('')}</section>`;
    }).join('');
    const status = matching.length ? `${page*PAGE_SIZE+1}–${Math.min((page+1)*PAGE_SIZE,matching.length)} of ${matching.length.toLocaleString()} matching` : 'No source maps match this search or category.';
    return `<section class="source-catalogue-list" aria-label="Source map catalogue"><h2 id="source-catalogue-heading">Source catalogue <span>${records.length.toLocaleString()}</span></h2><p class="hint">Names and definitions saved in this WinOLS file.</p>${groups || `<p class="hint">${escape(info.supported ? status : info.message || 'This project format is not supported yet.')}</p>`}<div class="catalogue-pagination"><span id="catalogue-page-status" role="status">${escape(status)}</span><div><button data-catalogue-page="-1" ${page === 0 ? 'disabled' : ''}>Previous maps</button><button data-catalogue-page="1" ${page+1 >= pages ? 'disabled' : ''}>Next maps</button></div></div></section>`;
  }
  function renderPanel(visible) {
    $('#catalogue-view').hidden = !info || !visible;
    if (!info || !visible) return;
    const record = current();
    if (!record) { $('#catalogue-view').innerHTML = `<div class="catalogue-unresolved"><h2>WinOLS project recognised</h2><p>${escape(info.message || 'The catalogue layout is not supported yet.')}</p><p>Project bytes remain available in Hex. No calibration values have been decoded.</p></div>`; return; }
    const pair = (label,value) => `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`;
    const axes = (record.axes || []).map((axis,index) => `<article><h3>${escape(axis.label || `Axis ${index+1}`)}</h3><dl>${pair('Unit',axis.unit || 'Not recorded')}${pair('Saved points',number(axis.count))}</dl><details><summary>Saved axis definition</summary><dl>${pair('Stored address',address(axis.address))}${pair('Factor',number(axis.factor))}${pair('Offset',number(axis.offset))}${pair('Source field',axis.source ?? 'Not recorded')}</dl><p>Breakpoint values have not been decoded.</p></details></article>`).join('');
    $('#catalogue-view').innerHTML = `<section class="catalogue-purpose"><span class="eyebrow">SAVED MAP DESCRIPTION</span><h2>${escape(record.name || title(record))}</h2><p class="catalogue-symbol">${escape(record.symbol || 'No saved symbol')}</p><p>${escape(record.reason || 'The original project supplies this map name and definition; its function has not been independently verified.')}</p><p class="hint">Category and role come from interpretation of saved labels. ${escape(record.confidence ? `Classification: ${record.confidence}.` : '')}</p></section><dl class="catalogue-summary">${pair('Saved shape',shape(record))}${pair('Output unit',record.unit || 'Not recorded')}${pair('Category',GROUPS[record.category] || GROUPS.other)}${pair('Suggested role',record.role && record.role !== 'unknown' ? record.role : 'Unconfirmed')}</dl><section class="catalogue-unresolved" role="status"><h2>Map values are not decoded yet</h2><p>This project contains a named definition for this map. Its numeric calibration values and axis breakpoints have not been recovered, so a table or graph is not available yet.</p></section>${axes ? `<section class="catalogue-axes" aria-label="Saved axis definitions">${axes}</section>` : ''}<details class="catalogue-technical"><summary>Saved scaling and address</summary><dl>${pair('Stored map address',address(record.address))}${pair('Factor',number(record.factor))}${pair('Offset',number(record.offset))}</dl><p>These are addresses stored in the WinOLS definition. They are not confirmed offsets into this project file or addresses in the connected ECU. Hex shows the native file bytes using file offsets.</p></details>`;
  }
  return {install,sidebar,renderPanel,current,get info(){return info;},get count(){return records.length;},title,shape};
}
