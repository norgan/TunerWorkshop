import { referenceCatalogue } from './map-reference-data.mjs';
import { MAP_CATEGORIES } from './map-workbench-model.mjs';

const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const hex = value => `0x${value.toString(16).toUpperCase()}`;

// Carry only research attribution into a new target definition. The reference
// addresses, axes, dimensions and encoding are not evidence for the Fiat image.
export function referenceDefinitionSeed(symbol) {
  const item = referenceCatalogue.candidates.find(candidate => candidate.symbol === symbol);
  if (!item) throw new Error('Unknown reference symbol.');
  return {
    name: `${item.symbol} · candidate match`, category: item.category, role: 'unknown', definitionStatus: 'candidate',
    address: '', rows: '', cols: '', type: '', endian: '', unit: '', factor: '', offset: '', xAxis: '', yAxis: '',
    evidence: `${referenceCatalogue.sourceLabel}; ${item.symbol}; source SHA-256 ${referenceCatalogue.sourceSha256}. No match to this image established.`,
    notes: `${item.description}. Reference address candidate ${hex(item.referenceAddress)}, shape candidate ${item.dimensions.join(' × ')}. Confirm this image’s location, row/column orientation, value encoding, scaling and axes independently.`,
  };
}

export function createMapReferences({ openDefinition }) {
  const button = document.createElement('button'); button.id='browse-map-references'; button.textContent='Browse MiTo references';
  document.querySelector('#export-defs').after(button);
  const dialog = document.createElement('dialog'); dialog.id='map-reference-dialog'; dialog.setAttribute('aria-labelledby','map-reference-title');
  dialog.innerHTML = `<div class="dialog-heading"><h2 id="map-reference-title">Boost, timing and fuel references</h2><button type="button" id="close-map-references" aria-label="Close references">×</button></div>
    <p>These ten leads come from the supplied <strong>${esc(referenceCatalogue.sourceLabel)}</strong> project. They help identify related tables in your 500X image.</p>
    <p class="map-guide">The Fiat locations are not established. Stored dimensions and scales are candidates; axis orientation, signedness and byte order need checking. Numeric table values were not recovered, so these references have no 2D/3D surface yet.</p>
    <div class="reference-cards">${referenceCatalogue.candidates.map(item => `<article class="reference-card"><div class="section-heading"><span>${esc(MAP_CATEGORIES[item.category])}</span><span>REFERENCE CANDIDATE</span></div>
      <h3>${esc(item.symbol)}</h3><p>${esc(item.description)}</p><dl><div><dt>MiTo address candidate</dt><dd>${hex(item.referenceAddress)}</dd></div><div><dt>Shape candidate</dt><dd>${item.dimensions.join(' × ')} · ${item.bytesPerCell} bytes/cell</dd></div><div><dt>Stored unit / scale candidate</dt><dd>${esc(item.unit || 'Unit unresolved')} · ×${esc(item.factor)} + ${esc(item.offset)}</dd></div></dl>
      <button type="button" data-reference-symbol="${esc(item.symbol)}">Start a matching definition</button></article>`).join('')}</div>
    <p class="hint">Starting a definition copies the name, category and research note. Enter the location, shape and conversion from the image you are editing. Pressure units alone do not establish absolute versus gauge pressure; lambda is not an AFR value.</p>`;
  document.body.append(dialog);
  button.addEventListener('click',()=>dialog.showModal());
  dialog.querySelector('#close-map-references').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('click',event=>{const symbol=event.target.closest('[data-reference-symbol]')?.dataset.referenceSymbol;if(!symbol)return;dialog.close();openDefinition(referenceDefinitionSeed(symbol));});
}
