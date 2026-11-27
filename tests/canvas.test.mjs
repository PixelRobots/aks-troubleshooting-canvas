import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { createKubernetes } from '../extensions/aks-canvas/kubernetes.mjs';
import { createInstance } from '../extensions/aks-canvas/server.mjs';
import { detectIssues, detectWarningIssues } from '../extensions/aks-canvas/issues.mjs';
import { groupFindings } from '../extensions/aks-canvas/finding-groups.mjs';
import { checkDeallocatedNodes, describeAzureFailure } from '../extensions/aks-canvas/azure.mjs';

test('canvas manifest exposes single and batch issue publishing', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extensions/aks-canvas/extension.json', import.meta.url), 'utf8'));
  const action = manifest.canvases[0].actions.find(item => item.name === 'publish_issue');
  assert.ok(action);
  assert.ok(action.inputSchema.required.includes('evidence'));
  const batch = manifest.canvases[0].actions.find(item => item.name === 'publish_issues');
  assert.ok(batch.inputSchema.properties.issues.items.required.includes('evidence'));
});

test('canvas investigations use a tool-free workflow and surface workflow failures', async () => {
  const source = (await readFile(new URL('../extensions/aks-canvas/extension.mjs', import.meta.url), 'utf8'))
    .replace(/^import .+;\r?\n/gm, '');
  let canvas;
  let instanceOptions;
  const requests = [];
  let outcome = 'completed';
  const completeSummary = '## Observations\nThe pod is Pending.\n\n## Next steps\nCheck scheduling.';
  await runInNewContext(`(async () => {\n${source}\n})()`, {
    declaration: { canvases: [{ actions: [] }] },
    createCanvas: value => value,
    defineWorkflow: value => value,
    joinSession: async options => {
      [canvas] = options.canvases;
      return { workflow: { run: async (workflow, request) => {
        requests.push(request);
        if (outcome !== 'completed') return { status: outcome };
        const result = await workflow.run({
          args: request.args, agents: { investigator: 'investigator', diagnostician: 'diagnostician', verifier: 'verifier' },
          agent: async (_prompt, options) => {
            assert.ok(['investigator', 'diagnostician', 'verifier'].includes(options.agent));
            if (options.agent === 'investigator') return 'Evidence: pod Pending.';
            return options.schema
              ? { findings: [{ index: 0, evidence: 'Pending', next: 'Check scheduling.', diagnosis: completeSummary, suggestions: ['Review pod'] }] }
              : completeSummary;
          }
        });
        return { status: 'completed', result };
      } } };
    },
    createInstance: async options => { instanceOptions = options; return { url: 'http://127.0.0.1/' }; }
  });
  await canvas.open({ instanceId: 'test-instance' });
  const summary = await instanceOptions.askResourceCopilot('ctx', { kind: 'Pod', name: 'web', namespace: 'shop' }, ['Pending']);
  assert.equal(summary, completeSummary);
  assert.equal(requests[0].notifyOnComplete, false);
  assert.match(requests[0].args.prompt, /Pending/);
  const review = await instanceOptions.askCopilot('ctx', [{ title: 'Pending' }], []);
  assert.equal(review[0].index, 0);
  outcome = 'error';
  await assert.rejects(instanceOptions.askResourceCopilot('ctx', { kind: 'Pod', name: 'web', namespace: 'shop' }, []), /workflow did not complete/);
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

test('recent warning checks retain distinct reasons and match current resource identities', () => {
  const now = Date.parse('2026-11-26T14:00:00Z');
  const pod = { kind: 'Pod', name: 'pod-a', namespace: 'shop', uid: 'pod-uid',
    owners: [{ kind: 'DaemonSet', name: 'agent', uid: 'owner-uid' }] };
  const event = (reason, time, target = pod) => ({ reason, time, target, message: 'private event message' });
  const result = detectWarningIssues([
    event('FailedMount', '2026-11-26T13:00:00Z'),
    event('FailedMount', '2026-11-26T13:30:00Z'),
    event('FailedScheduling', '2026-11-26T13:45:00Z'),
    event('Unhealthy', '2026-11-26T13:50:00Z', { kind: 'DaemonSet', name: 'agent', namespace: 'shop', uid: 'owner-uid' }),
    event('BackOff', '2026-11-26T12:59:59Z'),
    event('BackOff', '2026-11-26T14:00:01Z'),
    event('BackOff', 'invalid'),
    event('FailedMount', '2026-11-26T13:30:00Z', { ...pod, uid: 'old-uid' }),
    event('FailedMount', '2026-11-26T13:30:00Z', { ...pod, namespace: 'other' }),
    event('private-reason', '2026-11-26T13:30:00Z')
  ], [pod], [], now);
  assert.deepEqual(result.issues.map(issue => issue.title), [
    'Pod pod-a: recent FailedMount warning',
    'Pod pod-a: recent FailedScheduling warning',
    'DaemonSet agent: recent Unhealthy warning'
  ]);
  assert.match(result.errors[0], /2 matching events.*invalid or future timestamps/);
  assert.doesNotMatch(JSON.stringify(result), /private/);
  assert.deepEqual(groupFindings(result.issues, [], [pod]).map(group => group.target.kind), ['DaemonSet']);
  const ownerEvent = event('Unhealthy', '2026-11-26T13:50:00Z',
    { kind: 'DaemonSet', name: 'agent', namespace: 'shop', uid: 'owner-uid' });
  const oldPod = { ...pod, name: 'pod-old', uid: 'other-pod', owners: [{ kind: 'DaemonSet', name: 'agent', uid: 'old-owner' }] };
  const ambiguous = detectWarningIssues([ownerEvent], [pod, oldPod], [], now);
  assert.equal(ambiguous.issues.length, 0);
  assert.match(ambiguous.errors[0], /ambiguous resource identities/);
  const verified = detectWarningIssues([ownerEvent], [pod, oldPod,
    { kind: 'DaemonSet', name: 'agent', namespace: 'shop', uid: 'owner-uid' }], [], now);
  assert.equal(verified.issues.length, 1);
});

test('warning-event pages are bounded, context-pinned and exclude raw event messages', async () => {
  const requests = [];
  const kube = createKubernetes(async args => {
    requests.push(args);
    const url = new URL(args.at(-1), 'https://kubernetes.invalid');
    assert.equal(url.pathname, '/api/v1/events');
    assert.equal(url.searchParams.get('fieldSelector'), 'type=Warning');
    assert.equal(url.searchParams.get('limit'), '200');
    return JSON.stringify({
      kind: 'EventList',
      metadata: { continue: requests.length === 1 ? 'next+page' : '' },
      items: [{
        type: 'Warning', reason: 'FailedMount', message: 'private-event-message',
        lastTimestamp: '2026-11-26T13:00:00Z',
        involvedObject: { kind: 'Pod', name: 'pod-a', namespace: 'shop', uid: 'pod-uid' }
      }]
    });
  });
  const result = await kube.clusterWarningEvents('ctx');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].slice(0, 3), ['--context', 'ctx', 'get']);
  assert.equal(new URL(requests[1].at(-1), 'https://kubernetes.invalid').searchParams.get('continue'), 'next+page');
  assert.equal(result.truncated, false);
  assert.equal(result.events.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /private/);

  let page = 0;
  const bounded = createKubernetes(async () => JSON.stringify({
    kind: 'EventList', items: [], metadata: { continue: `page-${++page}` }
  }));
  assert.equal((await bounded.clusterWarningEvents('ctx')).truncated, true);
  assert.equal(page, 10);
  const repeated = createKubernetes(async () => JSON.stringify({
    kind: 'EventList', items: [], metadata: { continue: 'same' }
  }));
  await assert.rejects(repeated.clusterWarningEvents('ctx'), /repeated event continuation token/);
  let attempts = 0;
  const failed = createKubernetes(async () => {
    if (++attempts === 2) throw new Error('Forbidden');
    return JSON.stringify({ kind: 'EventList', items: [], metadata: { continue: 'next' } });
  });
  await assert.rejects(failed.clusterWarningEvents('ctx'), /Forbidden/);
  const unknownLastTime = createKubernetes(async () => JSON.stringify({
    kind: 'EventList',
    items: [{ type: 'Warning', reason: 'FailedMount', count: 2, firstTimestamp: '2026-11-26T13:00:00Z' }]
  }));
  assert.equal((await unknownLastTime.clusterWarningEvents('ctx')).events[0].time, undefined);
});

