import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRefreshScript, buildStageScript, createHandoffHandler, parseMarkedResult } from './handoff-tools.mjs';

const source = {
  path: '/Users/example/Desktop/artwork.af',
  title: 'artwork',
  sessionUuid: 'source-session',
  needsSaving: false,
  isDirty: false,
  mustSaveAs: false,
  spreads: [{ index: 0, topLayerCount: 2, visibleTopLayerCount: 2, layerNames: ['Logo', 'Background'] }],
};
const target = { comp: 'compNode#1', children: [], assets: [] };
const native = (value, marker) => ({ content: [{ type: 'text', text: `[info] ${marker}${JSON.stringify(value)}\nCurrent frame: 0` }], isError: false });

function harness(initial = source) {
  let currentSource = initial;
  let currentTarget = target;
  let file = { size: 123, mtimeMs: 456 };
  let stageCount = 0;
  let reloadCount = 0;
  const callNative = async (name) => name === 'execute_script'
    ? native(currentSource, 'CODEX_AFFINITY_HANDOFF:')
    : name === 'render_spread'
      ? { content: [{ type: 'image', data: 'affinity-image', mimeType: 'image/jpeg' }], isError: false }
      : { content: [{ type: 'text', text: 'preamble' }], isError: false };
  const client = {
    callTool: async ({ name, arguments: args }) => {
      if (name === 'preflight_script') return { content: [{ type: 'text', text: 'OK' }], isError: false };
      if (name === 'snapshot_layer') return { content: [{ type: 'image', data: 'cavalry-image', mimeType: 'image/png' }], isError: false };
      if (name === 'execute_script' && args.script.includes('api.reloadAsset(assetId)')) {
        reloadCount++;
        return native({ assetId: 'asset#2', assetPath: source.path, comp: currentTarget.comp,
          childrenBefore: currentTarget.children, childrenAfter: currentTarget.children }, 'CODEX_CAVALRY_HANDOFF:');
      }
      if (name === 'execute_script' && args.script.includes('api.loadAsset')) {
        stageCount++;
        const single = args.script.includes('api.addAssetToComp(assetId)');
        return native({ assetId: 'asset#2', assetPath: source.path, assetType: 'image',
          reusedAsset: false, layerId: single ? 'footageShape#1' : null, comp: target.comp,
          children: single ? ['footageShape#1'] : [] }, 'CODEX_CAVALRY_HANDOFF:');
      }
      return native(currentTarget, 'CODEX_CAVALRY_HANDOFF:');
    },
  };
  const handler = createHandoffHandler(callNative, {
    fileSnapshot: async () => file,
    withCavalry: async task => task(client),
  });
  return {
    handler,
    setSource: value => { currentSource = value; },
    setTarget: value => { currentTarget = value; },
    setFile: value => { file = value; },
    getStageCount: () => stageCount,
    getReloadCount: () => reloadCount,
  };
}

function body(result) { return JSON.parse(result.content[0].text); }

test('source inspection must be saved before a plan is issued', async () => {
  const h = harness({ ...source, isDirty: true });
  const result = await h.handler('codex_affinity_handoff_plan');
  assert.equal(result.isError, true);
  assert.match(body(result).reason, /Save the latest/);
});

test('empty documents are not offered as handoff assets', async () => {
  const h = harness({ ...source, spreads: [{ index: 0, topLayerCount: 0, visibleTopLayerCount: 0, layerNames: [] }] });
  const result = await h.handler('codex_affinity_handoff_plan');
  assert.equal(result.isError, true);
  assert.match(body(result).reason, /no layers/);
});

test('stage rejects a changed source file before touching Cavalry', async () => {
  const h = harness();
  const plan = body(await h.handler('codex_affinity_handoff_plan'));
  h.setFile({ size: 124, mtimeMs: 457 });
  const result = await h.handler('codex_affinity_handoff_stage', { planId: plan.planId });
  assert.equal(result.isError, true);
  assert.match(body(result).error, /file changed/);
  assert.equal(h.getStageCount(), 0);
});

test('stage rejects a changed receiving composition before importing', async () => {
  const h = harness();
  const plan = body(await h.handler('codex_affinity_handoff_plan'));
  h.setTarget({ ...target, children: ['existing-layer'] });
  const result = await h.handler('codex_affinity_handoff_stage', { planId: plan.planId });
  assert.equal(result.isError, true);
  assert.match(body(result).error, /composition changed/);
  assert.equal(h.getStageCount(), 0);
});

