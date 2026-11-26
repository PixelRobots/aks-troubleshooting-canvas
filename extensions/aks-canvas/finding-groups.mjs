const supportedKinds = new Set([
  'Pod', 'Deployment', 'ReplicaSet', 'Job', 'CronJob', 'StatefulSet', 'DaemonSet',
  'ReplicationController', 'PersistentVolumeClaim', 'SecretProviderClass', 'Node'
]);

function resourceKey(resource) {
  return JSON.stringify([resource.namespace || '', resource.kind, resource.name]);
}

function targetOf(resource) {
  return {
    kind: resource.kind,
    name: resource.name,
    namespace: resource.kind === 'Node' ? '' : (resource.namespace || '')
  };
}

export function groupFindings(clusterFindings, copilotFindings, resources = []) {
  const resourceMap = new Map(resources.map(resource => [resourceKey(resource), resource]));
  const resolving = new Set();
  const rootCache = new Map();
  const rootFor = target => {
    const key = resourceKey(target);
    if (rootCache.has(key)) return rootCache.get(key);
    if (resolving.has(key)) return targetOf(target);
    resolving.add(key);
    const resource = resourceMap.get(key);
    const owner = resource?.owners?.[0];
    const root = owner && supportedKinds.has(owner.kind)
      ? rootFor({ kind: owner.kind, name: owner.name, namespace: owner.kind === 'Node' ? '' : target.namespace })
      : targetOf(target);
    resolving.delete(key);
    rootCache.set(key, root);
    return root;
  };

  const referencedBy = new Map();
  for (const resource of resources) {
    const root = rootFor(targetOf(resource));
    for (const reference of resource.references || []) {
      const key = resourceKey({ ...reference, namespace: reference.kind === 'Node' ? '' : resource.namespace });
      if (!referencedBy.has(key)) referencedBy.set(key, new Set());
      referencedBy.get(key).add(resourceKey(root));
    }
  }

  const groupMap = new Map();
  const addFindings = (findings, source) => {
    for (const issue of findings || []) {
      if (!issue.kind || !issue.name) continue;
      const target = targetOf(issue);
      let root = rootFor(target);
      const targetKey = resourceKey(target);
      if (resourceKey(root) === targetKey) {
        const relatedRoots = referencedBy.get(targetKey);
        if (relatedRoots?.size === 1) {
          const [relatedRoot] = relatedRoots;
          const [namespace, kind, name] = JSON.parse(relatedRoot);
          root = { kind, name, namespace };
        }
      }
      const groupKey = resourceKey(root);
      if (!groupMap.has(groupKey)) groupMap.set(groupKey, { target: root, signals: [], resources: new Map() });
      const group = groupMap.get(groupKey);
      group.resources.set(targetKey, target);
      const titleKey = issue.title.trim().toLowerCase();
      const existing = group.signals.find(signal =>
        resourceKey(signal.target) === targetKey && signal.title.trim().toLowerCase() === titleKey
      );
      if (existing) {
        if (!existing.sources.includes(source)) existing.sources.push(source);
        if (issue.evidence && !existing.evidence.includes(issue.evidence)) existing.evidence.push(issue.evidence);
        if (issue.next && !existing.next.includes(issue.next)) existing.next.push(issue.next);
        for (const doc of issue.docs || []) if (!existing.docs.includes(doc)) existing.docs.push(doc);
      } else {
        group.signals.push({
          target,
          title: issue.title,
          sources: [source],
          evidence: issue.evidence ? [issue.evidence] : [],
          next: issue.next ? [issue.next] : [],
          docs: [...(issue.docs || [])]
        });
      }
    }
  };
  addFindings(clusterFindings, 'Cluster check');
  addFindings(copilotFindings, 'Copilot');

  return [...groupMap.values()];
}
