import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createKubernetes } from '../extensions/aks-canvas/kubernetes.mjs';
import { createInstance } from '../extensions/aks-canvas/server.mjs';
import { detectIssues } from '../extensions/aks-canvas/issues.mjs';
import { checkDeallocatedNodes, describeAzureFailure } from '../extensions/aks-canvas/azure.mjs';

test('canvas manifest exposes the publish_issue action with its input schema', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extensions/aks-canvas/extension.json', import.meta.url), 'utf8'));
  const action = manifest.canvases[0].actions.find(item => item.name === 'publish_issue');
  assert.ok(action);
  assert.ok(action.inputSchema.required.includes('evidence'));
});

test('issue checks report current signals with evidence without treating normal workloads as problems', () => {
  const issues = detectIssues([
    { kind: 'Pod', name: 'broken', namespace: 'shop', status: 'Running', waitingReason: 'CrashLoopBackOff' },
    { kind: 'Pod', name: 'healthy', namespace: 'shop', status: 'Running' },
    { kind: 'Deployment', name: 'web', namespace: 'shop', desired: 3, available: 2 },
    { kind: 'Deployment', name: 'zero', namespace: 'shop', desired: 0, available: 0 }
  ], [{ name: 'node-a', ready: 'False' }, { name: 'node-b', ready: 'True' }]);
  assert.equal(issues.length, 3);
  assert.equal(issues[0].name, 'broken');
  assert.match(issues[1].evidence, /rollout may be in progress/);
  assert.equal(issues[2].kind, 'Node');
  assert.ok(issues.every(issue => issue.evidence && issue.next && issue.docs.length));
});

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

test('cluster pod scanning handles Kubernetes lists without per-item kind metadata', async () => {
  const kube = createKubernetes(async () => JSON.stringify({
    kind: 'PodList',
    items: [{
      metadata: { name: 'app', namespace: 'shop' },
      status: { phase: 'Running', containerStatuses: [{ state: { waiting: { reason: 'CrashLoopBackOff' } }, restartCount: 4 }] }
    }]
  }));
  const pods = await kube.clusterPods('ctx');
  assert.equal(pods[0].kind, 'Pod');
  assert.equal(pods[0].waitingReason, 'CrashLoopBackOff');
  assert.equal(detectIssues(pods, [])[0].namespace, 'shop');
});

