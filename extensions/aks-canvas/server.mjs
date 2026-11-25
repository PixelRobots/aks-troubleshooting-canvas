import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createKubernetes } from './kubernetes.mjs';
import { createHistory } from './history.mjs';

const assets = new URL('./ui/', import.meta.url);

export async function createInstance({ kubernetes = createKubernetes(), history = createHistory() } = {}) {
  const state = { context: '', namespace: '', findings: [], editing: false };
  const token = randomBytes(32).toString('hex');
  const getContext = () => ({ ...state, findings: [...state.findings] });
  const addFinding = text => {
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('Finding must be between 1 and 2000 characters.');
    if (!state.context || !state.namespace) throw new Error('Select a context and namespace first.');
    state.findings.push(text.trim());
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
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 16384) return send(413, { error: 'Request is too large.' });
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid request.');
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
            state.findings = [];
            state.editing = false;
          }
          result = getContext();
          break;
        case '/api/namespaces':
          if (!state.context) throw new Error('Select a context first.');
          result = await kubernetes.namespaces(state.context);
          break;
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
            state.findings = [];
            state.editing = false;
          }
          result = getContext();
          break;
        case '/api/workloads':
        case '/api/events':
          if (!state.context || !state.namespace) throw new Error('Select a context and namespace first.');
          result = route.endsWith('workloads') ? await kubernetes.workloads(state.context, state.namespace) : await kubernetes.events(state.context, state.namespace);
          break;
        case '/api/logs':
          if (!state.context || !state.namespace) throw new Error('Select a context and namespace first.');
          result = await kubernetes.logs(state.context, state.namespace, body.pod, body.previous);
          break;
        case '/api/editing':
          if (!state.context || !state.namespace || typeof body.enabled !== 'boolean') throw new Error('Select a context and namespace first.');
          state.editing = body.enabled;
          result = getContext();
          break;
        case '/api/scale':
          if (!state.editing || body.context !== state.context || body.namespace !== state.namespace) throw new Error('Editing is disabled or the target has changed.');
          result = await kubernetes.scale(state.context, state.namespace, body.deployment, body.replicas);
          break;
        case '/api/finding':
          result = addFinding(body.text);
          break;
        case '/api/save':
          result = await history.save(state.context, state.namespace, [...state.findings]);
          break;
        case '/api/history':
          result = await history.list();
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
    addFinding,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  };
}
