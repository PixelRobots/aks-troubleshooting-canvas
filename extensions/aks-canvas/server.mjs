import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createKubernetes, validateResourceTarget } from './kubernetes.mjs';
import { detectIssues, detectWarningIssues, warningChecks } from './issues.mjs';
import { checkDeallocatedNodes } from './azure.mjs';

const assets = new URL('./ui/', import.meta.url);

const eventDetails = {
  FailedScheduling: [
    [/\binsufficient cpu\b/i, 'insufficient CPU'],
    [/\binsufficient memory\b/i, 'insufficient memory'],
    [/\binsufficient ephemeral-storage\b/i, 'insufficient ephemeral storage'],
    [/\buntolerated taint\b/i, 'an untolerated taint'],
    [/\b(?:didn.t match|did not match) pod(?:'s)? node (?:affinity|selector)\b/i, 'a node affinity or selector mismatch'],
    [/\bunbound immediate persistentvolumeclaims\b/i, 'unbound immediate PersistentVolumeClaims'],
    [/\btoo many pods\b/i, 'a pod capacity limit'],
    [/\bnode\(s\) were unschedulable\b/i, 'unschedulable nodes']
  ],
  FailedMount: [
    [/\b(?:secrets-store\.csi\.k8s\.io|secrets store csi driver)\b/i, 'the Secrets Store CSI driver'],
    [/\b(?:azure key vault|keyvault|vault\.azure\.net)\b/i, 'Azure Key Vault'],
    [/\bSecretNotFound\b/i, 'SecretNotFound'],
    [/\bSecretDisabled\b/i, 'SecretDisabled'],
    [/\bForbiddenByRbac\b/i, 'ForbiddenByRbac'],
    [/\bForbiddenByPolicy\b/i, 'ForbiddenByPolicy'],
    [/\b(?:forbidden|permission denied|access denied)\b/i, 'an access-denied indication'],
    [/\b(?:statuscode\s*[=:]\s*403|status(?:\s+code)?\s*[=:]\s*403|http\s+403)\b/i, 'HTTP status 403'],
    [/\b(?:statuscode\s*[=:]\s*404|status(?:\s+code)?\s*[=:]\s*404|http\s+404)\b/i, 'HTTP status 404'],
    [/\b(?:timed? out|deadline exceeded)\b/i, 'a timeout indication'],
    [/\bno such host\b/i, 'a DNS lookup failure indication']
  ],
  Failed: [
    [/\b(?:failed to pull image|errimagepull|imagepullbackoff)\b/i, 'an image-pull failure'],
    [/\b(?:unauthorized|authentication required|authentication failed)\b/i, 'an authentication failure indication'],
    [/\b(?:manifest unknown|manifest not found)\b/i, 'an image manifest not found indication'],
    [/\b(?:failed to create container|createcontainerconfigerror)\b/i, 'a container creation failure'],
    [/\b(?:configmap|secret) "[^"]+" not found\b/i, 'a referenced ConfigMap or Secret not found indication']
  ],
  Unhealthy: [
    [/\breadiness probe failed\b/i, 'a readiness probe failure'],
    [/\bliveness probe failed\b/i, 'a liveness probe failure'],
    [/\bstartup probe failed\b/i, 'a startup probe failure']
  ]
};

function summarizeResourceEvidence(details, events, eventError) {
  const signals = new Set();
  if (details.metadataOnly) signals.add('Only resource metadata was collected; configuration, status and health are unknown.');
  if (details.kind === 'Pod' && details.phase === 'Pending') signals.add('Pod phase is Pending.');
  if (details.kind === 'Deployment' && details.desired === 0) signals.add('The deployment has zero desired replicas; whether this is intentional is unknown.');
  if (details.kind === 'Deployment' && Number.isSafeInteger(details.desired) && details.desired >= 0 &&
      Number.isSafeInteger(details.available) && details.available >= 0) {
    signals.add(`The deployment reports ${details.available} available replicas and ${details.desired} desired replicas.`);
    if (details.available < details.desired) signals.add('The deployment has fewer available replicas than desired; a rollout may be in progress.');
  }
  if (details.kind === 'CronJob') {
    if (typeof details.suspended === 'boolean') signals.add(`The CronJob reports its schedule is ${details.suspended ? 'suspended' : 'not suspended'}.`);
    if (Number.isSafeInteger(details.activeJobs) && details.activeJobs >= 0) signals.add(`The CronJob reports ${details.activeJobs} active jobs.`);
    for (const [field, label] of [['lastScheduleTime', 'last scheduled'], ['lastSuccessfulTime', 'last successful']]) {
      const time = typeof details[field] === 'string' ? Date.parse(details[field]) : NaN;
      if (Number.isFinite(time)) signals.add(`The CronJob reports its ${label} time as ${new Date(time).toISOString()}; the timestamp is unverified.`);
    }
  }
  if (details.kind === 'Job') {
    for (const [field, label] of [['jobActive', 'active'], ['jobSucceeded', 'succeeded'], ['jobFailed', 'failed']]) {
      if (Number.isSafeInteger(details[field]) && details[field] >= 0) signals.add(`The Job reports ${details[field]} ${label} pods.`);
    }
  }
  for (const condition of details.conditions || []) {
    if (condition.type === 'PodScheduled' && condition.status === 'False' && condition.reason === 'Unschedulable') {
      signals.add('The PodScheduled condition reports Unschedulable.');
    }
    if (details.kind === 'Node' && condition.type === 'Ready' && ['False', 'Unknown'].includes(condition.status)) {
      signals.add(`The node Ready condition reports ${condition.status}.`);
    }
    if (details.kind === 'Node' && ['MemoryPressure', 'DiskPressure', 'PIDPressure'].includes(condition.type) && condition.status === 'True') {
      signals.add(`The node ${condition.type} condition reports True.`);
    }
  }
  for (const container of details.containers || []) {
    if (['ContainerCreating', 'CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerConfigError'].includes(container.waitingReason)) {
      signals.add(`A container reports ${container.waitingReason}.`);
    }
    if (container.terminationReason === 'OOMKilled') {
      signals.add('A container currently reports termination reason OOMKilled; its cause is unverified.');
    }
    if (Number.isInteger(container.terminationExitCode) && container.terminationExitCode >= 0 && container.terminationExitCode <= 255) {
      signals.add(`A container currently reports termination exit code ${container.terminationExitCode}; its cause is unverified.`);
    }
    if (container.lastTerminationReason === 'OOMKilled') {
      signals.add('A container previously terminated with reason OOMKilled; the timing and cause are unverified.');
    }
    if (Number.isInteger(container.lastTerminationExitCode) && container.lastTerminationExitCode >= 0 && container.lastTerminationExitCode <= 255) {
      signals.add(`A container previously terminated with exit code ${container.lastTerminationExitCode}; the timing and cause are unverified.`);
    }
    if (Number.isSafeInteger(container.restarts) && container.restarts > 0) {
      signals.add(`A container reports ${container.restarts} restarts; their timing and cause are unverified.`);
    }
  }
  const eventTimes = new Map();
  const correlatedEvents = new Map();
  for (const event of events) {
    if (event.type !== 'Warning') continue;
    if (Object.hasOwn(warningChecks, event.reason)) {
      signals.add(`A resource event reports ${event.reason}; its timing and cause are unverified.`);
      const time = typeof event.time === 'string' ? Date.parse(event.time) : NaN;
      if (Number.isFinite(time) && (!eventTimes.has(event.reason) || time > eventTimes.get(event.reason))) {
        eventTimes.set(event.reason, time);
      }
    }
    if (event.reason === 'FailedMount' && /\bSecretNotFound\b/i.test(event.message || '')) {
      signals.add('A FailedMount event reports SecretNotFound; the secret store and object have not been independently verified.');
    }
    if (Object.hasOwn(eventDetails, event.reason)) {
      const labels = [];
      for (const [pattern, label] of eventDetails[event.reason]) {
        if (pattern.test(event.message || '')) {
          labels.push(label);
          signals.add(`A ${event.reason} event contains an indication of ${label}; its context and current relevance are unverified.`);
        }
      }
      if (labels.length) {
        const key = JSON.stringify([event.reason, labels]);
        const time = typeof event.time === 'string' ? Date.parse(event.time) : NaN;
        const existing = correlatedEvents.get(key);
        if (!existing || (Number.isFinite(time) && (!Number.isFinite(existing.time) || time > existing.time))) {
          correlatedEvents.set(key, { reason: event.reason, labels, time, count: event.count });
        }
      }
      if (event.reason === 'FailedMount' && typeof event.message === 'string') {
        const references = [...event.message.matchAll(/https:\/\/([a-z0-9](?:[-a-z0-9]*[a-z0-9])?)\.vault\.azure\.net\/secrets\/([A-Za-z0-9][A-Za-z0-9._-]{0,126})\/?/gi)];
        for (const [, vault, object] of references.slice(0, 3)) {
          signals.add(`A returned FailedMount event references Key Vault "${vault}" and object "${object}"; this is event text, not independent verification.`);
        }
        const status = event.message.match(/\b(?:HTTP|status(?:code)?)[^0-9]{0,8}(403|404)\b/i);
        if (status) signals.add(`A returned FailedMount event includes HTTP ${status[1]}; its current relevance is unverified.`);
      }
    }
  }
  for (const [reason, time] of eventTimes) {
    signals.add(`A returned ${reason} event reports a last-observed time of ${new Date(time).toISOString()}; event timestamps and current status are unverified.`);
  }
  const matches = [...correlatedEvents.values()];
  for (const event of matches.slice(0, 10)) {
    const time = Number.isFinite(event.time) ? ` Its reported last-observed time is ${new Date(event.time).toISOString()}.` : ' Its last-observed time is unavailable.';
    const count = Number.isSafeInteger(event.count) && event.count > 0 ? ` It reports ${event.count} occurrences.` : '';
    signals.add(`One ${event.reason} event contains these fixed matches together: ${event.labels.join(', ')}.${time}${count} Event content and current relevance are unverified.`);
  }
  if (matches.length > 10) {
    const omitted = matches.length - 10;
    signals.add(`${omitted} additional ${omitted === 1 ? 'combination' : 'combinations'} of event indicators ${omitted === 1 ? 'was' : 'were'} omitted; event evidence is incomplete.`);
  }
  if (eventError) signals.add('Resource events could not be read; event evidence is incomplete.');
  if (!signals.size) signals.add('No supported status indicators were extracted; this does not establish health.');
  return [...signals];
}

function summarizeLogs(logs) {
  const patterns = [
    [/\bconnection refused\b/i, 'connection refused'],
    [/\b(?:timed? out|timeout)\b/i, 'timeout'],
    [/\bpermission denied\b/i, 'permission denied'],
    [/\bout of memory\b|\boomkilled\b/i, 'out of memory'],
    [/\bno space left on device\b/i, 'no space left on device'],
    [/\bno such host\b/i, 'no such host'],
    [/\bname or service not known\b/i, 'name or service not known'],
    [/\bconnection reset by peer\b/i, 'connection reset by peer'],
    [/\bx509: certificate signed by unknown authority\b/i, 'x509: certificate signed by unknown authority'],
    [/\btoo many requests\b/i, 'too many requests'],
    [/\bauthentication failed\b/i, 'authentication failed']
  ];
  return patterns.filter(([pattern]) => pattern.test(logs))
    .map(([, label]) => `A log contains text matching "${label}"; its context and cause are unverified.`);
}

function diagnosticTimestamp() {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZone: 'UTC'
  }).format(new Date());
}