test('admin-named contexts can scan workloads and events without changing context', async t => {
  const context = 'cluster-admin';
  const calls = [];
  const pod = { kind: 'Pod', metadata: { name: 'pod-a', namespace: 'shop' }, status: { phase: 'Pending' } };
  const deployment = { kind: 'Deployment', metadata: { name: 'api', namespace: 'shop' }, spec: { replicas: 2 }, status: { availableReplicas: 1 } };
  const kubernetes = createKubernetes(async args => {
    calls.push(args);
    if (args[0] === 'config') return `${context}\n`;
    assert.deepEqual(args.slice(0, 2), ['--context', context]);
    if (args.includes('--raw')) {
      const path = new URL(args.at(-1), 'https://kubernetes.invalid').pathname;
      if (path === '/api/v1/pods') return JSON.stringify({ kind: 'PodList', items: [pod] });
      if (path === '/apis/apps/v1/deployments') return JSON.stringify({ kind: 'DeploymentList', items: [deployment] });
      if (path === '/api/v1/nodes') return JSON.stringify({ kind: 'NodeList', items: [] });
    }
    if (args.includes('namespaces')) return JSON.stringify({ items: [{ metadata: { name: 'shop' } }] });
    if (args.includes('deployments,pods')) return JSON.stringify({ items: [pod, deployment] });
    if (args.includes('events')) return JSON.stringify({ items: [{ metadata: { name: 'event-a' }, type: 'Warning', reason: 'FailedScheduling' }] });
    assert.fail(`Unexpected kubectl command: ${args.join(' ')}`);
  });
  const instance = await createInstance({ kubernetes, checkNodes: async nodes => ({ nodes, errors: [] }) });
  t.after(() => instance.close());
  const page = await (await fetch(instance.url)).text();
  const token = page.match(/name="canvas-token" content="([^"]+)"/)[1];
  const request = async (path, data = {}) => {
    const response = await fetch(new URL(`api/${path}`, instance.url), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Canvas-Token': token }, body: JSON.stringify(data)
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  await request('select-context', { context });
  const scan = await request('scan');
  assert.deepEqual(scan.errors, []);
  assert.deepEqual(scan.issues.map(issue => issue.name), ['pod-a', 'api']);
  await request('select-namespace', { namespace: 'shop' });
  assert.deepEqual((await request('workloads')).map(item => item.name), ['pod-a', 'api']);
  assert.equal((await request('events'))[0].reason, 'FailedScheduling');
  assert.equal(instance.getContext().editing, false);
  assert.ok(calls.every(args => args[0] === 'config' || args[2] === '-n' || args[2] === 'get'));
});

test('resource investigation projects pending evidence and safe related references', async () => {
  const calls = [];
  const kube = createKubernetes(async args => {
    calls.push(args);
    if (args.includes('events')) return JSON.stringify({ items: [{
      metadata: { creationTimestamp: '2026-01-01' }, type: 'Warning', reason: 'FailedMount', message: 'Mount failed'
    }] });
    return JSON.stringify({
      metadata: { name: 'pod-a', uid: 'uid-123', ownerReferences: [{ kind: 'Job', name: 'backup' }] },
      spec: {
        nodeName: 'node-a', containers: [{ env: [{ value: 'do-not-return' }] }],
        volumes: [{ persistentVolumeClaim: { claimName: 'data' } }, { csi: { driver: 'secrets-store.csi.k8s.io', volumeAttributes: { secretProviderClass: 'vault' } } }]
      },
      status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: 'Insufficient cpu' }] }
    });
  });
  const target = { kind: 'Pod', name: 'pod-a', namespace: 'shop' };
  const details = await kube.resource('ctx', target);
  assert.equal(details.conditions[0].reason, 'Unschedulable');
  assert.deepEqual(details.related, [
    { kind: 'Job', name: 'backup' }, { kind: 'Node', name: 'node-a' },
    { kind: 'PersistentVolumeClaim', name: 'data' }, { kind: 'SecretProviderClass', name: 'vault' }
  ]);
  assert.doesNotMatch(JSON.stringify(details), /do-not-return/);
  const events = await kube.resourceEvents('ctx', target, details.uid);
  assert.equal(events[0].reason, 'FailedMount');
  assert.ok(calls[1].includes('involvedObject.uid=uid-123'));
  await assert.rejects(kube.resource('ctx', { ...target, kind: 'Secret' }), /Unsupported resource kind/);
  await assert.rejects(kube.resource('ctx', { ...target, name: '--all' }), /Invalid resource name/);
  assert.equal(calls.length, 2);
});

test('cluster pod scanning follows encoded continuation tokens without buffering the entire list', async () => {
  const calls = [];
  const padding = 'x'.repeat(4 * 1024 * 1024);
  const kube = createKubernetes(async args => {
    calls.push(args);
    const url = new URL(args.at(-1), 'https://kubernetes.invalid');
    assert.equal(url.pathname, '/api/v1/pods');
    assert.equal(url.searchParams.get('limit'), '25');
    const token = url.searchParams.get('continue');
    const page = token === null ? 0 : token === 'next+/=' ? 1 : 2;
    return JSON.stringify({
      kind: 'PodList',
      metadata: { continue: page === 0 ? 'next+/=' : page === 1 ? 'last' : '' },
      items: [{ metadata: { name: `pod-${page}`, namespace: 'shop', annotations: { padding } }, status: { phase: 'Pending' } }]
    });
  });
  const pods = await kube.clusterPods('ctx');
  assert.deepEqual(pods.map(pod => pod.name), ['pod-0', 'pod-1', 'pod-2']);
  assert.equal(detectIssues(pods, []).length, 3);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].slice(0, -1), ['--context', 'ctx', 'get', '--raw']);
  assert.match(calls[1].at(-1), /continue=next%2B%2F%3D/);
});

