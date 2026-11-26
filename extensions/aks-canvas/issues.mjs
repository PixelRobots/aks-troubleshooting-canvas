import { validateResourceTarget } from './kubernetes.mjs';

const podDocs = 'https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/';
const volumeDocs = 'https://kubernetes.io/docs/concepts/storage/persistent-volumes/';
const nodeDocs = 'https://kubernetes.io/docs/tasks/debug/debug-cluster/';
const aksDocs = 'https://learn.microsoft.com/en-us/troubleshoot/azure/azure-kubernetes/availability-performance/troubleshoot-pod-scheduler-errors';

export const warningChecks = {
  FailedScheduling: 'Review pod scheduling events, node capacity, selectors, taints and tolerations.',
  FailedMount: 'Inspect the pod volume configuration and mount events; verify referenced resources before changing them.',
  FailedAttachVolume: 'Inspect volume attachment events, the PVC and the node before changing storage.',
  FailedBinding: 'Inspect the PVC, storage class and provisioning events before changing storage.',
  FailedCreate: 'Inspect the controller events and the requested pod configuration before retrying.',
  FailedCreatePodSandBox: 'Inspect pod sandbox events and node networking before changing the workload.',
  Unhealthy: 'Inspect probe events, probe configuration and application readiness before changing probes.',
  BackOff: 'Inspect container termination details and current and previous logs before changing the workload.'
};

export function detectWarningIssues(events, resources, nodes, now = Date.now()) {
  const key = item => JSON.stringify([item.namespace || '', item.kind, item.name]);
  const identities = new Map();
  const ownerIdentities = new Map();
  const addIdentity = (map, resource, uid) => {
    if (!uid) return;
    const id = key(resource);
    if (!map.has(id)) map.set(id, new Set());
    map.get(id).add(uid);
  };
  for (const resource of [...resources, ...nodes.map(node => ({ ...node, kind: 'Node', namespace: '' }))]) {
    addIdentity(identities, resource, resource.uid);
    for (const owner of resource.owners || []) {
      addIdentity(ownerIdentities, { ...owner, namespace: resource.namespace }, owner.uid);
    }
  }
  const issues = new Map();
  let invalidTimes = 0;
  let invalidTargets = 0;
  let ambiguousIdentities = 0;
  for (const event of events) {
    if (!Object.hasOwn(warningChecks, event.reason)) continue;
    const target = event.target;
    if (!target) continue;
    const matches = identities.get(key(target)) || ownerIdentities.get(key(target));
    if (!matches) continue;
    if (!target.uid || matches.size !== 1) {
      ambiguousIdentities++;
      continue;
    }
    if (!matches.has(target.uid)) continue;
    try { validateResourceTarget(target); } catch { invalidTargets++; continue; }
    const time = typeof event.time === 'string' ? Date.parse(event.time) : NaN;
    if (!Number.isFinite(time) || time > now) {
      invalidTimes++;
      continue;
    }
    if (time < now - 60 * 60 * 1000) continue;
    const issueKey = JSON.stringify([key(target), event.reason]);
    if (!issues.has(issueKey)) issues.set(issueKey, {
      kind: target.kind, name: target.name, namespace: target.namespace,
      title: `${target.kind} ${target.name}: recent ${event.reason} warning`,
      evidence: `A Kubernetes Warning event in the last hour reports ${event.reason}. Events can be stale and do not establish the current cause.`,
      next: warningChecks[event.reason],
      docs: event.reason === 'FailedScheduling' ? [aksDocs, podDocs]
        : ['FailedBinding', 'FailedAttachVolume'].includes(event.reason) ? [volumeDocs] : [podDocs]
    });
  }
  return {
    issues: [...issues.values()],
    errors: [
      ...(invalidTimes ? [`Warning events: ${invalidTimes} matching events had invalid or future timestamps and were excluded.`] : []),
      ...(invalidTargets ? [`Warning events: ${invalidTargets} matching events had unsupported or invalid targets and were excluded.`] : []),
      ...(ambiguousIdentities ? [`Warning events: ${ambiguousIdentities} events had missing or ambiguous resource identities and were excluded.`] : [])
    ]
  };
}

export function detectIssues(workloads, nodes) {
  const issues = [];
  for (const item of workloads) {
    if (item.kind === 'Pod') {
      const reason = item.waitingReason || (item.terminationReason === 'OOMKilled' ? 'OOMKilled' : '') || (item.status === 'Pending' ? 'Pending' : '');
      if (!['Pending', 'CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerConfigError', 'OOMKilled'].includes(reason)) continue;
      issues.push({
        title: `Pod ${item.name}: ${reason}`,
        evidence: `Current pod state: ${item.status || 'unknown'}${item.waitingReason ? `; container waiting: ${item.waitingReason}` : item.terminationReason ? `; container terminated: ${item.terminationReason}` : ''}.`,
        next: reason === 'Pending'
          ? 'Review pod events, scheduling constraints and available capacity before changing anything.'
          : reason === 'OOMKilled'
            ? 'Inspect termination details, memory limits and available usage evidence before changing resources.'
          : 'Review pod events and container logs; verify the reported reason before applying a fix.',
        kind: 'Pod', name: item.name, namespace: item.namespace,
        docs: reason === 'Pending' ? [aksDocs, podDocs] : [podDocs]
      });
    } else if (item.kind === 'Deployment' && item.desired > item.available) {
      issues.push({
        title: `Deployment ${item.name}: replicas unavailable`,
        evidence: `${item.available} of ${item.desired} desired replicas are available; a rollout may be in progress.`,
        next: 'Inspect the deployment and its pods and events to determine why replicas are unavailable.',
        kind: 'Deployment', name: item.name, namespace: item.namespace,
        docs: [podDocs]
      });
    }
  }
  for (const node of nodes) {
    if (node.ready === 'Unknown' && node.expectedDeallocated) continue;
    if (node.ready !== 'False' && node.ready !== 'Unknown') continue;
    issues.push({
      title: `Node ${node.name}: not ready`,
      evidence: `Kubernetes Ready condition: ${node.ready}.`,
      next: node.ready === 'Unknown'
        ? 'Check whether this node is intentionally deallocated, then inspect node conditions and events before making changes.'
        : 'Inspect node conditions and related events before changing the node.',
      kind: 'Node', name: node.name, namespace: '',
      docs: [nodeDocs]
    });
  }
  return issues;
}
