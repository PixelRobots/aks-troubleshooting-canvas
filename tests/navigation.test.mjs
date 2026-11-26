import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

test('cluster picker opens the investigation and switching clusters resets editing', async () => {
  const elements = new Map();
  function element(id = '') {
    if (elements.has(id)) return elements.get(id);
    const node = {
      id, value: '', hidden: false, disabled: false, textContent: '', children: [], attributes: {},
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
  const backend = { context: '', namespace: '', aiIssues: [], editing: false };
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
  let partialScan = false;
  const respond = (route, body) => {
    if (route === 'state' || route === 'select-context' || route === 'select-namespace' || route === 'editing') return { ...backend };
    if (route === 'contexts') return ['east', 'west'];
    if (route === 'namespaces') return ['shop'];
    if (route === 'workloads') return [
      { kind: 'Deployment', name: 'checkout', status: '1/1 ready' },
      { kind: 'Pod', name: 'checkout-123', status: 'Running', restarts: 0 }
    ];
    if (route === 'events') return [];
    if (route === 'ask-copilot') return { sent: true };
    if (route === 'ask-resource-copilot') return { sent: true };
    if (route === 'ask-manual-copilot') return { sent: true };
    if (route === 'resource') return {
      details: { kind: body.kind, name: body.name, namespace: body.namespace, phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable' }], containers: [], related: [{ kind: 'SecretProviderClass', name: 'vault' }] },
      events: [{ type: 'Warning', reason: 'FailedMount', message: 'Mount failed' }]
    };
    if (route === 'scan') return { context: backend.context, issues: Array.from({ length: 130 }, (_, i) => ({
      title: `Signal ${i}`, evidence: 'Evidence', next: 'Inspect', docs: [],
      kind: 'Pod', name: i === 0 ? 'checkout-123' : `pod-${i}`, namespace: 'shop'
    })), errors: partialScan ? ['Nodes: Forbidden'] : [] };
    throw new Error(`Unexpected request: ${route}`);
  };
  const source = await readFile(new URL('../extensions/aks-canvas/ui/app.js', import.meta.url), 'utf8');
  runInNewContext(source, {
    document: {
      getElementById: element,
      querySelector: () => ({ content: 'token' }),
      createElement: () => element()
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
        }
        backend.context = body.context;
      }
      if (route === 'select-namespace') backend.namespace = body.namespace;
      if (route === 'editing') backend.editing = body.enabled;
      if (route === 'ask-copilot') {
        investigations.push(body.context);
        investigationRequests.push(body);
      }
      if (route === 'ask-resource-copilot') resourceInvestigations.push(body);
      if (route === 'ask-manual-copilot') manualInvestigations.push(body);
      if (route === 'scan') scans++;
      if (route === 'scan' && delayFirstScan) {
        delayFirstScan = false;
        await firstScan;
      }
      if (route === 'ask-copilot' && delayFirstInvestigation) {
        delayFirstInvestigation = false;
        await firstInvestigation;
      }
      if (route === 'ask-copilot' && failInvestigation) {
        return { ok: false, json: async () => ({ error: 'Timeout waiting for response' }) };
      }
      if (route === 'scan' && failScan) {
        return { ok: false, json: async () => ({ error: 'Scan unavailable' }) };
      }
      if (route === 'workloads' && failWorkloads) {
        return { ok: false, json: async () => ({ error: 'Workloads forbidden' }) };
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
  assert.equal(element('scan-result-icon').hidden, true);
  assert.equal(element('overview-title').textContent, 'Checking cluster…');
  assert.equal(element('scan').hidden, true);
  assert.match(element('scan-status').textContent, /Scanning/);
  assert.equal(element('scan').disabled, true);
  assert.equal(element('ai-spinner').hidden, false);
  assert.equal(element('ask-copilot').hidden, true);
  assert.match(element('ai-status').textContent, /Waiting for cluster checks/);
  assert.equal(element('ask-copilot').disabled, true);
  releaseScan();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element('scan-spinner').hidden, true);
  assert.equal(element('scan-result-icon').hidden, false);
  assert.equal(element('scan-result-icon').textContent, '✓');
  assert.match(element('scan-result-icon').className, /success/);
  assert.equal(element('overview-title').textContent, 'Cluster findings');
  assert.equal(element('scan').hidden, false);
  assert.equal(element('ai-spinner').hidden, false);
  assert.match(element('ai-status').textContent, /investigating/);
  assert.equal(investigationRequests[0].findings.length, 100);
  assert.equal(investigationRequests[0].findings[0].name, 'checkout-123');
  assert.deepEqual(investigationRequests[0].scanErrors, []);
  assert.equal(element('cluster-findings').hidden, false);
  const pendingIssue = element('issues').children[0];
  await pendingIssue.children[4].children[0].click();
  assert.match(element('resource-ai-status').textContent, /Copilot is checking the scan findings/);
  assert.equal(element('resource-ai-spinner').hidden, false);
  assert.equal(element('resource-manual-controls').hidden, true);
  assert.equal(element('resource-refresh').hidden, true);
  assert.equal(resourceInvestigations.length, 0);
  releaseInvestigation();
  await selecting;
  assert.equal(element('ai-spinner').hidden, true);
  assert.equal(element('ask-copilot').hidden, false);
  assert.match(element('ai-status').textContent, /finished/);
  backend.aiIssues = [{
    title: 'Copilot-improved finding', evidence: 'Copilot evidence', next: 'Review the recovery path',
    docs: [], kind: 'Pod', name: 'checkout-123', namespace: 'shop'
  }];
  pollState();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element('resource-issues').children[0].children[0].children[0].textContent, 'Copilot-improved finding');
  assert.match(element('resource-ai-status').textContent, /matching result is shown below/);
  await element('resource-back').click();
  failInvestigation = true;
  await element('ask-copilot').click();
  assert.equal(element('ai-spinner').hidden, true);
  assert.match(element('ai-status').textContent, /may still be working/);
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
  assert.equal(actionableIssue.children[0].children.length, 1);
  assert.equal(actionableIssue.children[1].textContent, 'Namespace: shop');
  assert.equal(actionableIssue.children[3].children[0].textContent, 'Suggested checks');
  assert.equal(actionableIssue.children[3].children[1].textContent, 'Next step: Inspect');
  assert.equal(actionableIssue.children[4].children[0].textContent, 'Investigate resource');
  assert.equal(element('issues').children[1].children[3].children[1].textContent, 'Next step: Inspect');
  assert.equal(element('show-more-issues').hidden, false);
  element('tab-workloads').click();
  element('show-more-issues').click();
  assert.equal(element('issues').children.length, 130);
  assert.equal(element('show-more-issues').hidden, true);
  element('findings-filter').value = 'CHECKOUT';
  element('findings-filter').input();
  assert.equal(element('issues').children.length, 1);
  assert.equal(element('findings-filter-status').textContent, '1 of 130 signals match.');
  element('findings-filter').value = 'not-a-resource';
  element('findings-filter').input();
  assert.equal(element('issues').textContent, 'No cluster checks match this filter.');
  assert.match(element('scan-status').textContent, /130 signals found/);
  element('findings-filter').value = '';
  element('findings-filter').input();
  assert.equal(element('issues').children.length, 100);
  assert.equal(element('show-more-issues').hidden, false);
  failScan = true;
  await element('scan').click();
  assert.equal(element('scan-spinner').hidden, true);
  assert.equal(element('scan').disabled, false);
  assert.equal(element('scan').hidden, false);
  assert.equal(element('overview-title').textContent, 'Cluster findings');
  assert.equal(element('cluster-findings').hidden, true);
  assert.equal(element('scan-result-icon').textContent, '!');
  assert.match(element('scan-status').textContent, /Scan unavailable/);
  failScan = false;
  partialScan = true;
  await element('scan').click();
  assert.equal(element('scan-result-icon').textContent, '!');
  assert.match(element('scan-status').textContent, /incomplete.*Forbidden/);
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
  await element('ask-cluster-question').click();
  assert.match(element('cluster-question-status').textContent, /Enter a question/);
  element('cluster-question').value = 'Why are pods pending?';
  await element('ask-cluster-question').click();
  assert.deepEqual(manualInvestigations[0], { context: 'east', question: 'Why are pods pending?' });
  assert.match(element('cluster-question-status').textContent, /Sent to Copilot/);

  backend.aiIssues = [{ title: 'Copilot signal', evidence: 'Observed', next: 'Review', docs: [], kind: 'Pod', name: 'other', namespace: 'shop' }];
  const scansBeforeNamespaceSelection = scans;
  element('namespace').value = 'shop';
  await element('namespace').change();
  assert.equal(scans, scansBeforeNamespaceSelection);
  assert.equal(element('refresh').disabled, false);
  assert.equal(element('panel-workloads').hidden, false);
  assert.equal(element('copilot-findings').hidden, false);
  assert.equal(element('ai-issues').children[0].children[0].children.length, 1);
  assert.equal(element('ai-issues').children[0].children[1].textContent, 'Namespace: shop');
  assert.equal(element('namespace-issues').children[0].children[0].children[1].textContent, 'Copilot finding');
  assert.equal(element('namespace-issues').children[1].children[0].children[1].textContent, 'Automated check');
  const existingCard = element('namespace-issues').children[1];
  pollState();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element('namespace-issues').children[1], existingCard);
  assert.deepEqual(investigations, ['east', 'east']);
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
  assert.equal(element('resource-events').children.length, 1);
  assert.equal(element('resource-cluster').textContent, 'east');
  assert.equal(element('resource-namespace').textContent, 'shop');
  assert.equal(element('resource-phase').textContent, 'Pending');
  assert.equal(element('resource-related').children[0].children[0].textContent, 'SecretProviderClass');
  assert.equal(element('resource-related').children[0].children[1].textContent, 'vault');
  assert.equal(resourceInvestigations[0].name, 'checkout-123');
  element('resource-question').value = 'Why is this pod pending?';
  await element('ask-resource-question').click();
  assert.deepEqual(manualInvestigations[1], { context: 'east', namespace: 'shop', kind: 'Pod', name: 'checkout-123', question: 'Why is this pod pending?' });
  assert.match(element('resource-question-status').textContent, /Sent to Copilot/);
  await element('resource-refresh').click();
  assert.equal(resourceInvestigations.length, 2);
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
  await element('change-cluster').click();
  assert.equal(element('cluster-picker').hidden, false);
  assert.equal(element('investigation').hidden, true);
  assert.equal(backend.editing, false);

  element('context').value = 'west';
  await element('context').change();
  assert.deepEqual(investigations, ['east', 'east', 'west']);
  assert.equal(element('cluster-title').textContent, 'west');
  assert.equal(backend.namespace, '');
  assert.equal(element('investigation').hidden, false);
});