test('cluster and Copilot findings merge under Deployment and CronJob owners', () => {
  const resources = [
    { kind: 'Pod', name: 'web-abc', namespace: 'shop', owners: [{ kind: 'ReplicaSet', name: 'web-rs' }] },
    { kind: 'ReplicaSet', name: 'web-rs', namespace: 'shop', owners: [{ kind: 'Deployment', name: 'web' }] },
    { kind: 'Pod', name: 'backup-123', namespace: 'shop', owners: [{ kind: 'Job', name: 'backup-123' }], references: [{ kind: 'PersistentVolumeClaim', name: 'backup-data' }] },
    { kind: 'Job', name: 'backup-123', namespace: 'shop', owners: [{ kind: 'CronJob', name: 'backup' }] },
  ];
  const cluster = [
    { kind: 'Pod', name: 'web-abc', namespace: 'shop', title: 'Pod web-abc: Pending', evidence: 'Pod is pending', next: 'Review scheduling', docs: [] },
    { kind: 'Pod', name: 'backup-123', namespace: 'shop', title: 'Pod backup-123: Pending', evidence: 'Pod is pending', next: 'Review scheduling', docs: [] }
  ];
  const copilot = [
    { kind: 'Pod', name: 'web-abc', namespace: 'shop', title: 'Pod web-abc: Pending', evidence: 'No assigned node is reported', next: 'Check the owner workload', docs: [], diagnosis: '## Summary\nScheduling is unconfirmed.', suggestions: ['Show pod events'] },
    { kind: 'PersistentVolumeClaim', name: 'backup-data', namespace: 'shop', title: 'PVC backup-data: unavailable', evidence: 'Copilot observed a related claim signal', next: 'Inspect the claim state', docs: [] }
  ];
  const groups = groupFindings(cluster, copilot, resources);
  assert.deepEqual(groups.map(group => [group.target.kind, group.target.name]), [
    ['Deployment', 'web'], ['CronJob', 'backup']
  ]);
  const deployment = groups.find(group => group.target.kind === 'Deployment');
  assert.equal(deployment.signals.length, 1);
  assert.deepEqual(deployment.signals[0].sources, ['Cluster check', 'Copilot']);
  assert.equal(deployment.signals[0].diagnoses[0], '## Summary\nScheduling is unconfirmed.');
  assert.deepEqual(deployment.signals[0].suggestions, ['Show pod events']);
  const cronjob = groups.find(group => group.target.kind === 'CronJob');
  assert.equal(cronjob.resources.size, 2);
  assert.equal(cronjob.signals.length, 2);

  const sharedClaim = groupFindings([{
    kind: 'PersistentVolumeClaim', name: 'shared-data', namespace: 'shop',
    title: 'PVC shared-data: unavailable', evidence: 'Claim signal', next: 'Review claim', docs: []
  }], [], [
    { kind: 'Pod', name: 'web-abc', namespace: 'shop', owners: [{ kind: 'Deployment', name: 'web' }], references: [{ kind: 'PersistentVolumeClaim', name: 'shared-data' }] },
    { kind: 'Pod', name: 'api-abc', namespace: 'shop', owners: [{ kind: 'Deployment', name: 'api' }], references: [{ kind: 'PersistentVolumeClaim', name: 'shared-data' }] }
  ]);
  assert.deepEqual(sharedClaim[0].target, { kind: 'PersistentVolumeClaim', name: 'shared-data', namespace: 'shop' });

  const customOwner = groupFindings([{
    kind: 'Pod', name: 'operator-pod', namespace: 'shop',
    title: 'Pod operator-pod: Pending', evidence: 'Pod is pending', next: 'Review scheduling', docs: []
  }], [], [{
    kind: 'Pod', name: 'operator-pod', namespace: 'shop', owners: [{ kind: 'CustomWorkload', name: 'workload' }]
  }]);
  assert.deepEqual(customOwner[0].target, { kind: 'Pod', name: 'operator-pod', namespace: 'shop' });
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

test('cluster pod scanning detects current OOM termination without treating recovered pods as failed', async () => {
  const kube = createKubernetes(async () => JSON.stringify({
    kind: 'PodList',
    items: [
      { metadata: { name: 'oom', namespace: 'shop' }, status: { phase: 'Failed',
        containerStatuses: [{ state: { terminated: { reason: 'OOMKilled' } } }] } },
      { metadata: { name: 'recovered', namespace: 'shop' }, status: { phase: 'Running',
        containerStatuses: [{ state: { running: {} }, lastState: { terminated: { reason: 'OOMKilled' } } }] } }
    ]
  }));
  const issues = detectIssues(await kube.clusterPods('ctx'), []);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].title, 'Pod oom: OOMKilled');
  assert.match(issues[0].evidence, /container terminated: OOMKilled/);
});

