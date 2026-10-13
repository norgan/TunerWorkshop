/** Renderer integration checks using only an isolated, generated workspace. */
export async function runMapWorkbenchSmoke(contents) {
  return contents.executeJavaScript(`(${mapWorkbenchSmokeInRenderer.toString()})()`);
}

async function mapWorkbenchSmokeInRenderer() {
  const $ = selector => document.querySelector(selector);
  const all = selector => [...document.querySelectorAll(selector)];
  const assert = (condition, message) => { if (!condition) throw new Error(`Map workbench smoke: ${message}`); };
  const until = async (predicate, message) => {
    const deadline = Date.now() + 15000;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert(predicate(), message);
  };
  const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const { CalibrationProject, createDemoProject } = await import('./core.mjs');
  const { getSelectedTuningContext } = await import('./app.mjs');
  assert(window.workshopDesktop, 'the native desktop save bridge is required');
  assert($('#sensor-strip').hidden, 'a sensor session was active before the isolated test');
  for (const dialog of all('dialog[open]')) dialog.close();
  if (!$('#assistant-panel').hidden) $('#assistant-close').click();
  $('#tuning-nav').click();

  const originalConfirm = window.confirm, originalCreateURL = URL.createObjectURL;
  const downloads = [];
  // This override approves replacement only inside the explicit synthetic smoke.
  // Downloads still go through the normal Electron completion notification.
  window.confirm = () => true;
  URL.createObjectURL = function(blob) {
    const url = originalCreateURL.call(URL, blob);
    downloads.push({ blob, url });
    return url;
  };
  const field = name => $('#map-form').elements.namedItem(name);
  const set = (name, value) => { field(name).value = String(value); };
  const change = (selector, value) => { $(selector).value = String(value); $(selector).dispatchEvent(new Event('change', { bubbles: true })); };
  const selected = () => getSelectedTuningContext().map.cells[0];
  const changedCount = () => getSelectedTuningContext().project.changedBytes;
  const currentBytesUnchanged = baseline => assert(changedCount() === baseline, 'preview or definition validation altered tune bytes');
  const injectProject = async (json, expectedFirstMap) => {
    const input = $('#file-input'), click = input.click;
    input.click = () => {};
    try { $('#open-project').click(); } finally { input.click = click; }
    const transfer = new DataTransfer();
    transfer.items.add(new File([JSON.stringify(json)], 'synthetic-map-workbench.tuneworkshop.json', { type: 'application/json' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => $('#project-name').textContent === json.name && $('#map-name').textContent === expectedFirstMap && !$('#save-project').textContent.includes('•'), 'synthetic workspace did not load');
    $('[data-view="table"]').click();
  };
  const saveProject = async () => {
    const previous = downloads.length;
    $('#save-project').click();
    await until(() => !$('#save-project').disabled && downloads.length > previous, 'native workspace save did not complete');
    assert(!$('#save-project').textContent.includes('•'), 'native workspace save was cancelled or failed');
    for (const item of downloads.slice(previous).reverse()) {
      const json = JSON.parse(await item.blob.text());
      if (json.format === 'tuneworkshop-workspace') return json;
    }
    throw new Error('Map workbench smoke: saved workspace blob was not captured');
  };
  const graphPoints = async view => {
    const originalArc = CanvasRenderingContext2D.prototype.arc, points = [];
    CanvasRenderingContext2D.prototype.arc = function(x, y, radius, ...rest) {
      if (this.canvas.id === 'plot' && radius > 0 && radius <= 8) points.push({ x, y });
      return originalArc.call(this, x, y, radius, ...rest);
    };
    try { $(`[data-view="${view}"]`).click(); await frames(); }
    finally { CanvasRenderingContext2D.prototype.arc = originalArc; }
    assert(!$('#plot-view').hidden, `${view} graph did not open`);
    return points.filter((point, index) => points.findIndex(other => Math.abs(other.x - point.x) < .01 && Math.abs(other.y - point.y) < .01) === index);
  };
  const graphKey = key => $('#plot').dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const clickGraphPoint = point => {
    const rect = $('#plot').getBoundingClientRect();
    $('#plot').dispatchEvent(new MouseEvent('click', { clientX: rect.left + point.x, clientY: rect.top + point.y, bubbles: true }));
  };

  try {
    const demo = createDemoProject(), bytes = demo.original, binary = new DataView(bytes.buffer);
    const axis = [1000, 2000, 3000, 4000];
    axis.forEach((value, index) => binary.setUint16(0x0800 + index * 2, value, false));
    const fixture = new CalibrationProject(bytes, { name: 'Synthetic map workbench smoke', maps: demo.maps, synthetic: true });
    // The first working breakpoint is deliberately different from the source.
    // The axis reader must still return 1000, not this working value of 5555.
    fixture.editBytes(0x0800, [0x15, 0xb3], 'Synthetic axis divergence');
    fixture.editBytes(0x0A00, [0, 0, 0xc0, 0x7f], 'Synthetic raw NaN for failed import');
    const fixtureJSON = await fixture.serialize(), baseline = fixture.changedByteCount;
    assert(baseline === 4, 'the generated fixture has unexpected changed bytes');
    await injectProject(fixtureJSON, 'Synthetic fuel VE');
    const importsBefore=all('#map-list [data-map]').map(item=>item.dataset.map).join(',');
    const importInput=$('#file-input'), savedClick=importInput.click;
    importInput.click=()=>{}; try { $('#import-defs').click(); } finally { importInput.click=savedClick; }
    const imports=new DataTransfer(); imports.items.add(new File([JSON.stringify([
      {id:'must-not-import',name:'Valid first definition',address:0x900,rows:1,cols:1,type:'uint8'},
      {id:'invalid-working-float',name:'Invalid working float',address:0xa00,rows:1,cols:1,type:'float32',endian:'little'},
    ])],'invalid-definitions.json',{type:'application/json'}));
    $('#toast').hidden=true; importInput.files=imports.files; importInput.dispatchEvent(new Event('change',{bubbles:true}));
    await until(()=>!$('#toast').hidden && $('#toast').classList.contains('error'),'invalid definition import did not report a failure');
    const failedImportSave=await saveProject();
    assert(failedImportSave.maps.length===demo.maps.length && all('#map-list [data-map]').map(item=>item.dataset.map).join(',')===importsBefore,'failed import partially changed map definitions');
    currentBytesUnchanged(baseline);
    $('[data-map="demo-ignition"]').click();
    assert(selected().modified === 11 && selected().original === 11, 'ignition demo values do not match the fixture');
    $('#edit-map-definition').click();
    assert($('#map-dialog').open, 'Map setup did not open');
    assert(field('category').value === 'ignition' && field('type').value === 'int16', 'the existing definition was not populated');

    set('name', 'Synthetic boost reference'); set('rows', 2); set('cols', 4);
    set('category', 'boost'); set('role', 'target'); set('definitionStatus', 'reference');
    set('xLabel', 'Synthetic RPM'); set('yLabel', 'Synthetic load');
    set('xAxis', axis.join(', ')); set('yAxis', '20, 40');
    set('evidence', 'Generated fixture only; software-independent UI test.');
    set('notes', 'Manual reference label; no ECU meaning claimed.');
    $('#preview-map').click();
    assert(!$('#save-map-definition').disabled && !$('#map-error').textContent, 'valid shape and metadata did not preview');
    const previewValues = all('#map-preview-table tbody td').map(cell => Number(cell.textContent));
    assert(JSON.stringify(previewValues) === JSON.stringify([11, 14, 17, 20, 23, 26, 29, 32]), 'reshaped preview decoded the wrong bytes');
    assert(field('unit').value === '°' && field('factor').value === '0.1', 'category selection silently changed units or scaling');
    currentBytesUnchanged(baseline);

    set('xAxis', '1000, 2000, 3000'); $('#preview-map').click();
    assert($('#save-map-definition').disabled && $('#map-error').textContent, 'wrong breakpoint count was accepted');
    $('#map-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    assert($('#map-dialog').open && $('#map-name').textContent === 'Synthetic ignition', 'invalid axis count committed a definition');
    currentBytesUnchanged(baseline);
    set('xAxis', axis.join(', ')); $('#preview-map').click();

    $('#axis-target').value = 'xAxis'; $('#axis-address').value = '0xFFF';
    $('#axis-type').value = 'uint16'; $('#axis-endian').value = 'big';
    $('#axis-factor').value = '1'; $('#axis-offset').value = '0';
    const beforeBadAxis = field('xAxis').value;
    $('#read-axis').click();
    assert($('#map-error').textContent && field('xAxis').value === beforeBadAxis, 'out-of-range axis read was not rejected atomically');
    $('#axis-address').value = '0x800'; $('#read-axis').click();
    assert(!$('#map-error').textContent && field('xAxis').value === '1000, 2000, 3000, 4000', 'axis reader did not use the immutable original bytes');
    currentBytesUnchanged(baseline);

    for (const [name, value] of [['address', '0x100'], ['factor', '0']]) {
      const previous = field(name).value; set(name, value); $('#preview-map').click();
      assert($('#save-map-definition').disabled && $('#map-error').textContent, `malformed ${name} was accepted`);
      $('#map-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      assert($('#map-dialog').open && $('#map-name').textContent === 'Synthetic ignition', `invalid ${name} changed the project definition`);
      currentBytesUnchanged(baseline); set(name, previous); $('#preview-map').click();
    }
    $('#save-map-definition').click();
    assert(!$('#map-dialog').open && $('#map-name').textContent === 'Synthetic boost reference', 'definition save did not refresh the selected map');
    assert(all('#table-view [data-cell]').length === 8, 'saved shape did not reach the table');
    assert($('#map-definition-info').textContent.includes('Generated fixture only; software-independent UI test.'), 'saved evidence is not displayed');
    currentBytesUnchanged(baseline);

    change('#map-filter', 'boost');
    assert(JSON.stringify(all('#map-list [data-map]').map(button => button.dataset.map)) === JSON.stringify(['demo-ignition']), 'boost filtering did not use the edited category');
    change('#map-filter', 'fuel');
    assert(JSON.stringify(all('#map-list [data-map]').map(button => button.dataset.map).sort()) === JSON.stringify(['demo-lambda', 'demo-ve']), 'fuel filtering omitted or misclassified demo maps');
    change('#map-filter', 'ignition'); assert(all('#map-list [data-map]').length === 0, 'old category remained after replacement');
    change('#map-filter', 'all');

    $('#plot-row').value = '0';
    const curve = await graphPoints('curve');
    assert(curve.length >= 4, '2D curve did not draw its data markers');
    graphKey('ArrowRight'); assert(selected().row === 0 && selected().column === 1, '2D keyboard selection did not move to the next cell');
    graphKey('ArrowDown'); assert(selected().row === 1 && $('#plot-row').value === '1', '2D curve did not follow the selected row');
    graphKey('ArrowUp'); assert(selected().row === 0 && $('#plot-row').value === '0', '2D curve did not return to the selected row');
    clickGraphPoint(curve[0]); assert(selected().row === 0 && selected().column === 0, '2D marker hit test selected the wrong cell');
    const surface = await graphPoints('surface');
    assert(surface.length >= 8, '3D surface did not draw its data markers');
    graphKey('ArrowDown'); assert(selected().row === 1 && selected().column === 0, '3D keyboard selection did not move to the next row');
    clickGraphPoint(surface[0]); assert(selected().row === 0 && selected().column === 0, '3D marker hit test selected the wrong cell');

    change('#edit-operation', 'add'); $('#edit-value').value = '1'; $('#edit-value').dispatchEvent(new Event('input', { bubbles: true }));
    assert(!$('#edit-preview').hidden && !$('#edit-preview').classList.contains('invalid') && $('#edit-preview').textContent.includes('11 → 12'), 'edit preview does not show the encoded before/after values');
    assert(selected().modified === 11, 'edit preview applied a value before confirmation'); currentBytesUnchanged(baseline);
    $('#apply-edit').click();
    assert(selected().modified === 12 && changedCount() === baseline + 1, 'graph-selected edit changed the wrong value or bytes');
    $('#undo').click(); assert(selected().modified === 11, 'undo did not restore the graph-selected edit'); currentBytesUnchanged(baseline);
    $('#plot-edit-cell').click();
    assert(!$('#table-view').hidden && $('#table-view [data-cell="0"] input'), 'graph edit action did not open the selected table cell');
    $('#table-view [data-cell="0"] input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    currentBytesUnchanged(baseline);

    const saved = await saveProject(), savedMap = saved.maps.find(map => map.id === 'demo-ignition');
    assert(saved.originalBase64 === fixtureJSON.originalBase64 && saved.modifiedBase64 === fixtureJSON.modifiedBase64 && saved.originalSha256 === fixtureJSON.originalSha256, 'definition workflow changed original or working binary bytes');
    assert(savedMap.rows === 2 && savedMap.cols === 4 && savedMap.name === 'Synthetic boost reference' && savedMap.category === 'boost' && savedMap.role === 'target' && savedMap.definitionStatus === 'reference', 'native save lost workbench metadata');
    assert(JSON.stringify(savedMap.xAxis) === JSON.stringify(axis) && JSON.stringify(savedMap.yAxis) === '[20,40]' && savedMap.evidence === 'Generated fixture only; software-independent UI test.', 'native save lost axes or evidence');
    await injectProject(saved, 'Synthetic fuel VE');
    $('[data-map="demo-ignition"]').click(); $('#edit-map-definition').click();
    for (const name of ['name', 'category', 'role', 'definitionStatus', 'notes', 'evidence']) assert(field(name).value === savedMap[name], `reloaded ${name} differs from the saved definition`);
    assert(field('rows').value === '2' && field('cols').value === '4' && field('xAxis').value === axis.join(', '), 'reloaded shape or original breakpoints were lost');
    $('#cancel-map').click(); currentBytesUnchanged(baseline);
    $('#browse-map-references').click();
    assert($('#map-reference-dialog').open && all('.reference-card').length === 10, 'MiTo reference catalogue did not open');
    $('[data-reference-symbol="PQAV"]').click();
    assert(!$('#map-reference-dialog').open && $('#map-dialog').open, 'reference did not start a candidate definition');
    for (const name of ['address','rows','cols','type','endian','factor','offset','xAxis','yAxis']) assert(field(name).value === '', `reference transferred unverified ${name}`);
    assert(field('category').value === 'ignition' && field('definitionStatus').value === 'candidate' && $('#save-map-definition').disabled, 'reference candidate was offered as a ready definition');
    assert(field('evidence').value.includes('No match to this image established'), 'reference evidence qualification was lost');
    $('#cancel-map').click(); currentBytesUnchanged(baseline);
    $('#edit-map-definition').click();
    const preciseAxis = [1.2345678901234567,2.345678901234567,3.456789012345678,4.567890123456789];
    set('xAxis',preciseAxis.join(', ')); $('#preview-map').click(); $('#save-map-definition').click();
    $('#edit-map-definition').click();
    assert(field('xAxis').value === preciseAxis.join(', '), 'opening a definition rounded editable breakpoints');
    $('#save-map-definition').click(); $('#edit-map-definition').click();
    assert(field('xAxis').value === preciseAxis.join(', '), 'saving a definition rounded breakpoints');
    set('xAxis',axis.join(', ')); $('#preview-map').click(); $('#save-map-definition').click();
    await saveProject(); currentBytesUnchanged(baseline);
    const restored = await CalibrationProject.fromJSON(saved);
    assert(restored.changedByteCount === baseline && restored.readBytes(0x0800, 2, { original: true })[0] === 3 && restored.readBytes(0x0800, 2)[0] === 0x15, 'saved source/working distinction was lost');
    window.scrollTo(0, 0);
    return {
      mapWorkbenchShapeAndMetadata: true, originalAxisReading: true,
      definitionErrorsAtomic: true, mapCategoryFiltering: true,
      curveMouseKeyboardSelection: true, surfaceMouseKeyboardSelection: true,
      editPreviewApplyUndo: true, graphToTableEditor: true,
      definitionWorkspaceRoundtrip: true, definitionBytesConserved: true,
      syntheticWorkbenchIsolation: true,
      referenceCandidatesRequireTargetLocation: true, exactAxisPrecision: true,
      invalidDefinitionImportAtomic: true,
    };
  } finally {
    window.confirm = originalConfirm; URL.createObjectURL = originalCreateURL;
    if ($('#map-dialog').open) $('#map-dialog').close();
  }
}
