import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createKubernetes } from '../extensions/aks-canvas/kubernetes.mjs';
import { createHistory } from '../extensions/aks-canvas/history.mjs';
import { createInstance } from '../extensions/aks-canvas/server.mjs';

test('kubectl commands pin the target and reject invalid mutation inputs', async () => {
  const calls = [];
  const kube = createKubernetes(async args => {
    calls.push(args);
    if (args.includes('get')) return JSON.stringify({ items: [] });
    return 'ok';
  });
  await kube.workloads('prod-context', 'shop');
  await kube.logs('prod-context', 'shop', 'api-123', true);
  await kube.scale('prod-context', 'shop', 'api', 2);
  assert.deepEqual(calls[0], ['--context', 'prod-context', '-n', 'shop', 'get', 'deployments,pods', '-o', 'json']);
  assert.ok(calls[1].includes('--previous'));
  assert.deepEqual(calls[2], ['--context', 'prod-context', '-n', 'shop', 'scale', 'deployment', 'api', '--replicas=2']);
  await assert.rejects(kube.scale('prod-context', 'shop', '--all', 2), /Invalid deployment/);
  await assert.rejects(kube.scale('prod-context', 'shop', 'api', -1), /Replicas/);
  await assert.rejects(kube.workloads('--other', 'shop'), /Invalid Kubernetes context/);
  assert.equal(calls.length, 3);
});

test('private history is opt-in and reports corrupt records', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aks-canvas-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const history = createHistory(directory);
  assert.deepEqual(await history.list(), []);
  await assert.rejects(history.save('ctx', 'ns', []), /add a finding/);
  const saved = await history.save('ctx', 'ns', ['Pod restarted five times']);
  assert.deepEqual(await history.list(), [saved]);
  const path = join(directory, `${saved.id}.json`);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 1);
  await writeFile(path, JSON.stringify({ ...saved, version: 999 }));
  await assert.rejects(history.list(), /Invalid investigation record/);
});

test('canvas requires a token, pins edits to the selected target, and resets editing on target change', async t => {
  const calls = [];
  const kubernetes = {
    contexts: async () => ['ctx-a', 'ctx-b'],
    namespaces: async () => ['shop', 'other'],
    workloads: async () => [],
    events: async () => [],
    logs: async () => 'logs',
    scale: async (...args) => { calls.push(args); return 'scaled'; }
  };
  const instance = await createInstance({ kubernetes, history: { save: async () => {}, list: async () => [] } });
  t.after(() => instance.close());
  const page = await (await fetch(instance.url)).text();
  const token = page.match(/name="canvas-token" content="([^"]+)"/)[1];
  const request = (path, data = {}, suppliedToken = token) => fetch(new URL(`api/${path}`, instance.url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Canvas-Token': suppliedToken },
    body: JSON.stringify(data)
  });
  assert.equal((await request('state', {}, 'incorrect')).status, 403);
  await request('select-context', { context: 'ctx-a' });
  await request('select-namespace', { namespace: 'shop' });
  const target = { context: 'ctx-a', namespace: 'shop', deployment: 'api', replicas: 2 };
  assert.equal((await request('scale', target)).status, 400);
  await request('editing', { enabled: true });
  assert.equal((await request('scale', { ...target, context: 'ctx-b' })).status, 400);
  assert.equal((await request('scale', target)).status, 200);
  assert.deepEqual(calls, [['ctx-a', 'shop', 'api', 2]]);
  instance.addFinding('Evidence: pod restart count is five.');
  assert.equal(instance.getContext().findings.length, 1);
  await request('select-namespace', { namespace: 'other' });
  assert.equal(instance.getContext().editing, false);
  assert.deepEqual(instance.getContext().findings, []);
  assert.equal((await request('scale', target)).status, 400);
  assert.equal(calls.length, 1);
});

test('namespace selection cannot finish against a context that changed during lookup', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let lookupStarted;
  const started = new Promise(resolve => { lookupStarted = resolve; });
  const kubernetes = {
    contexts: async () => ['ctx-a', 'ctx-b'],
    namespaces: async () => { lookupStarted(); await pending; return ['shop']; }
  };
  const instance = await createInstance({ kubernetes });
  t.after(() => instance.close());
  const page = await (await fetch(instance.url)).text();
  const token = page.match(/name="canvas-token" content="([^"]+)"/)[1];
  const request = (path, data) => fetch(new URL(`api/${path}`, instance.url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Canvas-Token': token },
    body: JSON.stringify(data)
  });
  await request('select-context', { context: 'ctx-a' });
  const selection = request('select-namespace', { namespace: 'shop' });
  await started;
  await request('select-context', { context: 'ctx-b' });
  release();
  assert.equal((await selection).status, 400);
  assert.equal(instance.getContext().context, 'ctx-b');
  assert.equal(instance.getContext().namespace, '');
});
