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

export function createKubernetes(run = async args => {
  try {
    const { stdout } = await execute('kubectl', args, { timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
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
      return result.items.map(item => ({
        kind: item.kind,
        name: item.metadata.name,
        created: item.metadata.creationTimestamp,
        status: item.kind === 'Pod' ? item.status?.phase : `${item.status?.readyReplicas || 0}/${item.spec?.replicas ?? 1} ready`,
        restarts: item.kind === 'Pod' ? (item.status?.containerStatuses || []).reduce((n, c) => n + (c.restartCount || 0), 0) : undefined
      }));
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
