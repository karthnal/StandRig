import { PoseInput } from './poseInput';
import './styles.css';
import { createRigFromPsdFile } from '@standrig/core/importers';
import { fetchRigDocument, downloadRigDocument } from '@standrig/core/io';
import { StandRigPlayer, type PlaybackSnapshot } from '@standrig/runtime';
import { parameterDefinitionsForRig, previewParameterValuesForRig } from '@standrig/core/parameters';
import type { ParameterValues, RigDocument } from '@standrig/core/types';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
<header><div><span class="eyebrow">AI MODELING WORKSPACE</span><h1>StandRig <span>Modeling & Playback</span></h1></div><a id="player-link" href="/player" target="_blank" class="badge">Open playback view ↗</a></header>
<main><section class="stage-panel"><div class="stage-heading"><h2 id="model-name">Loading…</h2><button id="reload">Reload</button></div><div class="motion-controls"><label>Renderer <select id="renderer" aria-label="Rendering method"><option value="canvas">Standard</option><option value="webgl">GPU (experimental)</option></select></label><span id="renderer-status" role="status"></span><label>Motion demo <select id="demo-mode" aria-label="Motion demo type"><option value="showcase-active">Showcase — Fast &amp; Wide</option><option value="mouse-expression">Mouse + Expressions</option></select></label><button id="demo" aria-pressed="false" disabled>Start demo</button><p id="demo-status" role="status">Please load a model.</p></div><div class="canvas-wrap"><canvas width="800" height="900" aria-label="Model preview"></canvas><div id="empty"><b>From artwork to a moving model.</b><p>Load a layer-separated PSD to get started.</p></div></div><p class="caption">The motion demo is reflected in this view and the playback view. Adjusting parameters does not change the model's saved contents.</p></section>
<aside><section><h2>Cubism Bridge</h2><p>Setup guide: docs/CUBISM-BRIDGE.md</p><button id="bridge-check">Check connection status</button><pre id="bridge-status" role="status">Not checked</pre></section><section><h2>Load artwork</h2><p>Supported artwork: layer-separated PSD. The current model is automatically saved to a checkpoint before loading.</p><label class="file-label">Select PSD<input id="files" type="file" accept=".psd"></label><p id="selection">No file selected</p><button id="import" class="primary" disabled>Load PSD</button><button id="export">Export model JSON</button><button id="export-portable">Export model JSON with images</button><p>Use “with images” to take the model to another app. It bundles the saved model and part images into a single file — no PSD required.</p><button id="sample">Try a sample</button></section>
<section><h2>AI entry point</h2><code id="api-url"></code><p>For MCP connection setup see <b>docs/MCP.md</b>, and for operating steps see <b>AI_OPERATING_GUIDE.md</b>.</p><button id="qa">Run numeric QA</button><pre id="status" role="status" aria-live="polite">Starting…</pre></section>
<section><div class="stage-heading"><h2>Pose &amp; Playback</h2><button id="reset">Defaults</button></div><button id="play">Play</button> <button id="pause">Pause</button><div id="params"></div></section><section id="motion-panel"><h2>Motion</h2><p>Loads a StandRig motion JSON. Live2D-format conversion is planned for a future release.</p><label class="file-label">Select motion JSON<input id="motion-file" type="file" accept=".json"></label><p id="motion-status" role="status">Not loaded</p><button id="motion-play" disabled>Play motion</button><button id="motion-pause" disabled>Pause motion</button><button id="motion-stop" disabled>Stop motion</button><label>Position <input id="motion-time" aria-label="Motion playback position" type="range" min="0" max="1" step="0.01" value="0" disabled></label><label>Speed <input id="motion-speed" aria-label="Motion speed" type="number" min="0.1" max="4" step="0.1" value="1" disabled></label><label><input id="motion-loop" type="checkbox" disabled>Loop</label><button id="motion-export" disabled>Export motion JSON</button></section></aside></main>`;
const canvas = document.querySelector('canvas')!;
const status = document.querySelector<HTMLPreElement>('#status')!;
const filesInput = document.querySelector<HTMLInputElement>('#files')!;
const importButton = document.querySelector<HTMLButtonElement>('#import')!;
const sampleButton = document.querySelector<HTMLButtonElement>('#sample')!;
const qaButton = document.querySelector<HTMLButtonElement>('#qa')!;
let rig: RigDocument;
let runtime: StandRigPlayer;
const rendererSelect = document.querySelector<HTMLSelectElement>('#renderer')!;
rendererSelect.value = new URLSearchParams(location.search).get('renderer') === 'webgl' ? 'webgl' : 'canvas';
function applyRenderer() {
  const mode = rendererSelect.value === 'webgl' ? 'webgl' : 'canvas';
  runtime?.setRenderer(mode);
  document.querySelector<HTMLAnchorElement>('#player-link')!.href = mode === 'webgl' ? '/player?renderer=webgl' : '/player';
}
rendererSelect.onchange = applyRenderer;
setInterval(() => {
  const state = runtime?.rendererStatus;
  const text = rendererSelect.value !== 'webgl' ? '' : state?.status === 'ready' ? 'GPU rendering (image quality under review)' : 'Falling back to standard rendering';
  const label = document.querySelector('#renderer-status')!;
  if (label.textContent !== text) label.textContent = text;
}, 1000);

let values: ParameterValues;
let importing = false;
let modelVersion = -1;
let physicsEpoch: number | undefined;
let sessionId: string | undefined;
let latest: PlaybackSnapshot | undefined;
let reloadQueue = Promise.resolve();
let inputSequence = 0;
const inputSource = 'preview_' + crypto.randomUUID().replaceAll('-', '');
const poseInput = new PoseInput(
  patch => post('/api/playback/parameters', { source: inputSource, sequence: ++inputSequence, values: patch, expectedSessionId: sessionId, expectedModelVersion: modelVersion }),
  reply => { const state = (reply as { playback: PlaybackSnapshot }).playback; if (state.sessionId === latest?.sessionId && state.modelVersion === latest?.modelVersion && state.revision >= latest.revision) latest = state; applyState(); },
  error => { report(error); applyState(); }
);
const demoButton = document.querySelector<HTMLButtonElement>('#demo')!;
const demoMode = document.querySelector<HTMLSelectElement>('#demo-mode')!;
demoButton.onclick = () => { void post('/api/playback/control', { command: latest?.demo?.active ? 'demo-stop' : 'demo-start', mode: demoMode.value }).catch(report); };
demoMode.onchange = () => { if (latest?.demo?.active) void post('/api/playback/control', { command: 'demo-start', mode: demoMode.value }).catch(report); };
let pointerPending: { x: number; y: number } | undefined;
let pointerSending = false;
canvas.onpointermove = event => {
  if (!latest?.demo?.active || latest.demo.mode !== 'mouse-expression') return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  pointerPending = { x: Math.max(-1, Math.min(1, (event.clientX - rect.left) / rect.width * 2 - 1)), y: Math.max(-1, Math.min(1, (event.clientY - rect.top) / rect.height * 2 - 1)) };
};
canvas.onpointerleave = () => { pointerPending = { x: 0, y: 0 }; };
const pointerTimer = setInterval(() => {
  if (pointerSending || !pointerPending) return;
  const pointer = pointerPending; pointerPending = undefined;
  if (!latest?.demo?.active || latest.demo.mode !== 'mouse-expression') return;
  pointerSending = true;
  void post('/api/playback/control', { command: 'demo-pointer', ...pointer }).catch(report).finally(() => { pointerSending = false; });
}, 50);
document.querySelector('#api-url')!.textContent = `${location.origin}/api/context`;
function report(error: unknown) { status.textContent = error instanceof Error ? error.message : String(error); }
let renderFrame: number | undefined;
function render() {
  if (renderFrame !== undefined) return;
  renderFrame = requestAnimationFrame(() => { renderFrame = undefined; if (runtime && values) runtime.setParameters(values); });
}
new ResizeObserver(render).observe(canvas.parentElement!);
async function post(url: string, body: unknown) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok || result.ok === false) throw new Error(JSON.stringify(result));
  return result;
}
function sendPose(patch: ParameterValues) { poseInput.enqueue(patch); }
function parameters() {
  const container = document.querySelector('#params')!;
  container.replaceChildren();
  for (const param of parameterDefinitionsForRig(rig)) {
    const label = document.createElement('label'); label.className = 'parameter';
    const caption = document.createElement('span'); caption.textContent = param.label;
    const output = document.createElement('output'); output.textContent = String(Number(values[param.id].toFixed(3)));
    const input = document.createElement('input');
    input.type = 'range'; input.min = String(param.min); input.max = String(param.max); input.step = String(param.step ?? 0.1); input.value = String(Number(values[param.id].toFixed(3))); input.setAttribute('aria-label', param.id);
    input.oninput = () => { values[param.id] = Number(input.value); output.textContent = input.value; render(); sendPose({ [param.id]: Number(input.value) }); };
    label.append(caption, output, input); container.append(label);
  }
}
function applyState() {
  if (!latest || !rig || modelVersion !== latest.modelVersion || sessionId !== latest.sessionId) return;
  if (physicsEpoch !== latest.physicsEpoch) { runtime.resetPhysics(); physicsEpoch = latest.physicsEpoch; }
  updateMotion();
  values = { ...latest.values, ...poseInput.optimistic };
  for (const input of document.querySelectorAll<HTMLInputElement>('#params input')) {
    const id = input.getAttribute('aria-label')!;
    if (document.activeElement !== input) { input.value = String(values[id]); input.parentElement!.querySelector('output')!.textContent = String(Number(values[id].toFixed(3))); }
  }
  if (latest.playing && !runtime.playing) runtime.play(); else if (!latest.playing && runtime.playing) runtime.pause();
  const demo = latest.demo;
  const active = !!demo?.active;
  demoButton.disabled = !demo?.parameterIds.length;
  demoButton.textContent = active ? 'Stop demo' : 'Start demo';
  demoButton.setAttribute('aria-pressed', String(active));
  if (active) demoMode.value = demo!.mode;
  canvas.style.cursor = active && demo?.mode === 'mouse-expression' ? 'crosshair' : '';
  document.querySelector('#demo-status')!.textContent = !demo?.parameterIds.length
    ? 'No motion is configured. Try a sample, or model it with AI.'
    : active ? (demo.mode === 'mouse-expression' ? 'Move the mouse over the preview and the model follows it. Blinking, winking, and mouth movement are automatic.' : 'Showcase playing: face, body, gaze, and expressions animate automatically.')
    : 'The pose before starting is restored when stopped. You can check it on the parts that have motion configured.';
  render();
}
function reload() {
  reloadQueue = reloadQueue.catch(() => {}).then(async () => {
    const version = latest?.modelVersion ?? -1;
    const session = latest?.sessionId;
    rig = await fetchRigDocument(); values = previewParameterValuesForRig(rig);
    runtime?.dispose();
    runtime = new StandRigPlayer(canvas, rig); applyRenderer(); await runtime.load(); modelVersion = version;
    sessionId = session; physicsEpoch = undefined;
    document.querySelector('#model-name')!.textContent = rig.name;
    document.querySelector<HTMLElement>('#empty')!.hidden = rig.assets.length > 0;
    qaButton.disabled = rig.assets.length === 0;
    parameters(); applyState(); render();
    status.textContent = rig.assets.length ? `${rig.parts.length} parts / ${rig.assets.length} assets\nLoad complete` : 'Load a layer-separated PSD, or try a sample.';
  });
  return reloadQueue;
}
async function importModel(document: RigDocument) {
  const response = await fetch('/api/context');
  const {context} = await response.json();
  if (!response.ok || !context?.revision) throw new Error('Could not read the current model revision');
  return post('/api/modeling/transaction', {kind:'import',rig:document,expectedRevision:context.revision,commit:true,qa:{poses:['neutral'],regions:['full'],width:240,height:240,physics:false}});
}
function busy(value: boolean) { importing = value; importButton.disabled = value || !filesInput.files?.length; sampleButton.disabled = value; }
filesInput.onchange = () => { document.querySelector('#selection')!.textContent = filesInput.files?.[0]?.name ?? 'No file selected'; busy(importing); };
importButton.onclick = async () => {
  const files = Array.from(filesInput.files ?? []);
  if (importing || !files.length) return;
  busy(true); status.textContent = 'Loading PSD…';
  try {
    if (files.length !== 1 || !/\.psd$/i.test(files[0].name)) throw new Error('Please select a single layer-separated PSD file.');
    const imported = await createRigFromPsdFile(files[0]);
    await importModel(imported); await reload();
  } catch (error) { report(error); } finally { busy(false); }
};
sampleButton.onclick = async () => {
  if (importing) return;
  busy(true);
  try { const sample = await fetch('/api/sample').then(r => r.json()); await importModel(sample); await reload(); }
  catch (error) { report(error); } finally { busy(false); }
};
for (const command of ['play','pause','reset']) document.querySelector<HTMLButtonElement>('#' + command)!.onclick = () => { void post('/api/playback/control', { command }).catch(report); };
document.querySelector<HTMLButtonElement>('#reload')!.onclick = () => { void reload().catch(report); };
document.querySelector<HTMLButtonElement>('#export')!.onclick = () => { if (rig) downloadRigDocument(rig); };
const portableExport = document.querySelector<HTMLButtonElement>('#export-portable')!;
portableExport.onclick = async () => {
  if (importing || portableExport.disabled) return;
  portableExport.disabled = true;
  status.textContent = 'Exporting, including part images…';
  try {
    const response = await fetch('/api/bundle', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Failed to export the model (${response.status})`);
    const bundle = await response.json();
    if (bundle.format !== 'standrig-bundle' || bundle.version !== 1 || !Array.isArray(bundle.rig?.parts) || !Array.isArray(bundle.rig?.assets)
      || !bundle.rig.assets.every((asset: {src?: string}) => typeof asset.src === 'string' && asset.src.startsWith('data:image/png;base64,'))) {
      throw new Error('Could not retrieve the model with images. Check the PNG artwork and the model.');
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle.rig, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = 'model.standrig.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = 'Started downloading the model JSON with images. The save location follows your browser\'s download settings.';
  } catch (error) { report(error); }
  finally { portableExport.disabled = false; }
};
qaButton.onclick = async () => {
  qaButton.disabled = true; status.textContent = 'Running numeric QA…';
  try {
    const response = await fetch('/api/qa/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ poseSamples: [{ poseId: 'preview', values }], regions: ['full'], width: 240, height: 240, physics: false }) });
    status.textContent = JSON.stringify(await response.json(), null, 2);
  } catch (error) { report(error); } finally { qaButton.disabled = false; }
};
const motionFile = document.querySelector<HTMLInputElement>('#motion-file')!;
const motionTime = document.querySelector<HTMLInputElement>('#motion-time')!;
const motionSpeed = document.querySelector<HTMLInputElement>('#motion-speed')!;
const motionLoop = document.querySelector<HTMLInputElement>('#motion-loop')!;
function updateMotion() {
  const m = latest?.motion;
  for (const id of ['play','pause','stop','time','speed','loop','export']) document.querySelector<HTMLInputElement>('#motion-'+id)!.disabled = !m?.loaded;
  document.querySelector('#motion-status')!.textContent = m?.loaded ? `${m.name} — ${m.time.toFixed(2)} / ${m.duration.toFixed(2)} s · ${m.running ? 'Playing' : m.ended ? 'Ended' : m.active ? 'Paused' : 'Stopped'}` : 'Not loaded';
  motionTime.max = String(m?.duration ?? 1);
  if (document.activeElement !== motionTime) motionTime.value = String(m?.time ?? 0);
  if (document.activeElement !== motionSpeed) motionSpeed.value = String(m?.speed ?? 1);
  motionLoop.checked = m?.loop ?? false;
}
motionFile.onchange = async () => {
  try {
    const file = motionFile.files?.[0]; if (!file) return;
    if (file.size > 1024*1024) throw new Error('The motion JSON must be 1 MiB or smaller.');
    await post('/api/playback/motion', {action:'load',clip:JSON.parse(await file.text())});
    status.textContent = 'Motion loaded. Press play to start.';
  } catch (error) { report(error); } finally { motionFile.value = ''; }
};
for (const action of ['play','pause','stop']) document.querySelector<HTMLButtonElement>('#motion-'+action)!.onclick = () => { void post('/api/playback/motion',{action}).catch(report); };
motionTime.onchange = () => { void post('/api/playback/motion',{action:'seek',time:Number(motionTime.value)}).catch(report); };
motionSpeed.onchange = () => { void post('/api/playback/motion',{action:'configure',speed:Number(motionSpeed.value)}).catch(report); };
motionLoop.onchange = () => { void post('/api/playback/motion',{action:'configure',loop:motionLoop.checked}).catch(report); };
document.querySelector<HTMLButtonElement>('#motion-export')!.onclick = async () => {
  try {
    const response = await fetch('/api/playback/motion'), result = await response.json();
    if (!response.ok || !result.clip) throw new Error('No motion is loaded.');
    const url = URL.createObjectURL(new Blob([JSON.stringify(result.clip,null,2)+'\n'],{type:'application/json'}));
    const link = document.createElement('a'); link.href=url; link.download='motion.standrig-motion.json'; link.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
  } catch (error) { report(error); }
};
const events = new EventSource('/api/playback/events');
events.addEventListener('playback', event => {
  const previousVersion = latest?.modelVersion;
  const previousSession = latest?.sessionId;
  const incoming: PlaybackSnapshot = JSON.parse((event as MessageEvent).data);
  if (incoming.sessionId === latest?.sessionId && incoming.revision < latest.revision) return;
  if (incoming.sessionId !== latest?.sessionId || incoming.modelVersion !== latest?.modelVersion) poseInput.reset();
  latest = incoming;
  if (previousVersion !== latest?.modelVersion || previousSession !== latest?.sessionId) void reload().catch(report);
  else applyState();
});
events.onerror = () => { status.textContent = 'Reconnecting to the playback service…'; };
window.addEventListener('pagehide', () => { events.close(); poseInput.reset(); if (renderFrame !== undefined) cancelAnimationFrame(renderFrame); runtime?.dispose(); clearInterval(pointerTimer); });

document.querySelector<HTMLButtonElement>("#bridge-check")!.onclick = async () => {
 const output = document.querySelector("#bridge-status")!;
 try { const response = await fetch("/api/bridge/status"); const {result:s} = await response.json(); output.textContent = !s?.configured ? "Not configured" : !s.connected ? "Cannot connect" : `API ${s.apiVersion} / ${s.state}${s.supported ? "" : " (unsupported)"}`; } catch { output.textContent = "Failed to check the connection."; }
};
