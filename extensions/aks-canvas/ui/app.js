const $ = id => document.getElementById(id);
const token = document.querySelector('meta[name="canvas-token"]').content;
let state = { context: '', namespace: '', aiIssues: [], editing: false };
let logsLoaded = false;
let workloadsCache = [];
let workloadsState = 'idle';
let workloadsVersion = 0;
let scanCache = [];
let scanErrors = [];
let scanLimit = 100;
let selectedResource = null;
let resourceDetails = null;
let manualResource = false;
let resourceHistory = [];
let resourceReturnTab = 'overview';
let activeTab = 'overview';
let resourceVersion = 0;
let editTarget = null;
let choosingCluster = false;
let scanVersion = 0;
let investigationVersion = 0;
let clusterCopilotStatus = 'idle';
const tabs = ['overview', 'workloads'];

function showTab(name, focus = false) {
  activeTab = name;
  selectedResource = null;
  resourceVersion++;
  $('panel-resource').hidden = true;
  $('investigation-tabs').hidden = false;
  $('namespace-controls').hidden = name !== 'workloads';
  $('panel-events').hidden = name !== 'workloads';
  $('panel-monitoring').hidden = name !== 'workloads';
  for (const tab of tabs) {
    const active = tab === name;
    const button = $(`tab-${tab}`);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    $(`panel-${tab}`).hidden = !active;
    if (active && focus) button.focus();
  }
}