test('cluster ownership scans project pod references, ReplicaSets and Jobs', async () => {
  const kube = createKubernetes(async args => {
    const path = new URL(args.at(-1), 'https://kubernetes.invalid').pathname;
    if (path === '/api/v1/pods') return JSON.stringify({
      kind: 'PodList',
      items: [{
        metadata: { name: 'backup-123', namespace: 'shop', ownerReferences: [{ kind: 'Job', name: 'backup-123', controller: true }] },
        spec: { volumes: [
          { persistentVolumeClaim: { claimName: 'backup-data' } },
          { csi: { driver: 'secrets-store.csi.k8s.io', volumeAttributes: { secretProviderClass: 'vault' } } }
        ] },
        status: { phase: 'Pending' }
      }]
    });
    if (path === '/apis/apps/v1/replicasets') return JSON.stringify({
      kind: 'ReplicaSetList',
      items: [{ metadata: { name: 'web-rs', namespace: 'shop', ownerReferences: [{ kind: 'Deployment', name: 'web', controller: true }] } }]
    });
    if (path === '/apis/batch/v1/jobs') return JSON.stringify({
      kind: 'JobList',
      items: [{ metadata: { name: 'backup-123', namespace: 'shop', ownerReferences: [{ kind: 'CronJob', name: 'backup', controller: true }] } }]
    });
    assert.fail(`Unexpected Kubernetes path: ${path}`);
  });
  const pods = await kube.clusterPods('ctx');
  const replicaSets = await kube.clusterReplicaSets('ctx');
  const jobs = await kube.clusterJobs('ctx');
  assert.deepEqual(pods[0].owners, [{ kind: 'Job', name: 'backup-123' }]);
  assert.deepEqual(pods[0].references, [
    { kind: 'PersistentVolumeClaim', name: 'backup-data' },
    { kind: 'SecretProviderClass', name: 'vault' }
  ]);
  assert.deepEqual(replicaSets[0].owners, [{ kind: 'Deployment', name: 'web' }]);
  assert.deepEqual(jobs[0].owners, [{ kind: 'CronJob', name: 'backup' }]);
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
      if (path === '/apis/apps/v1/replicasets') return JSON.stringify({ kind: 'ReplicaSetList', items: [] });
      if (path === '/apis/batch/v1/jobs') return JSON.stringify({ kind: 'JobList', items: [] });
      if (path === '/api/v1/nodes') return JSON.stringify({ kind: 'NodeList', items: [] });
      if (path === '/api/v1/events') return JSON.stringify({ kind: 'EventList', items: [] });
    }
    if (args.includes('namespaces')) return JSON.stringify({ items: [{ metadata: { name: 'shop' } }] });
    if (args.includes('deployments,pods')) return JSON.stringify({ items: [pod, deployment] });
    if (args.includes('events')) return JSON.stringify({ items: [{ metadata: { name: 'event-a' }, type: 'Warning', reason: 'FailedScheduling' }] });
    assert.fail(`Unexpected kubectl command: ${args.join(' ')}`);
  });
  const instance = await createInstance({ kubernetes, checkNodes: async nodes => ({ nodes, errors: [] }) });
  t.after(() => instance.close());
  const page = await (await fetch(instance.url)).text();
  const moduleResponse = await fetch(new URL('finding-groups.mjs', instance.url));
  assert.equal(moduleResponse.status, 200);
  assert.match(await moduleResponse.text(), /export function groupFindings/);
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
      status: {
        phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: 'Insufficient cpu' }],
        containerStatuses: [{ name: 'app', state: { terminated: { reason: 'Error', exitCode: 1 } }, lastState: { terminated: { reason: 'OOMKilled', exitCode: 137, message: 'private-termination' } } }]
      }
    });
  });
  const target = { kind: 'Pod', name: 'pod-a', namespace: 'shop' };
  const details = await kube.resource('ctx', target);
  assert.equal(details.conditions[0].reason, 'Unschedulable');
  assert.equal(details.containers[0].terminationExitCode, 1);
  assert.equal(details.containers[0].lastTerminationReason, 'OOMKilled');
  assert.equal(details.containers[0].lastTerminationExitCode, 137);
  assert.deepEqual(details.related, [
    { kind: 'Job', name: 'backup' }, { kind: 'Node', name: 'node-a' },
    { kind: 'PersistentVolumeClaim', name: 'data' }, { kind: 'SecretProviderClass', name: 'vault' }
  ]);
  assert.doesNotMatch(JSON.stringify(details), /do-not-return|private-termination/);
  const events = await kube.resourceEvents('ctx', target, details.uid);
  assert.equal(events[0].reason, 'FailedMount');
  assert.ok(calls[1].includes('involvedObject.uid=uid-123'));
  await assert.rejects(kube.resource('ctx', { ...target, kind: 'Secret' }), /Unsupported resource kind/);
  await assert.rejects(kube.resource('ctx', { ...target, name: '--all' }), /Invalid resource name/);
  assert.equal(calls.length, 2);
});

