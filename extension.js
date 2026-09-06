const vscode = require("vscode");
const { execFile } = require("child_process");
const { registerServerViews } = require("./server/views");

const VIEW_ID = "tmuxSessionTabs";
const TERMINAL_PREFIX = "tmux: ";
const OPEN_TERMINALS_KEY = "tmuxSessionTabs.openTerminals.v1";
const CATALOG_KEY = "tmuxSessionTabs.sessionCatalog";
let terminalTracker;

function runTmux(args) {
  return new Promise((resolve, reject) => {
    execFile("tmux", args, { encoding: "utf8", timeout: 5000 }, (error, stdout, stderr) => {
      if (!error) {
        resolve(stdout.trim());
        return;
      }
      const message = `${stderr || error.message}`.trim();
      if (args[0] === "list-sessions" && (
        message.includes("no server running") || message.includes("no sessions")
        || /error connecting to .+: No such file or directory/.test(message)
      )) {
        resolve("");
        return;
      }
      reject(new Error(message));
    });
  });
}

async function listSessions() {
  const output = await runTmux([
    "list-sessions",
    "-F",
    "#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_path}\t#{session_activity}\t#{session_last_attached}\t#{session_id}\t#{session_created}",
  ]);
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [name, windows, attached, cwd, activity, lastAttached, id, created] = line.split("\t");
      const activityTime = Number.parseInt(activity, 10) || 0;
      const lastAttachedTime = Number.parseInt(lastAttached, 10) || 0;
      return {
        name,
        id,
        created: Number.parseInt(created, 10) || 0,
        windows: Number.parseInt(windows, 10) || 0,
        attached: Number.parseInt(attached, 10) || 0,
        cwd: cwd || "",
        lastActivity: Math.max(activityTime, lastAttachedTime),
      };
    })
    .filter((session) => session.name);
}

function formatTimestamp(epoch) {
  if (!epoch) return "No activity";
  const date = new Date(epoch * 1000);
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.toDateString() === now.toDateString()) return `Today ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${time}`;
}

function terminalName(sessionName) {
  return `${TERMINAL_PREFIX}${sessionName}`;
}

function terminalSessionName(terminal) {
  const name = terminal.creationOptions?.name || terminal.name;
  return name.startsWith(TERMINAL_PREFIX) ? name.slice(TERMINAL_PREFIX.length) : undefined;
}

function findTerminal(sessionName) {
  return vscode.window.terminals.find((terminal) => (
    terminalSessionName(terminal) === sessionName && terminal.exitStatus === undefined
  ));
}

class OpenTerminals {
  constructor(context) {
    this.storage = context.workspaceState;
    // The old global rememberedSessions list included terminals already closed by the user.
    const saved = this.storage.get(OPEN_TERMINALS_KEY, []);
    this.names = new Set(Array.isArray(saved) ? saved.filter((name) => typeof name === "string") : []);
    this.tracked = new Map();
    this.pendingWrite = Promise.resolve();
    this.disposed = false;
  }

  opened(terminal) {
    if (this.disposed || terminal.exitStatus !== undefined) return;
    const name = terminalSessionName(terminal);
    if (!name) return;
    this.tracked.set(terminal, name);
    if (!this.names.has(name)) {
      this.names.add(name);
      this.save();
    }
  }

  closed(terminal) {
    const name = this.tracked.get(terminal) || terminalSessionName(terminal);
    this.tracked.delete(terminal);
    if (this.disposed || !name) return;
    const reason = terminal.exitStatus?.reason;
    // Window shutdown and transport loss must not erase the last open terminals.
    if (![vscode.TerminalExitReason.User, vscode.TerminalExitReason.Extension, vscode.TerminalExitReason.Process].includes(reason)) return;
    const anotherOpen = vscode.window.terminals.some((other) => (
      other !== terminal && other.exitStatus === undefined && terminalSessionName(other) === name
    ));
    if (!anotherOpen) this.forget(name);
  }

  forget(name) {
    if (this.names.delete(name)) this.save();
    return this.pendingWrite;
  }

  save() {
    const snapshot = [...this.names];
    this.pendingWrite = this.pendingWrite
      .then(() => this.storage.update(OPEN_TERMINALS_KEY, snapshot))
      .catch((error) => { vscode.window.showErrorMessage(`Unable to save tmux terminal state: ${error.message}`); });
    return this.pendingWrite;
  }