for (const [index, tab] of tabs.entries()) {
  const button = $(`tab-${tab}`);
  button.addEventListener('click', () => showTab(tab));
  button.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    showTab(tabs[next], true);
  });
}
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
  const findingsChanged = state.context !== next.context || state.namespace !== next.namespace ||
    JSON.stringify(state.aiIssues || []) !== JSON.stringify(next.aiIssues || []);
  state = next;
  $('cluster-title').textContent = state.context || 'Selected cluster';
  $('mode').textContent = state.editing ? 'Editing enabled' : 'Read only';
  $('mode').classList.toggle('edit', state.editing);
  $('toggle-edit').setAttribute('aria-checked', String(state.editing));
  $('toggle-edit').disabled = !state.namespace;
  $('refresh').disabled = !state.context || !state.namespace;
  if (findingsChanged) {
    const ai = $('ai-issues');
    ai.replaceChildren();
    $('copilot-findings').hidden = !(state.aiIssues || []).length;
    for (const issue of state.aiIssues || []) ai.append(issueCard(issue, 'Copilot finding', true, false));
    renderNamespaceIssues();
    renderResourceIssues();
  }
  if (selectedResource) $('resource-scale').hidden = !(selectedResource.kind === 'Deployment' && state.editing);
}
async function loadContexts() {
  const contexts = await api('contexts');
  setOptions($('context'), contexts, '', 'Select a context');
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
function issueCard(issue, label, inspect = true, showSource = true) {
  const card = document.createElement('article');
  card.className = 'issue-card';
  const header = document.createElement('div');
  header.className = 'issue-card-header';
  const heading = document.createElement(showSource ? 'h3' : 'h4');
  heading.textContent = issue.title;
  header.append(heading);
  if (showSource) {
    const source = document.createElement('p');
    source.className = 'issue-source';
    source.textContent = label;
    header.append(source);
  }
  const evidence = document.createElement('p');
  evidence.textContent = `${inspect ? 'Evidence' : 'What we know'}: ${issue.evidence}`;
  const next = document.createElement('p');
  next.className = 'hint';
  next.textContent = `${inspect ? 'Next step' : 'Suggested checks and fixes'}: ${issue.next}`;
  const canInvestigate = inspect && issue.kind && issue.namespace && issue.name;
  card.append(header);
  if (!showSource && issue.namespace) {
    const namespace = document.createElement('p');
    namespace.className = 'issue-namespace';
    namespace.textContent = `Namespace: ${issue.namespace}`;
    card.append(namespace);
  }
  card.append(evidence);
  if (label === 'Automated check' && canInvestigate) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Suggested checks';
    details.append(summary, next);
    card.append(details);
  } else {
    card.append(next);
  }
  const actions = document.createElement('div');
  actions.className = 'actions';
  if (canInvestigate) {
    const button = document.createElement('button');
    button.textContent = 'Investigate resource';
    button.setAttribute('aria-label', `Investigate ${issue.kind} ${issue.name} in namespace ${issue.namespace}`);
    button.addEventListener('click', () => perform(() => openIssue(issue)));
    actions.append(button);
  }
  for (const link of issue.docs || []) {
    const a = document.createElement('a');
    a.href = link;
    a.textContent = new URL(link).hostname === 'kubernetes.io' ? 'Kubernetes docs ↗' : 'AKS docs ↗';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    actions.append(a);
  }
  card.append(actions);
  return card;
}
async function scanIssues() {
  const context = state.context;
  if (!context) return;
  const version = ++scanVersion;
  $('scan-spinner').hidden = false;
  $('scan-result-icon').hidden = true;
  $('scan').hidden = true;
  $('scan').disabled = true;
  $('overview-title').textContent = 'Checking cluster…';
  $('scan-status').textContent = 'Scanning workloads and nodes…';
  $('issues').replaceChildren();
  $('cluster-findings').hidden = true;
  $('show-more-issues').hidden = true;
  scanCache = [];
  scanErrors = [];
  scanLimit = 100;
  renderNamespaceIssues();
  try {
    const result = await api('scan');
    if (state.context !== context || version !== scanVersion) return;
    scanCache = result.issues;
    scanErrors = result.errors;
    renderScanIssues();
    $('scan-result-icon').textContent = scanErrors.length ? '!' : '✓';
    $('scan-result-icon').className = `result-icon ${scanErrors.length ? 'warning' : 'success'}`;
    $('scan-result-icon').hidden = false;
    renderNamespaceIssues();
    return result;
  } catch (error) {
    if (state.context === context && version === scanVersion) {
      $('scan-status').textContent = `Checks could not be completed: ${error.message}`;
      $('scan-result-icon').textContent = '!';
      $('scan-result-icon').className = 'result-icon warning';
      $('scan-result-icon').hidden = false;
    }
    throw error;
  } finally {
    if (version === scanVersion) {
      $('overview-title').textContent = 'Cluster findings';
      $('scan-spinner').hidden = true;
      $('scan').disabled = false;
      $('scan').hidden = false;
    }
  }
}
function renderScanIssues() {
  const container = $('issues');
  container.replaceChildren();
  const query = $('findings-filter').value.trim().toLowerCase();
  const matches = scanCache.filter(issue => [issue.title, issue.name, issue.namespace].some(value => value && value.toLowerCase().includes(query)));
  for (const issue of matches.slice(0, scanLimit)) container.append(issueCard(issue, 'Automated check', true, false));
  const count = scanCache.length;
  $('cluster-findings').hidden = count === 0;
  const displayed = Math.min(matches.length, scanLimit);
  $('show-more-issues').hidden = displayed >= matches.length;
  $('findings-filter-status').textContent = query
    ? `${matches.length} of ${count} signals match${matches.length > displayed ? `; showing ${displayed}` : ''}.`
    : matches.length > displayed ? `Showing ${displayed} of ${count} signals.` : '';
  if (query && !matches.length) container.textContent = 'No cluster checks match this filter.';
  const countText = `${count} ${count === 1 ? 'signal' : 'signals'} found.`;
  $('scan-status').textContent = scanErrors.length
    ? `${countText} Some checks failed; results are incomplete: ${scanErrors.join(' | ')}`
    : count ? `Checks complete. ${countText} Investigate the evidence before making changes.`
      : 'Checks complete. No issues detected by these checks. This is not a complete cluster health assessment.';
}
function renderNamespaceIssues() {
  const container = $('namespace-issues');
  container.replaceChildren();
  if (!state.namespace) {
    $('namespace-issue-status').textContent = 'Select a namespace to see workload signals.';
    return;
  }
  const entries = [
    ...(state.aiIssues || []).map(issue => ({ issue, label: 'Copilot finding' })),
    ...scanCache.map(issue => ({ issue, label: 'Automated check' }))
  ].filter(({ issue }) => issue.namespace === state.namespace && ['Pod', 'Deployment'].includes(issue.kind));
  $('namespace-issue-status').textContent = entries.length
    ? `${entries.length} workload ${entries.length === 1 ? 'signal' : 'signals'} in this namespace.`
    : 'No workload signals to show yet. Checks and Copilot investigations may still be running or incomplete.';
  for (const { issue, label } of entries) container.append(issueCard(issue, label));
}
function matchesSelector(pod, selector) {
  if (!selector || (!Object.keys(selector.matchLabels || {}).length && !(selector.matchExpressions || []).length)) return false;
  const labels = pod.labels || {};
  if (!Object.entries(selector.matchLabels || {}).every(([key, value]) => labels[key] === value)) return false;
  return (selector.matchExpressions || []).every(rule => {
    const present = Object.hasOwn(labels, rule.key);
    if (rule.operator === 'Exists') return present;
    if (rule.operator === 'DoesNotExist') return !present;
    if (rule.operator === 'In') return present && (rule.values || []).includes(labels[rule.key]);
    if (rule.operator === 'NotIn') return !present || !(rule.values || []).includes(labels[rule.key]);
    return false;
  });
}
function renderResourceIssues() {
  const container = $('resource-issues');
  container.replaceChildren();
  if (!selectedResource) return;
  const issues = (state.aiIssues || []).filter(issue =>
    issue.kind === selectedResource.kind && issue.name === selectedResource.name && issue.namespace === selectedResource.namespace
  );
  if (!issues.length) {
    container.textContent = manualResource
      ? 'No Copilot finding is available for this resource yet.'
      : 'No matching Copilot finding is available from the cluster investigation.';
    updateResourceCopilotStatus(issues.length > 0);
    return;
  }
  for (const issue of issues) container.append(issueCard(issue, 'Copilot finding', false));
  updateResourceCopilotStatus(true);
}
function updateResourceCopilotStatus(hasFinding) {
  if (!selectedResource || manualResource) return;
  const active = ['waiting', 'running'].includes(clusterCopilotStatus);
  $('resource-ai-spinner').hidden = !active;
  if (clusterCopilotStatus === 'waiting') {
    $('resource-ai-status').textContent = 'Copilot will review the scan findings when the cluster checks finish.';
  } else if (clusterCopilotStatus === 'running') {
    $('resource-ai-status').textContent = 'Copilot is checking the scan findings. A matching result will appear here.';
  } else if (clusterCopilotStatus === 'complete') {
    $('resource-ai-status').textContent = hasFinding
      ? 'Copilot finished checking the scan findings. The matching result is shown below.'
      : 'Copilot finished checking the scan findings; no matching result was published for this resource.';
  } else if (clusterCopilotStatus === 'uncertain') {
    $('resource-ai-status').textContent = 'Copilot may still be working. Any matching result will appear here when available.';
  } else if (clusterCopilotStatus === 'error') {
    $('resource-ai-status').textContent = 'Copilot could not complete the cluster review. No extra resource request was sent.';
  } else {
    $('resource-ai-status').textContent = hasFinding
      ? 'Showing the matching Copilot finding from the earlier cluster investigation.'
      : 'No matching Copilot finding is available from the earlier cluster investigation.';
  }
}
function renderResourceRelated() {
  const container = $('resource-related');
  container.replaceChildren();
  if (!resourceDetails || !selectedResource) return;
  const related = [...resourceDetails.related];
  if (resourceDetails.kind === 'Deployment') {
    for (const pod of workloadsCache.filter(item => item.kind === 'Pod' && matchesSelector(item, resourceDetails.selector))) {
      related.push({ kind: 'Pod', name: pod.name });
    }
  }
  if (!related.length) container.textContent = 'No supported related resources found.';
  for (const item of related) {
    const button = document.createElement('button');
    button.className = 'secondary';
    const kind = document.createElement('span');
    kind.textContent = item.kind;
    const name = document.createElement('strong');
    name.textContent = item.name;
    const action = document.createElement('span');
    action.textContent = 'Open investigation →';
    button.append(kind, name, action);
    button.addEventListener('click', () => perform(() => openResource({ ...item, namespace: state.namespace }, {
      manual: manualResource,
      investigate: manualResource
    })));
    container.append(button);
  }
}
async function loadResource(target, version) {
  try {
    const result = await api('resource', target);
    if (version !== resourceVersion) return;
    resourceDetails = result.details;
    $('resource-phase').textContent = result.details.phase || 'Not reported';
    $('resource-created').textContent = result.details.created || 'Not reported';
    $('resource-status').textContent = 'Current conditions and container status from Kubernetes.';
    const evidence = $('resource-evidence');
    evidence.replaceChildren();
    for (const condition of result.details.conditions) {
      evidence.append(row(`${condition.type || 'Condition'}: ${condition.status || 'Unknown'}${condition.reason ? ` · ${condition.reason}` : ''}`, condition.message || 'No condition message.'));
    }
    for (const container of result.details.containers) {
      evidence.append(row(`Container ${container.name || 'unknown'} · ${container.waitingReason || (container.ready ? 'Ready' : 'Not ready')}`, `${container.restarts ?? 0} restarts${container.waitingMessage ? ` · ${container.waitingMessage}` : ''}`));
    }
    if (result.details.provider) evidence.append(row('CSI provider', result.details.provider));
    if (result.details.kind === 'Deployment') evidence.append(row('Available replicas', `${result.details.available} of ${result.details.desired}`));
    if (!evidence.children.length) evidence.textContent = 'No conditions or container status reported.';
    const events = $('resource-events');
    events.replaceChildren();
    if (result.eventError) events.textContent = `Events could not be loaded: ${result.eventError}`;
    else if (!result.events.length) events.textContent = 'No recent events found. Events are short-lived.';
    else for (const event of result.events) events.append(row(`${event.type || 'Event'} · ${event.reason || 'Unknown'}`, `${event.time || 'Unknown time'} · ${event.message || 'No message'}${event.count ? ` · ${event.count} occurrences` : ''}`));
    renderResourceRelated();
  } catch (error) {
    if (version === resourceVersion) {
      $('resource-status').textContent = `Resource could not be loaded: ${error.message}`;
      $('resource-phase').textContent = 'Unavailable';
      $('resource-created').textContent = 'Unavailable';
      $('resource-events').textContent = 'Events could not be loaded without the resource.';
    }
  }
}
async function requestResourceInvestigation(target, version) {
  $('resource-ai-spinner').hidden = false;
  $('resource-ai-status').textContent = 'Requesting a focused investigation in Copilot…';
  try {
    await api('ask-resource-copilot', target);
    if (version === resourceVersion) $('resource-ai-status').textContent = 'Investigation requested. Review tool approvals; new findings will appear here. Existing findings may predate this request.';
  } catch (error) {
    if (version === resourceVersion) $('resource-ai-status').textContent = `Copilot investigation could not be requested: ${error.message}`;
  } finally {
    if (version === resourceVersion) $('resource-ai-spinner').hidden = true;
  }
}
async function openResource(resource, { push = true, investigate = true, manual = true } = {}) {
  if (selectedResource && push) resourceHistory.push(selectedResource);
  if (!selectedResource) {
    resourceHistory = [];
    resourceReturnTab = activeTab;
  }
  const target = { context: state.context, namespace: resource.namespace, kind: resource.kind, name: resource.name };
  selectedResource = target;
  manualResource = manual;
  $('resource-ai-spinner').hidden = true;
  resourceDetails = null;
  const version = ++resourceVersion;
  for (const tab of tabs) $(`panel-${tab}`).hidden = true;
  $('panel-events').hidden = true;
  $('panel-monitoring').hidden = true;
  $('investigation-tabs').hidden = true;
  $('namespace-controls').hidden = true;
  $('panel-resource').hidden = false;
  $('panel-resource').focus();
  $('resource-manual-controls').hidden = !manual;
  $('resource-refresh').hidden = !manual;
  $('resource-title').textContent = `${target.kind} / ${target.name}`;
  $('resource-question').value = '';
  $('resource-question-status').textContent = '';
  $('resource-cluster').textContent = target.context;
  $('resource-namespace').textContent = target.kind === 'Node' ? 'Cluster-scoped' : target.namespace;
  $('resource-phase').textContent = 'Loading…';
  $('resource-created').textContent = 'Loading…';
  $('resource-status').textContent = 'Loading resource…';
  $('resource-evidence').replaceChildren();
  $('resource-events').textContent = 'Loading events…';
  $('resource-related').replaceChildren();
  $('resource-scale').hidden = !(target.kind === 'Deployment' && state.editing);
  $('pod-log-section').hidden = target.kind !== 'Pod';
  $('previous').checked = false;
  $('log-target').textContent = 'Logs can contain sensitive data. Pending containers may not have logs yet.';
  $('logs').textContent = 'Not loaded.';
  $('describe-output').textContent = 'Not loaded.';
  logsLoaded = false;
  renderResourceIssues();
  if (manual) {
    $('resource-ai-status').textContent = investigate
      ? 'Loading evidence before requesting a Copilot summary…'
      : 'Review the available findings below. They may predate the latest evidence.';
  } else {
    updateResourceCopilotStatus((state.aiIssues || []).some(issue =>
      issue.kind === selectedResource.kind && issue.name === selectedResource.name && issue.namespace === selectedResource.namespace
    ));
  }
  await loadResource(target, version);
  if (investigate && version === resourceVersion) await requestResourceInvestigation(target, version);
}
async function scaleDeployment(item) {
  const answer = window.prompt(`Scale ${item.name} in ${state.context} / ${state.namespace} to how many replicas?`, '1');
  if (answer === null) return;
  if (!/^(0|[1-9]\d*)$/.test(answer) || Number(answer) > 1000) throw new Error('Replicas must be an integer from 0 to 1000.');
  const target = { context: state.context, namespace: state.namespace, deployment: item.name, replicas: Number(answer) };
  if (!window.confirm(`Scale deployment ${target.deployment} in ${target.context} / ${target.namespace} to ${target.replicas} replicas? This changes the live cluster and GitOps may revert it.`)) return;
  message(await api('scale', target));
  await loadWorkloads();
  if (selectedResource?.kind === 'Deployment' && selectedResource.name === item.name) await loadResource(selectedResource, resourceVersion);
}
async function openIssue(issue) {
  const context = state.context;
  renderState(await api('state'));
  if (state.context !== context) throw new Error('The selected cluster changed before the finding was opened.');
  if (state.namespace !== issue.namespace) {
    renderState(await api('select-namespace', { namespace: issue.namespace }));
    $('namespace').value = issue.namespace;
    clearTargetData();
    loadWorkloads().catch(error => message(error.message));
  }
  await openResource(issue, { investigate: false, manual: false });
}
async function loadWorkloads() {
  const target = `${state.context}\0${state.namespace}`;
  const version = ++workloadsVersion;
  const previousSelection = $('workload-select').value;
  workloadsState = 'loading';
  workloadsCache = [];
  renderWorkloads('');
  let workloads;
  try {
    workloads = await api('workloads');
  } catch (error) {
    if (`${state.context}\0${state.namespace}` === target && version === workloadsVersion) {
      workloadsState = 'error';
      renderWorkloads('');
    }
    throw error;
  }
  if (`${state.context}\0${state.namespace}` !== target || version !== workloadsVersion) return;
  workloadsCache = workloads;
  workloadsState = 'ready';
  renderWorkloads(previousSelection);
  renderResourceRelated();
}
function workloadKey(item) {
  return JSON.stringify([item.kind, item.name]);
}
function renderWorkloads(selected = $('workload-select').value) {
  const container = $('workloads');
  container.classList.remove('empty');
  container.replaceChildren();
  const picker = $('workload-select');
  picker.replaceChildren(new Option('Select a workload', ''));
  picker.value = '';
  $('investigate-workload').disabled = true;
  picker.disabled = true;
  $('workload-kind').disabled = workloadsState !== 'ready';
  $('workload-filter').disabled = workloadsState !== 'ready';
  if (!state.namespace || workloadsState !== 'ready') {
    const text = !state.namespace ? 'Choose a namespace to load workloads.'
      : workloadsState === 'loading' ? 'Loading workloads…'
        : workloadsState === 'error' ? 'Workloads could not be loaded. See the error above.'
          : 'Workloads have not been loaded.';
    $('workload-status').textContent = text;
    container.textContent = text;
    return;
  }
  const kind = $('workload-kind').value;
  const query = $('workload-filter').value.trim().toLowerCase();
  const workloads = workloadsCache.filter(item => (!kind || item.kind === kind) && item.name.toLowerCase().includes(query));
  $('workload-status').textContent = workloads.length
    ? `${workloads.length} ${workloads.length === 1 ? 'workload' : 'workloads'} available in ${state.namespace}.`
    : workloadsCache.length ? 'No workloads match these filters.' : `No pods or deployments found in ${state.namespace}.`;
  if (!workloads.length) container.textContent = $('workload-status').textContent;
  for (const item of workloads) {
    picker.add(new Option(`${item.kind} / ${item.name} · ${item.status || 'Unknown'}`, workloadKey(item)));
    const element = row(`${item.kind} / ${item.name}`, `${item.status || 'Unknown'}${item.kind === 'Pod' ? ` · ${item.restarts} restarts` : ''}`);
    const button = document.createElement('button');
    button.className = 'secondary';
    button.textContent = 'Investigate';
    button.setAttribute('aria-label', `Investigate ${item.kind} ${item.name}`);
    button.addEventListener('click', () => perform(() => openResource({ ...item, namespace: state.namespace }, { manual: manualResource })));
    element.append(button);
    container.append(element);
  }
  picker.disabled = !workloads.length;
  picker.value = workloads.some(item => workloadKey(item) === selected) ? selected : '';
  $('investigate-workload').disabled = !picker.value;
}
async function loadEvents() {
  const target = `${state.context}\0${state.namespace}`;
  $('events').textContent = 'Loading events…';
  let events;
  try {
    events = await api('events');
  } catch (error) {
    if (`${state.context}\0${state.namespace}` === target) {
      $('events').textContent = 'Events could not be loaded. See the error above.';
    }
    throw error;
  }
  if (`${state.context}\0${state.namespace}` !== target) return;
  const container = $('events');
  container.classList.remove('empty');
  container.replaceChildren();
  if (!events.length) container.textContent = 'No events found.';
  for (const item of events) container.append(row(`${item.type || 'Event'} · ${item.reason || 'Unknown'}`, `${item.time || 'Unknown time'} · ${item.resource || 'Unknown resource'} · ${item.message || ''}`));
}
async function loadLogs() {
  if (!selectedResource || selectedResource.kind !== 'Pod') return;
  const target = selectedResource;
  const version = resourceVersion;
  $('log-target').textContent = `Pod: ${target.name} · ${$('previous').checked ? 'previous container' : 'current container'} · up to 200 lines per container`;
  $('logs').textContent = 'Loading logs…';
  try {
    const logs = await api('logs', { ...target, pod: target.name, previous: $('previous').checked });
    if (version === resourceVersion) {
      $('logs').textContent = logs || 'No log lines returned.';
      logsLoaded = true;
    }
  } catch (error) {
    if (version === resourceVersion) {
      $('logs').textContent = `Logs could not be loaded: ${error.message}`;
      logsLoaded = false;
    }
  }
}
async function loadDescribe() {
  if (!selectedResource) return;
  const target = selectedResource;
  const version = resourceVersion;
  $('describe-output').textContent = 'Loading describe output…';
  try {
    const output = await api('describe', target);
    if (version === resourceVersion) $('describe-output').textContent = output || 'No describe output returned.';
  } catch (error) {
    if (version === resourceVersion) $('describe-output').textContent = `Describe could not be loaded: ${error.message}`;
  }
}
function clearTargetData() {
  logsLoaded = false;
  selectedResource = null;
  resourceDetails = null;
  resourceHistory = [];
  resourceVersion++;
  workloadsVersion++;
  workloadsCache = [];
  workloadsState = 'idle';
  renderWorkloads('');
  $('events').textContent = 'Choose a namespace to see events.';
  renderNamespaceIssues();
}
async function refreshData() {
  const results = await Promise.allSettled([scanIssues(), ...(state.namespace ? [loadWorkloads(), loadEvents()] : [])]);
  const failures = results.filter(x => x.status === 'rejected');
  if (failures.length) message(failures.map(x => x.reason.message).join(' | '));
}
async function refreshNamespaceData() {
  const results = await Promise.allSettled([loadWorkloads(), loadEvents()]);
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length) message(failures.map(result => result.reason.message).join(' | '));
}
function showPicker() {
  choosingCluster = true;
  $('hero').classList.remove('compact');
  $('cluster-picker').hidden = false;
  $('investigation').hidden = true;
  $('context').value = '';
}
function showInvestigation() {
  choosingCluster = false;
  $('hero').classList.add('compact');
  $('cluster-picker').hidden = true;
  $('investigation').hidden = false;
}
$('refresh-contexts').addEventListener('click', () => perform(loadContexts));
$('context').addEventListener('change', () => perform(async () => {
  const context = $('context').value;
  if (!context) return;
  const changed = context !== state.context;
  $('context').disabled = true;
  try {
    renderState(await api('select-context', { context }));
    if (changed) {
      scanCache = [];
      $('findings-filter').value = '';
      $('cluster-question').value = '';
      $('cluster-question-status').textContent = '';
      clearTargetData();
      showTab('overview');
    }
    $('namespace').disabled = true;
    showInvestigation();
    $('context').disabled = false;
    $('ai-spinner').hidden = false;
    $('ask-copilot').disabled = true;
    $('ask-copilot').hidden = true;
    clusterCopilotStatus = 'waiting';
    $('ai-status').textContent = 'Waiting for cluster checks before Copilot investigates…';
    const scan = scanIssues();
    const investigation = scan.then(
      result => result && state.context === context ? requestInvestigation(context, result.issues, result.errors) : undefined,
      error => state.context === context
        ? requestInvestigation(context, [], [`Cluster checks could not complete: ${error.message}`])
        : undefined
    );
    const results = await Promise.allSettled([
      loadNamespaces(), scan, investigation,
      ...(state.namespace ? [loadWorkloads(), loadEvents()] : [])
    ]);
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) message(failures.map(result => result.reason.message).join(' | '));
  } catch (error) {
    if (choosingCluster) $('context').value = '';
    throw error;
  } finally {
    $('context').disabled = false;
  }
}));
$('change-cluster').addEventListener('click', () => perform(async () => {
  if (state.editing) renderState(await api('editing', { enabled: false }));
  showTab('overview');
  showPicker();
  await loadContexts();
}));
$('refresh-namespaces').addEventListener('click', () => perform(loadNamespaces));
$('namespace').addEventListener('change', () => perform(async () => {
  const namespace = $('namespace').value;
  const previous = state.namespace;
  if (!namespace) return loadNamespaces();
  $('namespace').disabled = true;
  try {
    renderState(await api('select-namespace', { namespace }));
    if (namespace !== previous) {
      clearTargetData();
      showTab('workloads', true);
    }
    await refreshNamespaceData();
  } catch (error) {
    $('namespace').value = state.namespace;
    throw error;
  } finally {
    $('namespace').disabled = false;
  }
}));
$('refresh').addEventListener('click', () => perform(refreshNamespaceData));
$('scan').addEventListener('click', () => perform(scanIssues));
$('findings-filter').addEventListener('input', () => { scanLimit = 100; renderScanIssues(); });
$('show-more-issues').addEventListener('click', () => { scanLimit += 100; renderScanIssues(); });
async function requestInvestigation(context, findings = scanCache, errors = scanErrors) {
  const version = ++investigationVersion;
  clusterCopilotStatus = 'running';
  $('ai-spinner').hidden = false;
  $('ask-copilot').hidden = true;
  $('ask-copilot').disabled = true;
  $('ai-status').textContent = 'Copilot is investigating… Check chat for any tool approval requests.';
  try {
    const signals = findings.slice(0, 100).map(({ title, evidence, next, kind, name, namespace }) => ({
      title: title.slice(0, 500),
      evidence: evidence.slice(0, 1000),
      next: next.slice(0, 1000),
      kind,
      name: name.slice(0, 253),
      namespace: namespace.slice(0, 253)
    }));
    await api('ask-copilot', { context, findings: signals, scanErrors: errors.slice(0, 20).map(error => error.slice(0, 500)) });
    if (state.context === context && version === investigationVersion) {
      clusterCopilotStatus = 'complete';
      $('ai-status').textContent = 'Copilot request finished. Check chat for the outcome and any limitations.';
    }
  } catch (error) {
    if (state.context === context && version === investigationVersion) {
      const timedOut = /timeout|timed out/i.test(error.message);
      clusterCopilotStatus = timedOut ? 'uncertain' : 'error';
      $('ai-status').textContent = timedOut
        ? 'Copilot did not finish in time. It may still be working; check the chat.'
        : `Copilot investigation could not be completed: ${error.message}`;
    }
  } finally {
    if (version === investigationVersion) {
      $('ai-spinner').hidden = true;
      $('ask-copilot').disabled = false;
      $('ask-copilot').hidden = false;
      renderResourceIssues();
    }
  }
}
$('ask-copilot').addEventListener('click', () => requestInvestigation(state.context));
async function askManualQuestion(resource = false) {
  const prefix = resource ? 'resource' : 'cluster';
  const input = $(`${prefix}-question`);
  const button = $(`ask-${prefix}-question`);
  const status = $(`${prefix}-question-status`);
  const question = input.value.trim();
  if (!question || question.length > 2000) {
    status.textContent = 'Enter a question of up to 2000 characters.';
    return;
  }
  const target = resource ? selectedResource : { context: state.context };
  if (!target || !target.context) {
    status.textContent = 'Select a target first.';
    return;
  }
  const version = resourceVersion;
  button.disabled = true;
  status.textContent = 'Sending to Copilot…';
  try {
    await api('ask-manual-copilot', { ...target, question });
    if (state.context === target.context && (!resource || version === resourceVersion)) {
      input.value = '';
      status.textContent = 'Sent to Copilot. Check chat for the response and tool approvals.';
    }
  } catch (error) {
    if (state.context === target.context && (!resource || version === resourceVersion)) status.textContent = `Could not send to Copilot: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}
$('ask-cluster-question').addEventListener('click', () => askManualQuestion());
$('ask-resource-question').addEventListener('click', () => askManualQuestion(true));
$('workload-kind').addEventListener('change', () => renderWorkloads());
$('workload-filter').addEventListener('input', () => renderWorkloads());
$('workload-select').addEventListener('change', () => { $('investigate-workload').disabled = !$('workload-select').value; });
$('investigate-workload').addEventListener('click', () => perform(async () => {
  const resource = workloadsCache.find(item => workloadKey(item) === $('workload-select').value);
  if (workloadsState !== 'ready' || !state.namespace || !resource) throw new Error('Select an available workload first.');
  await openResource({ ...resource, namespace: state.namespace }, { manual: true });
}));
$('resource-back').addEventListener('click', () => perform(async () => {
  const previous = resourceHistory.pop();
  if (previous) await openResource(previous, { push: false, investigate: false, manual: manualResource });
  else showTab(resourceReturnTab, true);
}));
$('resource-refresh').addEventListener('click', () => perform(async () => {
  if (selectedResource) await openResource(selectedResource, {
    push: false,
    manual: manualResource,
    investigate: manualResource
  });
}));
$('resource-scale').addEventListener('click', () => perform(async () => {
  if (!selectedResource || selectedResource.kind !== 'Deployment') throw new Error('Select a deployment first.');
  await scaleDeployment(selectedResource);
}));
$('load-describe').addEventListener('click', () => perform(loadDescribe));
$('load-logs').addEventListener('click', () => perform(loadLogs));
$('previous').addEventListener('change', () => { if (logsLoaded) perform(loadLogs); });
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
  if (state.editing) {
    renderState(await api('editing', { enabled: false }));
    await loadWorkloads();
    return;
  }
  editTarget = { context: state.context, namespace: state.namespace };
  $('edit-target').textContent = `Target: ${editTarget.context} / ${editTarget.namespace}`;
  $('edit-dialog').showModal();
}));
$('cancel-edit').addEventListener('click', () => $('edit-dialog').close());
$('confirm-edit').addEventListener('click', () => perform(async () => {
  $('edit-dialog').close();
  if (!editTarget) throw new Error('Select a target before enabling editing.');
  renderState(await api('editing', { enabled: true, ...editTarget }));
  editTarget = null;
  await loadWorkloads();
}));
perform(async () => {
  renderState(await api('state'));
  await loadContexts();
  if (state.context) {
    showInvestigation();
    $('ai-status').textContent = 'No new investigation was requested. Choose Investigate again to start one.';
    $('ask-copilot').hidden = false;
    const results = await Promise.allSettled([loadNamespaces(), refreshData()]);
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) message(failures.map(result => result.reason.message).join(' | '));
  } else {
    showPicker();
  }
});
setInterval(() => { api('state').then(renderState).catch(error => message(error.message)); }, 5000);