test('CronJob investigation projects only reported scheduling status', async () => {
  let item = {
    metadata: { name: 'backup', uid: 'uid-123' },
    spec: { schedule: '0 1 * * *', suspend: false, jobTemplate: { spec: { template: { spec: { secret: 'do-not-return' } } } } },
    status: { active: [{ name: 'a' }, { name: 'b' }], lastScheduleTime: '2026-01-02T01:00:00Z', lastSuccessfulTime: '2026-01-01T01:00:00Z' }
  };
  const kube = createKubernetes(async () => JSON.stringify(item));
  const target = { kind: 'CronJob', name: 'backup', namespace: 'shop' };
  const details = await kube.resource('ctx', target);
  assert.equal(details.schedule, '0 1 * * *');
  assert.equal(details.suspended, false);
  assert.equal(details.activeJobs, 2);
  assert.equal(details.lastScheduleTime, '2026-01-02T01:00:00Z');
  assert.equal(details.lastSuccessfulTime, '2026-01-01T01:00:00Z');
  assert.doesNotMatch(JSON.stringify(details), /do-not-return/);
  item = { metadata: { name: 'backup' }, spec: {}, status: {} };
  const missing = await kube.resource('ctx', target);
  assert.equal(missing.activeJobs, undefined);
  assert.equal(missing.suspended, undefined);
  assert.equal(missing.lastSuccessfulTime, undefined);
});

test('SecretProviderClass projection includes names but no object values or identity secrets', async () => {
  const kube = createKubernetes(async args => {
    assert.deepEqual(args.slice(0, 3), ['--context', 'ctx', '-n']);
    return JSON.stringify({
      apiVersion: 'secrets-store.csi.x-k8s.io/v1', kind: 'SecretProviderClass',
      metadata: { name: 'backup-spc', uid: '12345678-1234-1234-1234-123456789012' },
      spec: {
        provider: 'azure',
        parameters: {
          keyvaultName: 'backup-vault',
          clientID: 'private-identity-value',
          tenantId: 'private-tenant-value',
          objects: 'array:\\n  - |\\n    objectName: storage-account-name\\n    objectType: secret\\n    objectVersion: \"\"'
        }
      }
    });
  });
  const result = await kube.resource('ctx', { kind: 'SecretProviderClass', name: 'backup-spc', namespace: 'backup' });
  assert.equal(result.provider, 'azure');
  assert.equal(result.keyVaultName, 'backup-vault');
  assert.deepEqual(result.secretProviderObjects, ['storage-account-name']);
  assert.doesNotMatch(JSON.stringify(result), /private-identity-value|private-tenant-value/);
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
    clusterWarningEvents: async () => ({ events: [], truncated: false }),
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
  const node = { ...issue, title: 'Node not ready', kind: 'Node', name: 'node-a', namespace: '' };
  assert.throws(() => instance.publishIssues([node, { ...issue, context: 'other' }]), /context has changed/);
  assert.equal(instance.getContext().aiIssues.length, 2);
  assert.deepEqual(instance.publishIssues([node, { ...issue, title: 'Second finding' }]), { published: 2 });
  assert.equal(instance.getContext().aiIssues[2].namespace, '');
  assert.throws(() => instance.publishIssues([]), /between 1 and 100/);
});

test('cluster scan incorporates recent warning signals and reports incomplete event reads', async t => {
  const pod = { kind: 'Pod', name: 'pod-a', namespace: 'shop', uid: 'pod-uid', status: 'Running',
    owners: [{ kind: 'DaemonSet', name: 'agent', uid: 'agent-uid' }] };
  let failEvents = false;
  const kubernetes = {
    contexts: async () => ['ctx'],
    clusterPods: async () => [pod],
    clusterDeployments: async () => [],
    nodes: async () => [],
    clusterWarningEvents: async () => {
      if (failEvents) throw new Error('Forbidden');
      return { truncated: true, events: [
        { reason: 'FailedMount', time: new Date().toISOString(), target: pod, message: 'private-event-message' }
      ] };
    }
  };
  const instance = await createInstance({ kubernetes, checkNodes: async nodes => ({ nodes, errors: [] }) });
  t.after(() => instance.close());
  const page = await (await fetch(instance.url)).text();
  const token = page.match(/name="canvas-token" content="([^"]+)"/)[1];
  const request = async (path, data = {}) => (await fetch(new URL(`api/${path}`, instance.url), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Canvas-Token': token }, body: JSON.stringify(data)
  })).json();
  await request('select-context', { context: 'ctx' });
  const scan = await request('scan');
  assert.equal(scan.issues[0].title, 'Pod pod-a: recent FailedMount warning');
  assert.match(scan.errors[0], /2,000 events.*incomplete/);
  assert.equal(groupFindings(scan.issues, [], scan.resources)[0].target.kind, 'DaemonSet');
  assert.doesNotMatch(JSON.stringify(scan), /private-event-message/);
  failEvents = true;
  const failed = await request('scan');
  assert.deepEqual(failed.issues, []);
  assert.match(failed.errors[0], /Warning events: Forbidden/);
});