  dispose() {
    this.disposed = true;
  }
}

function createTerminal(session) {
  const terminal = vscode.window.createTerminal({
    name: terminalName(session.name),
    shellPath: "tmux",
    shellArgs: ["attach-session", "-t", session.id],
    cwd: session.cwd || undefined,
    env: { TMUX: null },
    location: vscode.TerminalLocation.Panel,
    // This extension restores its exact open set; tmux owns process persistence.
    isTransient: true,
  });
  terminalTracker.opened(terminal);
  return terminal;
}

async function createSession() {
  const name = await vscode.window.showInputBox({
    prompt: "New tmux session name",
    placeHolder: "project-or-task",
    validateInput: (value) => {
      if (!value.trim()) return "Enter a session name.";
      if (/[\t\r\n]/.test(value)) return "Session names cannot contain newlines or tabs.";
      return undefined;
    },
  });
  if (!name) return;

  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const args = ["new-session", "-d", "-s", name.trim()];
  if (cwd) args.push("-c", cwd);
  try {
    await runTmux(args);
    await attachSession(name.trim());
  } catch (error) {
    vscode.window.showErrorMessage(`Unable to create tmux session: ${error.message}`);
  }
}

async function killSession(name) {
  const liveSessions = await listSessions();
  const target = liveSessions.find((session) => session.name === name);
  const confirmation = await vscode.window.showWarningMessage(
    target
      ? `Delete tmux session "${name}"? Every process in it will stop.`
      : `Remove the saved entry for "${name}"? The tmux session is already gone.`,
    { modal: true },
    "Continue",
  );
  if (confirmation !== "Continue") return false;

  const typedName = await vscode.window.showInputBox({
    prompt: `Type the exact session name to confirm: ${name}`,
    placeHolder: name,
    ignoreFocusOut: true,
    validateInput: (value) => value === name ? undefined : "The name must match exactly.",
  });
  if (typedName !== name) return false;

  try {
    const current = (await listSessions()).find((session) => session.name === name);
    if (current && (!target || current.id !== target.id || current.created !== target.created)) {
      vscode.window.showWarningMessage(`Session "${name}" changed during confirmation. Nothing was deleted.`);
      return false;
    }
    if (current) await runTmux(["kill-session", "-t", current.id]);
    return true;
  } catch (error) {
    vscode.window.showErrorMessage(`Unable to kill tmux session: ${error.message}`);
    return false;
  }
}

async function attachSession(name, { restoring = false } = {}) {
  let terminal = findTerminal(name);
  if (!terminal) {
    const sessions = await listSessions();
    if (restoring && (terminalTracker.disposed || !terminalTracker.names.has(name))) return;
    const session = sessions.find((item) => item.name === name);
    if (!session) {
      vscode.window.showWarningMessage(`Tmux session "${name}" no longer exists.`);
      return;
    }
    terminal = findTerminal(name) || createTerminal(session);
  }
  terminalTracker.opened(terminal);
  if (!restoring) terminal.show(false);
  await terminalTracker.pendingWrite;
}

class SessionTabsView {
  constructor(extensionContext) {
    this.context = extensionContext;
    this.view = undefined;
    this.sessions = [];
    this.liveSessions = [];
    this.catalog = this.context.globalState.get(CATALOG_KEY, {}) || {};
    this.refreshTimer = undefined;
    this.refreshPromise = undefined;
    this.deleting = new Set();
    this.initialization = undefined;
  }

  async resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    webviewView.webview.html = this.html(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(async (message) => {
      try {
        if (message.type === "refresh") await this.refresh();
        if (message.type === "new") { await createSession(); await this.refresh(); }
        if (message.type === "openAll") await this.openAll();
        if (message.type === "attach" && typeof message.name === "string") {
          await attachSession(message.name);
          await this.refresh();
        }
        if (message.type === "delete" && typeof message.name === "string") {
          await this.deleteSession(message.name);
        }
        if (message.type === "close" && typeof message.name === "string") {
          await this.closeTerminal(message.name);
        }
      } catch (error) {
        vscode.window.showErrorMessage(`Tmux Sessions: ${error.message}`);
      }
    }, undefined, this.context.subscriptions);
    this.startPolling();
    await this.initialize();
    await this.refresh();
  }

