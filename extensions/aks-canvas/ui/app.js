import { groupFindings } from '../finding-groups.mjs';

const $ = id => document.getElementById(id);
const token = document.querySelector('meta[name="canvas-token"]').content;
let state = { context: '', namespace: '', aiIssues: [], editing: false };
let logsLoaded = false;
let workloadsCache = [];
let workloadsState = 'idle';
let workloadsVersion = 0;
let explorerTypes = [];
let explorerNames = [];
let explorerVersion = 0;
let explorerDiscoveryVersion = 0;
let explorerStatus = 'Select a resource type.';
let explorerProblemsOnly = false;
let scanCache = [];
let scanErrors = [];
let scanResources = [];
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
let copilotReviewCount = 0;
let resourceRequestVersion = 0;
let summarySequence = 0;
const summaryStates = new Map();
const tabs = ['overview', 'workloads'];
const inspectorTabs = ['overview', 'events', 'related', 'describe', 'logs'];
const commonExplorerKinds = ['Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'PersistentVolumeClaim', 'Node'];
const investigableKinds = new Set([
  'Pod', 'Deployment', 'ReplicaSet', 'Job', 'CronJob', 'StatefulSet', 'DaemonSet',
  'ReplicationController', 'PersistentVolumeClaim', 'SecretProviderClass', 'Node'
]);

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
function showInspectorTab(name) {
  if (name === 'events' && document.querySelector('[data-inspector-tab="events"]').hidden) name = 'describe';
  for (const tab of inspectorTabs) {
    const button = document.querySelector(`[data-inspector-tab="${tab}"]`);
    const active = tab === name;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    document.querySelector(`[data-inspector-panel="${tab}"]`).hidden = !active;
  }
}
function relativeAge(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return 'Not reported';
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60000));
  if (minutes < 1) return 'Just created';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