test('cluster-scoped nodes can be inspected without selecting a namespace', async t => {
  const calls = [];
  const kubernetes = createKubernetes(async args => {
    calls.push(args);
    if (args[0] === 'config') return 'ctx\n';
    if (args.includes('events')) return JSON.stringify({ items: [] });
    return JSON.stringify({ metadata: { name: 'node-a', uid: 'uid-123' }, status: { conditions: [{ type: 'Ready', status: 'False' }] } });
  });
  const instance = await createInstance({ kubernetes });
  t.after(() => instance.close());
  const page = await (await fetch(instance.url)).text();
  const token = page.match(/name="canvas-token" content="([^"]+)"/)[1];
  const request = (path, data) => fetch(new URL(`api/${path}`, instance.url), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Canvas-Token': token }, body: JSON.stringify(data)
  });
  await request('select-context', { context: 'ctx' });
  const node = { context: 'ctx', kind: 'Node', name: 'node-a', namespace: '' };
  const response = await request('resource', node);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).details.conditions[0].status, 'False');
  assert.ok(calls.some(args => args.includes('nodes') && !args.includes('-n')));
  assert.ok(calls.some(args => args.includes('events') && args.includes('--all-namespaces')));
  assert.equal((await request('resource', { ...node, context: 'other' })).status, 400);
  assert.equal((await request('resource', { ...node, kind: 'Pod' })).status, 400);
});

test('resource explorer discovers custom types and investigates only projected metadata', async t => {
  const calls = [];
  const sent = [];
  const kubernetes = createKubernetes(async args => {
    calls.push(args);
    if (args[0] === 'config') return 'ctx\nother\n';
    if (args.includes('api-resources')) return args.includes('--namespaced=true')
      ? 'pods\nsecrets\nwidgets.example.io\n' : 'nodes\nclusterwidgets.example.io\n';
    if (args.includes('namespaces')) return JSON.stringify({ items: [{ metadata: { name: 'shop' } }] });
    if (args.includes('get') && args.some(arg => arg.includes('range .items'))) return 'first\nsecond\n';
    if (args.includes('widgets.example.io') || args.includes('clusterwidgets.example.io') || args.includes('secrets')) return 'uid-123\t2026-01-01T00:00:00Z';
    throw new Error('Unexpected request');
  });
  const instance = await createInstance({
    kubernetes,
    askResourceCopilot: async (_context, target, signals) => { sent.push({ target, signals }); return 'Published'; }
  });
  t.after(() => instance.close());
  const page = await (await fetch(instance.url)).text();
  const token = page.match(/name="canvas-token" content="([^"]+)"/)[1];
  const request = (path, data = {}) => fetch(new URL(`api/${path}`, instance.url), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Canvas-Token': token }, body: JSON.stringify(data)
  });
  await request('select-context', { context: 'ctx' });
  const types = await (await request('resource-types')).json();
  assert.ok(types.some(type => type.kind === 'widgets.example.io' && type.namespaced));
  assert.ok(types.some(type => type.kind === 'clusterwidgets.example.io' && !type.namespaced));
  assert.ok(types.some(type => type.kind === 'Pod'));
  const cluster = { context: 'ctx', kind: 'clusterwidgets.example.io', namespace: '', name: 'first' };
  assert.deepEqual(await (await request('resource-names', cluster)).json(), ['first', 'second']);
  const clusterDetail = await (await request('resource', cluster)).json();
  assert.equal(clusterDetail.details.metadataOnly, true);
  assert.match(clusterDetail.eventError, /not collected/);
  assert.equal((await request('describe', cluster)).status, 400);
  assert.equal((await request('ask-resource-copilot', cluster)).status, 200);
  assert.match(sent[0].signals.join(' '), /Only resource metadata was collected/);
  assert.equal(instance.publishIssue({ ...cluster, title: 'Review resource', evidence: 'Only metadata was available.', next: 'Review authorized status.', docs: [] }).aiIssues[0].kind, cluster.kind);
  assert.equal((await request('resource', { ...cluster, kind: 'unknown.example.io' })).status, 400);
  await request('select-namespace', { namespace: 'shop' });
  const secret = { context: 'ctx', kind: 'secrets', namespace: 'shop', name: 'first' };
  assert.deepEqual(await (await request('resource-names', secret)).json(), ['first', 'second']);
  assert.equal((await request('resource', secret)).status, 200);
  assert.equal((await request('describe', secret)).status, 400);
  assert.ok(calls.filter(args => args.includes('secrets')).every(args => args.some(arg => arg.includes('.metadata.'))));
  assert.ok(calls.filter(args => args.includes('clusterwidgets.example.io')).every(args => !args.includes('-n')));
  await request('select-context', { context: 'other' });
  assert.equal((await request('resource', { ...cluster, context: 'other' })).status, 400);
});

test('scan retains unknown nodes and reports Azure verification failures', async t => {
  const node = { name: 'node-a', ready: 'Unknown', pool: 'pool1' };
  const kubernetes = {
    contexts: async () => ['ctx'],
    clusterPods: async () => [],
    clusterDeployments: async () => [],
    clusterWarningEvents: async () => ({ events: [], truncated: false }),
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
    askCopilot: async (...args) => {
      sent.push(args);
      return [{ index: 0, evidence: 'A current Pending pod was reported.', next: 'Inspect current events.', diagnosis: '## Summary\nPending requires investigation.', suggestions: ['Show recent events'] }];
    }
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
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].slice(0, 3), ['ctx-a', [finding], ['Nodes: Forbidden']]);
  assert.equal(sent[0][3][0].index, 0);
  assert.match(sent[0][3][0].signals.join(' '), /resource evidence could not be read/);
  const state = await (await request('state')).json();
  assert.match(state.aiIssues[0].diagnosis, /Summary/);
  assert.deepEqual(state.aiIssues[0].suggestions, ['Show recent events']);
  assert.equal((await request('ask-copilot', { context: 'ctx-a', findings: [{ ...finding, kind: 'Secret' }] })).status, 400);
});

test('manual Copilot questions require the selected context and resource target', async t => {
  const sent = [];
  const instance = await createInstance({
    kubernetes: { contexts: async () => ['ctx-a', 'ctx-b'], namespaces: async () => ['shop'] },
    askManualCopilot: async (...args) => { sent.push(args); return 'Answer to the resource question'; }
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
    ['ctx-a', null, 'Check cluster', ['No scan findings are available; this does not establish cluster health.'], []],
    ['ctx-a', { kind: 'Pod', name: 'pod-a', namespace: 'shop' }, 'Why pending?', [
      'Current resource evidence could not be read; do not assume the resource is healthy.',
      'Related pod 1 status or events could not be read; evidence is incomplete.'
    ], []]
  ]);
  const state = await (await request('state', {})).json();
  assert.equal(state.conversations.length, 2);
  assert.equal(state.conversations[1].messages[0].content, 'Why pending?');
  await request('ask-manual-copilot', { ...resource, question: 'What next?' });
  assert.equal(sent[2][4][0].content, 'Why pending?');
  assert.equal(sent[2][4][1].content, 'Answer to the resource question');
});

