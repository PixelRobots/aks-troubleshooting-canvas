const $ = id => document.getElementById(id);
const token = document.querySelector('meta[name="canvas-token"]').content;
let state = { context: '', namespace: '', findings: [], editing: false };
let selectedPod = '';

async function api(route, body = {}) {
  const response = await fetch(`/api/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Canvas-Token': token },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function message(text) { $('status').textContent = text; }
async function perform(fn) {
  message('');
  try { await fn(); } catch (error) { message(error.message); }
}
function setOptions(select, items, selected, placeholder) {
  select.replaceChildren(new Option(placeholder, ''));
  for (const item of items) select.add(new Option(item, item));
  select.value = items.includes(selected) ? selected : '';
}
function renderState(next) {
  state = next;
  $('mode').textContent = state.editing ? 'EDITING ENABLED' : 'READ ONLY';
  $('mode').classList.toggle('edit', state.editing);
  $('toggle-edit').textContent = state.editing ? 'Disable editing' : 'Enable editing';
  $('toggle-edit').disabled = !state.namespace;
  $('refresh').disabled = !state.namespace;
  $('findings').replaceChildren(...state.findings.map(text => {
    const item = document.createElement('li');
    item.textContent = text;
    return item;
  }));
}
async function loadContexts() {
  const contexts = await api('contexts');
  setOptions($('context'), contexts, state.context, 'Select a context');
  if (state.context && !contexts.includes(state.context)) message('The selected context is no longer in kubeconfig. Select another context.');
}
async function loadNamespaces() {
  if (!state.context) return;
  const context = state.context;
  const names = await api('namespaces');
  if (state.context !== context) return;
  setOptions($('namespace'), names, state.namespace, 'Select a namespace');
  $('namespace').disabled = false;
}
function row(title, details) {
  const div = document.createElement('div');
  div.className = 'row';
  const info = document.createElement('div');
  const strong = document.createElement('strong');
  strong.textContent = title;
  const small = document.createElement('small');
  small.textContent = details;
  info.append(strong, small);
  div.append(info);
  return div;
}
async function loadWorkloads() {
  const target = `${state.context}\0${state.namespace}`;
  const workloads = await api('workloads');
  if (`${state.context}\0${state.namespace}` !== target) return;
  const container = $('workloads');
  container.classList.remove('empty');
  container.replaceChildren();
  if (!workloads.length) container.textContent = 'No deployments or pods found.';
  for (const item of workloads) {
    const element = row(`${item.kind} / ${item.name}`, `${item.status || 'Unknown'}${item.kind === 'Pod' ? ` · ${item.restarts} restarts` : ''}`);
    const button = document.createElement('button');
    button.className = 'secondary';
    button.textContent = item.kind === 'Pod' ? 'View logs' : 'Scale';
    button.disabled = item.kind !== 'Pod' && !state.editing;
    button.addEventListener('click', () => perform(async () => {
      if (item.kind === 'Pod') {
        selectedPod = item.name;
        await loadLogs();
      } else {
        const answer = window.prompt(`Scale ${item.name} in ${state.context} / ${state.namespace} to how many replicas?`, '1');
        if (answer === null) return;
        if (!/^(0|[1-9]\d*)$/.test(answer) || Number(answer) > 1000) throw new Error('Replicas must be an integer from 0 to 1000.');
        const target = { context: state.context, namespace: state.namespace, deployment: item.name, replicas: Number(answer) };
        if (!window.confirm(`Scale deployment ${target.deployment} in ${target.context} / ${target.namespace} to ${target.replicas} replicas? This changes the live cluster and GitOps may revert it.`)) return;
        message(await api('scale', target));
        await loadWorkloads();
      }
    }));
    element.append(button);
    container.append(element);
  }
}
async function loadEvents() {
  const target = `${state.context}\0${state.namespace}`;
  const events = await api('events');
  if (`${state.context}\0${state.namespace}` !== target) return;
  const container = $('events');
  container.classList.remove('empty');
  container.replaceChildren();
  if (!events.length) container.textContent = 'No events found.';
  for (const item of events) container.append(row(`${item.type || 'Event'} · ${item.reason || 'Unknown'}`, `${item.time || 'Unknown time'} · ${item.resource || 'Unknown resource'} · ${item.message || ''}`));
}
async function loadLogs() {
  if (!selectedPod) return;
  const target = `${state.context}\0${state.namespace}\0${selectedPod}`;
  $('log-target').textContent = `Pod: ${selectedPod} · ${$('previous').checked ? 'previous container' : 'current container'} · up to 200 lines per container`;
  $('logs').textContent = 'Loading logs…';
  const logs = await api('logs', { pod: selectedPod, previous: $('previous').checked });
  if (`${state.context}\0${state.namespace}\0${selectedPod}` === target) $('logs').textContent = logs;
}
function clearTargetData() {
  selectedPod = '';
  $('workloads').textContent = 'Choose a namespace to see workloads.';
  $('events').textContent = 'Choose a namespace to see events.';
  $('logs').textContent = 'No logs loaded.';
  $('log-target').textContent = 'Select a pod above. Logs can contain sensitive data.';
}
async function refreshData() {
  const results = await Promise.allSettled([loadWorkloads(), loadEvents()]);
  const failures = results.filter(x => x.status === 'rejected');
  if (failures.length) message(failures.map(x => x.reason.message).join(' | '));
}
$('refresh-contexts').addEventListener('click', () => perform(loadContexts));
$('context').addEventListener('change', () => perform(async () => {
  if (!$('context').value) return loadContexts();
  renderState(await api('select-context', { context: $('context').value }));
  clearTargetData();
  $('namespace').disabled = true;
  await loadNamespaces();
}));
$('namespace').addEventListener('change', () => perform(async () => {
  if (!$('namespace').value) return loadNamespaces();
  renderState(await api('select-namespace', { namespace: $('namespace').value }));
  clearTargetData();
  await refreshData();
}));
$('refresh').addEventListener('click', () => perform(refreshData));
$('previous').addEventListener('change', () => perform(loadLogs));
$('grafana').addEventListener('input', () => {
  const link = $('grafana-link');
  link.hidden = true;
  link.removeAttribute('href');
  try {
    const url = new URL($('grafana').value);
    if (url.protocol === 'https:' && !url.username && !url.password) {
      link.href = url.href;
      link.hidden = false;
    }
  } catch {
    // Keep the link hidden until a complete HTTPS URL is entered.
  }
});
$('toggle-edit').addEventListener('click', () => perform(async () => {
  if (!state.editing && !window.confirm(`Enable editing for ${state.context} / ${state.namespace}? Individual changes still require confirmation.`)) return;
  renderState(await api('editing', { enabled: !state.editing }));
  await loadWorkloads();
}));
$('add-finding').addEventListener('click', () => perform(async () => {
  renderState(await api('finding', { text: $('finding').value }));
  $('finding').value = '';
}));
$('save').addEventListener('click', () => perform(async () => {
  if (!window.confirm('Save the current findings and target details privately on this machine? Do not save secrets or sensitive logs.')) return;
  await api('save');
  message('Investigation saved privately.');
}));
$('history').addEventListener('click', () => perform(async () => {
  const records = await api('history');
  const container = $('history-list');
  container.replaceChildren();
  if (!records.length) container.textContent = 'No saved investigations.';
  for (const record of records) {
    const element = row(`${record.context} / ${record.namespace}`, `${record.savedAt} · ${record.findings.length} findings`);
    const list = document.createElement('ul');
    for (const finding of record.findings) {
      const item = document.createElement('li');
      item.textContent = finding;
      list.append(item);
    }
    element.firstChild.append(list);
    container.append(element);
  }
}));
perform(async () => {
  renderState(await api('state'));
  await loadContexts();
  if (state.context) await loadNamespaces();
  if (state.namespace) await refreshData();
});
setInterval(() => { api('state').then(renderState).catch(error => message(error.message)); }, 5000);