  initialize() {
    if (!this.initialization) {
      this.initialization = this.restoreOpenTerminals().then(() => this.refresh()).catch((error) => {
        vscode.window.showErrorMessage(`Unable to restore tmux terminals: ${error.message}`);
      });
    }
    return this.initialization;
  }

  startPolling() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    const interval = vscode.workspace.getConfiguration("tmuxSessionTabs").get("pollIntervalMs", 2500);
    this.refreshTimer = setInterval(() => this.refresh(), interval);
  }

  refresh() {
    if (!this.refreshPromise) {
      this.refreshPromise = this.readSessions().finally(() => { this.refreshPromise = undefined; });
    }
    return this.refreshPromise;
  }

  async readSessions() {
    try {
      this.liveSessions = await listSessions();
      const nextCatalog = Object.assign(Object.create(null), this.catalog);
      for (const session of this.liveSessions) {
        const previous = nextCatalog[session.name] || {};
        nextCatalog[session.name] = {
          name: session.name,
          windows: session.windows,
          cwd: session.cwd,
          lastActivity: Math.max(session.lastActivity || 0, previous.lastActivity || 0),
        };
      }
      if (JSON.stringify(nextCatalog) !== JSON.stringify(this.catalog)) {
        this.catalog = nextCatalog;
        await this.context.globalState.update(CATALOG_KEY, this.catalog);
      }

      const openNames = new Set(vscode.window.terminals
        .filter((terminal) => terminal.exitStatus === undefined)
        .map(terminalSessionName).filter(Boolean));
      const liveNames = new Set(this.liveSessions.map((session) => session.name));
      const stateRank = { open: 0, active: 1, idle: 2, off: 3 };
      this.sessions = [
        ...this.liveSessions.map((session) => ({
          ...session,
          state: openNames.has(session.name) ? "open" : session.attached > 0 ? "active" : "idle",
          timestamp: formatTimestamp(session.lastActivity),
        })),
        ...Object.values(this.catalog)
          .filter((session) => !liveNames.has(session.name))
          .map((session) => ({
            ...session,
            attached: 0,
            state: "off",
            timestamp: formatTimestamp(session.lastActivity),
          })),
      ].sort((left, right) => (
        (stateRank[left.state] - stateRank[right.state])
        || ((right.lastActivity || 0) - (left.lastActivity || 0))
        || left.name.localeCompare(right.name)
      ));
      if (this.view) {
        this.view.webview.postMessage({ type: "sessions", sessions: this.sessions, openNames: [...openNames] });
      }
    } catch (error) {
      if (this.view) this.view.webview.postMessage({ type: "error", message: error.message });
    }
  }

  async openAll() {
    for (const session of this.liveSessions) {
      await attachSession(session.name);
    }
    await this.refresh();
  }

  async restoreOpenTerminals() {
    if (!vscode.workspace.getConfiguration("tmuxSessionTabs").get("autoRestore", true)) return;
    const previouslyOpen = [...terminalTracker.names];
    if (!previouslyOpen.length) return;
    const available = new Set((await listSessions()).map((session) => session.name));
    for (const name of previouslyOpen) {
      if (terminalTracker.disposed) return;
      if (!available.has(name)) await terminalTracker.forget(name);
      else if (terminalTracker.names.has(name) && !findTerminal(name)) {
        await attachSession(name, { restoring: true });
      }
    }
  }

  async closeTerminal(name) {
    await terminalTracker.forget(name);
    for (const terminal of [...vscode.window.terminals]) {
      if (terminalSessionName(terminal) === name) terminal.dispose();
    }
    await this.refresh();
  }

  async deleteSession(name) {
    if (this.deleting.has(name)) return;
    this.deleting.add(name);
    try {
      const deleted = await killSession(name);
      if (!deleted) return;
      if (this.refreshPromise) await this.refreshPromise;
      const nextCatalog = { ...this.catalog };
      delete nextCatalog[name];
      this.catalog = nextCatalog;
      await this.context.globalState.update(CATALOG_KEY, this.catalog);
      await terminalTracker.forget(name);
      await this.refresh();
    } finally {
      this.deleting.delete(name);
    }
  }

  html(webview) {
    const nonce = [...Array(16)].map(() => Math.random().toString(36)[2]).join("");
    const icons = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "codicon.css"));
    return `<!doctype html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src data:; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${icons}">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; letter-spacing: 0; }
  body { margin: 0; padding: 6px 0; font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground); }
  button { font: inherit; }
  header { display: flex; align-items: center; gap: 6px; padding: 0 8px 6px; }
  header strong { flex: 1; font-size: 11px; font-weight: 600; min-width: 0; }
  .icon-button { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 26px; height: 26px; border: 0; background: transparent; color: var(--vscode-foreground); cursor: pointer; padding: 0; border-radius: 3px; }
  .icon-button:hover { background: var(--vscode-toolbar-hoverBackground, #8882); }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: 2px; }
  #tabs { display: flex; flex-direction: column; gap: 6px; padding: 0 8px 6px; min-width: 0; }
  .tab { --state-color: var(--vscode-descriptionForeground, #888); width: 100%; min-width: 0; border: 1px solid var(--state-color); border-left-width: 3px; background: var(--vscode-editorWidget-background, #252526); border-radius: 4px; overflow: hidden; }
  .tab.state-open { --state-color: var(--vscode-testing-iconPassed, #388a34); }
  .tab.state-active { --state-color: var(--vscode-charts-blue, #3794ff); }
  .tab.state-idle { --state-color: var(--vscode-charts-yellow, #cca700); }
  .tab.state-off { border-style: dashed; }
  .attach { display: block; width: 100%; padding: 8px 8px 6px; border: 0; color: var(--vscode-foreground); background: color-mix(in srgb, var(--state-color) 14%, var(--vscode-editorWidget-background, #252526)); cursor: pointer; text-align: left; }
  .attach:hover:not(:disabled) { background: color-mix(in srgb, var(--state-color) 23%, var(--vscode-editorWidget-background, #252526)); }
  .attach:disabled { cursor: default; }
  .attach:focus-visible { outline-offset: -2px; }
  .tab-main, .tab-details, .tab-actions { display: flex; align-items: center; min-width: 0; }
  .tab-main { flex-wrap: wrap; gap: 4px 8px; }
  .name { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; font-size: 12px; font-weight: 600; }
  .timestamp { flex: 0 0 auto; font-size: 10px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
  .tab-details { flex-wrap: wrap; gap: 4px 8px; padding: 3px 6px 3px 8px; font-size: 10px; }
  .state-badge { display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; font-size: 9px; font-weight: 600; }
  .state-badge::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--state-color); }
  .window-count { color: var(--vscode-descriptionForeground); white-space: nowrap; }
  .tab-actions { margin-left: auto; gap: 6px; }
  .close { width: 24px; height: 24px; }
  .close:disabled { opacity: .35; cursor: default; background: transparent; }
  .delete { width: 24px; height: 24px; color: var(--vscode-descriptionForeground); }
  .delete:hover { color: var(--vscode-errorForeground, #f14c4c); background: var(--vscode-inputValidation-errorBackground, #f142); }
  .empty { color: var(--vscode-descriptionForeground); padding: 8px; font-size: 11px; }
</style></head><body>
<header><strong>Sessions <span id="count"></span></strong><button class="icon-button" id="new" title="New tmux session" aria-label="New tmux session"><i class="codicon codicon-add" aria-hidden="true"></i></button><button class="icon-button" id="all" title="Open all live sessions" aria-label="Open all live sessions"><i class="codicon codicon-terminal" aria-hidden="true"></i></button><button class="icon-button" id="refresh" title="Refresh sessions" aria-label="Refresh sessions"><i class="codicon codicon-refresh" aria-hidden="true"></i></button></header>
<div id="tabs" aria-label="Tmux sessions"></div><div id="error" class="empty" role="alert" hidden></div>
<script nonce="${nonce}">
  const api = acquireVsCodeApi();
  const tabs = document.getElementById('tabs');
  const error = document.getElementById('error');
  const formatTimestamp = ${formatTimestamp.toString()};
  const states = {
    open: ['OPEN HERE', 'Terminal open in this VS Code window'],
    active: ['ATTACHED', 'A tmux client is attached elsewhere'],
    idle: ['BACKGROUND', 'Running on the server without an attached client'],
    off: ['OFF', 'No live tmux session; saved entry only'],
  };
  function render(sessions) {
    error.hidden = true;
    document.getElementById('count').textContent = '(' + sessions.length + ')';
    if (!sessions.length) { tabs.innerHTML = '<div class="empty">No tmux sessions</div>'; return; }
    const existing = new Map([...tabs.querySelectorAll('.tab')].map((tab) => [tab.dataset.name, tab]));
    const names = new Set(sessions.map((session) => session.name));
    for (const node of [...tabs.children]) if (!names.has(node.dataset.name)) node.remove();
    for (const [index, session] of sessions.entries()) {
      const state = states[session.state] ? session.state : 'off';
      const tab = existing.get(session.name) || document.createElement('article');
      tab.className = 'tab state-' + state;
      tab.dataset.name = session.name;
      tab.dataset.state = state;
      if (!tab.children.length) {
        tab.innerHTML = '<button class="attach" data-action="attach"><span class="tab-main"><span class="name"></span><time class="timestamp"></time></span></button>'
          + '<div class="tab-details"><span class="state-badge"></span><span class="window-count"></span><div class="tab-actions"><button class="icon-button close" data-action="close"><i class="codicon codicon-close" aria-hidden="true"></i></button><button class="icon-button delete" data-action="delete"><i class="codicon codicon-trash" aria-hidden="true"></i></button></div></div>';
      }
      tab.querySelector('.name').textContent = session.name;
      const attach = tab.querySelector('.attach');
      attach.disabled = state === 'off';
      attach.title = state === 'off' ? states.off[1] : 'Open terminal for ' + session.name;
      attach.setAttribute('aria-label', attach.title);
      const timestamp = tab.querySelector('.timestamp');
      timestamp.textContent = formatTimestamp(session.lastActivity);
      timestamp.title = session.lastActivity ? 'Last tmux activity: ' + new Date(session.lastActivity * 1000).toLocaleString() : 'No recorded activity';
      const badge = tab.querySelector('.state-badge');
      badge.textContent = states[state][0];
      badge.title = states[state][1];
      tab.querySelector('.window-count').textContent = state === 'off' ? '' : session.windows === 1 ? '1 window' : session.windows + ' windows';
      const close = tab.querySelector('.close');
      close.disabled = state !== 'open';
      close.title = 'Close terminal for ' + session.name + '; keep tmux running';
      close.setAttribute('aria-label', close.title);
      const remove = tab.querySelector('.delete');
      remove.title = state === 'off' ? 'Remove saved entry for ' + session.name : 'Delete ' + session.name + '...';
      remove.setAttribute('aria-label', remove.title);
      if (tabs.children[index] !== tab) tabs.insertBefore(tab, tabs.children[index] || null);
    }
  }
  document.getElementById('new').onclick = () => api.postMessage({type:'new'});
  document.getElementById('all').onclick = () => api.postMessage({type:'openAll'});
  document.getElementById('refresh').onclick = () => api.postMessage({type:'refresh'});
  tabs.addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (!tab) return;
    const name = tab.dataset.name;
    const action = event.target.closest('button[data-action]');
    if (action && !action.disabled) api.postMessage({type: action.dataset.action, name});
  });
  window.addEventListener('message', (event) => {
    if (event.data.type === 'sessions') render(event.data.sessions);
    if (event.data.type === 'error') { error.textContent = event.data.message; error.hidden = false; }
  });
  api.postMessage({type:'refresh'});
</script></body></html>`;
  }

  dispose() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }
}

function activate(context) {
  terminalTracker = new OpenTerminals(context);
  const provider = new SessionTabsView(context);
  context.subscriptions.push(
    terminalTracker,
    provider,
    vscode.window.onDidOpenTerminal((terminal) => {
      terminalTracker.opened(terminal);
      void provider.refresh();
    }),
    vscode.window.onDidCloseTerminal((terminal) => {
      terminalTracker.closed(terminal);
      void provider.refresh();
    }),
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("tmuxSessionTabs.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("tmuxSessionTabs.newSession", () => createSession()),
    vscode.commands.registerCommand("tmuxSessionTabs.openAll", () => provider.openAll()),
  );
  for (const terminal of vscode.window.terminals) terminalTracker.opened(terminal);
  registerServerViews(context, { attachSession });
  return provider.initialize();
}

function deactivate() {
  terminalTracker?.dispose();
  return terminalTracker?.pendingWrite;
}

module.exports = { activate, deactivate };