test('focused investigations sample related pods locally and retain the complete response', async t => {
  const calls = [];
  const prompts = [];
  const pods = ['a', 'b', 'c', 'd'].map(name => ({
    kind: 'Pod', name, namespace: 'shop', status: 'Pending', owners: [{ kind: 'Job', name: 'job' }]
  }));
  const kubernetes = {
    contexts: async () => ['ctx'], namespaces: async () => ['shop'],
    clusterPods: async () => [...pods, { kind: 'Pod', name: 'unrelated', namespace: 'shop', status: 'Pending', owners: [] }],
    clusterDeployments: async () => [], clusterReplicaSets: async () => [],
    clusterWarningEvents: async () => ({ events: [], truncated: false }),
    clusterJobs: async () => [{ kind: 'Job', name: 'job', namespace: 'shop', owners: [{ kind: 'CronJob', name: 'backup' }] }],
    nodes: async () => [],
    resource: async (_context, target) => ({
      ...target, uid: 'uid-123', phase: target.kind === 'Pod' ? 'Pending' : undefined,
      conditions: [], containers: [{ restarts: 1 }], related: []
    }),
    resourceEvents: async () => [{ type: 'Warning', reason: 'FailedScheduling', message: 'private-event-value' }],
    logs: async (_context, _namespace, pod, previous) => {
      calls.push([pod, previous]);
      if (previous) throw new Error('private-error-value');
      return 'connection refused private-log-value';
    }
  };
  const instance = await createInstance({
    kubernetes, checkNodes: async nodes => ({ nodes, errors: [] }),
    askResourceCopilot: async (_context, _target, signals) => { prompts.push(signals); return 'Complete answer\nwith the actual checks.'; }
  });
  t.after(() => instance.close());
  const page = await (await fetch(instance.url)).text();
  const token = page.match(/name="canvas-token" content="([^"]+)"/)[1];
  const request = (path, data = {}) => fetch(new URL(`api/${path}`, instance.url), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Canvas-Token': token }, body: JSON.stringify(data)
  });
  await request('select-context', { context: 'ctx' });
  await request('scan');
  await request('select-namespace', { namespace: 'shop' });
  const target = { context: 'ctx', namespace: 'shop', kind: 'CronJob', name: 'backup' };
  await request('resource', target);
  const response = await request('ask-resource-copilot', target);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).summary, 'Complete answer\nwith the actual checks.');
  assert.equal(calls.length, 6);
  assert.ok(calls.every(([name]) => ['a', 'b', 'c'].includes(name)));
  assert.match(prompts[0].join(' '), /Only 3 of 4 related pods/);
  assert.match(prompts[0].join(' '), /FailedScheduling.*connection refused.*previous logs could not be read/);
  assert.doesNotMatch(JSON.stringify(prompts), /private/);
  const state = await (await request('state')).json();
  assert.match(state.resourceSummaries[0].summary, /Cluster: ctx/);
  assert.match(state.resourceSummaries[0].summary, /Complete answer\nwith the actual checks\.$/);
  assert.match(state.resourceSummaries[0].activity.join(' '), /selected resource.*pod 1.*log indicators/i);
});

test('focused investigations check bounded related jobs and storage without forwarding configuration', async t => {
  const reads = [];
  let observed;
  const jobs = Array.from({ length: 4 }, (_, i) => ({
    kind: 'Job', name: `job-${i}`, namespace: 'shop', owners: [{ kind: 'CronJob', name: 'backup' }]
  }));
  const pod = { kind: 'Pod', name: 'pod-a', namespace: 'shop', owners: [{ kind: 'Job', name: 'job-0' }] };
  const kubernetes = {
    contexts: async () => ['ctx'], namespaces: async () => ['shop'],
    clusterPods: async () => [pod], clusterDeployments: async () => [], clusterReplicaSets: async () => [],
    clusterJobs: async () => jobs, nodes: async () => [],
    clusterWarningEvents: async () => ({ events: [], truncated: false }),
    resource: async (context, target) => {
      reads.push([context, target.kind, target.name]);
      if (target.kind === 'SecretProviderClass') return { ...target, provider: 'azure', private: 'private-object' };
      if (target.kind === 'PersistentVolumeClaim') return { ...target, phase: 'Bound' };
      if (target.kind === 'Job') return { ...target, jobActive: 1, jobFailed: 2, conditions: [], containers: [] };
      return {
        ...target, uid: 'uid-123', phase: 'Pending', conditions: [], containers: [],
        related: target.kind === 'Pod' ? [{ kind: 'PersistentVolumeClaim', name: 'claim' }, { kind: 'SecretProviderClass', name: 'class' }] : []
      };
    },
    resourceEvents: async () => [],
    logs: async () => ''
  };
  const instance = await createInstance({
    kubernetes, checkNodes: async nodes => ({ nodes, errors: [] }),
    askResourceCopilot: async (_context, _target, signals) => { observed = signals; return 'Summary'; }
  });
  t.after(() => instance.close());
  const page = await (await fetch(instance.url)).text();
  const token = page.match(/name="canvas-token" content="([^"]+)"/)[1];
  const request = (path, data = {}) => fetch(new URL(`api/${path}`, instance.url), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Canvas-Token': token }, body: JSON.stringify(data)
  });
  await request('select-context', { context: 'ctx' });
  await request('scan');
  await request('select-namespace', { namespace: 'shop' });
  const target = { context: 'ctx', namespace: 'shop', kind: 'CronJob', name: 'backup' };
  await request('resource', target);
  assert.equal((await request('ask-resource-copilot', target)).status, 200);
  assert.ok(reads.every(([context]) => context === 'ctx'));
  assert.equal(reads.filter(([, kind]) => kind === 'Job').length, 3);
  assert.match(observed.join(' '), /PersistentVolumeClaim.*Bound/);
  assert.match(observed.join(' '), /SecretProviderClass.*Azure provider/);
  assert.match(observed.join(' '), /Only 3 of 4 related Jobs/);
  assert.match(observed.join(' '), /Job reports 2 failed pods/);
  assert.doesNotMatch(JSON.stringify(observed), /private-object|claim|class/);
});