for (const tab of inspectorTabs) {
  document.querySelector(`[data-inspector-tab="${tab}"]`).addEventListener('click', () => showInspectorTab(tab));
}
showInspectorTab('overview');

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
    JSON.stringify(state.aiIssues || []) !== JSON.stringify(next.aiIssues || []) ||
    JSON.stringify(state.resourceSummaries || []) !== JSON.stringify(next.resourceSummaries || []) ||
    JSON.stringify(state.conversations || []) !== JSON.stringify(next.conversations || []);
  state = next;
  renderOverviewCopilotStatus();
  $('cluster-title').textContent = state.context || 'Selected cluster';
  $('mode').textContent = state.editing ? 'Editing enabled' : 'Read only';
  $('mode').classList.toggle('edit', state.editing);
  $('toggle-edit').setAttribute('aria-checked', String(state.editing));
  $('toggle-edit').disabled = !state.namespace;
  $('refresh').disabled = !state.context || !state.namespace;
  if (findingsChanged) {
    renderCombinedFindings();
    renderNamespaceIssues();
    renderResourceIssues();
    renderResourceRelated();
    renderConversation('cluster-conversation', null);
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
function findingGroups(clusterFindings = scanCache, copilotFindings = state.aiIssues || []) {
  return groupFindings(clusterFindings, copilotFindings, scanResources).sort((left, right) =>
    Number(right.signals.some(signal => signal.sources.includes('Copilot'))) -
    Number(left.signals.some(signal => signal.sources.includes('Copilot')))
  );
}
function sameTarget(left, right) {
  return left.kind === right.kind && left.name === right.name && left.namespace === right.namespace;
}
function resourceKey(resource) {
  return JSON.stringify([resource.namespace, resource.kind, resource.name]);
}
function summaryKey(resource) {
  return JSON.stringify([resource.context, resource.namespace, resource.kind, resource.name]);
}
function setSummaryState(target, phase, id) {
  const key = summaryKey(target);
  if (id !== undefined && summaryStates.get(key)?.id !== id) return null;
  const nextId = id ?? ++summarySequence;
  summaryStates.set(key, { phase, id: nextId });
  if (selectedResource && summaryKey(selectedResource) === key) {
    $('resource-scan-details').open = phase !== 'complete';
    renderSummaryAge();
  }
  return nextId;
}
function renderSummaryAge() {
  const label = $('resource-summary-age');
  const summary = selectedResource && (state.resourceSummaries || []).find(item => sameTarget(item, selectedResource));
  const phase = selectedResource && summaryStates.get(summaryKey(selectedResource))?.phase;
  label.hidden = !summary || !['loading', 'failed', 'previous'].includes(phase);
  label.textContent = phase === 'loading' ? 'Previous summary · updating…'
    : phase === 'failed' ? 'Previous summary · the latest investigation failed.'
      : 'Previous summary · it may be out of date.';
}
function appendSummaryInline(container, value) {
  const tokens = /\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*([^*\n]+)\*/g;
  let start = 0;
  const text = value => {
    const span = document.createElement('span');
    span.textContent = value;
    container.append(span);
  };
  for (const match of value.matchAll(tokens)) {
    if (match.index > start) text(value.slice(start, match.index));
    if (match[3]) {
      let url;
      try { url = new URL(match[4]); } catch { /* Display malformed links as text. */ }
      if (url?.protocol === 'https:' && !url.username && !url.password &&
          ['learn.microsoft.com', 'kubernetes.io'].includes(url.hostname)) {
        const anchor = document.createElement('a');
        anchor.href = url.href;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        anchor.textContent = match[3];
        container.append(anchor);
      } else {
        text(`${match[3]} (${match[4]})`);
      }
    } else {
      const element = document.createElement(match[1] ? 'strong' : match[2] ? 'code' : 'em');
      element.textContent = match[1] || match[2] || match[5];
      container.append(element);
    }
    start = match.index + match[0].length;
  }
  if (start < value.length) text(value.slice(start));
}
function renderSummary(container, value, target = selectedResource) {
  container.replaceChildren();
  const lines = value.replace(/\r\n?/g, '\n').split('\n');
  let list;
  let listKind;
  let paragraph = [];
  let code = null;
  const flushParagraph = () => {
    if (!paragraph.length) return;
    const element = document.createElement('p');
    appendSummaryInline(element, paragraph.join('\n'));
    container.append(element);
    paragraph = [];
  };
  const flushCode = () => {
    const pre = document.createElement('pre');
    const element = document.createElement('code');
    element.textContent = code.join('\n');
    pre.append(element);
    container.append(pre);
    code = null;
  };
  for (const line of lines) {
    const suggestionText = line.match(/^\s*SUGGESTIONS:\s*(.+?)\s*$/i);
    if (suggestionText) {
      flushParagraph();
      list = null;
      const suggestions = suggestionText[1].split('|').map(item => item.trim()).filter(Boolean).slice(0, 3);
      if (suggestions.length) {
        const group = document.createElement('div');
        group.className = 'suggestions';
        const label = document.createElement('strong');
        label.textContent = 'Suggested follow-ups';
        group.append(label);
        for (const suggestion of suggestions) {
          const button = document.createElement('button');
          button.className = 'secondary';
          button.textContent = suggestion;
          button.addEventListener('click', () => askSuggestion(suggestion, target));
          group.append(button);
        }
        container.append(group);
      }
      continue;
    }
    if (/^\s*```/.test(line)) {
      flushParagraph();
      list = null;
      if (code) flushCode();
      else code = [];
      continue;
    }
    if (code) { code.push(line); continue; }
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    const item = line.match(/^\s{0,3}([-*+]|\d+[.)])\s+(.+)$/);
    if (heading) {
      flushParagraph();
      list = null;
      const element = document.createElement('h4');
      appendSummaryInline(element, heading[1]);
      container.append(element);
    } else if (item) {
      flushParagraph();
      const kind = /^\d/.test(item[1]) ? 'ol' : 'ul';
      if (!list || listKind !== kind) {
        list = document.createElement(kind);
        listKind = kind;
        container.append(list);
      }
      const element = document.createElement('li');
      if (kind === 'ol') element.value = Number.parseInt(item[1], 10);
      appendSummaryInline(element, item[2]);
      list.append(element);
    } else {
      list = null;
      if (line.trim()) paragraph.push(line);
      else flushParagraph();
    }
  }
  if (code) flushCode();
  flushParagraph();
}
async function askSuggestion(suggestion, target = selectedResource) {
  if (target && (!selectedResource || !sameTarget(selectedResource, target))) {
    await openResource(target, { manual: true, investigate: false });
  }
  const resource = Boolean(target && selectedResource);
  const prefix = resource ? 'resource' : 'cluster';
  $(`${prefix}-question`).value = suggestion;
  await askManualQuestion(resource);
}
function ownedBy(target, owner, resources) {
  const visited = new Set();
  let resource = target;
  while (resource) {
    const key = resourceKey(resource);
    if (visited.has(key)) return false;
    visited.add(key);
    const parent = resources.get(key)?.owners?.[0];
    if (!parent || !investigableKinds.has(parent.kind)) return false;
    resource = { ...parent, namespace: parent.kind === 'Node' ? '' : resource.namespace };
    if (sameTarget(resource, owner)) return true;
  }
  return false;
}
function findingGroupCard(group, inspect = true) {
  const card = document.createElement('article');
  card.className = 'issue-card';
  const title = document.createElement('h3');
  title.textContent = `${group.target.kind} ${group.target.name}: ${group.signals.length} ${group.signals.length === 1 ? 'finding' : 'findings'}`;
  card.append(title);
  const sources = [...new Set(group.signals.flatMap(signal => signal.sources))];
  const source = document.createElement('p');
  source.className = 'issue-source';
  source.textContent = `Sources: ${sources.join(' and ')}`;
  card.append(source);
  if (group.target.namespace) {
    const namespace = document.createElement('p');
    namespace.className = 'issue-namespace';
    namespace.textContent = `Namespace: ${group.target.namespace}`;
    card.append(namespace);
  }
  const resources = [...group.resources.values()];
  const summary = document.createElement('p');
  summary.textContent = `${resources.length} ${resources.length === 1 ? 'resource' : 'resources'} grouped under this owner.`;
  card.append(summary);
  const distinctTitles = [...new Set(group.signals.map(signal =>
    signal.title.replaceAll(signal.target.name, '').replace(/\s+:/g, ':').replace(/\s+/g, ' ').trim()
  ))];
  const overview = document.createElement('p');
  overview.textContent = `Signals: ${distinctTitles.slice(0, 3).join('; ')}${distinctTitles.length > 3 ? `; and ${distinctTitles.length - 3} more` : ''}`;
  card.append(overview);
  const diagnosis = group.signals.find(signal => signal.diagnoses?.length);
  if (diagnosis) {
    const details = document.createElement('details');
    details.className = 'diagnosis-preview';
    const label = document.createElement('summary');
    label.textContent = 'AI diagnosis';
    const content = document.createElement('div');
    content.className = 'resource-summary';
    renderSummary(content, diagnosis.diagnoses[0], group.target);
    if (diagnosis.suggestions?.length) {
      const suggestions = document.createElement('div');
      suggestions.className = 'suggestions';
      const heading = document.createElement('strong');
      heading.textContent = 'Suggested follow-ups';
      suggestions.append(heading);
      for (const text of diagnosis.suggestions.slice(0, 3)) {
        const button = document.createElement('button');
        button.className = 'secondary';
        button.textContent = text;
        button.addEventListener('click', () => askSuggestion(text, group.target));
        suggestions.append(button);
      }
      content.append(suggestions);
    }
    details.append(label, content);
    card.append(details);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  if (inspect && investigableKinds.has(group.target.kind) && group.target.name &&
      (group.target.namespace || group.target.kind === 'Node')) {
    const button = document.createElement('button');
    button.textContent = 'Investigate resource';
    button.setAttribute('aria-label', `Investigate ${group.target.kind} ${group.target.name}${group.target.namespace ? ` in namespace ${group.target.namespace}` : ''}`);
    button.addEventListener('click', () => perform(() => openIssue(group.target)));
    actions.append(button);
  }
  card.append(actions);
  return card;
}
function renderCombinedFindings() {
  const container = $('issues');
  if (!container) return;
  container.replaceChildren();
  const groups = findingGroups();
  const query = $('findings-filter').value.trim().toLowerCase();
  const matches = groups.filter(group => {
    const values = [
      group.target.kind, group.target.name, group.target.namespace,
      ...group.signals.map(signal => signal.title),
      ...[...group.resources.values()].flatMap(resource => [resource.kind, resource.name, resource.namespace])
    ];
    return values.some(value => value && value.toLowerCase().includes(query));
  });
  for (const group of matches.slice(0, scanLimit)) container.append(findingGroupCard(group));
  $('cluster-findings').hidden = groups.length === 0;
  const displayed = Math.min(matches.length, scanLimit);
  $('show-more-issues').hidden = displayed >= matches.length;
  $('findings-filter-status').textContent = query
    ? `${matches.length} of ${groups.length} grouped findings match${matches.length > displayed ? `; showing ${displayed}` : ''}.`
    : matches.length > displayed ? `Showing ${displayed} of ${groups.length} grouped findings.` : '';
  if (query && !matches.length) container.textContent = 'No findings match this filter.';
}
async function scanIssues() {
  const context = state.context;
  if (!context) return;
  const version = ++scanVersion;
  $('scan-progress').hidden = false;
  $('scan-spinner').hidden = false;
  $('scan-result-icon').hidden = true;
  $('scan').hidden = true;
  $('scan').disabled = true;
  $('overview-title').textContent = 'Checking cluster…';
  $('scan-status').textContent = 'Scanning workloads, ownership, nodes and warning events…';
  $('issues').replaceChildren();
  $('cluster-findings').hidden = true;
  $('show-more-issues').hidden = true;
  scanCache = [];
  scanErrors = [];
  scanResources = [];
  scanLimit = 100;
  renderCombinedFindings();
  renderNamespaceIssues();
  renderResourceIssues();
  renderResourceRelated();
  try {
    const result = await api('scan');
    if (state.context !== context || version !== scanVersion) return;
    scanCache = result.issues;
    scanErrors = result.errors;
    scanResources = result.resources || [];
    renderScanIssues();
    $('scan-result-icon').textContent = scanErrors.length ? '!' : '✓';
    $('scan-result-icon').className = `result-icon ${scanErrors.length ? 'warning' : 'success'}`;
    $('scan-result-icon').hidden = false;
    renderNamespaceIssues();
    renderResourceIssues();
    renderResourceRelated();
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
      $('overview-title').textContent = 'Findings';
      $('scan-spinner').hidden = true;
      $('scan').disabled = false;
      $('scan').hidden = false;
    }
  }
}
function renderScanIssues() {
  renderCombinedFindings();
  const count = scanCache.length;
  const groupedCount = groupFindings(scanCache, [], scanResources).length;
  const countText = `${count} cluster ${count === 1 ? 'signal' : 'signals'} grouped into ${groupedCount} ${groupedCount === 1 ? 'finding' : 'findings'}.`;
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
  const groups = findingGroups().filter(group => group.target.namespace === state.namespace);
  $('namespace-issue-status').textContent = groups.length
    ? `${groups.length} grouped ${groups.length === 1 ? 'finding' : 'findings'} in this namespace.`
    : 'No workload findings to show yet. Checks and Copilot investigations may still be running or incomplete.';
  for (const group of groups) container.append(findingGroupCard(group));
}
function renderOverviewCopilotStatus() {
  if (clusterCopilotStatus !== 'complete') return;
  if (copilotReviewCount > 100) {
    $('ai-progress').hidden = false;
    $('ai-status').textContent = `Only the first 100 of ${copilotReviewCount} grouped findings were reviewed by Copilot.`;
  } else if ((state.aiIssues || []).some(issue => issue.kind && issue.name)) {
    const detailed = (state.aiIssues || []).filter(issue => issue.diagnosis?.trim()).length;
    $('ai-progress').hidden = false;
    $('ai-status').textContent = detailed
      ? `${detailed} detailed AI ${detailed === 1 ? 'diagnosis is' : 'diagnoses are'} ready. Other findings retain summary-only evidence.`
      : 'AI summary review complete. Open a finding for a deeper diagnosis.';
  } else {
    $('ai-progress').hidden = false;
    $('ai-status').textContent = 'No resource-targeted Copilot findings are available.';
  }
}
function groupClusterSignals(signals) {
  const grouped = new Map();
  for (const signal of signals) {
    const prefix = `${signal.kind} ${signal.name}: `;
    const title = signal.title.startsWith(prefix) ? signal.title.slice(prefix.length) : signal.title;
    const key = JSON.stringify([signal.kind, title, signal.evidence, signal.next]);
    if (!grouped.has(key)) grouped.set(key, { title, sample: signal, targets: new Map() });
    grouped.get(key).targets.set(resourceKey(signal), signal);
  }
  return [...grouped.values()];
}
function renderResourceIssues() {
  const container = $('resource-issues');
  const scanContainer = $('resource-scan-issues');
  container.replaceChildren();
  scanContainer.replaceChildren();
  $('resource-summary').replaceChildren();
  if (!selectedResource) return;
  renderConversation('resource-conversation', selectedResource);
  const summary = (state.resourceSummaries || []).find(item => sameTarget(item, selectedResource));
  if (summary) renderSummary($('resource-summary'), summary.summary);
  const activity = summary?.activity || [];
  $('resource-activity').hidden = !activity.length;
  $('resource-activity-summary').textContent = `Investigation activity · ${activity.length} ${activity.length === 1 ? 'step' : 'steps'}`;
  $('resource-activity-list').replaceChildren();
  for (const step of activity) {
    const item = document.createElement('li');
    item.textContent = step;
    $('resource-activity-list').append(item);
  }
  renderSummaryAge();
  $('resource-scan-status').textContent = scanErrors.length
    ? `Some cluster checks failed; scan findings are incomplete: ${scanErrors.join(' | ')}`
    : '';
  const resources = new Map(scanResources.map(resource => [resourceKey(resource), resource]));
  const groups = findingGroups().filter(group =>
    sameTarget(group.target, selectedResource) || [...group.resources.values()].some(resource =>
      sameTarget(resource, selectedResource) || ownedBy(resource, selectedResource, resources))
  );
  const matchesSelected = target => sameTarget(target, selectedResource);
  const includedTargets = groups.flatMap(group => matchesSelected(group.target)
    ? [group.target, ...group.resources.values()]
    : [selectedResource, ...[...group.resources.values()].filter(resource => ownedBy(resource, selectedResource, resources))]);
  const issues = (state.aiIssues || []).filter(issue => includedTargets.some(target => sameTarget(issue, target)));
  if (!issues.length && !summary && summaryStates.get(summaryKey(selectedResource))?.phase !== 'loading') {
    container.textContent = manualResource
      ? 'No Copilot summary is available for this resource yet.'
      : 'No matching Copilot summary is available from the cluster investigation.';
  }
  let issueContainer = container;
  if (summary && issues.length) {
    const details = document.createElement('details');
    details.className = 'resource-published';
    const label = document.createElement('summary');
    label.textContent = `Published Copilot findings (${issues.length})`;
    issueContainer = document.createElement('div');
    issueContainer.className = 'issue-list';
    details.append(label, issueContainer);
    container.append(details);
  }
  for (const issue of issues) {
    const card = document.createElement('article');
    card.className = 'issue-card';
    const heading = document.createElement('h3');
    heading.textContent = issue.title;
    const evidence = document.createElement('p');
    evidence.textContent = `What we know: ${issue.evidence}`;
    const next = document.createElement('p');
    next.textContent = `Suggested checks and fixes: ${issue.next}`;
    card.append(heading, evidence, next);
    if (!matchesSelected(issue)) {
      const target = document.createElement('p');
      target.className = 'issue-source';
      target.textContent = `Related ${issue.kind}: ${issue.name}`;
      card.append(target);
    }
    issueContainer.append(card);
  }
  const signals = scanCache.filter(issue => includedTargets.some(target => sameTarget(issue, target)));
  const podPhases = new Map();
  const countedPods = new Set();
  for (const signal of signals) {
    if (signal.kind !== 'Pod' || countedPods.has(resourceKey(signal))) continue;
    countedPods.add(resourceKey(signal));
    const phase = resources.get(resourceKey(signal))?.status;
    if (['Pending', 'Running', 'Succeeded', 'Failed', 'Unknown'].includes(phase)) {
      podPhases.set(phase, (podPhases.get(phase) || 0) + 1);
    }
  }
  $('resource-pod-summary').hidden = selectedResource.kind === 'Pod' || !podPhases.size;
  $('resource-pod-phases').textContent = [...podPhases].map(([phase, count]) =>
    `${count} ${phase} ${count === 1 ? 'pod' : 'pods'}`
  ).join(' · ');
  if (!signals.length) {
    scanContainer.textContent = 'No matching cluster-check signals are available. Checks may be incomplete or out of date.';
  } else {
    for (const group of groupClusterSignals(signals)) {
      const { sample: signal, targets } = group;
      const item = document.createElement('div');
      item.className = 'finding-signal';
      const heading = document.createElement('strong');
      heading.textContent = targets.size > 1 ? `${targets.size} ${signal.kind}s: ${group.title}` : signal.title;
      item.append(heading);
      if (signal.evidence) {
        const text = document.createElement('p');
        text.textContent = `Evidence: ${signal.evidence}`;
        item.append(text);
      }
      if (signal.next) {
        const text = document.createElement('p');
        text.className = 'hint';
        text.textContent = `Next step: ${signal.next}`;
        item.append(text);
      }
      const affected = [...targets.values()].filter(target => !matchesSelected(target) && investigableKinds.has(target.kind));
      const createButton = target => {
        const button = document.createElement('button');
        button.className = 'secondary';
        button.textContent = `Investigate ${target.kind} ${target.name}`;
        button.addEventListener('click', () => perform(() => openResource(target, {
          manual: manualResource, investigate: true
        })));
        return button;
      };
      if (affected.length > 1) {
        const details = document.createElement('details');
        const label = document.createElement('summary');
        label.textContent = `View affected resources (${affected.length})`;
        const list = document.createElement('div');
        list.className = 'related-list';
        for (const target of affected) list.append(createButton(target));
        details.append(label, list);
        item.append(details);
      } else if (affected.length === 1) {
        item.append(createButton(affected[0]));
      }
      scanContainer.append(item);
    }
  }
  const docs = [...new Set([...issues, ...signals].flatMap(issue => issue.docs || []))];
  if (docs.length) {
    const actions = document.createElement('div');
    actions.className = 'actions';
    for (const link of docs) {
      const anchor = document.createElement('a');
      anchor.href = link;
      anchor.textContent = new URL(link).hostname === 'kubernetes.io' ? 'Kubernetes docs ↗' : 'AKS docs ↗';
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      actions.append(anchor);
    }
    scanContainer.append(actions);
  }
  updateResourceCopilotStatus(issues.length > 0);
}
function showResourceCopilotStatus(text, active = false) {
  $('resource-ai-progress').hidden = false;
  $('resource-ai-spinner').hidden = !active;
  $('resource-ai-status').textContent = text;
}
function hideResourceCopilotStatus() {
  $('resource-ai-progress').hidden = true;
  $('resource-ai-spinner').hidden = true;
  $('resource-ai-status').textContent = '';
}
function updateResourceCopilotStatus(hasFinding) {
  if (!selectedResource || manualResource || resourceRequestVersion === resourceVersion) return;
  if (summaryStates.get(summaryKey(selectedResource))?.phase === 'failed') {
    showResourceCopilotStatus('The latest investigation failed. Refresh to try again.');
    return;
  }
  if ((state.resourceSummaries || []).some(item => sameTarget(item, selectedResource))) {
    hideResourceCopilotStatus();
    return;
  }
  if (clusterCopilotStatus === 'waiting') {
    showResourceCopilotStatus('Copilot will review the grouped scan findings when the cluster checks finish.', true);
  } else if (clusterCopilotStatus === 'running') {
    showResourceCopilotStatus('Copilot is checking the scan findings. A matching result will appear here.', true);
  } else if (clusterCopilotStatus === 'complete') {
    if (hasFinding) hideResourceCopilotStatus();
    else showResourceCopilotStatus('No matching result was published for this resource.');
  } else if (clusterCopilotStatus === 'uncertain') {
    showResourceCopilotStatus('Copilot may still be working. Any matching result will appear here when available.');
  } else if (clusterCopilotStatus === 'error') {
    showResourceCopilotStatus('Copilot could not complete the cluster review. No extra resource request was sent.');
  } else {
    if (hasFinding) hideResourceCopilotStatus();
    else showResourceCopilotStatus('No matching Copilot finding is available from the earlier cluster investigation.');
  }
}
function renderResourceRelated() {
  const container = $('resource-related');
  container.replaceChildren();
  if (!resourceDetails || !selectedResource) return;
  const resources = new Map(scanResources.map(resource => [resourceKey(resource), resource]));
  const related = [...resourceDetails.related].map(item => ({
    ...item, namespace: item.kind === 'Node' ? '' : selectedResource.namespace
  }));
  for (const pod of scanResources) {
    if (pod.kind !== 'Pod' || (!sameTarget(pod, selectedResource) && !ownedBy(pod, selectedResource, resources))) continue;
    for (const reference of pod.references || []) {
      if (['PersistentVolumeClaim', 'SecretProviderClass'].includes(reference.kind)) {
        related.push({ ...reference, namespace: pod.namespace });
      }
    }
  }
  const unique = related.filter((item, index) => !related.slice(0, index).some(other => sameTarget(item, other)));
  if (!unique.length) {
    container.textContent = 'No related resources needed investigation.';
    document.querySelector('[data-inspector-tab="related"]').hidden = true;
  } else {
    document.querySelector('[data-inspector-tab="related"]').hidden = false;
  }
  for (const item of unique) {
    const button = document.createElement('button');
    button.className = 'secondary';
    const kind = document.createElement('span');
    kind.textContent = item.kind;
    const name = document.createElement('strong');
    name.textContent = item.name;
    const action = document.createElement('span');
    action.textContent = 'Open investigation →';
    button.append(kind, name, action);
    button.addEventListener('click', () => perform(() => openResource(item, {
      manual: manualResource,
      investigate: true
    })));
    container.append(button);
  }
}
async function loadResource(target, version) {
  try {
    const result = await api('resource', target);
    if (version !== resourceVersion) return;
    resourceDetails = result.details;
    $('resource-phase').textContent = result.details.phase ||
      (result.details.kind === 'CronJob' && typeof result.details.suspended === 'boolean'
        ? (result.details.suspended ? 'Suspended' : 'Not suspended') : 'Not reported');
    $('resource-created').textContent = result.details.created
      ? relativeAge(result.details.created)
      : 'Not reported';
    $('resource-status').textContent = '';
    const evidence = $('resource-evidence');
    evidence.replaceChildren();
    for (const condition of result.details.conditions) {
      evidence.append(row(`${condition.type || 'Condition'}: ${condition.status || 'Unknown'}${condition.reason ? ` · ${condition.reason}` : ''}`, condition.message || 'No condition message.'));
    }
    for (const container of result.details.containers) {
      evidence.append(row(`Container ${container.name || 'unknown'} · ${container.waitingReason || (container.ready ? 'Ready' : 'Not ready')}`, `${container.restarts ?? 0} restarts${container.waitingMessage ? ` · ${container.waitingMessage}` : ''}`));
    }
    if (result.details.provider) evidence.append(row('CSI provider', result.details.provider));
    if (result.details.keyVaultName) evidence.append(row('Key Vault reference', result.details.keyVaultName));
    if (result.details.secretProviderObjects?.length) {
      evidence.append(row('Referenced Key Vault objects', result.details.secretProviderObjects.join(', ')));
    }
    if (result.details.kind === 'Deployment') evidence.append(row('Available replicas', `${result.details.available} of ${result.details.desired}`));
    if (result.details.kind === 'CronJob') {
      if (result.details.schedule) evidence.append(row('Schedule', result.details.schedule));
      if (typeof result.details.suspended === 'boolean') evidence.append(row('Suspended', result.details.suspended ? 'Yes' : 'No'));
      if (Number.isInteger(result.details.activeJobs)) evidence.append(row('Active jobs', String(result.details.activeJobs)));
      if (result.details.lastScheduleTime) evidence.append(row('Last scheduled', result.details.lastScheduleTime));
      if (result.details.lastSuccessfulTime) evidence.append(row('Last successful job', result.details.lastSuccessfulTime));
    }
    document.querySelector('[data-inspector-tab="overview"]').hidden = !evidence.children.length;
    if (!evidence.children.length) {
      evidence.textContent = 'No additional status beyond the summary was reported.';
      showInspectorTab('events');
    }
    const events = $('resource-events');
    events.replaceChildren();
    document.querySelector('[data-inspector-tab="events"]').hidden = !result.eventError && !result.events.length;
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
async function requestResourceInvestigation(target, version, summaryId) {
  resourceRequestVersion = version;
  showResourceCopilotStatus('Collecting local evidence and requesting a focused Copilot summary…', true);
  try {
    await api('ask-resource-copilot', target);
    if (version === resourceVersion) {
      const nextState = await api('state');
      if (version === resourceVersion) {
        setSummaryState(target, 'complete', summaryId);
        renderState(nextState);
        if ((nextState.resourceSummaries || []).some(item => sameTarget(item, target))) hideResourceCopilotStatus();
        else showResourceCopilotStatus('No Copilot summary was returned for this resource.');
      } else {
        setSummaryState(target, 'previous', summaryId);
      }
    }
  } catch (error) {
    setSummaryState(target, 'failed', summaryId);
    if (version === resourceVersion) showResourceCopilotStatus(`Copilot investigation could not be requested: ${error.message}`);
  } finally {
    if (version === resourceVersion) {
      $('resource-ai-spinner').hidden = true;
      $('resource-refresh').disabled = false;
      $('ask-resource-question').disabled = false;
    } else if (summaryStates.get(summaryKey(target))?.phase === 'loading') {
      setSummaryState(target, 'previous', summaryId);
    }
    if (resourceRequestVersion === version) resourceRequestVersion = 0;
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
  hideResourceCopilotStatus();
  resourceDetails = null;
  const version = ++resourceVersion;
  if (investigate) resourceRequestVersion = version;
  const summaryId = investigate ? setSummaryState(target, 'loading') : null;
  if (!investigate && summaryStates.get(summaryKey(target))?.phase !== 'failed') setSummaryState(target, 'previous');
  else if (!investigate) $('resource-scan-details').open = true;
  for (const tab of tabs) $(`panel-${tab}`).hidden = true;
  $('panel-events').hidden = true;
  $('panel-monitoring').hidden = true;
  $('investigation-tabs').hidden = true;
  $('namespace-controls').hidden = true;
  $('panel-resource').hidden = false;
  $('panel-resource').focus();
  $('resource-manual-controls').hidden = false;
  $('resource-refresh').hidden = false;
  $('resource-refresh').disabled = investigate;
  $('ask-resource-question').disabled = investigate;
  $('resource-title').textContent = `${target.kind} / ${target.name}`;
  $('resource-question').value = '';
  $('resource-question-status').textContent = '';
  $('resource-cluster').textContent = target.context;
  $('resource-namespace').textContent = target.namespace || 'Cluster-scoped';
  $('resource-phase-label').textContent = target.kind === 'CronJob' ? 'Schedule status' : 'State';
  $('resource-phase').textContent = 'Loading…';
  $('resource-pod-summary').hidden = true;
  $('resource-created').textContent = 'Loading…';
  $('resource-status').textContent = 'Loading resource…';
  $('resource-evidence').replaceChildren();
  $('resource-events').textContent = 'Loading events…';
  $('resource-related').replaceChildren();
  $('resource-scale').hidden = !(target.kind === 'Deployment' && state.editing);
  $('pod-log-section').hidden = target.kind !== 'Pod';
  $('describe-section').hidden = !investigableKinds.has(target.kind);
  $('logs-inspector-tab').hidden = target.kind !== 'Pod';
  document.querySelector('[data-inspector-tab="describe"]').hidden = !investigableKinds.has(target.kind);
  showInspectorTab('overview');
  $('previous').checked = false;
  $('log-target').textContent = 'Logs can contain sensitive data. Pending containers may not have logs yet.';
  $('logs').textContent = 'Not loaded.';
  $('describe-output').textContent = 'Not loaded.';
  logsLoaded = false;
  renderResourceIssues();
  if (investigate) {
    showResourceCopilotStatus('Loading evidence before requesting a Copilot summary…', true);
  }
  else if (manual) {
    if (summaryStates.get(summaryKey(target))?.phase === 'failed') showResourceCopilotStatus('The latest investigation failed. Refresh to try again.');
    else if (!(state.resourceSummaries || []).some(item => sameTarget(item, target))) showResourceCopilotStatus('Review the available findings below. They may predate the latest evidence.');
  }
  await loadResource(target, version);
  if (investigate && version === resourceVersion) await requestResourceInvestigation(target, version, summaryId);
  else if (investigate) setSummaryState(target, 'previous', summaryId);
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
  if (issue.kind !== 'Node' && state.namespace !== issue.namespace) {
    renderState(await api('select-namespace', { namespace: issue.namespace }));
    $('namespace').value = issue.namespace;
    clearTargetData();
    loadWorkloads().catch(error => message(error.message));
  }
  await openResource(issue, { investigate: true, manual: false });
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
async function loadResourceTypes() {
  const context = state.context;
  const version = ++explorerDiscoveryVersion;
  explorerVersion++;
  explorerTypes = [];
  explorerNames = [];
  $('explorer-type').disabled = true;
  setOptions($('explorer-type'), [], '', 'Loading resource types…');
  explorerStatus = 'Loading resource types…';
  renderExplorer();
  try {
    const types = await api('resource-types');
    if (context !== state.context || version !== explorerDiscoveryVersion) return;
    explorerTypes = types;
    $('explorer-type').replaceChildren(new Option('Select a resource type', ''));
    for (const type of types) $('explorer-type').add(new Option(`${type.resource} · ${type.namespaced ? 'Namespaced' : 'Cluster-scoped'}`, type.kind));
    if (types.some(type => type.kind === 'Pod')) $('explorer-type').value = 'Pod';
    renderKindShortcuts();
    $('explorer-type').disabled = !types.length;
    explorerStatus = types.some(type => type.kind === 'Pod')
      ? 'Pod is selected. Choose a namespace to browse pods.'
      : types.length ? 'Select a resource type.' : 'No listable resource types were discovered.';
    renderExplorer();
  } catch (error) {
    if (context === state.context && version === explorerDiscoveryVersion) {
      explorerStatus = 'Resource types could not be loaded. Refresh to try again.';
      renderExplorer();
    }
    throw error;
  }
}
function renderKindShortcuts() {
  const container = $('resource-kind-shortcuts');
  container.replaceChildren();
  for (const kind of commonExplorerKinds) {
    const type = explorerTypes.find(item => item.kind === kind);
    if (!type) continue;
    const button = document.createElement('button');
    button.className = 'secondary';
    button.classList.toggle('active', $('explorer-type').value === kind);
    button.textContent = kind === 'PersistentVolumeClaim' ? 'PVCs' : `${kind}s`;
    button.addEventListener('click', () => {
      $('explorer-type').value = kind;
      renderKindShortcuts();
      perform(loadExplorerNames);
    });
    container.append(button);
  }
}
async function loadExplorerNames() {
  const type = explorerTypes.find(item => item.kind === $('explorer-type').value);
  renderKindShortcuts();
  const context = state.context;
  const namespace = type?.namespaced ? state.namespace : '';
  const version = ++explorerVersion;
  explorerNames = [];
  if (!type || (type.namespaced && !namespace)) {
    explorerStatus = type ? 'Select a namespace to browse this resource type.' : 'Select a resource type.';
    renderExplorer();
    return;
  }
  explorerStatus = 'Loading resources…';
  renderExplorer();
  try {
    const names = await api('resource-names', { context, namespace, kind: type.kind });
    if (version !== explorerVersion || context !== state.context || (type.namespaced && namespace !== state.namespace)) return;
    explorerNames = names;
    explorerStatus = names.length ? `${names.length} ${names.length === 1 ? 'resource' : 'resources'} available.` : 'No resources found.';
    renderExplorer();
  } catch (error) {
    if (version === explorerVersion && context === state.context) {
      explorerStatus = 'Resources could not be loaded. Check permissions and try again.';
      renderExplorer();
    }
    throw error;
  }
}
function renderExplorer() {
  const query = $('explorer-filter').value.trim().toLowerCase();
  const names = explorerNames.filter(name => name.toLowerCase().includes(query));
  const type = explorerTypes.find(item => item.kind === $('explorer-type').value);
  const problemNames = new Set(findingGroups().filter(group =>
    (!state.namespace || group.target.namespace === state.namespace) &&
    (!type || group.target.kind === type.kind)
  ).flatMap(group => [...group.resources.values()].map(resource => resource.name)));
  const visibleNames = explorerProblemsOnly ? names.filter(name => problemNames.has(name)) : names;
  const select = $('explorer-select');
  const selected = select.value;
  setOptions(select, names, selected, 'Select a resource');
  select.disabled = !names.length;
  $('explorer-refresh').disabled = !type || (type.namespaced && !state.namespace);
  $('explorer-filter').disabled = !explorerNames.length;
  $('explorer-investigate').disabled = !select.value;
  $('explorer-status').textContent = explorerNames.length && !names.length ? 'No resources match this filter.' : explorerStatus;
  const grid = $('explorer-resource-grid');
  grid.replaceChildren();
  if (!type) {
    grid.textContent = 'Choose a resource type to browse.';
    grid.classList.add('empty');
    return;
  }
  grid.classList.toggle('empty', !names.length);
  if (!visibleNames.length) {
    grid.textContent = explorerProblemsOnly && names.length ? 'No problem resources match this type and search.' : explorerNames.length ? 'No resources match this search.' : 'No resources are available for this scope.';
    return;
  }
  const count = Math.min(visibleNames.length, 200);
  for (const name of visibleNames.slice(0, count)) {
    const button = document.createElement('button');
    button.className = 'resource-browser-card';
    if (problemNames.has(name)) button.classList.add('has-problem');
    const kind = document.createElement('span');
    kind.className = 'resource-kind';
    kind.textContent = type.kind;
    const title = document.createElement('strong');
    title.textContent = name;
    const scope = document.createElement('span');
    scope.className = 'resource-scope';
    scope.textContent = type.namespaced ? state.namespace : 'Cluster-scoped';
    const status = workloadsCache.find(item => item.kind === type.kind && item.name === name);
    if (status?.status) {
      const badge = document.createElement('span');
      badge.className = `resource-status-badge status-${String(status.status).toLowerCase().replace(/[^a-z]+/g, '-')}`;
      badge.textContent = status.status;
      button.append(kind, badge, title, scope);
    } else {
      button.append(kind, title, scope);
    }
    const action = document.createElement('span');
    action.className = 'resource-action';
    action.textContent = 'Open diagnosis →';
    button.append(action);
    button.addEventListener('click', () => perform(() => openResource({
      kind: type.kind, name, namespace: type.namespaced ? state.namespace : ''
    }, { manual: true })));
    grid.append(button);
  }
  if (visibleNames.length > count) {
    const more = document.createElement('p');
    more.className = 'hint';
    more.textContent = `${visibleNames.length - count} additional resources are hidden. Refine the search.`;
    grid.append(more);
  }
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
    button.addEventListener('click', () => perform(() => openResource({ ...item, namespace: state.namespace }, { manual: true })));
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
  explorerVersion++;
  explorerNames = [];
  explorerStatus = 'Select a resource type.';
  renderExplorer();
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
  const results = await Promise.allSettled([loadWorkloads(), loadEvents(), ...($('explorer-type').value ? [loadExplorerNames()] : [])]);
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
      scanErrors = [];
      scanResources = [];
      $('findings-filter').value = '';
      renderCombinedFindings();
      $('cluster-question').value = '';
      $('cluster-question-status').textContent = '';
      clearTargetData();
      showTab('overview');
    }
    $('namespace').disabled = true;
    showInvestigation();
    $('context').disabled = false;
    investigationVersion++;
    $('ai-progress').hidden = true;
    $('ai-spinner').hidden = true;
    $('ask-copilot').disabled = true;
    $('ask-copilot').hidden = true;
    clusterCopilotStatus = 'waiting';
    $('ai-status').textContent = '';
    const scan = scanIssues();
    const investigation = scan.then(
      result => result && state.context === context ? requestInvestigation(context, result.issues, result.errors) : undefined,
      error => state.context === context
        ? requestInvestigation(context, [], [`Cluster checks could not complete: ${error.message}`])
        : undefined
    );
    const results = await Promise.allSettled([
      loadNamespaces(), loadResourceTypes(), scan, investigation,
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
$('refresh-resource-types').addEventListener('click', () => perform(loadResourceTypes));
$('explorer-refresh').addEventListener('click', () => perform(loadExplorerNames));
$('explorer-type').addEventListener('change', () => perform(loadExplorerNames));
$('explorer-filter').addEventListener('input', renderExplorer);
$('explorer-select').addEventListener('change', renderExplorer);
$('explorer-investigate').addEventListener('click', () => perform(async () => {
  const type = explorerTypes.find(item => item.kind === $('explorer-type').value);
  const name = $('explorer-select').value;
  if (!type || !explorerNames.includes(name)) throw new Error('Select an available resource first.');
  await openResource({ kind: type.kind, name, namespace: type.namespaced ? state.namespace : '' }, { manual: true });
}));
$('refresh-namespaced-inventory').addEventListener('click', () => perform(async () => {
  if ($('explorer-type').value) await loadExplorerNames();
  if (state.namespace) await loadWorkloads();
}));
$('explorer-problems-toggle').addEventListener('click', () => {
  explorerProblemsOnly = !explorerProblemsOnly;
  $('explorer-problems-toggle').setAttribute('aria-pressed', String(explorerProblemsOnly));
  $('explorer-problems-toggle').classList.toggle('active', explorerProblemsOnly);
  renderExplorer();
});
$('scan').addEventListener('click', () => perform(scanIssues));
$('findings-filter').addEventListener('input', () => { scanLimit = 100; renderScanIssues(); });
$('show-more-issues').addEventListener('click', () => { scanLimit += 100; renderScanIssues(); });
async function requestInvestigation(context, findings = scanCache, errors = scanErrors) {
  const version = ++investigationVersion;
  const groupedFindings = groupFindings(findings, [], scanResources);
  clusterCopilotStatus = 'running';
  copilotReviewCount = groupedFindings.length;
  $('ai-progress').hidden = false;
  $('ai-spinner').hidden = false;
  if (!errors.length && $('scan-spinner').hidden && $('scan-result-icon').textContent === '✓') {
    $('scan-progress').hidden = true;
  }
  $('ask-copilot').hidden = true;
  $('ask-copilot').disabled = true;
  const coverage = groupedFindings.length > 100 ? ` Reviewing the first 100 of ${groupedFindings.length} grouped findings.` : '';
  $('ai-status').textContent = `Copilot is enriching the findings…${coverage}`;
  try {
    const signals = groupedFindings.slice(0, 100).map(group => {
      const evidence = [`${group.signals.length} signals across ${group.resources.size} related resources.`];
      let included = 0;
      for (const signal of group.signals.slice(0, 8)) {
        const line = `${signal.target.kind} ${signal.target.name}: ${signal.title}. ${signal.evidence.join(' ')}`;
        if ([...evidence, line].join('\n').length > 930) break;
        evidence.push(line);
        included++;
      }
      const remaining = group.signals.length - included;
      if (remaining > 0) evidence.push(`${remaining} additional related signals omitted from this summary.`);
      return {
        title: `${group.target.kind} ${group.target.name}: ${group.signals.length} grouped signals`.slice(0, 500),
        evidence: evidence.join('\n'),
        next: [...new Set(group.signals.flatMap(signal => signal.next))].slice(0, 3).join(' ').slice(0, 1000) || 'Review the supporting signals and confirm their scope before making changes.',
        kind: group.target.kind,
        name: group.target.name.slice(0, 253),
        namespace: group.target.namespace.slice(0, 253)
      };
    });
    await api('ask-copilot', { context, findings: signals, scanErrors: errors.slice(0, 20).map(error => error.slice(0, 500)) });
    if (state.context === context && version === investigationVersion) {
      const nextState = await api('state');
      if (state.context !== context || version !== investigationVersion) return;
      renderState(nextState);
      clusterCopilotStatus = 'complete';
      renderOverviewCopilotStatus();
    }
  } catch (error) {
    if (state.context === context && version === investigationVersion) {
      const timedOut = /timeout|timed out/i.test(error.message);
      clusterCopilotStatus = timedOut ? 'uncertain' : 'error';
      $('ai-status').textContent = timedOut
        ? 'Copilot did not finish in time. The review may still be running.'
        : `Copilot investigation could not be completed: ${error.message}`;
    }
  } finally {
    if (version === investigationVersion) {
      $('ai-spinner').hidden = true;
      $('scan-progress').hidden = false;
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
  if (resource) {
    resourceRequestVersion = version;
    $('resource-refresh').disabled = true;
    showResourceCopilotStatus('Collecting evidence and waiting for Copilot…', true);
  }
  status.textContent = resource ? '' : 'Sending to Copilot…';
  try {
    await api('ask-manual-copilot', { ...target, question });
    if (state.context === target.context && (!resource || version === resourceVersion)) {
      const nextState = await api('state');
      if (state.context !== target.context || (resource && version !== resourceVersion)) return;
      renderState(nextState);
      if (resource) hideResourceCopilotStatus();
      input.value = '';
      status.textContent = '';
    }
  } catch (error) {
    if (state.context === target.context && (!resource || version === resourceVersion)) status.textContent = `Could not send to Copilot: ${error.message}`;
    if (resource && version === resourceVersion) showResourceCopilotStatus('The latest Copilot question could not be completed.');
  } finally {
    if (!resource || version === resourceVersion) {
      button.disabled = false;
      if (resource) {
        $('resource-refresh').disabled = false;
        $('resource-ai-spinner').hidden = true;
      }
    }
    if (resource && resourceRequestVersion === version) resourceRequestVersion = 0;
  }
}
function renderConversation(id, target) {
  const container = $(id);
  container.replaceChildren();
  const conversation = (state.conversations || []).find(item => item.context === state.context &&
    item.kind === (target?.kind || '') && item.name === (target?.name || '') &&
    item.namespace === (target?.namespace || ''));
  for (const message of conversation?.messages || []) {
    const article = document.createElement('article');
    article.className = `conversation-message ${message.role}`;
    const heading = document.createElement('strong');
    heading.textContent = message.role === 'user' ? 'You' : 'Copilot';
    const content = document.createElement('div');
    if (message.role === 'assistant') renderSummary(content, message.content);
    else content.textContent = message.content;
    article.append(heading, content);
    container.append(article);
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
    investigate: true
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