function decorateDiagnostic(context, summary, signals) {
  const times = signals.flatMap(signal =>
    [...signal.matchAll(/\blast-observed time is (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)/g)].map(match => match[1])
  ).filter(value => Number.isFinite(Date.parse(value))).sort();
  const eventLastSeen = times.length ? new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZone: 'UTC'
  }).format(new Date(times.at(-1))) : 'Unavailable';
  const heading = `Cluster: ${context} · Analyzed: ${diagnosticTimestamp()} UTC · Event last seen: ${eventLastSeen}${times.length ? ' UTC (reported)' : ''}`;
  return `${heading}\n\n${summary}`;
}

function investigationActivity(signals) {
  const activity = [];
  activity.push('Read or attempted to read the selected resource status and current events');
  const pods = new Set(signals.flatMap(signal => [...signal.matchAll(/Related pod (\d+):/g)].map(match => match[1])));
  for (const pod of [...pods].sort((a, b) => Number(a) - Number(b))) activity.push(`Read related pod ${pod} status and events`);
  if (signals.some(signal => /Pod \d+ .*logs:/i.test(signal))) activity.push('Checked available current and previous pod log indicators');
  if (signals.some(signal => /related SecretProviderClass/i.test(signal))) activity.push('Read the referenced SecretProviderClass safely and projected provider, vault and object names');
  if (signals.some(signal => /related PersistentVolumeClaim/i.test(signal))) activity.push('Read referenced PVC phase');
  if (signals.some(signal => /related Node/i.test(signal))) activity.push('Read referenced node readiness');
  if (signals.some(signal => /Related Job \d+:/i.test(signal))) activity.push('Read related Job outcomes');
  return activity;
}

