const vscode = require("vscode");
const fs = require("node:fs/promises");
const { randomBytes } = require("node:crypto");
const { AgentSampler } = require("./agents");
const { ResourceSampler } = require("./resources");

const LABELS_KEY = "tmuxSessionTabs.agentLabels";

class MonitorView {
  constructor(context, kind, { attachSession, sampler } = {}) {
    this.context = context;
    this.kind = kind;
    this.attachSession = attachSession;
    this.sampler = sampler || (kind === "agents" ? new AgentSampler() : new ResourceSampler());
    this.agents = [];
    this.pending = undefined;
    this.view = undefined;
    this.timer = undefined;
    this.disposed = false;
    this.naming = false;
    this.subscriptions = [];
  }

  resolveWebviewView(view) {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions = [];
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")] };
    view.webview.html = this.html(view.webview);
    this.subscriptions.push(
      view.webview.onDidReceiveMessage((message) => this.handleMessage(message)),
      view.onDidChangeVisibility(() => this.poll()),
      view.onDidDispose(() => {
        if (this.timer) clearInterval(this.timer);
        if (this.view === view) this.view = undefined;
      }),
    );
    this.poll();
  }

  poll() {
    if (this.timer) clearInterval(this.timer);
    if (!this.view?.visible || this.disposed) return;
    const configured = vscode.workspace.getConfiguration("tmuxSessionTabs").get("monitorIntervalMs", 3000);
    const interval = Math.max(1000, Number(configured) || 3000);
    void this.refresh();
    this.timer = setInterval(() => this.refresh(), interval);
  }

  refresh() {
    if (this.disposed || !this.view) return Promise.resolve();
    if (!this.pending) {
      this.pending = this.read().catch((error) => {
        this.view?.webview.postMessage({ type: "error", message: error.message });
      }).finally(() => { this.pending = undefined; });
    }
    return this.pending;
  }

  async read() {
    let data;
    if (this.kind === "agents") {
      this.agents = await this.sampler.read();
      const labels = this.context.globalState.get(LABELS_KEY, {});
      data = { agents: this.agents.map((agent) => ({ ...agent, name: labels[agent.key] || agent.name })), sampledAt: Date.now() };
    } else {
      const directories = (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
      data = await this.sampler.read(directories);
    }
    if (!this.disposed) this.view?.webview.postMessage({ type: "data", kind: this.kind, data });
  }

  async handleMessage(message) {
    try {
      if (message?.type === "refresh") { await this.refresh(); return; }
      if (this.kind !== "agents" || typeof message?.key !== "string") return;
      const agent = this.agents.find((item) => item.key === message.key);
      if (!agent) return;
      if (message.type === "name" && !this.naming) {
        this.naming = true;
        try {
          const labels = this.context.globalState.get(LABELS_KEY, {});
          const name = await vscode.window.showInputBox({
            prompt: "Agent name or short note", value: labels[agent.key] || "", placeHolder: agent.name,
            validateInput: (value) => value.length > 100 || /[\r\n]/.test(value) ? "Use one line of at most 100 characters." : undefined,
          });
          if (name !== undefined) {
            const latest = { ...this.context.globalState.get(LABELS_KEY, {}) };
            if (name.trim()) latest[agent.key] = name.trim();
            else delete latest[agent.key];
            await this.context.globalState.update(LABELS_KEY, latest);
            await this.refresh();
          }
        } finally { this.naming = false; }
      }
      if (message.type === "folder" && agent.cwd) {
        if (!(await fs.stat(agent.cwd)).isDirectory()) return;
        await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(agent.cwd), { forceNewWindow: true });
      }
      if (message.type === "terminal" && agent.session && this.attachSession) await this.attachSession(agent.session);
    } catch (error) {
      vscode.window.showErrorMessage(`Server monitor: ${error.message}`);
    }
  }

  html(webview) {
    const asset = (file) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", file));
    const nonce = randomBytes(16).toString("hex");
    return `<!doctype html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src data:; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${asset("codicon.css")}"><link rel="stylesheet" href="${asset("server-monitor.css")}">
</head><body data-view="${this.kind}">
<header><strong>${this.kind === "agents" ? "Agents" : "Resources"} <span id="count"></span></strong><time id="updated"></time><button id="refresh" class="icon-button" title="Refresh" aria-label="Refresh"><i class="codicon codicon-refresh" aria-hidden="true"></i></button></header>
<div id="error" role="alert" hidden></div><main id="content"><div class="empty">Loading...</div></main>
<script nonce="${nonce}" src="${asset("server-monitor.js")}"></script></body></html>`;
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}

function registerServerViews(context, options) {
  for (const [id, kind] of [["tmuxServerAgents", "agents"], ["tmuxServerResources", "resources"]]) {
    const provider = new MonitorView(context, kind, options);
    context.subscriptions.push(
      provider,
      vscode.window.registerWebviewViewProvider(id, provider, { webviewOptions: { retainContextWhenHidden: true } }),
    );
  }
}

module.exports = { MonitorView, registerServerViews };
