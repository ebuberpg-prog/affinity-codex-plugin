import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const SOURCE_MARKER = 'CODEX_AFFINITY_HANDOFF:';
const TARGET_MARKER = 'CODEX_CAVALRY_HANDOFF:';
const PLAN_LIFETIME_MS = 10 * 60 * 1000;

export const handoffToolDefinitions = [
  {
    name: 'codex_affinity_handoff_plan',
    description: 'Inspect the current Affinity document and active Cavalry composition for a native .af handoff. Read-only. Returns a short-lived plan ID; save the Affinity document first if it has unsaved changes.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'codex_affinity_handoff_stage',
    description: 'Stage a planned native Affinity file in Cavalry. Default asset mode preserves the option to choose Separate Layers in Cavalry; single_layer asks Cavalry to place a footage layer, whose visual result must be checked. Rechecks both apps and the file before changing Cavalry.',
    inputSchema: {
      type: 'object',
      properties: {
        planId: { type: 'string' },
        mode: { type: 'string', enum: ['asset', 'single_layer'], description: 'Default: asset. Choose Separate Layers in Cavalry after staging.' },
      },
      required: ['planId'],
      additionalProperties: false,
    },
  },
  {
    name: 'codex_affinity_refresh_plan',
    description: 'Read-only plan to refresh a Cavalry asset linked to the saved active Affinity document. Requires exactly one matching asset and an active Cavalry composition.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'codex_affinity_refresh_apply',
    description: 'Reload the exact Cavalry asset from a refresh plan. Rechecks the saved Affinity file, asset path, and active composition before reloading; preserves the existing asset ID and scene layers.',
    inputSchema: { type: 'object', properties: { planId: { type: 'string' } }, required: ['planId'], additionalProperties: false },
  },
  {
    name: 'codex_affinity_visual_compare',
    description: 'Return side-by-side previews of an Affinity spread and the active Cavalry composition or one Cavalry layer. Read-only; the views may have different framing and size.',
    inputSchema: {
      type: 'object',
      properties: {
        spreadIndex: { type: 'integer', minimum: 0, description: 'Zero-based Affinity spread index. Default 0.' },
        frame: { type: 'number', description: 'Optional Cavalry frame. Defaults to the current playhead.' },
        layerId: { type: 'string', description: 'Optional Cavalry layer ID to preview instead of the whole composition.' },
      },
      additionalProperties: false,
    },
  },
];

const sourceScript = `
const { Document } = require('/document.js');
const doc = Document.current;
if (!doc) {
  console.log('${SOURCE_MARKER}' + JSON.stringify({ noDocument: true }));
} else {
  const spreads = Array.from(doc.spreads);
  const spreadSummary = spreads.map((spread, index) => {
    const layers = Array.from(spread.layers);
    return {
      index,
      topLayerCount: layers.length,
      visibleTopLayerCount: layers.filter(layer => layer.isVisible).length,
      layerNames: layers.slice(0, 12).map(layer => layer.userDescription || layer.description || '')
    };
  });
  console.log('${SOURCE_MARKER}' + JSON.stringify({
    path: doc.path,
    title: doc.title,
    sessionUuid: doc.sessionUuid,
    needsSaving: doc.needsSaving,
    isDirty: doc.isDirty,
    mustSaveAs: doc.mustSaveAs,
    spreads: spreadSummary
  }));
}
`;

const targetScript = `
const comp = api.getActiveComp();
const children = comp ? api.getChildren(comp) : [];
const assets = api.getAssetWindowLayers(false)
  .filter(id => id.startsWith('asset#'))
  .map(id => ({ id, path: api.getAssetFilePath(id), type: api.getAssetType(id) }));
console.log('${TARGET_MARKER}' + JSON.stringify({ comp, children, assets }));
`;

