import { sha256 } from './core.mjs';
import { discoverCalibrationCandidates } from './calibration-discovery.mjs';

const $ = selector => document.querySelector(selector);
const hex = value => value.toString(16).toUpperCase().padStart(6, '0');
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/** Candidate discovery never changes bytes or assigns a tuning meaning. */
export function createPayloadInspector({ getProject, inspectHex, openCandidate, requestExport, download, filename, toast }) {
  let inspectedProject = null, discovery = null, scanningProject = null;
  const scanButtons = () => [$('#find-candidates'), $('#sidebar-find-candidates')];
  function render() {
    const project = getProject(), info = project.payloadInfo;
    if (project !== inspectedProject) {
      inspectedProject = project; discovery = null; scanningProject = null;
      $('#candidate-list').replaceChildren(); $('#candidate-dialog').close();
      $('#payload-details').open = false;
    }
    $('#payload-inspection').hidden = !info;
    $('#sidebar-find-candidates').hidden = !info;
    $('#tuning-workspace').classList.toggle('with-payload', !!info);
    scanButtons().forEach(button => { button.disabled = !info || scanningProject === project; button.textContent = scanningProject === project ? 'Inspecting image…' : 'Find table candidates'; });
    if (!info) return;
    $('#payload-summary').textContent = `${(info.byteLength / 1048576).toLocaleString()} MiB candidate ECU image`;
    $('#payload-boundary').textContent = `${info.headerByteLength.toLocaleString()} wrapper bytes + ${info.byteLength.toLocaleString()} image bytes. Image offset 0x000000 corresponds to file offset 0x${hex(info.fileOffset)}.`;
    $('#payload-description').textContent = 'The image boundary is inferred from this GEN_FILE layout. Extraction does not verify map meanings, ECU memory addresses or checksums. Your project retains the complete original container.';
    $('#candidate-status').textContent = scanningProject === project ? 'Inspecting original image bytes…' : discovery ? `${discovery.candidates.length} raw candidates available. Their purpose and scaling are unverified.` : 'Inspect the original image for numeric patterns, then choose a candidate to open as a raw table.';
  }
  function renderCandidates(project) {
    $('#candidate-warning').textContent = discovery.warning || 'These numeric patterns may be axes, curves or unrelated data. Map purpose, units and scaling are unverified.';
    $('#candidate-summary').textContent = `${discovery.candidates.length} results from ${discovery.scannedRange.bytes.toLocaleString()} original image bytes${discovery.truncated ? ' · Result list limited' : ''}${discovery.scanLimited ? ' · Scan range limited' : ''}. Opening a candidate adds a definition; it does not change any bytes.`;
    $('#candidate-list').innerHTML = discovery.candidates.map((candidate, index) => {
      const fileOffset = project.payloadToFileOffset(candidate.offset, candidate.count * 2);
      return `<article class="candidate-item"><div class="candidate-heading"><div><strong>Raw series at image 0x${hex(candidate.offset)}</strong><p>File 0x${hex(fileOffset)} · ${candidate.rows} × ${candidate.cols} · uint16 ${candidate.endian === 'big' ? 'BE' : 'LE'} · Unverified</p></div><button type="button" data-candidate-index="${index}">Open raw table</button></div><details><summary>Inspect pattern evidence and values</summary><p>${esc(candidate.evidence.join(' '))}</p><p class="candidate-values">${candidate.values.map(esc).join(', ')}</p></details></article>`;
    }).join('') || '<p>No candidates matched this structural scan. You can still inspect the image or define maps from matching verified definitions.</p>';
  }
  async function scan() {
    const target = getProject(), info = target.payloadInfo;
    if (!info || scanningProject === target) return;
    scanningProject = target; render();
    try {
      // Give the status a frame before the bounded local scan. Only immutable
      // original image bytes participate, even after working-copy edits.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (target !== getProject()) return;
      const result = discoverCalibrationCandidates(target.readPayload(0, info.byteLength, { original: true }), { maxResults: 40 });
      if (target !== getProject()) return;
      discovery = result; renderCandidates(target); $('#candidate-dialog').showModal();
    } catch (error) { toast(error.message, true); }
    finally { if (scanningProject === target) scanningProject = null; render(); }
  }
  async function exportReport() {
    const target = getProject(), info = target.payloadInfo;
    if (!info) return;
    const original = target.original, working = target.exportBinary();
    const originalPayload = original.slice(info.fileOffset, info.fileOffset + info.byteLength);
    const workingPayload = working.slice(info.fileOffset, info.fileOffset + info.byteLength);
    const capturedDiscovery = inspectedProject === target ? discovery : null;
    $('#export-inspection-report').disabled = true;
    try {
      const [originalContainerSha256, originalPayloadSha256, workingContainerSha256, workingPayloadSha256] = await Promise.all([original, originalPayload, working, workingPayload].map(sha256));
      const report = {
        format: 'tuneworkshop-payload-inspection', version: 1,
        containerFormat: 'GEN_FILE', containerByteLength: original.length,
        image: { fileOffset: info.fileOffset, byteLength: info.byteLength, boundaryStatus: 'inferred', checksumStatus: 'unverified' },
        originalContainerSha256, originalPayloadSha256, workingContainerSha256, workingPayloadSha256,
        inspectionSource: 'original image bytes',
        discovery: capturedDiscovery,
        limitations: ['Numeric candidates have no verified tuning meaning, units or scaling.', 'Image offsets are not verified ECU memory addresses.', 'ECU and container checksums are not validated.', 'This report omits wrapper contents and personal file paths.'],
      };
      const saved = await download(filename('.inspection.json', target), JSON.stringify(report, null, 2));
      toast(saved ? 'Inspection report saved with original and working image hashes.' : 'Inspection report save cancelled.');
    } catch (error) { toast(error.message, true); }
    finally { $('#export-inspection-report').disabled = false; }
  }
  $('#inspect-payload').addEventListener('click', () => inspectHex());
  scanButtons().forEach(button => button.addEventListener('click', scan));
  $('#close-candidates').addEventListener('click', () => $('#candidate-dialog').close());
  $('#candidate-list').addEventListener('click', event => {
    const button = event.target.closest('[data-candidate-index]');
    if (!button || !discovery || inspectedProject !== getProject()) return;
    const candidate = discovery.candidates[Number(button.dataset.candidateIndex)];
    if (!candidate) return;
    try {
      openCandidate(candidate); $('#candidate-dialog').close();
    } catch (error) { toast(error.message, true); }
  });
  $('#export-payload').addEventListener('click', () => requestExport('payload'));
  $('#export-inspection-report').addEventListener('click', exportReport);
  return { render };
}
