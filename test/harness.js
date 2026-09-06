const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");

function session(name, id, attached = 0, activity = 100) {
  return { name, id, attached, lastActivity: activity, created: 1, windows: 1, cwd: "/tmp" };
}

function harness(sessions = [], initialState = {}, options = {}) {
  const state = new Map(Object.entries(initialState));
  const workspaceState = new Map(Object.entries(options.workspaceState || {}));
  const onOpen = new Set();
  const onClose = new Set();
  const exitReasons = { Unknown: 0, Shutdown: 1, Process: 2, User: 3, Extension: 4 };
  const h = { sessions, calls: [], warnings: [], errors: [], messages: [], terminals: [] };
  const memento = (values) => ({
    get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
    update: async (key, value) => { values.set(key, value); },
  });
  const context = {
    subscriptions: [],
    extensionUri: pathToFileURL(path.resolve(__dirname, "..")),
    globalState: memento(state),
    workspaceState: memento(workspaceState),
  };
  const subscribe = (listeners) => (listener) => {
    listeners.add(listener);
    return { dispose: () => listeners.delete(listener) };
  };
  h.openTerminal = (terminalOptions) => {
    const terminal = {
      ...terminalOptions,
      creationOptions: { ...terminalOptions },
      show() { this.showCount = (this.showCount || 0) + 1; },
      dispose() { h.closeTerminal(this, exitReasons.Extension); },
    };
    h.terminals.push(terminal);
    for (const listener of onOpen) listener(terminal);
    return terminal;
  };
  h.closeTerminal = (terminal, reason = exitReasons.User) => {
    const index = h.terminals.indexOf(terminal);
    if (index >= 0) h.terminals.splice(index, 1);
    terminal.exitStatus = { reason, code: 0 };
    for (const listener of onClose) listener(terminal);
  };
  for (const terminalOptions of options.terminals || []) h.openTerminal(terminalOptions);
  const vscode = {
    Uri: { joinPath: (base, ...segments) => new URL(base.href + "/" + segments.join("/")) },
    TerminalLocation: { Panel: 1 },
    TerminalExitReason: exitReasons,
    workspace: { getConfiguration: () => ({ get: (key, fallback) => options.configuration?.[key] ?? fallback }) },
    commands: { registerCommand: () => ({ dispose() {} }) },
    window: {
      terminals: h.terminals,
      onDidOpenTerminal: subscribe(onOpen),
      onDidCloseTerminal: subscribe(onClose),
      registerWebviewViewProvider: (id, provider) => { h.provider = provider; return { dispose() {} }; },
      showWarningMessage: async (...args) => { h.warnings.push(args); return h.confirm; },
      showInputBox: async (options) => { h.inputOptions = options; if (h.onInput) h.onInput(); return h.typed; },
      showErrorMessage: (message) => h.errors.push(message),
      createTerminal: h.openTerminal,
    },
  };
  function execFile(command, args, options, callback) {
    h.calls.push([...args]);
    if (h.failure) return callback(new Error(h.failure), "", h.failure);
    if (args[0] === "kill-session") {
      h.sessions = h.sessions.filter((item) => item.id !== args[2]);
      return callback(null, "", "");
    }
    if (args[0] !== "list-sessions") throw new Error("Unexpected tmux mutation in test");
    const output = h.sessions.map((item) => {
      const fields = {
        session_name: item.name, session_id: item.id, session_windows: item.windows,
        session_attached: item.attached, session_path: item.cwd,
        session_activity: item.lastActivity, session_last_attached: item.lastActivity,
        session_created: item.created,
      };
      return args[2].replace(/#\{(\w+)\}/g, (_, key) => fields[key] ?? "");
    }).join("\n");
    callback(null, output, "");
  }
  const sandbox = {
    require: (name) => name === "vscode" ? vscode : name === "child_process" ? { execFile } : require(name),
    module: { exports: {} },
    setInterval: () => 1, clearInterval: () => {}, console,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../extension.js"), "utf8"), sandbox);
  h.ready = sandbox.module.exports.activate(context);
  h.context = context;
  h.tracker = context.subscriptions[0];
  h.provider.view = { webview: {
    postMessage: (message) => { h.messages.push(message); },
    onDidReceiveMessage: (listener) => { h.receive = listener; },
    cspSource: "file:", asWebviewUri: (uri) => uri.href,
  } };
  h.flush = async () => {
    await h.tracker.pendingWrite;
    if (h.provider.refreshPromise) await h.provider.refreshPromise;
  };
  h.workspaceSnapshot = () => Object.fromEntries(workspaceState);
  h.deactivate = async () => {
    await sandbox.module.exports.deactivate();
    for (const disposable of context.subscriptions) disposable.dispose();
  };
  h.exitReasons = exitReasons;
  h.html = () => h.provider.html({ cspSource: "file:", asWebviewUri: (uri) => uri.href });
  return h;
}

module.exports = { harness, session };
