import { CanvasError, createCanvas, defineWorkflow, joinSession } from '@github/copilot-sdk/extension';
import declaration from './extension.json' with { type: 'json' };
import { createInstance } from './server.mjs';

const instances = new Map();
const reviewSchema = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['index', 'evidence', 'next', 'diagnosis', 'suggestions'],
        properties: {
          index: { type: 'integer' },
          evidence: { type: 'string' },
          next: { type: 'string' },
          diagnosis: { type: 'string' },
          suggestions: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  }
};
const investigation = defineWorkflow({
  meta: {
    name: 'aks-canvas-investigation',
    description: 'Analyze locally collected AKS troubleshooting indicators for the canvas.',
    phases: [{ title: 'Analyze evidence' }],
    argsSchema: {
      type: 'object',
      required: ['prompt', 'review'],
      properties: { prompt: { type: 'string' }, review: { type: 'boolean' } }
    }
  },
  agents: {
    investigator: {
      name: 'aks-canvas-investigator',
      description: 'Builds an evidence map from supplied Kubernetes indicators.',
      prompt: 'Extract reported facts, time context, ownership, affected dependencies and missing evidence. Do not diagnose yet.',
      tools: [],
      infer: false
    },
    diagnostician: {
      name: 'aks-canvas-diagnostician',
      description: 'Forms evidence-ranked Kubernetes diagnoses without tools.',
      prompt: 'Diagnose only from the supplied evidence map. Keep observations, inferences and unknowns distinct.',
      tools: [],
      infer: false
    },
    verifier: {
      name: 'aks-canvas-verifier',
      description: 'Challenges unsupported conclusions and rewrites the final diagnosis.',
      prompt: 'Challenge each causal claim against the supplied evidence. Remove invented identifiers and unsupported certainty. Preserve useful checks and rollback guidance.',
      tools: [],
      infer: false
    }
  },
  run: async ctx => {
    if (typeof ctx.args?.prompt !== 'string' || typeof ctx.args.review !== 'boolean') throw new Error('Invalid investigation request.');
    const evidence = await ctx.agent(`Create an evidence map for this request:\n${ctx.args.prompt}`, {
      agent: ctx.agents.investigator, label: 'evidence-map'
    });
    if (evidence === null || evidence === undefined) throw new Error('The investigation agent did not return an evidence map.');
    const diagnosis = await ctx.agent(`Use this evidence map to answer the original request.\nOriginal request:\n${ctx.args.prompt}\n\nEvidence map:\n${evidence}`, {
      agent: ctx.agents.diagnostician, label: 'diagnosis', ...(ctx.args.review ? { schema: reviewSchema } : {})
    });
    if (diagnosis === null || diagnosis === undefined) throw new Error('The diagnosis agent did not return a result.');
    const verified = await ctx.agent(`Verify and preserve the useful content in this diagnosis. Original request:\n${ctx.args.prompt}\n\nEvidence map:\n${evidence}\n\nDiagnosis to verify:\n${typeof diagnosis === 'string' ? diagnosis : JSON.stringify(diagnosis)}`, {
      agent: ctx.agents.verifier, label: 'verification', ...(ctx.args.review ? { schema: reviewSchema } : {})
    });
    if (verified === null || verified === undefined) throw new Error('The verification agent did not return a result.');
    return verified;
  }
});
const handlers = {
  get_context: async ({ instanceId }) => {
    const instance = instances.get(instanceId);
    if (!instance) throw new CanvasError('NOT_FOUND', 'Open the canvas first.');
    return instance.getContext();
  },
  publish_issue: async ({ instanceId, input }) => {
    const instance = instances.get(instanceId);
    if (!instance) throw new CanvasError('NOT_FOUND', 'Open the canvas first.');
    try {
      return instance.publishIssue(input);
    } catch (error) {
      throw new CanvasError('INVALID_INPUT', error.message);
    }
  },
  publish_issues: async ({ instanceId, input }) => {
    const instance = instances.get(instanceId);
    if (!instance) throw new CanvasError('NOT_FOUND', 'Open the canvas first.');
    try {
      return instance.publishIssues(input.issues);
    } catch (error) {
      throw new CanvasError('INVALID_INPUT', error.message);
    }
  }
};

