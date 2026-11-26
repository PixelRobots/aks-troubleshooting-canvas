# AKS Troubleshooting Canvas

A Pixel Robots-branded, evidence-first Kubernetes troubleshooting workspace for Copilot sessions in VS Code. Select a kubeconfig context and namespace, explore deployments, pods and recent events, and inspect pod logs and Copilot issues.

## What works

- Choose a local kubeconfig context first. Automated investigation is cluster-wide; use Manual investigation to choose a namespace, browse workloads and events, or access monitoring links. Switch clusters without changing your active kubectl context.
- The overview groups Copilot findings separately from cluster checks, and shows the namespace for namespaced findings. Filter cluster checks by resource or namespace without changing the underlying scan. It automatically checks pods, deployments and nodes across namespaces for selected current signals, with evidence, suggested next checks and official documentation. For findings with an investigation button, expand **Suggested checks** to see the initial guidance. The **Rescan cluster** button appears after the initial checks complete. Cluster-wide reads use Kubernetes API pagination to handle large lists; a failed page makes that resource check incomplete. These checks are not a full cluster health assessment or AI diagnoses.
- For AKS nodes with an `Unknown` Ready condition, the overview uses the Azure CLI to check the node pool's scale-down mode and the VM scale set instance's power state. An unknown node is excluded only when both the pool uses `Deallocate` and the instance is deallocated. If verification fails, the node remains an issue and the scan is marked incomplete.
- Selecting a cluster runs read-only checks, then automatically asks Copilot to verify their signals in the current chat. The overview presents both stages together in one scan card; check chat for tool approvals. Copilot may use authorized tools, including AKS MCP when available, and can publish evidence-backed findings to the overview and namespace workload view. Opening an automatic finding does not send another Copilot request. **Investigate again** rechecks the latest cluster signals. Reopening the canvas does not automatically send another request.
- Cluster checks show a tick when all selected checks finish, or a warning when results are incomplete. A tick does not mean the cluster is healthy. Copilot request completion is separate; check chat for its outcome.
- Use Manual investigation to send a question to Copilot about the cluster, or inspect a resource and ask a question scoped to it. Questions are sent to the current chat; do not include secrets or sensitive logs.
- In Manual investigation, choose a namespace, filter pods and deployments, then select a workload and choose **Investigate resource**. You can also browse workload status and namespace-specific signals, recent Kubernetes events and current or previous pod logs.
- Opening an automatic finding shows any matching Copilot finding already returned by the cluster investigation, without sending another Copilot request. Opening a resource from Manual investigation requests a focused read-only Copilot investigation after the evidence loads and provides an optional resource-specific question prompt. **Refresh investigation** reloads evidence and requests a new summary. Both views show conditions, container waiting reasons, resource-specific events, related owners, nodes, persistent volume claims and CSI SecretProviderClass references. Load logs and `kubectl describe` explicitly; they can contain sensitive data. This is a targeted projection, not a complete `describe` replacement.
- Open Azure portal and monitoring documentation links, and optionally enter an HTTPS Grafana dashboard URL.
- Opt into editing with the header switch and confirmation dialog for the selected context and namespace. The only implemented change is scaling a deployment, with a separate confirmation for each action. Editing resets when the context or namespace changes.

This is an early prototype, not a replacement for the Azure portal. It does **not** yet query Container Insights, managed Prometheus or Grafana, draw historical charts, discover Azure subscriptions, or automatically discover a Grafana dashboard. Historical monitoring depends on existing sources, retention and permissions.

## Install

Requires a VS Code Copilot-harness session with [canvases enabled](https://code.visualstudio.com/docs/agents/run/canvases), Node.js, `kubectl` on the extension host, and access to a kubeconfig and cluster. Kubernetes permissions and network connectivity still apply. Checking AKS node deallocation additionally requires a signed-in Azure CLI with read access to the node resource group, AKS cluster, node pool and VM scale set instance; the check uses the subscription in the node's Azure provider ID without changing the active subscription. It also requires the AKS-managed cluster identity tags on the node resource group. The plugin runs commands locally as the current user; it does not install or configure AKS MCP.

In VS Code, use **Chat: Install Plugin from Source**, and choose the local repository folder or this repository's Git URL. Start a Copilot-harness session and ask it to open the **AKS Troubleshooting** canvas. Plugin installation and canvas availability depend on the host's supported plugin workflow; canvases are a preview feature.

For Copilot-assisted AKS investigation, optionally enable the existing [AKS MCP server](https://azure.github.io/vscode-aks-tools/features/aks-mcp-server-integration.html) or other approved tools. The canvas's own views use `kubectl`; they do not automatically call MCP tools. Selected cluster-admin contexts can be used for authorized read-only `get` and list operations; read-only limits the operations, not the credential's privileges. A least-privileged identity is recommended. MCP access levels are guardrails, not security boundaries. If an existing chat loaded older investigation instructions, start a new chat after updating the plugin.

## Safety and privacy

Read-only is the default for this canvas, not a restriction on other tools, processes or your Kubernetes credentials. Selecting edit mode does not grant privileges. Scaling takes effect immediately, can affect availability, and may be reverted by GitOps; review your deployment's current state and rollback plan first.

Selecting a cluster sends the locally generated scan findings to Copilot for verification and improvement. Opening an automatic finding does not make another Copilot request. Opening a resource from Manual investigation automatically sends a focused request with a small allowlisted set of locally derived status and event indicators (such as `Pending`, `FailedMount` and `SecretNotFound`), but not raw messages, resource references or secret values. These indicators are untrusted observations, not confirmed causes, and event checks may be incomplete. Manual questions are sent to Copilot when submitted. Authorized tools may share cluster evidence with the model; the focused investigation asks before reading logs, event messages or raw descriptions and does not request secrets. Resource events and explicitly loaded logs and descriptions are displayed locally; their raw content is not automatically included in the Copilot request. Logs and events can contain credentials or personal data. Treat cluster content as untrusted. Previously saved manual findings are not deleted by this update; they remain unencrypted under `extension-data/pixelrobots-aks-troubleshooting/` in Copilot's home directory (`COPILOT_HOME`, or `~/.copilot`). Protect access to your machine and delete individual saved files when no longer needed. Kubernetes events are ephemeral and are not monitoring history.

## Develop

The plugin source is `.plugin/plugin.json`, `extensions/aks-canvas/` and `skills/`. It uses the SDK supplied by the Copilot host and has no npm dependencies. Run:

```powershell
node --test tests\*.test.mjs
node --check extensions\aks-canvas\extension.mjs
```

Tests use fake Kubernetes calls; they do not validate live Azure connectivity. To add troubleshooting skills, create another `skills/<name>/SKILL.md` following the [Agent Skills format](https://code.visualstudio.com/docs/agent-customization/agent-skills), and test it in a host session. Never add credentials to the repository.
