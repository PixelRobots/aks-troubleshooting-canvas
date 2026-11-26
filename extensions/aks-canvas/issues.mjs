const podDocs = 'https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/';
const nodeDocs = 'https://kubernetes.io/docs/tasks/debug/debug-cluster/';
const aksDocs = 'https://learn.microsoft.com/en-us/troubleshoot/azure/azure-kubernetes/availability-performance/troubleshoot-pod-scheduler-errors';

export function detectIssues(workloads, nodes) {
  const issues = [];
  for (const item of workloads) {
    if (item.kind === 'Pod') {
      const reason = item.waitingReason || (item.status === 'Pending' ? 'Pending' : '');
      if (!['Pending', 'CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerConfigError'].includes(reason)) continue;
      issues.push({
        title: `Pod ${item.name}: ${reason}`,
        evidence: `Current pod state: ${item.status || 'unknown'}${item.waitingReason ? `; container waiting: ${item.waitingReason}` : ''}.`,
        next: reason === 'Pending'
          ? 'Review pod events, scheduling constraints and available capacity before changing anything.'
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