test('cluster scan fails explicitly when pagination fails or repeats a continuation token', async () => {
  let calls = 0;
  const kube = createKubernetes(async () => {
    calls++;
    return JSON.stringify({ kind: 'NodeList', metadata: { continue: 'same' }, items: [] });
  });
  await assert.rejects(kube.nodes('ctx'), /repeated continuation token/);
  assert.equal(calls, 2);

  const failed = createKubernetes(async args => {
    if (new URL(args.at(-1), 'https://kubernetes.invalid').searchParams.has('continue')) throw new Error('Forbidden');
    return JSON.stringify({ kind: 'DeploymentList', metadata: { continue: 'next' }, items: [] });
  });
  await assert.rejects(failed.clusterDeployments('ctx'), /Forbidden/);
});

test('only confirmed deallocated instances in a deallocating AKS pool are excluded', async () => {
  const providerId = instance => `azure:///subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/node-rg/providers/Microsoft.Compute/virtualMachineScaleSets/vmss/virtualMachines/${instance}`;
  const nodes = [
    { name: 'deallocated', ready: 'Unknown', pool: 'pool1', providerId: providerId('1') },
    { name: 'running', ready: 'Unknown', pool: 'pool1', providerId: providerId('2') },
    { name: 'not-ready', ready: 'False', pool: 'pool1', providerId: providerId('3') }
  ];
  const calls = [];
  const run = async args => {
    calls.push(args);
    if (args[0] === 'group') return { tags: { 'AKS-Managed-Cluster-Name': 'cluster', 'AKS-Managed-Cluster-RG': 'cluster-rg' } };
    if (args[0] === 'aks' && args[1] === 'show') return { nodeResourceGroup: 'node-rg' };
    if (args[0] === 'aks') return { scaleDownMode: 'Deallocate' };
    return { statuses: [{ code: args.at(-1) === '1' ? 'PowerState/deallocated' : 'PowerState/running' }] };
  };
  const result = await checkDeallocatedNodes(nodes, run);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(detectIssues([], result.nodes).map(issue => issue.title), ['Node running: not ready', 'Node not-ready: not ready']);
  assert.equal(calls.filter(args => args[0] === 'group').length, 1);
  assert.equal(calls.filter(args => args[0] === 'vmss').length, 2);
  assert.ok(calls.every(args => args.includes('00000000-0000-0000-0000-000000000001')));
});

test('failed Azure verification keeps unknown nodes as issues and reports incomplete checks', async () => {
  const node = {
    name: 'unknown', ready: 'Unknown', pool: 'pool1',
    providerId: 'azure:///subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/node-rg/providers/Microsoft.Compute/virtualMachineScaleSets/vmss/virtualMachines/1'
  };
  const result = await checkDeallocatedNodes([node, { ...node, name: 'unknown-2' }], async () => { throw new Error('Forbidden'); });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /2 nodes/);
  assert.match(result.errors[0], /Forbidden/);
  assert.equal(detectIssues([], result.nodes).length, 2);
});

test('Azure checks reject unsafe resource identifiers before executing commands', async () => {
  const node = {
    name: 'unknown', ready: 'Unknown', pool: 'pool&unsafe',
    providerId: 'azure:///subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/node-rg/providers/Microsoft.Compute/virtualMachineScaleSets/vmss/virtualMachines/1'
  };
  const result = await checkDeallocatedNodes([node], async () => assert.fail('Unexpected Azure command'));
  assert.match(result.errors[0], /unsupported Azure resource name/);
  assert.equal(detectIssues([], result.nodes).length, 1);
});

