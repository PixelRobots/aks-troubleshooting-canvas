import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const namePattern = /^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/;

function contextName(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || value.startsWith('-') || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('Invalid Kubernetes context.');
  }
  return value;
}

function resourceName(value, label) {
  if (typeof value !== 'string' || value.length > 253 || !namePattern.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

const resourceKinds = {
  Pod: 'pods', Deployment: 'deployments', ReplicaSet: 'replicasets', Job: 'jobs',
  CronJob: 'cronjobs', PersistentVolumeClaim: 'persistentvolumeclaims',
  SecretProviderClass: 'secretproviderclasses.secrets-store.csi.x-k8s.io', Node: 'nodes'
};

export function validateResourceTarget(target) {
  if (!target || !Object.hasOwn(resourceKinds, target.kind)) throw new Error('Unsupported resource kind.');
  resourceName(target.name, 'resource name');
  resourceName(target.namespace, 'namespace');
  return target;
}

function projectResource(item, target) {
  if (!item.metadata?.name) throw new Error('kubectl returned a resource without a name.');
  const related = [];
  const add = (kind, name) => {
    if (Object.hasOwn(resourceKinds, kind) && typeof name === 'string' && namePattern.test(name) && name.length <= 253 &&
        !related.some(value => value.kind === kind && value.name === name)) related.push({ kind, name });
  };
  for (const owner of item.metadata.ownerReferences || []) add(owner.kind, owner.name);
  if (target.kind === 'Pod') {
    add('Node', item.spec?.nodeName);
    for (const volume of item.spec?.volumes || []) {
      add('PersistentVolumeClaim', volume.persistentVolumeClaim?.claimName);
      if (volume.csi?.driver === 'secrets-store.csi.k8s.io') add('SecretProviderClass', volume.csi.volumeAttributes?.secretProviderClass);
    }
  }
  const conditions = (item.status?.conditions || []).map(condition => ({
    type: condition.type, status: condition.status, reason: condition.reason, message: condition.message
  }));
  const containers = target.kind === 'Pod'
    ? [...(item.status?.initContainerStatuses || []), ...(item.status?.containerStatuses || [])].map(container => ({
      name: container.name, ready: container.ready, restarts: container.restartCount,
      waitingReason: container.state?.waiting?.reason, waitingMessage: container.state?.waiting?.message
    }))
    : [];
  return {
    kind: target.kind, name: item.metadata.name, namespace: target.namespace, uid: item.metadata.uid,
    created: item.metadata.creationTimestamp, phase: item.status?.phase,
    conditions, containers, related,
    provider: target.kind === 'SecretProviderClass' ? item.spec?.provider : undefined,
    selector: target.kind === 'Deployment' ? item.spec?.selector : undefined,
    desired: target.kind === 'Deployment' ? (item.spec?.replicas ?? 1) : undefined,
    available: target.kind === 'Deployment' ? (item.status?.availableReplicas || 0) : undefined
  };
}

export function createKubernetes(run = async args => {
  try {
    const { stdout } = await execute('kubectl', args, { timeout: 30000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    return stdout;
  } catch (error) {
    throw new Error(`kubectl failed: ${(error.stderr || error.message).trim()}`);
  }
}) {
  const json = async args => {
    const output = await run(args);
    try {
      return JSON.parse(output);
    } catch {
      throw new Error('kubectl returned invalid JSON.');
    }
  };
  const contextArgs = context => ['--context', contextName(context)];
  const listClusterResources = async (context, path, kind, project) => {
    const items = [];
    const seenTokens = new Set();
    let continuation = '';
    do {
      const params = new URLSearchParams({ limit: '25' });
      if (continuation) params.set('continue', continuation);
      const page = await json([...contextArgs(context), 'get', '--raw', `${path}?${params}`]);
      if (page.kind !== kind || !Array.isArray(page.items) ||
          (page.metadata?.continue !== undefined && typeof page.metadata.continue !== 'string')) {
        throw new Error('kubectl returned an invalid resource page.');
      }
      items.push(...project(page));
      continuation = page.metadata?.continue || '';
      if (continuation && seenTokens.has(continuation)) throw new Error('Kubernetes returned a repeated continuation token.');
      if (continuation) seenTokens.add(continuation);
    } while (continuation);
    return items;
  };
  const projectWorkloads = result => result.items.map(item => {
    const kind = item.kind || ({ PodList: 'Pod', DeploymentList: 'Deployment' })[result.kind];
    if (!['Pod', 'Deployment'].includes(kind)) throw new Error('kubectl returned a workload with an unknown kind.');
    return {
      kind,
      name: item.metadata.name,
      namespace: item.metadata.namespace,
      labels: kind === 'Pod' ? (item.metadata.labels || {}) : undefined,
      selector: kind === 'Deployment' ? item.spec?.selector : undefined,
      created: item.metadata.creationTimestamp,
      status: kind === 'Pod' ? item.status?.phase : `${item.status?.readyReplicas || 0}/${item.spec?.replicas ?? 1} ready`,
      desired: kind === 'Deployment' ? (item.spec?.replicas ?? 1) : undefined,
      available: kind === 'Deployment' ? (item.status?.availableReplicas || 0) : undefined,
      waitingReason: kind === 'Pod' ? [...(item.status?.initContainerStatuses || []), ...(item.status?.containerStatuses || [])].map(c => c.state?.waiting?.reason).find(reason => ['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerConfigError'].includes(reason)) : undefined,
      restarts: kind === 'Pod' ? (item.status?.containerStatuses || []).reduce((n, c) => n + (c.restartCount || 0), 0) : undefined
    };
  });
  return {
    async contexts() {
      const output = await run(['config', 'get-contexts', '-o', 'name']);
      return output.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    },
    async namespaces(context) {
      const result = await json([...contextArgs(context), 'get', 'namespaces', '-o', 'json']);
      return result.items.map(item => item.metadata.name);
    },
    async workloads(context, namespace) {
      const result = await json([...contextArgs(context), '-n', resourceName(namespace, 'namespace'), 'get', 'deployments,pods', '-o', 'json']);
      return projectWorkloads(result);
    },
    async clusterPods(context) {
      return listClusterResources(context, '/api/v1/pods', 'PodList', projectWorkloads);
    },
    async clusterDeployments(context) {
      return listClusterResources(context, '/apis/apps/v1/deployments', 'DeploymentList', projectWorkloads);
    },
    async nodes(context) {
      return listClusterResources(context, '/api/v1/nodes', 'NodeList', result => result.items.map(item => ({
        name: item.metadata.name,
        ready: (item.status?.conditions || []).find(condition => condition.type === 'Ready')?.status ?? 'Missing',
        providerId: item.spec?.providerID,
        pool: item.metadata.labels?.['kubernetes.azure.com/agentpool'] || item.metadata.labels?.agentpool
      })));
    },
    async events(context, namespace) {
      const result = await json([...contextArgs(context), '-n', resourceName(namespace, 'namespace'), 'get', 'events', '-o', 'json']);
      return result.items.map(item => ({
        name: item.metadata.name,
        type: item.type,
        reason: item.reason,
        message: item.message,
        resource: item.involvedObject?.name,
        time: item.lastTimestamp || item.eventTime || item.metadata.creationTimestamp,
        count: item.count
      })).sort((a, b) => String(b.time).localeCompare(String(a.time))).slice(0, 100);
    },
    async resource(context, target) {
      validateResourceTarget(target);
      const scope = target.kind === 'Node' ? [] : ['-n', target.namespace];
      const item = await json([...contextArgs(context), ...scope, 'get', resourceKinds[target.kind], target.name, '-o', 'json']);
      return projectResource(item, target);
    },
    async resourceEvents(context, target, uid) {
      validateResourceTarget(target);
      if (typeof uid !== 'string' || !/^[a-z0-9-]{1,128}$/i.test(uid)) throw new Error('Invalid resource UID.');
      const scope = target.kind === 'Node' ? ['--all-namespaces'] : ['-n', target.namespace];
      const result = await json([...contextArgs(context), ...scope, 'get', 'events', '--field-selector', `involvedObject.uid=${uid}`, '-o', 'json']);
      return result.items.map(item => ({
        type: item.type, reason: item.reason, message: item.message,
        time: item.lastTimestamp || item.eventTime || item.metadata.creationTimestamp, count: item.count
      })).sort((a, b) => String(b.time).localeCompare(String(a.time))).slice(0, 100);
    },
    async describe(context, target) {
      validateResourceTarget(target);
      const scope = target.kind === 'Node' ? [] : ['-n', target.namespace];
      return run([...contextArgs(context), ...scope, 'describe', resourceKinds[target.kind], target.name]);
    },
    async logs(context, namespace, pod, previous = false) {
      if (typeof previous !== 'boolean') throw new Error('Invalid log selection.');
      const args = [...contextArgs(context), '-n', resourceName(namespace, 'namespace'), 'logs', resourceName(pod, 'pod'), '--tail=200', '--all-containers=true'];
      if (previous) args.push('--previous');
      return run(args);
    },
    async scale(context, namespace, deployment, replicas) {
      if (!Number.isInteger(replicas) || replicas < 0 || replicas > 1000) throw new Error('Replicas must be an integer from 0 to 1000.');
      return run([...contextArgs(context), '-n', resourceName(namespace, 'namespace'), 'scale', 'deployment', resourceName(deployment, 'deployment'), `--replicas=${replicas}`]);
    }
  };
}