export function buildStageScript(path, mode) {
  const encodedPath = JSON.stringify(path);
  const place = mode === 'single_layer'
    ? 'const layerId = api.addAssetToComp(assetId);'
    : 'const layerId = null;';
  return `
const sourcePath = ${encodedPath};
const existing = api.getAssetWindowLayers(false)
  .filter(id => id.startsWith('asset#'))
  .find(id => api.getAssetFilePath(id) === sourcePath);
const assetId = existing || api.loadAsset(sourcePath, false);
${place}
console.log('${TARGET_MARKER}' + JSON.stringify({
  assetId,
  reusedAsset: Boolean(existing),
  assetPath: api.getAssetFilePath(assetId),
  assetType: api.getAssetType(assetId),
  layerId,
  comp: api.getActiveComp(),
  children: api.getChildren(api.getActiveComp())
}));
`;
}

export function buildRefreshScript(path, assetId) {
  return `
const sourcePath = ${JSON.stringify(path)};
const assetId = ${JSON.stringify(assetId)};
const beforePath = api.getAssetFilePath(assetId);
if (beforePath !== sourcePath) {
  console.log('${TARGET_MARKER}' + JSON.stringify({ error: 'Linked asset path changed.', assetId, beforePath }));
} else {
  const comp = api.getActiveComp();
  const childrenBefore = comp ? api.getChildren(comp) : [];
  api.reloadAsset(assetId);
  console.log('${TARGET_MARKER}' + JSON.stringify({ assetId, assetPath: api.getAssetFilePath(assetId), comp,
    childrenBefore, childrenAfter: comp ? api.getChildren(comp) : [] }));
}
`;
}

export function parseMarkedResult(result, marker) {
  if (result?.isError) throw new Error(result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') || 'Native tool returned an error.');
  const allText = (result?.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n');
  const index = allText.lastIndexOf(marker);
  if (index < 0) throw new Error(`Native result marker ${marker} was missing. Inspect both apps before retrying.`);
  return JSON.parse(allText.slice(index + marker.length).split(/\r?\n/)[0]);
}

function resultText(value, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], isError };
}

function sourceProblem(source) {
  if (source.noDocument) return 'Open an Affinity document before planning the handoff.';
  if (!source.path || source.mustSaveAs) return 'Save the Affinity document as a native .af file, then plan again.';
  if (source.needsSaving || source.isDirty) return 'Save the latest Affinity changes, then plan again. Cavalry imports the saved file.';
  if (extname(source.path).toLowerCase() !== '.af') {
    return 'Save the Affinity document as a current .af file before importing it into Cavalry.';
  }
  if (!source.spreads?.length) return 'The Affinity document has no spreads to hand off.';
  if (!source.spreads.some(spread => spread.topLayerCount > 0)) return 'The Affinity document has no layers to hand off.';
  return null;
}

function sourceIdentity(source) {
  return { path: source.path, sessionUuid: source.sessionUuid, title: source.title };
}

function targetIdentity(target) {
  return { comp: target.comp, children: target.children };
}

function matchingAssets(target, path) {
  return target.assets.filter(asset => asset.path === path);
}

export function firstImage(result, label) {
  if (result?.isError) throw new Error(`${label} preview failed: ${result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') || 'unknown error'}`);
  const image = result?.content?.find(item => item.type === 'image');
  if (image?.data && image?.mimeType) return { type: 'image', data: image.data, mimeType: image.mimeType };
  const text = result?.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') || '';
  const match = text.match(/(?:data:image\/(jpeg|jpg|png);base64,)?([A-Za-z0-9+/]{100,}={0,2})/);
  if (match) return { type: 'image', data: match[2], mimeType: match[1] === 'png' ? 'image/png' : 'image/jpeg' };
  throw new Error(`${label} preview returned no image.`);
}

async function fileSnapshot(path) {
  const info = await stat(path);
  if (!info.isFile()) throw new Error('The saved Affinity path is not a regular file.');
  return { size: info.size, mtimeMs: info.mtimeMs };
}