test('a pool using delete mode does not suppress unknown nodes', async () => {
  const node = {
    name: 'unknown', ready: 'Unknown', pool: 'pool1',
    providerId: 'azure:///subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/node-rg/providers/Microsoft.Compute/virtualMachineScaleSets/vmss/virtualMachines/1'
  };
  const result = await checkDeallocatedNodes([node], async args => {
    if (args[0] === 'group') return { tags: { 'AKS-Managed-Cluster-Name': 'cluster', 'AKS-Managed-Cluster-RG': 'cluster-rg' } };
    if (args[1] === 'show') return { nodeResourceGroup: 'node-rg' };
    if (args[1] === 'nodepool') return { scaleDownMode: 'Delete' };
    assert.fail('A delete-mode pool does not need an instance view');
  });
  assert.deepEqual(result.errors, []);
  assert.equal(detectIssues([], result.nodes).length, 1);
});

test('Azure authentication errors are concise and do not expose CLI output', () => {
  const result = describeAzureFailure({ stderr: '#< CLIXML ERROR: AADSTS70043: expired token. tenant-id trace-id az logout <Objs>secret</Objs>' });
  assert.match(result, /sign-in expired/i);
  assert.doesNotMatch(result, /CLIXML|tenant-id|trace-id|az logout|secret/);
  assert.match(describeAzureFailure({ stderr: 'AuthorizationFailed' }), /access was denied/i);
  assert.match(describeAzureFailure({ stderr: 'unexpected private response' }), /check failed/i);
  assert.doesNotMatch(describeAzureFailure({ stderr: 'unexpected private response' }), /private response/);
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
  const instance = await createInstance({ kubernetes });
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
  assert.equal((await request('editing', { enabled: true, context: 'ctx-b', namespace: 'shop' })).status, 400);
  await request('editing', { enabled: true, context: 'ctx-a', namespace: 'shop' });
  assert.equal((await request('scale', { ...target, context: 'ctx-b' })).status, 400);
  assert.equal((await request('scale', target)).status, 200);
  assert.deepEqual(calls, [['ctx-a', 'shop', 'api', 2]]);
  await request('select-namespace', { namespace: 'other' });
  assert.equal(instance.getContext().editing, false);
  assert.equal((await request('scale', target)).status, 400);
  assert.equal(calls.length, 1);
});

test('cluster scan reports partial failures and rejects stale or unsafe AI issues', async t => {
  const kubernetes = {
    contexts: async () => ['ctx'],
    clusterPods: async () => [{ kind: 'Pod', name: 'pod-a', namespace: 'shop', status: 'Pending' }],
    clusterDeployments: async () => [],
    nodes: async () => { throw new Error('Forbidden'); }
  };
  const instance = await createInstance({ kubernetes });
  t.after(() => instance.close());
  const page = await (await fetch(instance.url)).text();
  const token = page.match(/name="canvas-token" content="([^"]+)"/)[1];
  const request = async (path, data = {}) => {
    const response = await fetch(new URL(`api/${path}`, instance.url), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Canvas-Token': token }, body: JSON.stringify(data)
    });
    return response.json();
  };
  await request('select-context', { context: 'ctx' });
  const scan = await request('scan');
  assert.equal(scan.issues[0].name, 'pod-a');
  assert.match(scan.errors[0], /Nodes: Forbidden/);
  const issue = { context: 'ctx', title: 'Pending pod', evidence: 'Pod is pending', next: 'Inspect events', docs: ['https://kubernetes.io/docs/'] };
  assert.equal(instance.publishIssue(issue).aiIssues.length, 1);
  assert.equal(instance.publishIssue({ ...issue, kind: 'Pod', name: 'pod-a', namespace: 'shop' }).aiIssues[1].name, 'pod-a');
  const updated = instance.publishIssue({ ...issue, kind: 'Pod', name: 'pod-a', namespace: 'shop', next: 'Review updated evidence' });
  assert.equal(updated.aiIssues.length, 2);
  assert.equal(updated.aiIssues[1].next, 'Review updated evidence');
  assert.throws(() => instance.publishIssue({ ...issue, context: 'other' }), /context has changed/);
  assert.throws(() => instance.publishIssue({ ...issue, docs: ['https://evil.example/'] }), /Documentation links/);
  assert.throws(() => instance.publishIssue({ ...issue, kind: 'Pod', name: '--all', namespace: 'shop' }), /Invalid resource name/);
});