export async function createInstance({ kubernetes = createKubernetes(), askCopilot, askResourceCopilot, askManualCopilot, checkNodes = checkDeallocatedNodes } = {}) {
  const state = { context: '', namespace: '', aiIssues: [], resourceSummaries: [], conversations: [], editing: false };
  const resourceEvidence = new Map();
  let scanSnapshot = { resources: [], issues: [], errors: [] };
  let targetGeneration = 0;
  const summaryRequests = new Map();
  let reviewRequest = 0;
  let discoveredTypes = new Map();
  let discoveryGeneration = 0;
  const evidenceKey = (context, resource) => JSON.stringify([context, resource.namespace, resource.kind, resource.name]);
  const token = randomBytes(32).toString('hex');
  const getContext = () => ({ ...state, aiIssues: [...state.aiIssues], resourceSummaries: [...state.resourceSummaries], conversations: [...state.conversations] });
  const relatedPods = target => {
    if (target.kind === 'Pod') return [target];
    const key = item => JSON.stringify([item.namespace, item.kind, item.name]);
    const resources = new Map(scanSnapshot.resources.map(resource => [key(resource), resource]));
    const belongsToTarget = pod => {
      const visited = new Set();
      let resource = pod;
      while (resource) {
        const id = key(resource);
        if (visited.has(id)) return false;
        visited.add(id);
        const owner = resources.get(id)?.owners?.[0];
        if (!owner) return false;
        resource = { ...owner, namespace: pod.namespace };
        if (key(resource) === key(target)) return true;
      }
      return false;
    };
    const affected = new Set(scanSnapshot.issues.filter(issue => issue.kind === 'Pod').map(key));
    return scanSnapshot.resources.filter(resource => resource.kind === 'Pod' && belongsToTarget(resource))
      .sort((a, b) => Number(affected.has(key(b))) - Number(affected.has(key(a))));
  };
  const collectResourceSignals = async (context, target, saved) => {
    const generation = targetGeneration;
    const assertTarget = () => {
      if (generation !== targetGeneration || state.context !== context) throw new Error('The selected context or namespace changed during evidence collection.');
    };
    let root = saved;
    if (!root) {
      try {
        const details = await kubernetes.resource(context, target);
        assertTarget();
        let events = [];
        let eventError;
        try { events = await kubernetes.resourceEvents(context, target, details.uid); }
        catch (error) { eventError = error.message; }
        root = { details, signals: summarizeResourceEvidence(details, events, eventError) };
      } catch {
        assertTarget();
        root = { signals: ['Current resource evidence could not be read; do not assume the resource is healthy.'] };
      }
    }
    const signals = [...root.signals];
    const pods = relatedPods(target);
    const references = [...(root.details?.related || [])];
    if (target.kind !== 'Pod' && !pods.length) {
      signals.push('No related pods were identified in the scan; ownership data may be incomplete.');
    }
    if (pods.length > 3) signals.push(`Only 3 of ${pods.length} related pods were sampled.`);
    for (const [index, pod] of pods.slice(0, 3).entries()) {
      assertTarget();
      let details = target.kind === 'Pod' ? root.details : undefined;
      if (!details) {
        try {
          details = await kubernetes.resource(context, pod);
          assertTarget();
          let events = [];
          let eventError;
          try { events = await kubernetes.resourceEvents(context, pod, details.uid); }
          catch (error) { eventError = error.message; }
          signals.push(...summarizeResourceEvidence(details, events, eventError).map(signal => `Related pod ${index + 1}: ${signal}`));
        } catch {
          assertTarget();
          signals.push(`Related pod ${index + 1} status or events could not be read; evidence is incomplete.`);
          continue;
        }
      }
      assertTarget();
      references.push(...(details?.related || []));
      if (!kubernetes.logs) {
        signals.push(`Pod ${index + 1} logs were unavailable; log evidence is incomplete.`);
        continue;
      }
      const previousSelections = [false, ...(details?.containers?.some(container => container.restarts > 0) ? [true] : [])];
      for (const previous of previousSelections) {
        assertTarget();
        try {
          const logs = await kubernetes.logs(context, pod.namespace, pod.name, previous);
          const extracted = summarizeLogs(logs);
          signals.push(...extracted.map(signal => `Pod ${index + 1} ${previous ? 'previous' : 'current'} logs: ${signal}`));
          if (!extracted.length) signals.push(`Pod ${index + 1} ${previous ? 'previous' : 'current'} logs: no supported indicators extracted; this does not establish health.`);
        } catch {
          signals.push(`Pod ${index + 1} ${previous ? 'previous' : 'current'} logs could not be read; log evidence is incomplete.`);
        }
      }
    }
    assertTarget();
    const seen = new Set();
    const checks = references.filter(reference => {
      if (!['PersistentVolumeClaim', 'SecretProviderClass', 'Node'].includes(reference.kind)) return false;
      const key = `${reference.kind}:${reference.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (checks.length > 3) signals.push(`Only 3 of ${checks.length} related storage or node references were checked.`);
    for (const [index, reference] of checks.slice(0, 3).entries()) {
      assertTarget();
      const related = { ...reference, namespace: reference.kind === 'Node' ? '' : target.namespace };
      try {
        const details = await kubernetes.resource(context, related);
        assertTarget();
        const label = `Related ${reference.kind} ${index + 1}`;
        if (reference.kind === 'PersistentVolumeClaim') {
          signals.push(['Pending', 'Bound', 'Lost'].includes(details.phase)
            ? `${label} reports phase ${details.phase}.`
            : `${label} phase was not reported; this check is incomplete.`);
        } else if (reference.kind === 'SecretProviderClass') {
          signals.push(`${label} was readable; its object configuration and access were not verified.`);
          if (details.provider === 'azure') signals.push(`${label} reports the Azure provider.`);
          if (details.keyVaultName) signals.push(`${label} references Key Vault name "${details.keyVaultName}"; the vault was not queried.`);
          if (details.secretProviderObjects?.length) signals.push(`${label} references object ${details.secretProviderObjects.map(name => `"${name}"`).join(', ')}; these are object names, not values, and existence was not verified.`);
        } else if (reference.kind === 'Node') {
          const ready = (details.conditions || []).find(condition => condition.type === 'Ready');
          signals.push(['True', 'False', 'Unknown'].includes(ready?.status)
            ? `${label} reports Ready ${ready.status}.`
            : `${label} Ready condition was not reported; this check is incomplete.`);
        }
      } catch {
        assertTarget();
        signals.push(`A related ${reference.kind} could not be read; this check is incomplete.`);
      }
    }
    if (target.kind === 'CronJob') {
      const jobs = scanSnapshot.resources.filter(resource => resource.kind === 'Job' && resource.namespace === target.namespace &&
        resource.owners?.some(owner => owner.kind === target.kind && owner.name === target.name));
      if (!jobs.length) signals.push('No related Jobs were identified in the scan; ownership data may be incomplete.');
      else signals.push('Related Jobs were identified from the scan; their current ownership was not reverified.');
      if (jobs.length > 3) signals.push(`Only 3 of ${jobs.length} related Jobs from the scan were checked.`);
      for (const [index, job] of jobs.slice(0, 3).entries()) {
        assertTarget();
        try {
          const details = await kubernetes.resource(context, job);
          assertTarget();
          const jobSignals = summarizeResourceEvidence(details, [], undefined);
          signals.push(...jobSignals.map(signal => `Related Job ${index + 1}: ${signal}`));
        } catch {
          assertTarget();
          signals.push(`Related Job ${index + 1} could not be read; this check is incomplete.`);
        }
      }
    }
    return signals;
  };
  const conversationFor = target => state.conversations.find(item =>
    item.context === state.context && item.kind === (target?.kind || '') &&
    item.name === (target?.name || '') && item.namespace === (target?.namespace || ''));
  const appendConversation = (target, question, answer) => {
    let conversation = conversationFor(target);
    if (!conversation) {
      conversation = { context: state.context, kind: target?.kind || '', name: target?.name || '', namespace: target?.namespace || '', messages: [] };
      state.conversations.push(conversation);
    }
    conversation.messages.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
    if (conversation.messages.length > 20) conversation.messages.splice(0, conversation.messages.length - 20);
  };
  const validateIssue = issue => {
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
    if (hasResource) validateResourceTarget(issue, discoveredTypes);
    const diagnosis = issue.diagnosis === undefined ? undefined : issue.diagnosis;
    if (diagnosis !== undefined && (typeof diagnosis !== 'string' || diagnosis.length > 12000)) throw new Error('Invalid issue diagnosis.');
    const suggestions = issue.suggestions === undefined ? undefined : issue.suggestions;
    if (suggestions !== undefined && (!Array.isArray(suggestions) || suggestions.length > 3 ||
        !suggestions.every(value => typeof value === 'string' && value.trim() && value.length <= 160))) throw new Error('Invalid issue suggestions.');
    return {
      title: issue.title, evidence: issue.evidence, next: issue.next, docs: issue.docs,
      ...(diagnosis !== undefined ? { diagnosis } : {}),
      ...(suggestions !== undefined ? { suggestions } : {}),
      ...(hasResource ? { kind: issue.kind, name: issue.name, namespace: issue.namespace } : {})
    };
  };
  const saveIssue = saved => {
    const existing = state.aiIssues.findIndex(item =>
      item.title === saved.title && item.kind === saved.kind && item.name === saved.name && item.namespace === saved.namespace
    );
    if (existing < 0) state.aiIssues.push(saved);
    else state.aiIssues[existing] = saved;
  };
  const publishIssue = issue => {
    saveIssue(validateIssue(issue));
    return getContext();
  };
  const publishIssues = issues => {
    if (!Array.isArray(issues) || issues.length < 1 || issues.length > 100) throw new Error('Provide between 1 and 100 issues.');
    const validated = issues.map(validateIssue);
    for (const issue of validated) saveIssue(issue);
    return { published: validated.length };
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
      if (req.method === 'GET' && route === '/finding-groups.mjs') {
        return send(200, await readFile(new URL('../finding-groups.mjs', assets), 'utf8'), 'text/javascript; charset=utf-8');
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
        const clusterResource = (body.kind === 'Node' || discoveredTypes.get(body.kind)?.namespaced === false) && body.namespace === '';
        if (body.context !== state.context || !state.context ||
            (!clusterResource && (body.namespace !== state.namespace || !state.namespace))) {
          throw new Error('The selected context or namespace has changed.');
        }
        return validateResourceTarget({ kind: body.kind, name: body.name, namespace: body.namespace }, discoveredTypes);
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
            state.resourceSummaries = [];
            state.conversations = [];
            reviewRequest++;
            state.editing = false;
            discoveredTypes = new Map();
            discoveryGeneration++;
            resourceEvidence.clear();
            scanSnapshot = { resources: [], issues: [], errors: [] };
            targetGeneration++;
          }
          result = getContext();
          break;
        case '/api/namespaces':
          if (!state.context) throw new Error('Select a context first.');
          result = await kubernetes.namespaces(state.context);
          break;
        case '/api/resource-types': {
          if (!state.context) throw new Error('Select a context first.');
          const context = state.context;
          const generation = ++discoveryGeneration;
          const types = await kubernetes.resourceTypes(context);
          if (state.context !== context) throw new Error('The context changed during resource discovery.');
          if (generation !== discoveryGeneration) throw new Error('A newer resource discovery replaced this request.');
          discoveredTypes = new Map(types.map(type => [type.kind, type]));
          result = types;
          break;
        }
        case '/api/resource-names': {
          if (!state.context || body.context !== state.context) throw new Error('The context changed; select a resource type again.');
          const type = discoveredTypes.get(body.kind);
          if (!type) throw new Error('Select an available resource type.');
          const context = state.context;
          const namespace = type.namespaced ? state.namespace : '';
          if (type.namespaced && (!namespace || body.namespace !== namespace)) throw new Error('Select a namespace first.');
          const names = await kubernetes.resourceNames(context, type, namespace);
          if (context !== state.context || (type.namespaced && namespace !== state.namespace)) throw new Error('The selected context or namespace changed while loading resources.');
          result = names;
          break;
        }
        case '/api/scan': {
          if (!state.context) throw new Error('Select a context first.');
          const context = state.context;
          const checks = await Promise.allSettled([
            kubernetes.clusterPods(context),
            kubernetes.clusterDeployments(context),
            kubernetes.clusterReplicaSets ? kubernetes.clusterReplicaSets(context) : Promise.resolve([]),
            kubernetes.clusterJobs ? kubernetes.clusterJobs(context) : Promise.resolve([]),
            kubernetes.nodes(context),
            Promise.resolve().then(() => kubernetes.clusterWarningEvents(context))
          ]);
          if (state.context !== context) throw new Error('The context changed during the scan.');
          const labels = ['Pods', 'Deployments', 'ReplicaSets (ownership)', 'Jobs (ownership)', 'Nodes', 'Warning events'];
          const errors = checks.flatMap((check, index) => check.status === 'rejected' ? [`${labels[index]}: ${check.reason.message}`] : []);
          const nodeCheck = checks[4].status === 'fulfilled' ? await checkNodes(checks[4].value) : { nodes: [], errors: [] };
          if (state.context !== context) throw new Error('The context changed during the scan.');
          errors.push(...nodeCheck.errors);
          const resources = checks.slice(0, 4).flatMap(check => check.status === 'fulfilled' ? check.value : []);
          const warnings = checks[5].status === 'fulfilled'
            ? detectWarningIssues(checks[5].value.events, resources, nodeCheck.nodes)
            : { issues: [], errors: [] };
          errors.push(...warnings.errors);
          if (checks[5].status === 'fulfilled' && checks[5].value.truncated) {
            errors.push('Warning events: results exceeded 2,000 events; recent event checks are incomplete.');
          }
          result = {
            context,
            issues: [...detectIssues(resources, nodeCheck.nodes), ...warnings.issues],
            resources,
            errors
          };
          scanSnapshot = result;
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
                !['Pod', 'Deployment', 'ReplicaSet', 'Job', 'CronJob', 'StatefulSet', 'DaemonSet', 'ReplicationController', 'PersistentVolumeClaim', 'SecretProviderClass', 'Node'].includes(issue.kind) ||
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
          {
            const context = state.context;
            const request = ++reviewRequest;
            const candidates = findings.map((finding, index) => {
              const text = `${finding.title} ${finding.evidence}`.toLowerCase();
              const score = (text.includes('failedmount') ? 100 : 0) +
                (text.includes('crashloopbackoff') ? 90 : 0) +
                (text.includes('failedscheduling') ? 80 : 0) +
                (text.includes('unhealthy') ? 70 : 0) +
                (text.includes('backoff') ? 60 : 0) +
                (text.includes('pending') ? 40 : 0);
              return { finding, index, score };
            }).sort((left, right) => right.score - left.score).slice(0, 6);
            const detailedEvidence = (await Promise.all(candidates.map(async ({ finding, index }) => {
              const signals = await collectResourceSignals(context, finding, resourceEvidence.get(evidenceKey(context, finding)));
              return { index, signals };
            }))).filter(Boolean);
            if (context !== state.context) throw new Error('The context changed during automatic evidence collection.');
            const reviewed = await askCopilot(context, findings, body.scanErrors || [], detailedEvidence);
            if (context !== state.context) throw new Error('The context changed during the scan review.');
            if (request !== reviewRequest) throw new Error('A newer scan review replaced this request.');
            if (!Array.isArray(reviewed) || reviewed.length > findings.length) throw new Error('Invalid Copilot scan review.');
            const indexes = new Set();
            const issues = reviewed.map(item => {
              if (!item || !Number.isInteger(item.index) || item.index < 0 || item.index >= findings.length || indexes.has(item.index)) throw new Error('Invalid Copilot scan finding index.');
              indexes.add(item.index);
              return validateIssue({
                ...findings[item.index], context, evidence: item.evidence, next: item.next, docs: [],
                diagnosis: item.diagnosis || '', suggestions: Array.isArray(item.suggestions) ? item.suggestions : []
              });
            });
            for (const issue of issues) saveIssue(issue);
          }
          result = { sent: true };
          break;
        case '/api/ask-manual-copilot': {
          if (!state.context || body.context !== state.context) throw new Error('The context changed; request the investigation again.');
          if (typeof body.question !== 'string' || !body.question.trim() || body.question.length > 2000) throw new Error('Enter a question of up to 2000 characters.');
          const hasTarget = body.kind !== undefined || body.name !== undefined || body.namespace !== undefined;
          const resourceTarget = hasTarget ? target() : null;
          if (!askManualCopilot) throw new Error('Copilot investigation is unavailable in this session.');
          const context = state.context;
          const generation = targetGeneration;
          const key = resourceTarget ? evidenceKey(context, resourceTarget) : JSON.stringify([context, '', '', '']);
          const requestId = (summaryRequests.get(key) || 0) + 1;
          summaryRequests.set(key, requestId);
          const signals = resourceTarget
            ? await collectResourceSignals(context, resourceTarget, resourceEvidence.get(key))
            : [
              ...scanSnapshot.issues.slice(0, 100).map(issue => `${issue.title}: ${issue.evidence}`),
              ...scanSnapshot.errors.map(() => 'A cluster check was incomplete.'),
              ...(scanSnapshot.issues.length > 100 ? ['Only the first 100 cluster findings were included.'] : []),
              ...(!scanSnapshot.issues.length ? ['No scan findings are available; this does not establish cluster health.'] : [])
            ];
          if (generation !== targetGeneration) throw new Error('The selected context or namespace changed during evidence collection.');
          const initial = resourceTarget && state.resourceSummaries.find(item => evidenceKey(context, item) === key);
          const history = [
            ...(initial ? [{ role: 'assistant', content: initial.summary }] : []),
            ...(conversationFor(resourceTarget)?.messages || [])
          ].map(message => message.role === 'assistant'
            ? { ...message, content: message.content.replace(/^Cluster: [^\n]+\n\n/, '') }
            : message);
          const summary = await askManualCopilot(context, resourceTarget, body.question.trim(), signals, history);
          if (generation !== targetGeneration) throw new Error('The selected context or namespace changed during the investigation.');
          if (summaryRequests.get(key) !== requestId) throw new Error('A newer investigation replaced this request.');
          if (typeof summary !== 'string' || !summary.trim()) throw new Error('Copilot did not return an answer.');
          const diagnostic = resourceTarget ? decorateDiagnostic(context, summary, signals) : summary;
          appendConversation(resourceTarget, body.question.trim(), diagnostic);
          result = { sent: true, summary };
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
            targetGeneration++;
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
          const type = discoveredTypes.get(resourceTarget.kind);
          const generic = type && !/^[A-Z]/.test(resourceTarget.kind);
          const details = generic ? await kubernetes.resourceMetadata(context, type, resourceTarget) : await kubernetes.resource(context, resourceTarget);
          let events;
          let eventError;
          if (generic) {
            eventError = 'Events are not collected for metadata-only resources.';
          } else try {
            events = await kubernetes.resourceEvents(context, resourceTarget, details.uid);
          } catch (error) {
            eventError = error.message;
          }
          target();
          resourceEvidence.set(key, { details, signals: summarizeResourceEvidence(details, events || [], eventError) });
          result = { details, events: events || [], eventError };
          break;
        }
        case '/api/describe': {
          const resourceTarget = target();
          if (discoveredTypes.has(resourceTarget.kind) && !/^[A-Z]/.test(resourceTarget.kind)) throw new Error('Describe is unavailable for metadata-only resources.');
          result = await kubernetes.describe(state.context, resourceTarget);
          target();
          break;
        }
        case '/api/ask-resource-copilot': {
          const resourceTarget = target();
          if (!askResourceCopilot) throw new Error('Copilot resource investigation is unavailable in this session.');
          const context = state.context;
          const generation = targetGeneration;
          const key = evidenceKey(context, resourceTarget);
          const requestId = (summaryRequests.get(key) || 0) + 1;
          summaryRequests.set(key, requestId);
          const signals = await collectResourceSignals(context, resourceTarget, resourceEvidence.get(key));
          if (generation !== targetGeneration) throw new Error('The selected context or namespace changed during evidence collection.');
          const summary = await askResourceCopilot(context, resourceTarget, signals);
          if (generation !== targetGeneration) throw new Error('The selected context or namespace changed during the investigation.');
          if (summaryRequests.get(key) !== requestId) throw new Error('A newer investigation replaced this request.');
          if (typeof summary !== 'string' || !summary.trim()) throw new Error('Copilot did not return a diagnostic summary.');
          state.resourceSummaries = state.resourceSummaries.filter(item => evidenceKey(context, item) !== key);
          const diagnostic = decorateDiagnostic(context, summary, signals);
          state.resourceSummaries.push({
            ...resourceTarget,
            summary: diagnostic,
            activity: investigationActivity(signals)
          });
          result = { sent: true, summary };
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
    publishIssues,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  };
}
