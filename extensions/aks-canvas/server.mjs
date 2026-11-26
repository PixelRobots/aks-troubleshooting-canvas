import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createKubernetes, validateResourceTarget } from './kubernetes.mjs';
import { detectIssues } from './issues.mjs';
import { checkDeallocatedNodes } from './azure.mjs';

const assets = new URL('./ui/', import.meta.url);

function summarizeResourceEvidence(details, events, eventError) {
  const signals = new Set();
  if (details.kind === 'Pod' && details.phase === 'Pending') signals.add('Pod phase is Pending.');
  if (details.kind === 'Deployment' && Number.isInteger(details.desired) && Number.isInteger(details.available) && details.available < details.desired) {
    signals.add('The deployment has fewer available replicas than desired; a rollout may be in progress.');
  }
  for (const condition of details.conditions || []) {
    if (condition.type === 'PodScheduled' && condition.status === 'False' && condition.reason === 'Unschedulable') {
      signals.add('The PodScheduled condition reports Unschedulable.');
    }
  }
  for (const container of details.containers || []) {
    if (['ContainerCreating', 'CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerConfigError'].includes(container.waitingReason)) {
      signals.add(`A container reports ${container.waitingReason}.`);
    }
  }
  for (const event of events) {
    if (event.reason === 'FailedMount') {
      signals.add('A resource event reports FailedMount.');
      if (/\bSecretNotFound\b/i.test(event.message || '')) signals.add('A FailedMount event reports SecretNotFound; the secret store and object have not been independently verified.');
    }
    if (event.reason === 'FailedScheduling') signals.add('A resource event reports FailedScheduling.');
  }
  if (eventError) signals.add('Resource events could not be read; event evidence is incomplete.');
  if (!signals.size) signals.add('No supported status indicators were extracted; this does not establish health.');
  return [...signals];
}