test('scan retains unknown nodes and reports Azure verification failures', async t => {
  const node = { name: 'node-a', ready: 'Unknown', pool: 'pool1' };
  const kubernetes = {
    contexts: async () => ['ctx'],
    clusterPods: async () => [],
    clusterDeployments: async () => [],
    nodes: async () => [node]
  };
  const instance = await createInstance({
    kubernetes,
    checkNodes: async nodes => ({ nodes, errors: ['Azure deallocation check failed: Forbidden'] })
  });
  t.after(() => instance.close());
  const page = await (await fetch(instance.url)).text();
  const token = page.match(/name="canvas-token" content="([^"]+)"/)[1];
  const request = async (path, data = {}) => (await fetch(new URL(`api/${path}`, instance.url), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Canvas-Token': token }, body: JSON.stringify(data)
  })).json();
  await request('select-context', { context: 'ctx' });
  const scan = await request('scan');
  assert.equal(scan.issues[0].name, 'node-a');
  assert.match(scan.errors[0], /Forbidden/);
});

test('Copilot requests are context-bound and include verified scan inputs', async t => {
  const sent = [];
  const instance = await createInstance({
    kubernetes: { contexts: async () => ['ctx-a', 'ctx-b'] },
    askCopilot: async (...args) => { sent.push(args); }
  });
  t.after(() => instance.close());
  const page = await (await fetch(instance.url)).text();
  const token = page.match(/name="canvas-token" content="([^"]+)"/)[1];
  const request = (path, data) => fetch(new URL(`api/${path}`, instance.url), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Canvas-Token': token }, body: JSON.stringify(data)
  });
  await request('select-context', { context: 'ctx-a' });
  assert.equal((await request('ask-copilot', { context: 'ctx-b' })).status, 400);
  const finding = { title: 'Pod checkout: Pending', evidence: 'Current pod state: Pending.', next: 'Review events.', kind: 'Pod', name: 'checkout', namespace: 'shop' };
  assert.equal((await request('ask-copilot', { context: 'ctx-a', findings: [finding], scanErrors: ['Nodes: Forbidden'] })).status, 200);
  assert.deepEqual(sent, [['ctx-a', [finding], ['Nodes: Forbidden']]]);
  assert.equal((await request('ask-copilot', { context: 'ctx-a', findings: [{ ...finding, kind: 'Secret' }] })).status, 400);
});

test('manual Copilot questions require the selected context and resource target', async t => {
  const sent = [];
  const instance = await createInstance({
    kubernetes: { contexts: async () => ['ctx-a', 'ctx-b'], namespaces: async () => ['shop'] },
    askManualCopilot: async (...args) => sent.push(args)
  });
  t.after(() => instance.close());
  const page = await (await fetch(instance.url)).text();
  const token = page.match(/name="canvas-token" content="([^"]+)"/)[1];
  const request = (path, data) => fetch(new URL(`api/${path}`, instance.url), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Canvas-Token': token }, body: JSON.stringify(data)
  });
  await request('select-context', { context: 'ctx-a' });
  await request('select-namespace', { namespace: 'shop' });
  const resource = { context: 'ctx-a', namespace: 'shop', kind: 'Pod', name: 'pod-a', question: ' Why pending? ' };
  assert.equal((await request('ask-manual-copilot', { context: 'ctx-b', question: 'Check cluster' })).status, 400);
  assert.equal((await request('ask-manual-copilot', { ...resource, namespace: 'other' })).status, 400);
  assert.equal((await request('ask-manual-copilot', { ...resource, kind: 'Secret' })).status, 400);
  assert.equal((await request('ask-manual-copilot', { context: 'ctx-a', question: '  ' })).status, 400);
  assert.equal((await request('ask-manual-copilot', { context: 'ctx-a', question: 'x'.repeat(2001) })).status, 400);
  assert.equal((await request('ask-manual-copilot', { context: 'ctx-a', question: 'Check cluster' })).status, 200);
  assert.equal((await request('ask-manual-copilot', resource)).status, 200);
  assert.deepEqual(sent, [
    ['ctx-a', null, 'Check cluster'],
    ['ctx-a', { kind: 'Pod', name: 'pod-a', namespace: 'shop' }, 'Why pending?']
  ]);
});

