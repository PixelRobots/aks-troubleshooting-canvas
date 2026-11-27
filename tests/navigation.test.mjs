import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { groupFindings } from '../extensions/aks-canvas/finding-groups.mjs';

test('cluster picker opens the investigation and switching clusters resets editing', async () => {
  const elements = new Map();
  function element(id = '', tag = 'div') {
    if (elements.has(id)) return elements.get(id);
    const node = {
      id, tagName: tag.toUpperCase(), value: '', hidden: false, disabled: false, textContent: '', children: [], attributes: {},
      classList: { toggle() {}, add() {}, remove() {} },
      setAttribute(name, value) { this.attributes[name] = value; },
      focus() {},
      showModal() { this.open = true; },
      close() { this.open = false; },
      addEventListener(name, callback) { this[name] = callback; },
      replaceChildren(...children) { this.children = children; },
      add(child) { this.children.push(child); },
      append(...children) { this.children.push(...children); },
      removeAttribute() {}
    };
    if (id) elements.set(id, node);
    return node;
  }
  const textOf = node => node.textContent + node.children.map(textOf).join('');
  const backend = { context: '', namespace: '', aiIssues: [], resourceSummaries: [], conversations: [], editing: false };
  const investigations = [];
  const investigationRequests = [];
  const resourceInvestigations = [];
  const manualInvestigations = [];
  let scans = 0;
  let pollState;
  let releaseScan;
  let releaseInvestigation;
  const firstScan = new Promise(resolve => { releaseScan = resolve; });
  const firstInvestigation = new Promise(resolve => { releaseInvestigation = resolve; });
  let delayFirstScan = true;
  let delayFirstInvestigation = true;
  let failInvestigation = false;
  let failScan = false;
  let failWorkloads = false;
  let failResourceRead = false;
  let partialScan = false;
  let laterInvestigation;
  let groupedScan = false;
  let groupedSetKind = '';
  let longGroupedScan = false;
  let resourceDelay;
  let resourceQuestionDelay;
  let failResource = false;
  let customResourceSummary;
  const respond = (route, body) => {
    if (route === 'state' || route === 'select-context' || route === 'select-namespace' || route === 'editing') return { ...backend };
    if (route === 'contexts') return ['east', 'west'];
    if (route === 'namespaces') return ['shop'];
    if (route === 'resource-types') return [
      { resource: 'pods', kind: 'Pod', namespaced: true },
      { resource: 'widgets.example.io', kind: 'widgets.example.io', namespaced: true },
      { resource: 'clusterwidgets.example.io', kind: 'clusterwidgets.example.io', namespaced: false }
    ];
    if (route === 'resource-names') return body.kind === 'Pod' ? ['checkout-123'] : ['sample'];
    if (route === 'workloads') return [
      { kind: 'Deployment', name: 'checkout', status: '1/1 ready' },
      { kind: 'Pod', name: 'checkout-123', status: 'Running', restarts: 0 }
    ];
    if (route === 'events') return [];
    if (route === 'ask-copilot') return { sent: true };
    if (route === 'ask-resource-copilot') return { sent: true };
    if (route === 'ask-manual-copilot') return { sent: true };
    if (route === 'resource') return {
      details: body.kind === 'CronJob'
        ? { kind: body.kind, name: body.name, namespace: body.namespace, schedule: '0 1 * * *', suspended: false, activeJobs: 2, lastScheduleTime: '2026-01-02T01:00:00Z', conditions: [], containers: [], related: [] }
        : { kind: body.kind, name: body.name, namespace: body.namespace, phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable' }], containers: [], related: body.name === 'backup-d' || body.name === 'worker' || body.name.startsWith('worker-') || body.kind === 'SecretProviderClass' ? [] : body.name === 'backup-job-a' ? [{ kind: 'CronJob', name: 'backup' }] : body.name === 'backup-a' ? [{ kind: 'Job', name: 'backup-job-a' }, { kind: 'SecretProviderClass', name: 'vault' }] : [{ kind: 'SecretProviderClass', name: body.name === 'backup-c' ? 'other-vault' : 'vault' }] },
      events: [{ type: 'Warning', reason: 'FailedMount', message: 'Mount failed' }]
    };
    if (route === 'scan' && longGroupedScan) {
      const pods = Array.from({ length: 10 }, (_, index) => ({
        kind: 'Pod', name: `pod-${index}-${'x'.repeat(65)}`, namespace: 'shop', status: 'Pending',
        owners: [{ kind: 'Deployment', name: 'large-group' }]
      }));
      return {
        context: backend.context, errors: [], resources: pods,
        issues: pods.map(pod => ({
          ...pod, title: `Pod ${pod.name}: Pending`, evidence: 'Long evidence. '.repeat(12), next: 'Inspect pod.', docs: []
        }))
      };
    }
    if (route === 'scan' && groupedSetKind) return {
      context: backend.context, errors: [],
      resources: ['a', 'b'].map(suffix => ({
        kind: 'Pod', name: `worker-${suffix}`, namespace: 'shop', status: 'Pending',
        owners: [{ kind: groupedSetKind, name: 'worker' }],
        references: [{ kind: 'SecretProviderClass', name: 'shared-vault' },
          ...(suffix === 'b' ? [{ kind: 'PersistentVolumeClaim', name: 'data-b' }] : [])]
      })),
      issues: ['a', 'b'].map(suffix => ({
        kind: 'Pod', name: `worker-${suffix}`, namespace: 'shop', title: `Pod worker-${suffix}: Pending`,
        evidence: 'Current pod state: Pending.', next: 'Review pod events.', docs: []
      }))
    };
    if (route === 'scan' && groupedScan) return {
      context: backend.context, errors: [],
      resources: [
        { kind: 'Pod', name: 'backup-a', namespace: 'shop', status: 'Pending', owners: [{ kind: 'Job', name: 'backup-job-a' }], references: [{ kind: 'SecretProviderClass', name: 'vault' }, { kind: 'PersistentVolumeClaim', name: 'data' }] },
        { kind: 'Job', name: 'backup-job-a', namespace: 'shop', owners: [{ kind: 'CronJob', name: 'backup' }] },
        { kind: 'Pod', name: 'backup-b', namespace: 'shop', status: 'Pending', owners: [{ kind: 'Job', name: 'backup-job-b' }], references: [{ kind: 'SecretProviderClass', name: 'vault' }] },
        { kind: 'Job', name: 'backup-job-b', namespace: 'shop', owners: [{ kind: 'CronJob', name: 'backup' }] },
        { kind: 'Pod', name: 'backup-c', namespace: 'shop', status: 'Pending', owners: [{ kind: 'Job', name: 'backup-job-c' }], references: [{ kind: 'SecretProviderClass', name: 'other-vault' }] },
        { kind: 'Job', name: 'backup-job-c', namespace: 'shop', owners: [{ kind: 'CronJob', name: 'backup' }] },
        { kind: 'Pod', name: 'backup-d', namespace: 'shop', status: 'Pending', owners: [{ kind: 'Job', name: 'backup-job-d' }], references: [] },
        { kind: 'Job', name: 'backup-job-d', namespace: 'shop', owners: [{ kind: 'CronJob', name: 'backup' }] },
        { kind: 'Pod', name: 'unrelated', namespace: 'other', status: 'Pending', owners: [{ kind: 'Job', name: 'backup-job-a' }], references: [{ kind: 'SecretProviderClass', name: 'unrelated-vault' }] }
      ],
      issues: [
        ...['a', 'b', 'c', 'd'].map(suffix => ({
          kind: 'Pod', name: `backup-${suffix}`, namespace: 'shop', title: `Pod backup-${suffix}: ${suffix === 'd' ? 'ImagePullBackOff' : 'Pending'}`,
          evidence: suffix === 'c' ? 'Different evidence' : 'Shared evidence', next: 'Check pod',
          docs: [suffix === 'b' ? 'https://learn.microsoft.com/' : 'https://kubernetes.io/docs/']
        })),
        { kind: 'Pod', name: 'backup-d', namespace: 'shop', title: 'Pod backup-d: Pending',
          evidence: 'Shared evidence', next: 'Different next step', docs: [] }
      ]
    };
    if (route === 'scan') return { context: backend.context, resources: [], issues: Array.from({ length: 130 }, (_, i) => ({
      title: `Signal ${i}`, evidence: 'Evidence', next: 'Inspect',
      docs: i === 0 ? ['https://kubernetes.io/docs/'] : [],
      kind: i === 129 ? 'Node' : 'Pod', name: i === 0 ? 'checkout-123' : `pod-${i}`, namespace: i === 129 ? '' : 'shop'
    })), errors: partialScan ? ['Nodes: Forbidden'] : [] };
    throw new Error(`Unexpected request: ${route}`);
  };
  const source = (await readFile(new URL('../extensions/aks-canvas/ui/app.js', import.meta.url), 'utf8'))
    .replace("import { groupFindings } from '../finding-groups.mjs';", '');
  runInNewContext(source, {
    groupFindings,
    document: {
      getElementById: element,
      querySelector: selector => selector.includes('meta[name=')
        ? { content: 'token' }
        : element(selector.replace(/^\[data-inspector-(?:tab|panel)="([^"]+)"\]$/, 'inspector-$1')),
      createElement: tag => element('', tag)
    },
    Option: function (text, value) { this.text = text; this.value = value; },
    URL,
    setInterval(callback) { pollState = callback; },
    window: { confirm: () => true },
    fetch: async (url, options) => {
      const route = url.split('/').pop();
      const body = JSON.parse(options.body);
      if (route === 'select-context') {
        if (backend.context !== body.context) {
          backend.namespace = '';
          backend.editing = false;
          backend.aiIssues = [];
          backend.resourceSummaries = [];
          backend.conversations = [];
        }
        backend.context = body.context;
      }
      if (route === 'select-namespace') backend.namespace = body.namespace;
      if (route === 'editing') backend.editing = body.enabled;
      if (route === 'ask-copilot') {
        investigations.push(body.context);
        investigationRequests.push(body);
      }
      if (route === 'ask-resource-copilot') {
        resourceInvestigations.push(body);
        if (resourceDelay) await resourceDelay;
        if (failResource) return { ok: false, json: async () => ({ error: 'Investigation unavailable' }) };
        backend.resourceSummaries = backend.resourceSummaries.filter(item =>
          item.kind !== body.kind || item.name !== body.name || item.namespace !== body.namespace);
        backend.resourceSummaries.push({ kind: body.kind, name: body.name, namespace: body.namespace, summary: customResourceSummary || `Full Copilot summary for ${body.name}` });
      }
      if (route === 'ask-manual-copilot') {
        manualInvestigations.push(body);
        if (body.kind && resourceQuestionDelay) await resourceQuestionDelay;
        const conversation = { context: body.context, kind: body.kind || '', name: body.name || '', namespace: body.namespace || '',
          messages: [{ role: 'user', content: body.question }, { role: 'assistant', content: 'Full answer to the question' }] };
        backend.conversations = backend.conversations.filter(item =>
          item.context !== conversation.context || item.kind !== conversation.kind || item.name !== conversation.name || item.namespace !== conversation.namespace);
        backend.conversations.push(conversation);
      }
      if (route === 'scan') scans++;
      if (route === 'scan' && delayFirstScan) {
        delayFirstScan = false;
        await firstScan;
      }
      if (route === 'ask-copilot' && delayFirstInvestigation) {
        delayFirstInvestigation = false;
        await firstInvestigation;
      }
      if (route === 'ask-copilot' && laterInvestigation) await laterInvestigation;
      if (route === 'ask-copilot' && failInvestigation) {
        return { ok: false, json: async () => ({ error: 'Timeout waiting for response' }) };
      }
      if (route === 'scan' && failScan) {
        return { ok: false, json: async () => ({ error: 'Scan unavailable' }) };
      }
      if (route === 'workloads' && failWorkloads) {
        return { ok: false, json: async () => ({ error: 'Workloads forbidden' }) };
      }
      if (route === 'resource' && failResourceRead) {
        return { ok: false, json: async () => ({ error: 'Resource forbidden' }) };
      }
      const result = respond(route, body);
      return { ok: true, json: async () => result };
    }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element('cluster-picker').hidden, false);
  assert.equal(element('investigation').hidden, true, element('status').textContent);

  element('context').value = 'east';
  const selecting = element('context').change();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element('scan-spinner').hidden, false);
  assert.equal(element('scan-result-icon').hidden, true, element('status').textContent);
  assert.equal(element('overview-title').textContent, 'Checking cluster…');
  assert.equal(element('scan').hidden, true);
  assert.match(element('scan-status').textContent, /Scanning/);
  assert.equal(element('scan-progress').hidden, false);
  assert.equal(element('scan').disabled, true);
  assert.equal(element('ai-progress').hidden, true);
  assert.equal(element('ai-spinner').hidden, true);
  assert.equal(element('ask-copilot').hidden, true);
  assert.equal(element('ask-copilot').disabled, true);
  releaseScan();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element('scan-spinner').hidden, true);
  assert.equal(element('scan-result-icon').hidden, false);
  assert.equal(element('scan-result-icon').textContent, '✓');
  assert.match(element('scan-result-icon').className, /success/);
  assert.equal(element('overview-title').textContent, 'Findings');
  assert.equal(element('scan').hidden, false);
  assert.equal(element('scan-progress').hidden, true);
  assert.equal(element('ai-progress').hidden, false);
  assert.equal(element('ai-spinner').hidden, false);
  assert.match(element('ai-status').textContent, /enriching the findings/);
  assert.match(element('ai-status').textContent, /first 100 of 130 grouped findings/);
  assert.equal(investigationRequests[0].findings.length, 100);
  assert.equal(investigationRequests[0].findings[0].name, 'checkout-123');
  assert.deepEqual(investigationRequests[0].scanErrors, []);
  assert.equal(element('cluster-findings').hidden, false);
  const pendingIssue = element('issues').children[0];
  assert.equal(pendingIssue.children.length, 6);
  assert.equal(pendingIssue.children[5].children.length, 1);
  assert.equal(pendingIssue.children[5].children[0].textContent, 'Investigate resource');
  await pendingIssue.children[5].children[0].click();
  assert.equal(textOf(element('resource-summary')), 'Full Copilot summary for checkout-123', element('status').textContent);
  assert.equal(element('resource-scan-details').open, false);
  const resourceFinding = element('resource-scan-issues').children[0];
  assert.equal(resourceFinding.children[1].textContent, 'Evidence: Evidence');
  assert.equal(resourceFinding.children[2].textContent, 'Next step: Inspect');
  assert.equal(element('resource-scan-issues').children[1].children[0].href, 'https://kubernetes.io/docs/');
  assert.equal(element('resource-ai-progress').hidden, true);
  assert.equal(element('resource-ai-spinner').hidden, true);
  assert.equal(element('resource-manual-controls').hidden, false);
  assert.equal(element('resource-refresh').hidden, false);
  assert.equal(resourceInvestigations.length, 1);
  releaseInvestigation();
  await selecting;
  assert.equal(element('ai-spinner').hidden, true);
  assert.equal(element('scan-progress').hidden, false);
  assert.equal(element('ask-copilot').hidden, false);
  assert.equal(element('ai-progress').hidden, false);
  assert.match(element('ai-status').textContent, /first 100 of 130 grouped findings/);
  backend.aiIssues = [{
    title: 'Copilot-improved finding', evidence: 'Copilot evidence', next: 'Review the recovery path',
    docs: [], kind: 'Pod', name: 'checkout-123', namespace: 'shop'
  }];
  element('resource-scan-details').open = true;
  pollState();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element('resource-scan-details').open, true);
  assert.equal(element('ai-progress').hidden, false);
  assert.match(element('ai-status').textContent, /first 100 of 130 grouped findings/);
  const published = element('resource-issues').children[0];
  assert.equal(published.tagName, 'DETAILS');
  assert.equal(published.children[0].textContent, 'Published Copilot findings (1)');
  assert.equal(published.children[1].children[0].children[0].textContent, 'Copilot-improved finding');
  assert.equal(published.children[1].children[0].children[1].textContent, 'What we know: Copilot evidence');
  assert.equal(published.children[1].children[0].children[2].textContent, 'Suggested checks and fixes: Review the recovery path');
  assert.equal(element('resource-ai-progress').hidden, true);
  await element('resource-back').click();
  failInvestigation = true;
  await element('ask-copilot').click();
  assert.equal(element('ai-spinner').hidden, true);
  assert.equal(element('ai-progress').hidden, false);
  assert.match(element('ai-status').textContent, /may still be running/);
  failInvestigation = false;
  assert.equal(element('cluster-picker').hidden, true);
  assert.equal(element('investigation').hidden, false);
  assert.equal(element('cluster-title').textContent, 'east');
  assert.equal(element('panel-overview').hidden, false);
  assert.equal(element('namespace-controls').hidden, true);
  assert.equal(element('panel-workloads').hidden, true);
  assert.deepEqual(investigations, ['east', 'east']);
  assert.equal(element('issues').children.length, 100);
  const actionableIssue = element('issues').children[0];
  assert.equal(actionableIssue.children[0].textContent, 'Pod checkout-123: 2 findings');
  assert.equal(actionableIssue.children[1].textContent, 'Sources: Cluster check and Copilot');
  assert.equal(actionableIssue.children.length, 6);
  assert.equal(actionableIssue.children[5].children.length, 1);
  assert.equal(actionableIssue.children[5].children[0].textContent, 'Investigate resource');
  assert.equal(element('show-more-issues').hidden, false);
  element('tab-workloads').click();
  element('show-more-issues').click();
  assert.equal(element('issues').children.length, 130);
  assert.equal(element('show-more-issues').hidden, true);
  const nodeIssue = element('issues').children[129];
  await nodeIssue.children[4].children[0].click();
  assert.equal(element('resource-title').textContent, 'Node / pod-129');
  assert.equal(element('resource-namespace').textContent, 'Cluster-scoped');
  assert.equal(element('resource-manual-controls').hidden, false);
  assert.equal(resourceInvestigations.length, 2);
  await element('resource-back').click();
  element('findings-filter').value = 'CHECKOUT';
  element('findings-filter').input();
  assert.equal(element('issues').children.length, 1);
  assert.equal(element('findings-filter-status').textContent, '1 of 130 grouped findings match.');
  element('findings-filter').value = 'not-a-resource';
  element('findings-filter').input();
  assert.equal(element('issues').textContent, 'No findings match this filter.');
  assert.match(element('scan-status').textContent, /130 cluster signals grouped into 130 findings/);
  element('findings-filter').value = '';
  element('findings-filter').input();
  assert.equal(element('issues').children.length, 100);
  assert.equal(element('show-more-issues').hidden, false);
  failScan = true;
  await element('scan').click();
  assert.equal(element('scan-spinner').hidden, true);
  assert.equal(element('scan').disabled, false);
  assert.equal(element('scan').hidden, false);
  assert.equal(element('overview-title').textContent, 'Findings');
  assert.equal(element('cluster-findings').hidden, false);
  assert.equal(element('issues').children.length, 1);
  assert.equal(element('issues').children[0].children[1].textContent, 'Sources: Copilot');
  assert.equal(element('scan-result-icon').textContent, '!');
  assert.match(element('scan-status').textContent, /Scan unavailable/);
  let releaseLaterInvestigation;
  laterInvestigation = new Promise(resolve => { releaseLaterInvestigation = resolve; });
  const failedScanReview = element('ask-copilot').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element('scan-progress').hidden, false);
  assert.match(element('scan-status').textContent, /Scan unavailable/);
  releaseLaterInvestigation();
  await failedScanReview;
  laterInvestigation = null;
  failScan = false;
  partialScan = true;
  await element('scan').click();
  assert.equal(element('scan-result-icon').textContent, '!');
  assert.match(element('scan-status').textContent, /incomplete.*Forbidden/);
  laterInvestigation = new Promise(resolve => { releaseLaterInvestigation = resolve; });
  const partialReview = element('ask-copilot').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element('scan-progress').hidden, false);
  assert.equal(element('ai-progress').hidden, false);
  assert.match(element('scan-status').textContent, /incomplete.*Forbidden/);
  releaseLaterInvestigation();
  await partialReview;
  laterInvestigation = null;
  partialScan = false;
  await element('scan').click();
  element('tab-workloads').click();
  assert.equal(element('panel-overview').hidden, true);
  assert.equal(element('panel-workloads').hidden, false);
  assert.equal(element('namespace-controls').hidden, false);
  assert.equal(element('tab-workloads').attributes['aria-selected'], 'true');
  assert.equal(element('refresh').disabled, false);
  assert.equal(element('workload-select').disabled, false);
  assert.equal(element('investigate-workload').disabled, true);
  assert.equal(element('panel-events').hidden, false);
  assert.equal(element('panel-monitoring').hidden, false);
  element('explorer-type').value = 'clusterwidgets.example.io';
  await element('explorer-type').change();
  assert.match(element('explorer-status').textContent, /1 resource available/);
  assert.equal(element('explorer-resource-grid').children.length, 1);
  assert.equal(textOf(element('explorer-resource-grid').children[0]), 'clusterwidgets.example.iosampleCluster-scopedOpen diagnosis →');
  assert.equal(element('resource-kind-shortcuts').children.length, 1);
  element('explorer-filter').value = 'missing';
  element('explorer-filter').input();
  assert.match(element('explorer-status').textContent, /No resources match/);
  element('explorer-filter').value = '';
  element('explorer-filter').input();
  element('explorer-select').value = 'sample';
  element('explorer-select').change();
  await element('explorer-investigate').click();
  assert.equal(element('resource-namespace').textContent, 'Cluster-scoped');
  assert.equal(element('describe-section').hidden, true);
  assert.equal(resourceInvestigations.at(-1).kind, 'clusterwidgets.example.io');
  assert.equal(resourceInvestigations.at(-1).namespace, '');
  await element('resource-back').click();
  await element('ask-cluster-question').click();
  assert.match(element('cluster-question-status').textContent, /Enter a question/);
  element('cluster-question').value = 'Why are pods pending?';
  await element('ask-cluster-question').click();
  assert.deepEqual(manualInvestigations[0], { context: 'east', question: 'Why are pods pending?' });
  assert.match(textOf(element('cluster-conversation')), /Why are pods pending.*Full answer to the question/);

  backend.aiIssues = [{ title: 'Copilot signal', evidence: 'Observed', next: 'Review', docs: [], kind: 'Pod', name: 'other', namespace: 'shop' }];
  const scansBeforeNamespaceSelection = scans;
  element('namespace').value = 'shop';
  await element('namespace').change();
  assert.equal(scans, scansBeforeNamespaceSelection);
  assert.equal(element('refresh').disabled, false);
  assert.equal(element('panel-workloads').hidden, false);
  assert.equal(element('cluster-findings').hidden, false);
  assert.equal(element('issues').children.length, 100);
  assert.equal(element('issues').children[0].children[0].textContent, 'Pod other: 1 finding');
  assert.equal(element('namespace-issues').children.length, 130);
  const copilotCard = element('namespace-issues').children[0];
  assert.equal(copilotCard.children[0].textContent, 'Pod other: 1 finding');
  assert.equal(copilotCard.children[1].textContent, 'Sources: Copilot');
  const existingCard = element('namespace-issues').children[1];
  pollState();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element('namespace-issues').children[1], existingCard);
  assert.deepEqual(investigations, ['east', 'east', 'east', 'east']);
  assert.equal(element('workloads').children.length, 2);
  assert.equal(element('workload-select').disabled, false);
  assert.equal(element('workload-select').children.length, 3);
  assert.match(element('workload-status').textContent, /2 workloads available in shop/);
  element('workload-kind').value = 'Pod';
  element('workload-kind').change();
  assert.equal(element('workloads').children.length, 1);
  element('workload-select').value = JSON.stringify(['Pod', 'checkout-123']);
  element('workload-select').change();
  assert.equal(element('investigate-workload').disabled, false);
  element('workload-filter').value = 'missing';
  element('workload-filter').input();
  assert.equal(element('workloads').children.length, 0);
  assert.equal(element('investigate-workload').disabled, true);
  assert.match(element('workload-status').textContent, /No workloads match/);
  element('workload-filter').value = 'checkout';
  element('workload-filter').input();
  element('workload-select').value = JSON.stringify(['Pod', 'checkout-123']);
  element('workload-select').change();
  await element('investigate-workload').click();
  assert.equal(element('panel-resource').hidden, false);
  assert.equal(element('resource-manual-controls').hidden, false);
  assert.equal(element('resource-refresh').hidden, false);
  assert.equal(element('namespace-controls').hidden, true);
  assert.equal(element('panel-workloads').hidden, true);
  assert.equal(element('resource-title').textContent, 'Pod / checkout-123');
  assert.equal(element('resource-evidence').children.length, 1);
  assert.equal(element('resource-status').textContent, '');
  assert.equal(element('resource-events').children.length, 1);
  assert.equal(element('resource-cluster').textContent, 'east');
  assert.equal(element('resource-namespace').textContent, 'shop');
  assert.equal(element('resource-phase').textContent, 'Pending');
  assert.equal(element('resource-related').children[0].children[0].textContent, 'SecretProviderClass');
  assert.equal(element('resource-related').children[0].children[1].textContent, 'vault');
  assert.equal(resourceInvestigations.at(-1).name, 'checkout-123');
  element('resource-question').value = 'Why is this pod pending?';
  let releaseQuestion;
  resourceQuestionDelay = new Promise(resolve => { releaseQuestion = resolve; });
  const asking = element('ask-resource-question').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element('resource-summary-age').hidden, true);
  assert.equal(element('resource-scan-details').open, false);
  assert.equal(element('resource-refresh').disabled, true);
  assert.equal(element('resource-ai-spinner').hidden, false);
  assert.equal(element('resource-ai-progress').hidden, false);
  releaseQuestion();
  await asking;
  resourceQuestionDelay = null;
  assert.deepEqual(manualInvestigations[1], { context: 'east', namespace: 'shop', kind: 'Pod', name: 'checkout-123', question: 'Why is this pod pending?' });
  assert.equal(element('resource-question-status').textContent, '');
  assert.equal(element('resource-ai-progress').hidden, true);
  assert.match(textOf(element('resource-conversation')), /Why is this pod pending.*Full answer to the question/);
  assert.equal(element('resource-scan-details').open, false);
  let releaseResource;
  resourceDelay = new Promise(resolve => { releaseResource = resolve; });
  customResourceSummary = '## Observations\n**Pending** pod; see [guide](https://kubernetes.io/docs/).\n\n## Next steps\n1. Check `kubectl`.\n2. Review [unsafe](javascript:alert).\n\n<img src=x onerror=alert(1)>\n\nSUGGESTIONS: Show the SecretProviderClass | Show recent events for this pod';
  const refreshing = element('resource-refresh').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element('resource-summary-age').hidden, false);
  assert.match(element('resource-summary-age').textContent, /Previous summary.*updating/);
  assert.equal(element('resource-scan-details').open, true);
  assert.equal(element('resource-ai-progress').hidden, false);
  assert.equal(element('resource-refresh').disabled, true);
  assert.equal(element('ask-resource-question').disabled, true);
  releaseResource();
  await refreshing;
  resourceDelay = null;
  const summaryNodes = element('resource-summary').children;
  assert.equal(summaryNodes[0].tagName, 'H4');
  assert.equal(textOf(summaryNodes[0]), 'Observations');
  assert.equal(summaryNodes[1].children[0].tagName, 'STRONG');
  assert.equal(summaryNodes[1].children[2].tagName, 'A');
  assert.equal(summaryNodes[1].children[2].href, 'https://kubernetes.io/docs/');
  assert.equal(summaryNodes[2].tagName, 'H4');
  assert.equal(summaryNodes[3].tagName, 'OL');
  assert.equal(summaryNodes[3].children[1].value, 2);
  assert.equal(summaryNodes[3].children[0].children[1].tagName, 'CODE');
  assert.doesNotMatch(JSON.stringify(summaryNodes[3]), /"tagName":"A"/);
  assert.match(textOf(summaryNodes[4]), /<img src=x onerror=alert\(1\)>/);
  assert.doesNotMatch(JSON.stringify(summaryNodes[4]), /"tagName":"IMG"/);
  assert.equal(summaryNodes[5].className, 'suggestions');
  assert.equal(textOf(summaryNodes[5].children[1]), 'Show the SecretProviderClass');
  await summaryNodes[5].children[1].click();
  assert.equal(manualInvestigations.at(-1).question, 'Show the SecretProviderClass');
  assert.equal(element('resource-summary-age').hidden, true);
  assert.equal(element('resource-ai-progress').hidden, true);
  assert.equal(element('resource-scan-details').open, false);
  failResource = true;
  await element('resource-refresh').click();
  assert.equal(element('resource-summary-age').hidden, false);
  assert.match(element('resource-summary-age').textContent, /latest investigation failed/);
  assert.match(element('resource-ai-status').textContent, /Investigation unavailable/);
  assert.equal(element('resource-ai-progress').hidden, false);
  assert.equal(element('resource-scan-details').open, true);
  assert.equal(textOf(element('resource-summary').children[0]), 'Observations');
  failResource = false;
  customResourceSummary = null;
  assert.equal(resourceInvestigations.length, 6);
  await element('resource-back').click();
  assert.equal(element('panel-workloads').hidden, false);
  assert.equal(element('namespace-controls').hidden, false);
  element('workload-kind').value = 'Deployment';
  element('workload-kind').change();
  element('workload-select').value = JSON.stringify(['Deployment', 'checkout']);
  element('workload-select').change();
  await element('investigate-workload').click();
  assert.equal(element('resource-title').textContent, 'Deployment / checkout');
  assert.equal(resourceInvestigations.at(-1).kind, 'Deployment');
  assert.equal(resourceInvestigations.at(-1).namespace, 'shop');
  await element('resource-back').click();
  const investigationsBeforeBrowse = resourceInvestigations.length;
  await element('workloads').children[0].children[1].click();
  assert.equal(element('resource-manual-controls').hidden, false);
  element('resource-scan-details').open = false;
  assert.equal(resourceInvestigations.length, investigationsBeforeBrowse + 1);
  await element('resource-back').click();
  await element('refresh').click();
  assert.equal(element('workload-select').value, JSON.stringify(['Deployment', 'checkout']));
  assert.equal(element('investigate-workload').disabled, false);
  failWorkloads = true;
  await element('refresh').click();
  assert.equal(element('workload-select').disabled, true);
  assert.equal(element('investigate-workload').disabled, true);
  assert.match(element('workload-status').textContent, /could not be loaded/);
  assert.match(element('status').textContent, /Workloads forbidden/);
  failWorkloads = false;
  await element('refresh').click();
  assert.equal(element('workload-select').disabled, false);
  assert.equal(element('investigate-workload').disabled, true);
  element('tab-overview').click();
  assert.equal(element('namespace-controls').hidden, true);
  assert.equal(element('panel-events').hidden, true);
  assert.equal(element('panel-monitoring').hidden, true);
  let prevented = false;
  element('tab-overview').keydown({ key: 'ArrowRight', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(element('panel-workloads').hidden, false);
  await element('toggle-edit').click();
  assert.equal(backend.editing, false);
  assert.equal(element('edit-dialog').open, true);
  await element('confirm-edit').click();
  assert.equal(backend.editing, true);

  element('tab-overview').click();
  groupedScan = true;
  await element('scan').click();
  backend.aiIssues = [];
  pollState();
  await new Promise(resolve => setImmediate(resolve));
  await element('ask-copilot').click();
  assert.equal(element('ai-progress').hidden, false);
  assert.match(element('ai-status').textContent, /No resource-targeted Copilot findings are available/);
  backend.aiIssues = [{ title: 'General finding', evidence: 'Observed', next: 'Review', docs: [] }];
  pollState();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element('ai-progress').hidden, false);
  backend.aiIssues = [{
    kind: 'Pod', name: 'backup-a', namespace: 'shop', title: 'Pending a',
    evidence: 'Copilot interpretation', next: 'Inspect scheduling', docs: []
  }];
  pollState();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element('ai-progress').hidden, false);
  assert.match(element('ai-status').textContent, /AI summary review complete/);
  failInvestigation = true;
  await element('ask-copilot').click();
  assert.equal(element('ai-progress').hidden, false);
  assert.match(element('ai-status').textContent, /may still be running/);
  failInvestigation = false;
  const requestsBeforeGrouped = resourceInvestigations.length;
  await element('issues').children[0].children[5].children[0].click();
  assert.equal(element('resource-title').textContent, 'CronJob / backup');
  assert.equal(element('resource-phase-label').textContent, 'Schedule status');
  assert.equal(element('resource-phase').textContent, 'Not suspended');
  assert.equal(element('resource-pod-summary').hidden, false);
  assert.equal(element('resource-pod-phases').textContent, '4 Pending pods');
  assert.deepEqual(element('resource-evidence').children.map(row => row.children[0].children[0].textContent),
    ['Schedule', 'Suspended', 'Active jobs', 'Last scheduled']);
  const relatedFinding = element('resource-issues').children[0].children[1].children[0];
  assert.equal(relatedFinding.children[1].textContent, 'What we know: Copilot interpretation');
  assert.equal(relatedFinding.children[3].textContent, 'Related Pod: backup-a');
  const groupedSignals = element('resource-scan-issues').children;
  assert.equal(groupedSignals.length, 5);
  assert.equal(groupedSignals[0].children[0].textContent, '2 Pods: Pending');
  assert.equal(groupedSignals[0].children[1].textContent, 'Evidence: Shared evidence');
  assert.equal(groupedSignals[0].children[3].tagName, 'DETAILS');
  assert.equal(groupedSignals[0].children[3].children[0].textContent, 'View affected resources (2)');
  assert.equal(groupedSignals[1].children[0].textContent, 'Pod backup-c: Pending');
  assert.equal(groupedSignals[1].children[1].textContent, 'Evidence: Different evidence');
  assert.equal(groupedSignals[2].children[0].textContent, 'Pod backup-d: ImagePullBackOff');
  assert.equal(groupedSignals[3].children[0].textContent, 'Pod backup-d: Pending');
  assert.equal(groupedSignals[3].children[2].textContent, 'Next step: Different next step');
  assert.deepEqual(groupedSignals[4].children.map(link => link.href),
    ['https://kubernetes.io/docs/', 'https://learn.microsoft.com/']);
  assert.deepEqual(element('resource-related').children.map(button => button.children[1].textContent),
    ['vault', 'data', 'other-vault']);
  await element('resource-related').children[0].click();
  assert.equal(element('resource-title').textContent, 'SecretProviderClass / vault');
  assert.equal(resourceInvestigations.at(-1).name, 'vault');
  await element('resource-back').click();
  await groupedSignals[0].children[3].children[1].children[0].click();
  assert.equal(element('resource-title').textContent, 'Pod / backup-a');
  assert.equal(element('resource-phase-label').textContent, 'State');
  assert.equal(element('resource-pod-summary').hidden, true);
  assert.equal(element('resource-scan-issues').children[0].children[1].textContent, 'Evidence: Shared evidence');
  assert.equal(element('resource-scan-issues').children.length, 2);
  assert.deepEqual(element('resource-related').children.map(button => button.children[1].textContent),
    ['backup-job-a', 'vault', 'data']);
  assert.equal(resourceInvestigations.length, requestsBeforeGrouped + 3);
  await element('resource-related').children[0].click();
  assert.equal(element('resource-title').textContent, 'Job / backup-job-a');
  assert.equal(element('resource-scan-issues').children[0].children[1].textContent, 'Evidence: Shared evidence');
  assert.equal(element('resource-scan-issues').children.length, 2);
  assert.deepEqual(element('resource-related').children.map(button => button.children[1].textContent), ['backup', 'vault', 'data']);
  await element('resource-back').click();
  await element('resource-back').click();
  await element('resource-scan-issues').children[0].children[3].children[1].children[1].click();
  assert.equal(textOf(element('resource-summary')), 'Full Copilot summary for backup-b');
  assert.equal(element('resource-scan-issues').children[0].children[1].textContent, 'Evidence: Shared evidence');
  assert.equal(element('resource-scan-issues').children.length, 2);
  assert.deepEqual(element('resource-related').children.map(button => button.children[1].textContent), ['vault']);
  await element('resource-back').click();
  await element('resource-scan-issues').children[2].children[3].click();
  assert.equal(element('resource-title').textContent, 'Pod / backup-d');
  assert.equal(element('resource-related').children.length, 0);
  assert.equal(element('resource-related').textContent, 'No related resources needed investigation.');
  assert.equal(element('inspector-related').hidden, true);
  failResourceRead = true;
  await element('resource-refresh').click();
  assert.match(element('resource-status').textContent, /Resource could not be loaded: Resource forbidden/);
  failResourceRead = false;
  await element('resource-back').click();
  groupedScan = false;
  await element('resource-back').click();
  backend.aiIssues = [];
  pollState();
  await new Promise(resolve => setImmediate(resolve));
  for (const kind of ['DaemonSet', 'StatefulSet']) {
    groupedSetKind = kind;
    await element('scan').click();
    const card = element('issues').children[0];
    assert.equal(card.children[0].textContent, `${kind} worker: 2 findings`);
    await card.children.at(-1).children[0].click();
    assert.equal(element('resource-title').textContent, `${kind} / worker`);
    assert.equal(element('resource-pod-phases').textContent, '2 Pending pods');
    assert.equal(element('resource-scan-issues').children[0].children[0].textContent, '2 Pods: Pending');
    assert.deepEqual(element('resource-related').children.map(button => button.children[1].textContent),
      ['shared-vault', 'data-b']);
    await element('resource-scan-issues').children[0].children[3].children[1].children[0].click();
    assert.equal(element('resource-title').textContent, 'Pod / worker-a');
    assert.equal(element('resource-scan-issues').children.length, 1);
    assert.deepEqual(element('resource-related').children.map(button => button.children[1].textContent), ['shared-vault']);
    await element('resource-back').click();
    await element('resource-back').click();
  }
  groupedSetKind = '';
  longGroupedScan = true;
  await element('scan').click();
  await element('ask-copilot').click();
  const groupedEvidence = investigationRequests.at(-1).findings[0].evidence;
  const shown = (groupedEvidence.match(/\nPod /g) || []).length;
  const omitted = Number(groupedEvidence.match(/(\d+) additional related signals omitted from this summary\.$/)[1]);
  assert.ok(groupedEvidence.length <= 1000);
  assert.ok(shown > 0);
  assert.equal(shown + omitted, 10);
  longGroupedScan = false;
  await element('change-cluster').click();
  assert.equal(element('cluster-picker').hidden, false);
  assert.equal(element('investigation').hidden, true);
  assert.equal(backend.editing, false);

  element('context').value = 'west';
  await element('context').change();
  assert.deepEqual(investigations, ['east', 'east', 'east', 'east', 'east', 'east', 'east', 'west']);
  assert.equal(element('cluster-title').textContent, 'west');
  assert.equal(backend.namespace, '');
  assert.equal(element('investigation').hidden, false);
});