test('asset handoff stages exactly once and returns the layered import step', async () => {
  const h = harness();
  const plan = body(await h.handler('codex_affinity_handoff_plan'));
  assert.equal(plan.ready, true);
  const result = body(await h.handler('codex_affinity_handoff_stage', { planId: plan.planId }));
  assert.equal(result.staged, true);
  assert.equal(result.mode, 'asset');
  assert.match(result.nextStep, /Separate Layers/);
  assert.equal(h.getStageCount(), 1);
  const duplicate = await h.handler('codex_affinity_handoff_stage', { planId: plan.planId });
  assert.equal(duplicate.isError, true);
  assert.equal(h.getStageCount(), 1);
});

test('single-layer mode confirms a layer was placed in the composition', async () => {
  const h = harness();
  const plan = body(await h.handler('codex_affinity_handoff_plan'));
  const result = body(await h.handler('codex_affinity_handoff_stage', { planId: plan.planId, mode: 'single_layer' }));
  assert.equal(result.staged, true);
  assert.equal(result.layerId, 'footageShape#1');
  assert.equal(h.getStageCount(), 1);
});

test('file paths are safely quoted in the Cavalry script', () => {
  const path = '/Users/example/Desktop/a"; api.deleteLayer("all") ;.af';
  const script = buildStageScript(path, 'asset');
  assert.ok(script.includes(`const sourcePath = ${JSON.stringify(path)};`));
  assert.ok(!script.includes('api.addAssetToComp(assetId)'));
  assert.ok(buildStageScript('/tmp/a.af', 'single_layer').includes('api.addAssetToComp(assetId)'));
});

test('native marker parser reads Cavalry log prefixes', () => {
  assert.deepEqual(parseMarkedResult(native({ ok: true }, 'MARK:'), 'MARK:'), { ok: true });
});

test('refresh reuses the exact linked asset and keeps layer IDs', async () => {
  const h = harness();
  h.setTarget({ comp: target.comp, children: ['footageShape#1'],
    assets: [{ id: 'asset#2', path: source.path, type: 'image' }] });
  const plan = body(await h.handler('codex_affinity_refresh_plan'));
  assert.equal(plan.ready, true);
  const applied = body(await h.handler('codex_affinity_refresh_apply', { planId: plan.planId }));
  assert.equal(applied.reloadCompleted, true);
  assert.equal(applied.assetIdPreserved, true);
  assert.equal(applied.compositionLayerIdsPreserved, true);
  assert.equal(h.getReloadCount(), 1);
  assert.equal((await h.handler('codex_affinity_refresh_apply', { planId: plan.planId })).isError, true);
});

test('refresh refuses ambiguous and changed asset links', async () => {
  const h = harness();
  h.setTarget({ ...target, assets: [
    { id: 'asset#2', path: source.path, type: 'image' },
    { id: 'asset#3', path: source.path, type: 'image' },
  ] });
  assert.match(body(await h.handler('codex_affinity_refresh_plan')).reason, /Multiple/);
  h.setTarget({ ...target, assets: [{ id: 'asset#2', path: source.path, type: 'image' }] });
  const plan = body(await h.handler('codex_affinity_refresh_plan'));
  h.setTarget({ ...target, assets: [] });
  const rejected = await h.handler('codex_affinity_refresh_apply', { planId: plan.planId });
  assert.equal(rejected.isError, true);
  assert.match(body(rejected).error, /asset changed/);
  assert.equal(h.getReloadCount(), 0);
});

test('visual comparison returns labeled source and Cavalry images', async () => {
  const h = harness();
  const compared = await h.handler('codex_affinity_visual_compare', { spreadIndex: 0, frame: 12 });
  assert.equal(compared.isError, false);
  assert.deepEqual(compared.content.map(item => item.type), ['text', 'image', 'text', 'image']);
  assert.match(compared.content[2].text, /frame 12/);
});

test('refresh script quotes both file and asset ID', () => {
  const path = '/tmp/a"; api.deleteLayer("all") ;.af';
  const script = buildRefreshScript(path, 'asset#2');
  assert.ok(script.includes(`const sourcePath = ${JSON.stringify(path)};`));
  assert.ok(script.includes('const assetId = "asset#2";'));
});