test('resource evidence is target-bound and event failures remain visible', async t => {
  const requested = [];
  const kubernetes = {
    contexts: async () => ['ctx'],
    namespaces: async () => ['shop', 'other'],
    resource: async (_context, target) => ({ ...target, uid: 'uid-123', conditions: [], containers: [], related: [] }),
    resourceEvents: async () => { throw new Error('Forbidden'); }
  };
  const instance = await createInstance({
    kubernetes, askResourceCopilot: async (context, target, signals) => requested.push({ context, target, signals })
  });
  t.after(() => instance.close());
  const page = await (await fetch(instance.url)).text();
  const token = page.match(/name="canvas-token" content="([^"]+)"/)[1];
  const request = (path, data) => fetch(new URL(`api/${path}`, instance.url), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Canvas-Token': token }, body: JSON.stringify(data)
  });
  await request('select-context', { context: 'ctx' });
  await request('select-namespace', { namespace: 'shop' });
  const target = { context: 'ctx', namespace: 'shop', kind: 'Pod', name: 'pod-a' };
  const response = await (await request('resource', target)).json();
  assert.equal(response.details.name, 'pod-a');
  assert.equal(response.eventError, 'Forbidden');
  assert.equal((await request('ask-resource-copilot', target)).status, 200);
  assert.deepEqual(requested, [{
    context: 'ctx', target: { kind: 'Pod', name: 'pod-a', namespace: 'shop' },
    signals: ['Resource events could not be read; event evidence is incomplete.']
  }]);
  assert.equal((await request('resource', { ...target, namespace: 'other' })).status, 400);
  assert.equal((await request('ask-resource-copilot', { ...target, kind: 'Secret' })).status, 400);
});

test('resource investigation shares only allowlisted indicators and clears them for a new target', async t => {
  const requested = [];
  const kubernetes = {
    contexts: async () => ['ctx'],
    namespaces: async () => ['shop', 'other'],
    resource: async (_context, target) => ({
      ...target, uid: 'uid-123', phase: 'Pending', desired: 3, available: 1,
      conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: 'private-condition' }],
      containers: [{ waitingReason: 'ContainerCreating', waitingMessage: 'private-container' }],
      related: [{ kind: 'SecretProviderClass', name: 'private-reference' }]
    }),
    resourceEvents: async () => [
      { reason: 'FailedMount', message: 'SecretNotFound private-event' },
      { reason: 'private-reason', message: 'private-message' }
    ]
  };
  const instance = await createInstance({
    kubernetes, askResourceCopilot: async (_context, _target, signals) => requested.push(signals)
  });
  t.after(() => instance.close());
  const page = await (await fetch(instance.url)).text();
  const token = page.match(/name="canvas-token" content="([^"]+)"/)[1];
  const request = (path, data) => fetch(new URL(`api/${path}`, instance.url), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Canvas-Token': token }, body: JSON.stringify(data)
  });
  await request('select-context', { context: 'ctx' });
  await request('select-namespace', { namespace: 'shop' });
  const target = { context: 'ctx', namespace: 'shop', kind: 'Pod', name: 'pod-a' };
  assert.equal((await request('resource', target)).status, 200);
  assert.equal((await request('ask-resource-copilot', { ...target, signals: ['private-client-input'] })).status, 200);
  assert.match(requested[0].join(' '), /Pending.*Unschedulable.*ContainerCreating.*FailedMount.*SecretNotFound/);
  assert.doesNotMatch(JSON.stringify(requested[0]), /private/);
  await request('select-namespace', { namespace: 'other' });
  await request('select-namespace', { namespace: 'shop' });
  await request('ask-resource-copilot', target);
  assert.match(requested[1][0], /not available/);
  const deployment = { ...target, kind: 'Deployment', name: 'checkout' };
  await request('resource', deployment);
  await request('ask-resource-copilot', deployment);
  assert.match(requested[2].join(' '), /fewer available replicas than desired/);
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
