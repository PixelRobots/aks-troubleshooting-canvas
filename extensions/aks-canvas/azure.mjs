import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export function describeAzureFailure(error) {
  const detail = `${error.stderr || ''} ${error.message || ''}`;
  if (/AADSTS70043|AADSTS700082|AADSTS50076|AADSTS50079|interaction_required|login required|please run ['"]?az login/i.test(detail)) {
    return 'Azure sign-in expired or requires interaction. Sign in to the customer tenant with Azure CLI, then refresh checks.';
  }
  if (/AuthorizationFailed|Forbidden|does not have authorization/i.test(detail)) {
    return 'Azure access was denied. Check read permissions for the AKS cluster, node resource group and VM scale set.';
  }
  if (error.code === 'ENOENT' || /az.+not recognized as the name|az: command not found/i.test(detail)) {
    return 'Azure CLI is unavailable. Install it and sign in to the customer tenant, then refresh checks.';
  }
  if (error.killed || error.code === 'ETIMEDOUT') return 'Azure CLI check timed out. Check connectivity and retry.';
  const code = detail.match(/\bAADSTS\d+\b/i)?.[0];
  return `Azure CLI check failed${code ? ` (${code})` : ''}. Check Azure sign-in, permissions and connectivity.`;
}

async function runAzure(args) {
  const command = [...args, '--output', 'json', '--only-show-errors'];
  const options = { timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: { ...process.env, AZURE_EXTENSION_USE_DYNAMIC_INSTALL: 'no' } };
  try {
    let result;
    if (process.platform === 'win32') {
      const encoded = Buffer.from(JSON.stringify(command)).toString('base64');
      const script = `$arguments = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json; & az @arguments; exit $LASTEXITCODE`;
      result = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], options);
    } else {
      result = await execute('az', command, options);
    }
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(describeAzureFailure(error));
  }
}

const vmssProviderId = /^azure:\/\/\/subscriptions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/resourcegroups\/([^/]+)\/providers\/microsoft\.compute\/virtualmachinescalesets\/([^/]+)\/virtualmachines\/([^/]+)$/i;
const safeAzureName = value => typeof value === 'string' && value.length <= 255 && /^[a-z0-9_][a-z0-9_.-]*$/i.test(value);

export async function checkDeallocatedNodes(nodes, run = runAzure) {
  const cache = new Map();
  const cached = (key, load) => {
    if (!cache.has(key)) cache.set(key, load());
    return cache.get(key);
  };
  const failures = new Map();
  const updated = [...nodes];
  const candidates = nodes.map((node, index) => ({ node, index })).filter(({ node }) => node.ready === 'Unknown' && node.pool);

  async function check({ node, index }) {
    try {
      const match = vmssProviderId.exec(node.providerId || '');
      if (!match) throw new Error('Node has no supported Azure VM scale set provider ID.');
      const [, subscription, nodeGroup, vmss, instance] = match;
      if (![nodeGroup, vmss, instance, node.pool].every(safeAzureName)) throw new Error('Node has an unsupported Azure resource name.');
      const group = await cached(`group:${subscription}:${nodeGroup}`, () => run(['group', 'show', '--subscription', subscription, '--name', nodeGroup]));
      const tags = Object.fromEntries(Object.entries(group.tags || {}).map(([key, value]) => [key.toLowerCase(), value]));
      const clusterName = tags['aks-managed-cluster-name'];
      const clusterGroup = tags['aks-managed-cluster-rg'];
      if (![clusterName, clusterGroup].every(safeAzureName)) {
        throw new Error('AKS cluster identity is missing or unsupported in the node resource group tags.');
      }
      const clusterKey = `${subscription}:${clusterGroup}:${clusterName}`;
      const cluster = await cached(`cluster:${clusterKey}`, () => run(['aks', 'show', '--subscription', subscription, '--resource-group', clusterGroup, '--name', clusterName]));
      if (typeof cluster.nodeResourceGroup !== 'string' || cluster.nodeResourceGroup.toLowerCase() !== nodeGroup.toLowerCase()) {
        throw new Error('AKS cluster does not match the node resource group.');
      }
      const pool = await cached(`pool:${clusterKey}:${node.pool}`, () => run(['aks', 'nodepool', 'show', '--subscription', subscription, '--resource-group', clusterGroup, '--cluster-name', clusterName, '--name', node.pool]));
      if (!['Deallocate', 'Delete'].includes(pool.scaleDownMode)) throw new Error('Node pool scale-down mode is unavailable.');
      if (pool.scaleDownMode !== 'Deallocate') return;
      const view = await run(['vmss', 'get-instance-view', '--subscription', subscription, '--resource-group', nodeGroup, '--name', vmss, '--instance-id', instance]);
      if (!Array.isArray(view.statuses)) throw new Error('VM instance power state is unavailable.');
      const power = view.statuses.find(status => typeof status.code === 'string' && status.code.startsWith('PowerState/'));
      if (!power) throw new Error('VM instance power state is unavailable.');
      if (power.code.toLowerCase() === 'powerstate/deallocated') updated[index] = { ...node, expectedDeallocated: true };
    } catch (error) {
      failures.set(error.message, (failures.get(error.message) || 0) + 1);
    }
  }

  for (let i = 0; i < candidates.length; i += 4) {
    await Promise.all(candidates.slice(i, i + 4).map(check));
  }
  const errors = [...failures].map(([message, count]) => `Azure deallocation check (${count} ${count === 1 ? 'node' : 'nodes'}): ${message}`);
  return { nodes: updated, errors };
}