async function connectCavalry() {
  const port = Number(process.env.CAVALRY_MCP_PORT || 6768);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CAVALRY_MCP_PORT must be an integer from 1 to 65535.');
  const headers = {
    'X-Cavalry-MCP-Fingerprint': 'codex-affinity-handoff-v1',
    'X-Cavalry-MCP-Client-Name': 'Codex',
    'X-Cavalry-MCP-Client-Version': '0.3.0',
  };
  const transport = new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`), {
    requestInit: { headers },
    eventSourceInit: { fetch: (url, init) => {
      const merged = new Headers(init?.headers);
      for (const [key, value] of Object.entries(headers)) merged.set(key, value);
      return fetch(url, { ...init, headers: merged });
    } },
  });
  const client = new Client({ name: 'Codex Affinity Handoff', version: '0.3.0' });
  try {
    await client.connect(transport);
    const preamble = await client.callTool({ name: 'read_preamble', arguments: {} });
    if (preamble.isError) throw new Error('Cavalry did not provide its preamble.');
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

async function withCavalry(task) {
  const client = await connectCavalry();
  try { return await task(client); }
  finally { await client.close(); }
}

async function inspectCavalry(client) {
  const result = await client.callTool({ name: 'execute_script', arguments: { script: targetScript } });
  return parseMarkedResult(result, TARGET_MARKER);
}

export function createHandoffHandler(callNative, deps = {}) {
  const plans = new Map();
  const snapshot = deps.fileSnapshot || fileSnapshot;
  const cavalry = deps.withCavalry || withCavalry;
  let preambleRead = false;

  async function inspectAffinity() {
    if (!preambleRead) {
      const preamble = await callNative('read_sdk_documentation_topic', { filename: 'preamble' });
      if (preamble.isError) throw new Error('Affinity did not provide its SDK preamble.');
      preambleRead = true;
    }
    const result = await callNative('execute_script', { script: sourceScript });
    return parseMarkedResult(result, SOURCE_MARKER);
  }

  function prunePlans() {
    for (const [id, plan] of plans) if (Date.now() - plan.createdAt > PLAN_LIFETIME_MS) plans.delete(id);
  }

  return async function handleHandoff(name, args = {}) {
    try {
      if (name === 'codex_affinity_handoff_plan') {
        prunePlans();
        if (plans.size >= 100) return resultText({ error: 'Too many active handoff plans. Stage an existing plan or reconnect.' }, true);
        const source = await inspectAffinity();
        const problem = sourceProblem(source);
        if (problem) return resultText({ ready: false, reason: problem, source }, true);
        const file = await snapshot(source.path);
        const target = await cavalry(inspectCavalry);
        if (!target.comp) return resultText({ ready: false, reason: 'Open a Cavalry composition before staging the Affinity file.', source }, true);
        const planId = randomUUID();
        plans.set(planId, { kind: 'handoff', source: sourceIdentity(source), file, target: targetIdentity(target), createdAt: Date.now() });
        return resultText({ ready: true, planId, expiresInMinutes: 10, source, file, target,
          modes: { asset: 'Stage the .af file as a Cavalry asset. Drag it into the composition and choose Separate Layers in Cavalry.',
            single_layer: 'Stage the .af file and request one footage layer in the active composition. Check its visual result.' } });
      }
      if (name === 'codex_affinity_handoff_stage') {
        const mode = args.mode || 'asset';
        if (!['asset', 'single_layer'].includes(mode)) return resultText({ error: 'Mode must be asset or single_layer.' }, true);
        const plan = plans.get(args.planId);
        if (!plan || plan.kind !== 'handoff') return resultText({ error: 'Handoff plan not found in this connection. Plan the handoff again.' }, true);
        plans.delete(args.planId);
        if (Date.now() - plan.createdAt > PLAN_LIFETIME_MS) return resultText({ error: 'Plan expired. Plan the handoff again.' }, true);
        const source = await inspectAffinity();
        const problem = sourceProblem(source);
        if (problem || JSON.stringify(sourceIdentity(source)) !== JSON.stringify(plan.source)) {
          return resultText({ error: problem || 'The active Affinity document changed. Plan the handoff again.' }, true);
        }
        const file = await snapshot(source.path);
        if (JSON.stringify(file) !== JSON.stringify(plan.file)) return resultText({ error: 'The saved Affinity file changed. Plan the handoff again.' }, true);
        const staged = await cavalry(async client => {
          const target = await inspectCavalry(client);
          if (JSON.stringify(targetIdentity(target)) !== JSON.stringify(plan.target)) {
            throw new Error('The active Cavalry composition changed. Plan the handoff again.');
          }
          const script = buildStageScript(source.path, mode);
          const preflight = await client.callTool({ name: 'preflight_script', arguments: { script } });
          if (preflight.isError) throw new Error('Cavalry rejected the handoff script during preflight.');
          const result = await client.callTool({ name: 'execute_script', arguments: { script } });
          return parseMarkedResult(result, TARGET_MARKER);
        });
        if (staged.assetPath !== source.path || !staged.assetId) {
          return resultText({ error: 'Cavalry did not confirm the imported asset path. Inspect its Assets window before retrying.', staged }, true);
        }
        if (mode === 'single_layer' && (!staged.layerId || !staged.children?.includes(staged.layerId))) {
          return resultText({ error: 'Cavalry did not confirm the flattened layer in the active composition. Inspect the scene before retrying.', staged }, true);
        }
        return resultText({ staged: true, mode, sourcePath: source.path, ...staged,
          nextStep: mode === 'asset'
            ? 'In Cavalry, drag the staged Affinity asset from Assets into the composition and choose Separate Layers. Verify the layers, then save the Cavalry scene.'
            : 'Inspect the footage layer visually in Cavalry. If it does not render the artwork, use the staged asset through Cavalry’s native drag-and-drop import dialog. Save the scene after verifying it.' });
      }
      if (name === 'codex_affinity_refresh_plan') {
        prunePlans();
        if (plans.size >= 100) return resultText({ error: 'Too many active plans. Apply an existing plan or reconnect.' }, true);
        const source = await inspectAffinity();
        const problem = sourceProblem(source);
        if (problem) return resultText({ ready: false, reason: problem, source }, true);
        const file = await snapshot(source.path);
        const target = await cavalry(inspectCavalry);
        if (!target.comp) return resultText({ ready: false, reason: 'Open a Cavalry composition before refreshing.', source }, true);
        const matches = matchingAssets(target, source.path);
        if (matches.length !== 1) return resultText({ ready: false,
          reason: matches.length ? 'Multiple Cavalry assets reference this Affinity file; choose one manually.' : 'No Cavalry asset links to this Affinity file. Stage the handoff first.',
          source, target }, true);
        const planId = randomUUID();
        plans.set(planId, { kind: 'refresh', source: sourceIdentity(source), file,
          target: targetIdentity(target), assetId: matches[0].id, createdAt: Date.now() });
        return resultText({ ready: true, planId, expiresInMinutes: 10, source, file,
          asset: matches[0], composition: targetIdentity(target) });
      }
      if (name === 'codex_affinity_refresh_apply') {
        const plan = plans.get(args.planId);
        if (!plan || plan.kind !== 'refresh') return resultText({ error: 'Refresh plan not found in this connection. Plan again.' }, true);
        plans.delete(args.planId);
        if (Date.now() - plan.createdAt > PLAN_LIFETIME_MS) return resultText({ error: 'Plan expired. Plan again.' }, true);
        const source = await inspectAffinity();
        const problem = sourceProblem(source);
        if (problem || JSON.stringify(sourceIdentity(source)) !== JSON.stringify(plan.source)) {
          return resultText({ error: problem || 'The active Affinity document changed. Plan again.' }, true);
        }
        const file = await snapshot(source.path);
        if (JSON.stringify(file) !== JSON.stringify(plan.file)) return resultText({ error: 'The saved Affinity file changed. Plan again.' }, true);
        const refreshed = await cavalry(async client => {
          const target = await inspectCavalry(client);
          if (JSON.stringify(targetIdentity(target)) !== JSON.stringify(plan.target)) throw new Error('The active Cavalry composition changed. Plan again.');
          const matches = matchingAssets(target, source.path);
          if (matches.length !== 1 || matches[0].id !== plan.assetId) throw new Error('The linked Cavalry asset changed. Plan again.');
          const script = buildRefreshScript(source.path, plan.assetId);
          const preflight = await client.callTool({ name: 'preflight_script', arguments: { script } });
          if (preflight.isError) throw new Error('Cavalry rejected the refresh script during preflight.');
          const result = parseMarkedResult(await client.callTool({ name: 'execute_script', arguments: { script } }), TARGET_MARKER);
          if (result.error) throw new Error(result.error);
          const after = await inspectCavalry(client);
          return { ...result, after };
        });
        const { after, ...details } = refreshed;
        if (details.assetId !== plan.assetId || details.assetPath !== source.path ||
            JSON.stringify(targetIdentity(after)) !== JSON.stringify(plan.target) ||
            !matchingAssets(after, source.path).some(asset => asset.id === plan.assetId)) {
          return resultText({ error: 'Reload ran, but Cavalry did not confirm the same asset and scene layers. Inspect the composition before retrying.', details, after }, true);
        }
        return resultText({ reloadCompleted: true, assetIdPreserved: true, compositionLayerIdsPreserved: true,
          sourcePath: source.path, ...details,
          nextStep: 'Use codex_affinity_visual_compare to inspect the Affinity spread and Cavalry render. Confirm the artwork changed before saving the Cavalry scene. Added or removed Affinity layers require reimport into a Separate Layers composition.' });
      }
      if (name === 'codex_affinity_visual_compare') {
        const source = await inspectAffinity();
        if (source.noDocument || !source.sessionUuid) return resultText({ error: 'Open an Affinity document before comparing previews.' }, true);
        const spreadIndex = args.spreadIndex ?? 0;
        if (!Number.isInteger(spreadIndex) || spreadIndex < 0 || !source.spreads?.some(spread => spread.index === spreadIndex)) {
          return resultText({ error: 'Choose an existing zero-based Affinity spread index.' }, true);
        }
        if (args.frame !== undefined && !Number.isFinite(args.frame)) return resultText({ error: 'Frame must be a finite number.' }, true);
        const affinityImage = firstImage(await callNative('render_spread', {
          document_session_uuid: source.sessionUuid, spread_index: spreadIndex }), 'Affinity');
        const cavalryImage = await cavalry(async client => {
          const target = await inspectCavalry(client);
          if (!target.comp) throw new Error('Open a Cavalry composition before comparing previews.');
          if (args.layerId && !target.children.includes(args.layerId)) throw new Error('The requested Cavalry layer is not a direct child of the active composition.');
          const previewArgs = { maxSize: 1024 };
          if (args.frame !== undefined) previewArgs.frame = args.frame;
          if (args.layerId) previewArgs.layerId = args.layerId;
          const preview = await client.callTool({ name: 'snapshot_layer', arguments: previewArgs });
          return { target, image: firstImage(preview, 'Cavalry') };
        });
        return { content: [
          { type: 'text', text: `Affinity: ${source.title || source.path || 'open document'}, spread ${spreadIndex}.` },
          affinityImage,
          { type: 'text', text: `Cavalry: ${args.layerId || 'active composition'}${args.frame === undefined ? ' at current playhead' : ` at frame ${args.frame}`}. Previews may differ in framing, scale, or transparency.` },
          cavalryImage.image,
        ], isError: false };
      }
      return resultText({ error: 'Unknown handoff tool.' }, true);
    } catch (error) {
      return resultText({ error: String(error.message || error), retry: 'Inspect Affinity and Cavalry before retrying; an import may already have completed.' }, true);
    }
  };
}