export async function createInstance({ kubernetes = createKubernetes(), askCopilot, askResourceCopilot, askManualCopilot, checkNodes = checkDeallocatedNodes } = {}) {
  const state = { context: '', namespace: '', aiIssues: [], editing: false };
  const resourceEvidence = new Map();
  const evidenceKey = (context, resource) => JSON.stringify([context, resource.namespace, resource.kind, resource.name]);
  const token = randomBytes(32).toString('hex');
  const getContext = () => ({ ...state, aiIssues: [...state.aiIssues] });
  const publishIssue = issue => {
    if (!issue || issue.context !== state.context || !state.context) throw new Error('The selected context has changed.');
    for (const field of ['title', 'evidence', 'next']) {
      if (typeof issue[field] !== 'string' || !issue[field].trim() || issue[field].length > 2000) throw new Error(`Invalid issue ${field}.`);
    }
    if (!Array.isArray(issue.docs) || issue.docs.length > 5 || !issue.docs.every(value => {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password && ['learn.microsoft.com', 'kubernetes.io'].includes(url.hostname);
      } catch {
        return false;
      }
    })) throw new Error('Documentation links must be HTTPS links to Microsoft Learn or kubernetes.io.');
    const hasResource = issue.kind !== undefined || issue.name !== undefined || issue.namespace !== undefined;
    if (hasResource) validateResourceTarget(issue);
    const saved = { title: issue.title, evidence: issue.evidence, next: issue.next, docs: issue.docs, ...(hasResource ? { kind: issue.kind, name: issue.name, namespace: issue.namespace } : {}) };
    const existing = state.aiIssues.findIndex(item =>
      item.title === saved.title && item.kind === saved.kind && item.name === saved.name && item.namespace === saved.namespace
    );
    if (existing < 0) state.aiIssues.push(saved);
    else state.aiIssues[existing] = saved;
    return getContext();
  };
  const server = createServer(async (req, res) => {
    const send = (status, data, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'"
      });
      res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
    };
    try {
      const port = server.address().port;
      if (req.headers.host !== `127.0.0.1:${port}`) return send(403, { error: 'Invalid host.' });
      const route = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
      if (req.method === 'GET' && route === '/') {
        const html = await readFile(new URL('index.html', assets), 'utf8');
        return send(200, html.replace('__CANVAS_TOKEN__', token), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && (route === '/app.js' || route === '/style.css')) {
        return send(200, await readFile(new URL(route.slice(1), assets), 'utf8'), route.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
      }
      if (req.method !== 'POST' || !route.startsWith('/api/') || req.headers['x-canvas-token'] !== token || req.headers['content-type'] !== 'application/json') {
        return send(403, { error: 'Request not permitted.' });
      }
      const chunks = [];
      let size = 0;
      const maxBodySize = route === '/api/ask-copilot' ? 262144 : 16384;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBodySize) return send(413, { error: 'Request is too large.' });
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid request.');
      const target = () => {
        if (body.context !== state.context || body.namespace !== state.namespace || !state.context || !state.namespace) {
          throw new Error('The selected context or namespace has changed.');
        }
        return validateResourceTarget({ kind: body.kind, name: body.name, namespace: body.namespace });
      };
      let result;
      switch (route) {
        case '/api/state':
          result = getContext();
          break;
        case '/api/contexts':
          result = await kubernetes.contexts();
          break;
        case '/api/select-context':
          if (typeof body.context !== 'string' || !(await kubernetes.contexts()).includes(body.context)) throw new Error('Context not found in kubeconfig.');
          if (state.context !== body.context) {
            state.context = body.context;
            state.namespace = '';
            state.aiIssues = [];
            state.editing = false;
            resourceEvidence.clear();
          }
          result = getContext();
          break;
        case '/api/namespaces':
          if (!state.context) throw new Error('Select a context first.');
          result = await kubernetes.namespaces(state.context);
          break;
        case '/api/scan': {
          if (!state.context) throw new Error('Select a context first.');
          const context = state.context;
          const checks = await Promise.allSettled([kubernetes.clusterPods(context), kubernetes.clusterDeployments(context), kubernetes.nodes(context)]);
          if (state.context !== context) throw new Error('The context changed during the scan.');
          const labels = ['Pods', 'Deployments', 'Nodes'];
          const errors = checks.flatMap((check, index) => check.status === 'rejected' ? [`${labels[index]}: ${check.reason.message}`] : []);
          const nodeCheck = checks[2].status === 'fulfilled' ? await checkNodes(checks[2].value) : { nodes: [], errors: [] };
          if (state.context !== context) throw new Error('The context changed during the scan.');
          errors.push(...nodeCheck.errors);
          result = {
            context,
            issues: detectIssues([...checks.slice(0, 2).flatMap(check => check.status === 'fulfilled' ? check.value : [])], nodeCheck.nodes),
            errors
          };
          break;
        }
        case '/api/ask-copilot':
          if (!state.context) throw new Error('Select a context first.');
          if (body.context !== state.context) throw new Error('The context changed; request the investigation again.');
          if (!askCopilot) throw new Error('Copilot investigation is unavailable in this session.');
          if (body.findings !== undefined && (!Array.isArray(body.findings) || body.findings.length > 100)) throw new Error('Invalid cluster findings.');
          if (body.scanErrors !== undefined && (!Array.isArray(body.scanErrors) || body.scanErrors.length > 20 || !body.scanErrors.every(error => typeof error === 'string' && error.length <= 500))) throw new Error('Invalid cluster check errors.');
          const findings = (body.findings || []).map(issue => {
            if (!issue || typeof issue !== 'object' ||
                !['Pod', 'Deployment', 'Node'].includes(issue.kind) ||
                typeof issue.name !== 'string' || issue.name.length > 253 ||
                typeof issue.namespace !== 'string' || issue.namespace.length > 253 ||
                typeof issue.title !== 'string' || !issue.title.trim() || issue.title.length > 500 ||
                typeof issue.evidence !== 'string' || !issue.evidence.trim() || issue.evidence.length > 1000 ||
                typeof issue.next !== 'string' || !issue.next.trim() || issue.next.length > 1000) {
              throw new Error('Invalid cluster finding.');
            }
            return {
              title: issue.title, evidence: issue.evidence, next: issue.next,
              kind: issue.kind, name: issue.name, namespace: issue.namespace
            };
          });
          await askCopilot(state.context, findings, body.scanErrors || []);
          result = { sent: true };
          break;
        case '/api/ask-manual-copilot': {
          if (!state.context || body.context !== state.context) throw new Error('The context changed; request the investigation again.');
          if (typeof body.question !== 'string' || !body.question.trim() || body.question.length > 2000) throw new Error('Enter a question of up to 2000 characters.');
          const hasTarget = body.kind !== undefined || body.name !== undefined || body.namespace !== undefined;
          const resourceTarget = hasTarget ? target() : null;
          if (!askManualCopilot) throw new Error('Copilot investigation is unavailable in this session.');
          await askManualCopilot(state.context, resourceTarget, body.question.trim());
          result = { sent: true };
          break;
        }
        case '/api/select-namespace':
          if (!state.context || typeof body.namespace !== 'string') throw new Error('Select a context and namespace first.');
          {
            const context = state.context;
            const namespaces = await kubernetes.namespaces(context);
            if (state.context !== context) throw new Error('The context changed; select the namespace again.');
            if (!namespaces.includes(body.namespace)) throw new Error('Namespace not found in the selected context.');
          }
          if (state.namespace !== body.namespace) {
            state.namespace = body.namespace;
            state.editing = false;
            resourceEvidence.clear();
          }
          result = getContext();
          break;
        case '/api/workloads':
        case '/api/events':
          if (!state.context || !state.namespace) throw new Error('Select a context and namespace first.');
          result = route.endsWith('workloads') ? await kubernetes.workloads(state.context, state.namespace) : await kubernetes.events(state.context, state.namespace);
          break;
        case '/api/resource': {
          const resourceTarget = target();
          const context = state.context;
          const key = evidenceKey(context, resourceTarget);
          resourceEvidence.delete(key);
          const details = await kubernetes.resource(context, resourceTarget);
          let events;
          let eventError;
          try {
            events = await kubernetes.resourceEvents(context, resourceTarget, details.uid);
          } catch (error) {
            eventError = error.message;
          }
          target();
          resourceEvidence.set(key, summarizeResourceEvidence(details, events || [], eventError));
          result = { details, events: events || [], eventError };
          break;
        }
        case '/api/describe': {
          const resourceTarget = target();
          result = await kubernetes.describe(state.context, resourceTarget);
          target();
          break;
        }
        case '/api/ask-resource-copilot': {
          const resourceTarget = target();
          if (!askResourceCopilot) throw new Error('Copilot resource investigation is unavailable in this session.');
          const signals = resourceEvidence.get(evidenceKey(state.context, resourceTarget));
          await askResourceCopilot(state.context, resourceTarget, signals || ['Resource evidence was not available; do not assume the resource is healthy.']);
          result = { sent: true };
          break;
        }
        case '/api/logs':
          if (body.context !== state.context || body.namespace !== state.namespace || !state.context || !state.namespace) throw new Error('The selected context or namespace has changed.');
          result = await kubernetes.logs(state.context, state.namespace, body.pod, body.previous);
          if (body.context !== state.context || body.namespace !== state.namespace) throw new Error('The selected context or namespace has changed.');
          break;
        case '/api/editing':
          if (!state.context || !state.namespace || typeof body.enabled !== 'boolean') throw new Error('Select a context and namespace first.');
          if (body.enabled && (body.context !== state.context || body.namespace !== state.namespace)) throw new Error('The target changed; confirm editing again.');
          state.editing = body.enabled;
          result = getContext();
          break;
        case '/api/scale':
          if (!state.editing || body.context !== state.context || body.namespace !== state.namespace) throw new Error('Editing is disabled or the target has changed.');
          result = await kubernetes.scale(state.context, state.namespace, body.deployment, body.replicas);
          break;
        default:
          return send(404, { error: 'Unknown endpoint.' });
      }
      return send(200, result);
    } catch (error) {
      return send(400, { error: error.message || 'Request failed.' });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    getContext,
    publishIssue,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  };
}