test('scan review rejects invalid indices instead of publishing to another target', async t => {
  const instance = await createInstance({
    kubernetes: { contexts: async () => ['ctx'] },
    askCopilot: async () => [{ index: 1, evidence: 'Wrong target', next: 'Inspect' }]
  });
  t.after(() => instance.close());
  const page = await (await fetch(instance.url)).text();
  const token = page.match(/name="canvas-token" content="([^"]+)"/)[1];
  const request = (path, data = {}) => fetch(new URL(`api/${path}`, instance.url), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Canvas-Token': token }, body: JSON.stringify(data)
  });
  await request('select-context', { context: 'ctx' });
  const finding = { title: 'Pending', evidence: 'Pending', next: 'Inspect', kind: 'Pod', name: 'pod-a', namespace: 'shop' };
  assert.equal((await request('ask-copilot', { context: 'ctx', findings: [finding] })).status, 400);
  assert.deepEqual((await (await request('state')).json()).aiIssues, []);
});

test('evidence collection stops before further reads when the namespace changes', async t => {
  let release;
  let started;
  const waiting = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { started = resolve; });
  let eventReads = 0;
  const instance = await createInstance({
    kubernetes: {
      contexts: async () => ['ctx'], namespaces: async () => ['shop', 'other'],
      resource: async (_context, target) => {
        started();
        await waiting;
        return { ...target, uid: 'uid-123', conditions: [], containers: [], related: [] };
      },
      resourceEvents: async () => { eventReads++; return []; }
    },
    askResourceCopilot: async () => 'Should not be requested'
  });
  t.after(() => instance.close());
  const page = await (await fetch(instance.url)).text();
  const token = page.match(/name="canvas-token" content="([^"]+)"/)[1];
  const request = (path, data = {}) => fetch(new URL(`api/${path}`, instance.url), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Canvas-Token': token }, body: JSON.stringify(data)
  });
  await request('select-context', { context: 'ctx' });
  await request('select-namespace', { namespace: 'shop' });
  const pending = request('ask-resource-copilot', { context: 'ctx', namespace: 'shop', kind: 'Pod', name: 'pod-a' });
  await began;
  await request('select-namespace', { namespace: 'other' });
  release();
  assert.equal((await pending).status, 400);
  assert.equal(eventReads, 0);
});

test('focused investigation does not save a response after the selected namespace changes', async t => {
  let release;
  let started;
  const waiting = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { started = resolve; });
  const instance = await createInstance({
    kubernetes: {
      contexts: async () => ['ctx'], namespaces: async () => ['shop', 'other'],
      resource: async (_context, target) => ({ ...target, uid: 'uid-123', conditions: [], containers: [], related: [] }),
      resourceEvents: async () => []
    },
    askResourceCopilot: async () => { started(); await waiting; return 'Old summary'; }
  });
  t.after(() => instance.close());
  const page = await (await fetch(instance.url)).text();
  const token = page.match(/name="canvas-token" content="([^"]+)"/)[1];
  const request = (path, data = {}) => fetch(new URL(`api/${path}`, instance.url), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Canvas-Token': token }, body: JSON.stringify(data)
  });
  await request('select-context', { context: 'ctx' });
  await request('select-namespace', { namespace: 'shop' });
  const target = { context: 'ctx', namespace: 'shop', kind: 'Deployment', name: 'web' };
  await request('resource', target);
  const pending = request('ask-resource-copilot', target);
  await began;
  await request('select-namespace', { namespace: 'other' });
  release();
  assert.equal((await pending).status, 400);
  assert.deepEqual((await (await request('state')).json()).resourceSummaries, []);
});