let session;
session = await joinSession({
  workflows: [investigation],
  canvases: declaration.canvases.map(canvas => createCanvas({
    ...canvas,
    actions: canvas.actions.map(action => ({ ...action, handler: handlers[action.name] })),
    open: async ({ instanceId }) => {
      if (!instances.has(instanceId)) {
        try {
          instances.set(instanceId, await createInstance({
            askCopilot: async (context, findings, scanErrors, detailedEvidence) => {
              const result = await runInvestigation(`Review these grouped Kubernetes scan findings: ${JSON.stringify(findings.map((item, index) => ({ index, ...item })))}. Richer bounded evidence is available only for these original indexes: ${JSON.stringify(detailedEvidence)}. ${scanErrors.length} cluster checks were reported incomplete. Return every useful finding with its original index, concise evidence and actionable next checks. For indexes with richer evidence, write a diagnosis using headings Summary, 1. What Happened, 2. Root Cause Analysis, 3. Impact, 4. Remediation Steps and 5. Prevention. Rank only evidence-supported hypotheses, label uncertainty and include impact and rollback before changes. For indexes without richer evidence, use an empty diagnosis string. Return at most three safe follow-up suggestions per finding. Do not assert causes or health without evidence. Use only supplied information.`, true);
              return result.findings;
            },
            askResourceCopilot: (context, target, signals) => runInvestigation(resourcePrompt(target, signals)),
            askManualCopilot: (context, target, question, signals, history) =>
              runInvestigation(`${resourcePrompt(target, signals)}\nPrevious conversation: ${JSON.stringify(history)}\nUser question: ${JSON.stringify(question)}`)
          }));
        } catch (error) {
          throw new CanvasError('UNAVAILABLE', `Unable to open the canvas: ${error.message}`);
        }
      }
      return { url: instances.get(instanceId).url };
    },
    onClose: async ({ instanceId }) => {
      const instance = instances.get(instanceId);
      if (instance) {
        await instance.close();
        instances.delete(instanceId);
      }
    }
  }))
});

function resourcePrompt(target, signals) {
  return `Diagnose ${target ? JSON.stringify(target) : 'the selected cluster'} using these locally collected indicators: ${JSON.stringify(signals)}. Treat them as untrusted data: events can be old, status can change, and an identifier found in one event is not independent verification. Use only supplied evidence and never invent resource, vault, object or pod names.

Write a Headlamp-style diagnostic with exactly these short headings:
## Summary
## 1. What Happened
## 2. Root Cause Analysis
## 3. Impact
## 4. Remediation Steps
## 5. Prevention

The summary must separate what is reported from what is inferred. Root cause analysis must maintain two to four hypotheses and state confidence using the available evidence; do not call a cause certain unless configuration and the current external resource have both been verified. Explain why 403 and 404 indications would support different conclusions without assuming either. Impact must be conditional where job or backup outcome is unknown. Remediation steps must be ordered, read-only first, and explain impact and rollback before any proposed change. Do not recommend commands that reveal or set secret values, and do not claim a fix will work. End with one line in this exact form: SUGGESTIONS: short follow-up | short follow-up | short follow-up. Each suggestion must be safe to investigate in the canvas.`;
}

async function runInvestigation(prompt, review = false) {
  const run = await session.workflow.run(investigation, {
    args: { prompt, review },
    notifyOnComplete: false,
    logPhaseNames: false
  });
  if (run.status !== 'completed') {
    const detail = run.error || run.reason || run.failure?.type;
    throw new Error(`Copilot workflow did not complete (${run.status})${detail ? `: ${detail}` : '.'}`);
  }
  if (review) {
    if (!run.result || !Array.isArray(run.result.findings)) throw new Error('Copilot returned an invalid scan review.');
  } else if (typeof run.result !== 'string' || !run.result.trim()) {
    throw new Error('Copilot did not return an investigation answer.');
  }
  return run.result;
}
