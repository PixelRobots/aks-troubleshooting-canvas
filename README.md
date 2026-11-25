# AKS Troubleshooting Canvas

A Pixel Robots-branded, evidence-first Kubernetes troubleshooting workspace for Copilot sessions in VS Code. Select a kubeconfig context and namespace, explore deployments, pods and recent events, inspect pod logs, and share findings with Copilot.

## What works

- Discover local kubeconfig contexts without changing your active context.
- List namespaces, deployments and pods; inspect recent Kubernetes events and current or previous pod logs.
- Ask Copilot to add evidence-backed findings using the bundled investigation skill.
- Explicitly save findings and target details as private local investigation records. Nothing is saved automatically; logs are not automatically saved.
- Open Azure portal and monitoring documentation links, and optionally enter an HTTPS Grafana dashboard URL.
- Opt into editing for the selected context and namespace. The only implemented change is scaling a deployment, with a separate confirmation for each action. Editing resets when the context or namespace changes.

This is an early prototype, not a replacement for the Azure portal. It does **not** yet query Container Insights, managed Prometheus or Grafana, draw historical charts, discover Azure subscriptions, or automatically discover a Grafana dashboard. Historical monitoring depends on existing sources, retention and permissions. Saved investigations are not a metrics database.

## Install

Requires a VS Code Copilot-harness session with [canvases enabled](https://code.visualstudio.com/docs/agents/run/canvases), Node.js, `kubectl` on the extension host, and access to a kubeconfig and cluster. Kubernetes permissions and network connectivity still apply. The plugin runs commands locally as the current user; it does not install or configure AKS MCP.

In VS Code, use **Chat: Install Plugin from Source**, and choose the local repository folder or this repository's Git URL. Start a Copilot-harness session and ask it to open the **AKS Troubleshooting** canvas. Plugin installation and canvas availability depend on the host's supported plugin workflow; canvases are a preview feature.

For Copilot-assisted AKS investigation, optionally enable the existing [AKS MCP server](https://azure.github.io/vscode-aks-tools/features/aks-mcp-server-integration.html) or other approved tools. The canvas's own views use `kubectl`; they do not automatically call MCP tools. MCP access levels are guardrails, not security boundaries. Use a least-privileged identity.

## Safety and privacy

Read-only is the default for this canvas, not a restriction on other tools, processes or your Kubernetes credentials. Selecting edit mode does not grant privileges. Scaling takes effect immediately, can affect availability, and may be reverted by GitOps; review your deployment's current state and rollback plan first.

Logs and events can contain credentials or personal data. They are displayed locally but may be exposed to a model if you share them in chat. Treat cluster content as untrusted. Do not put secrets in findings. Explicitly saved findings include the context and namespace and are stored under `extension-data/pixelrobots-aks-troubleshooting/` in Copilot's home directory (`COPILOT_HOME`, or `~/.copilot`). The files are not encrypted; protect access to your machine and delete individual saved files when no longer needed. Kubernetes events are ephemeral and are not monitoring history.

## Develop

The plugin source is `.plugin/plugin.json`, `extensions/aks-canvas/` and `skills/`. It uses the SDK supplied by the Copilot host and has no npm dependencies. Run:

```powershell
node --test tests\*.test.mjs
node --check extensions\aks-canvas\extension.mjs
```

Tests use fake Kubernetes calls; they do not validate live Azure connectivity. To add troubleshooting skills, create another `skills/<name>/SKILL.md` following the [Agent Skills format](https://code.visualstudio.com/docs/agent-customization/agent-skills), and test it in a host session. Never add credentials to the repository.