test('focused investigation reports a missing Copilot response', async t => {
  const instance = await createInstance({
    kubernetes: { contexts: async () => ['ctx'], namespaces: async () => ['shop'] },
    askResourceCopilot: async () => undefined
  });
  t.after(() => instance.close());
  const page = await (await fetch(instance.url)).text();
  const token = page.match(/name="canvas-token" content="([^"]+)"/)[1];
  const request = (path, data = {}) => fetch(new URL(`api/${path}`, instance.url), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Canvas-Token': token }, body: JSON.stringify(data)
  });
  await request('select-context', { context: 'ctx' });
  await request('select-namespace', { namespace: 'shop' });
  const response = await request('ask-resource-copilot', { context: 'ctx', namespace: 'shop', kind: 'Deployment', name: 'web' });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /did not return a (?:diagnostic )?summary/);
  assert.deepEqual((await (await request('state')).json()).resourceSummaries, []);
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
    kubernetes, askResourceCopilot: async (context, target, signals) => { requested.push({ context, target, signals }); return 'Investigation summary'; }
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
    signals: ['Resource events could not be read; event evidence is incomplete.', 'Pod 1 logs were unavailable; log evidence is incomplete.']
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
      containers: [{ waitingReason: 'ContainerCreating', waitingMessage: 'private-container', terminationExitCode: 1, lastTerminationReason: 'OOMKilled', lastTerminationExitCode: 137 }],
      related: [{ kind: 'SecretProviderClass', name: 'private-reference' }],
      suspended: false, activeJobs: 2, lastScheduleTime: '2026-11-26T13:00:00Z', lastSuccessfulTime: 'private-date'
    }),
    resourceEvents: async () => [
      { type: 'Warning', reason: 'FailedMount', time: '2026-11-26T13:42:16Z', message: 'SecretNotFound private-event' },
      { type: 'Normal', reason: 'Unhealthy', message: 'private-normal-event' },
      { type: 'Warning', reason: 'private-reason', message: 'private-message' }
    ]
  };
  const instance = await createInstance({
    kubernetes, askResourceCopilot: async (_context, _target, signals) => { requested.push(signals); return 'Investigation summary'; }
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
  assert.match(requested[0].join(' '), /OOMKilled.*exit code 137/);
  assert.match(requested[0].join(' '), /currently reports termination exit code 1/);
  assert.match(requested[0].join(' '), /FailedMount event reports a last-observed time of 2026-11-26T13:42:16\.000Z/);
  assert.doesNotMatch(JSON.stringify(requested[0]), /Unhealthy/);
  assert.doesNotMatch(JSON.stringify(requested[0]), /private/);
  await request('select-namespace', { namespace: 'other' });
  await request('select-namespace', { namespace: 'shop' });
  await request('ask-resource-copilot', target);
  assert.match(requested[1][0], /Pod phase is Pending/);
  const deployment = { ...target, kind: 'Deployment', name: 'checkout' };
  await request('resource', deployment);
  await request('ask-resource-copilot', deployment);
  assert.match(requested[2].join(' '), /fewer available replicas than desired/);
  assert.match(requested[2].join(' '), /1 available replicas and 3 desired replicas/);
  const cronjob = { ...target, kind: 'CronJob', name: 'backup' };
  await request('resource', cronjob);
  await request('ask-resource-copilot', cronjob);
  assert.match(requested[3].join(' '), /schedule is not suspended.*2 active jobs.*last scheduled time as 2026-11-26T13:00:00\.000Z/);
  assert.doesNotMatch(requested[3].join(' '), /last successful|private/);
});

test('focused evidence extracts fixed diagnostic indicators without forwarding event or log text', async t => {
  const requested = [];
  const kubernetes = {
    contexts: async () => ['ctx'],
    namespaces: async () => ['shop'],
    resource: async (_context, target) => ({
      ...target, uid: 'uid-123', phase: 'Pending', conditions: [],
      containers: [{ restarts: 3 }], related: []
    }),
    resourceEvents: async () => [
      { type: 'Warning', reason: 'FailedMount', time: '2026-11-26T13:42:16Z', count: 6, message: 'MountVolume.SetUp failed for private-volume: secrets-store.csi.k8s.io failed to get secret from https://private-vault.vault.azure.net/ private-secret: StatusCode=404 Code="SecretNotFound" private-token' },
      { type: 'Warning', reason: 'FailedMount', time: '2026-11-26T12:42:16Z', count: 2, message: 'secrets-store.csi.k8s.io https://private-vault.vault.azure.net/ private-secret StatusCode=404 SecretNotFound' },
      { type: 'Warning', reason: 'FailedScheduling', message: '0/3 nodes are available: 2 Insufficient cpu, 1 Insufficient memory, 1 node(s) had untolerated taint private-taint.' },
      { type: 'Warning', reason: 'Failed', message: 'Failed to pull image private-registry: authentication required' },
      { type: 'Warning', reason: 'Unhealthy', message: 'Readiness probe failed: private-response' },
      { type: 'Normal', reason: 'FailedMount', message: 'StatusCode=403 permission denied private-normal' },
      { type: 'Warning', reason: 'Unknown', message: 'StatusCode=403 permission denied private-unknown' }
    ],
    logs: async (_context, _namespace, _pod, previous) => previous
      ? 'authentication failed private-password'
      : 'lookup private-host: no such host; x509: certificate signed by unknown authority; private-log'
  };
  const instance = await createInstance({
    kubernetes, askResourceCopilot: async (_context, _target, signals) => { requested.push(signals); return 'Summary'; }
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
  assert.equal((await request('ask-resource-copilot', target)).status, 200);
  const signals = requested[0].join(' ');
  assert.match(signals, /3 restarts/);
  assert.match(signals, /FailedMount.*SecretNotFound.*Secrets Store CSI driver.*Azure Key Vault.*HTTP status 404/);
  assert.match(signals, /One FailedMount event contains these fixed matches together:.*SecretNotFound.*HTTP status 404\. Its reported last-observed time is 2026-11-26T13:42:16\.000Z\. It reports 6 occurrences/);
  assert.equal(requested[0].filter(signal => signal.startsWith('One FailedMount event')).length, 1);
  assert.doesNotMatch(signals, /2026-11-26T12:42:16/);
  assert.match(signals, /FailedScheduling.*insufficient CPU.*insufficient memory.*untolerated taint/);
  assert.match(signals, /Failed event.*image-pull failure.*authentication failure indication/);
  assert.match(signals, /Unhealthy event.*readiness probe failure/);
  assert.match(signals, /current logs.*no such host.*certificate signed by unknown authority/);
  assert.match(signals, /previous logs.*authentication failed/);
  assert.doesNotMatch(signals, /HTTP status 403|access-denied indication|private-/);
  assert.match(signals, /event references Key Vault "private-vault" and object|event includes HTTP 404/i, 'Key Vault names are safe only when part of an allowlisted event URL');

  const fragments = ['Insufficient cpu', 'Insufficient memory', 'Insufficient ephemeral-storage', 'untolerated taint'];
  kubernetes.resourceEvents = async () => Array.from({ length: 11 }, (_, index) => ({
    type: 'Warning', reason: 'FailedScheduling',
    message: fragments.filter((_, bit) => (index + 1) & (1 << bit)).join('; ') + ' private-content'
  }));
  await request('resource', target);
  await request('ask-resource-copilot', target);
  assert.equal(requested[1].filter(signal => signal.startsWith('One FailedScheduling event')).length, 10);
  assert.match(requested[1].join(' '), /1 additional combination of event indicators was omitted/);
  assert.doesNotMatch(requested[1].join(' '), /private-content/);
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
