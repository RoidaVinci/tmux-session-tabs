const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");

function monitorHarness(kind = "agents", read = async () => []) {
  const entry = path.resolve(__dirname, "../server/views.js");
  const localRequire = createRequire(entry);
  const stored = new Map();
  const h = { messages: [], errors: [], attached: [], commands: [], timers: new Set(), registrations: [] };
  const context = {
    extensionUri: pathToFileURL(path.resolve(__dirname, "..")), subscriptions: [],
    globalState: { get: (key, fallback) => stored.has(key) ? stored.get(key) : fallback, update: async (key, value) => { stored.set(key, value); } },
  };
  const vscode = {
    Uri: { joinPath: (base, ...parts) => new URL(base.href + "/" + parts.join("/")), file: (name) => pathToFileURL(name) },
    window: {
      showInputBox: async (options) => { h.inputOptions = options; return h.typed; },
      showErrorMessage: (message) => h.errors.push(message),
      registerWebviewViewProvider: (id, provider) => { h.registrations.push({ id, provider }); return { dispose() {} }; },
    },
    workspace: { getConfiguration: () => ({ get: (_, fallback) => fallback }), workspaceFolders: [{ uri: { fsPath: "/projects/alpha" } }] },
    commands: { executeCommand: async (...args) => h.commands.push(args) },
  };
  const sandbox = {
    require: (name) => name === "vscode" ? vscode : localRequire(name), module: { exports: {} },
    setInterval: (fn) => { const timer = { fn }; h.timers.add(timer); return timer; },
    clearInterval: (timer) => h.timers.delete(timer), console,
  };
  vm.runInNewContext(fs.readFileSync(entry, "utf8"), sandbox, { filename: entry });
  const { MonitorView, registerServerViews } = sandbox.module.exports;
  h.provider = new MonitorView(context, kind, { sampler: { read }, attachSession: async (name) => h.attached.push(name) });
  const disposable = () => ({ dispose() {} });
  h.view = {
    visible: true,
    webview: {
      cspSource: "file:", asWebviewUri: (uri) => uri.href,
      onDidReceiveMessage: (fn) => { h.receive = fn; return disposable(); },
      postMessage: (message) => h.messages.push(message),
    },
    onDidChangeVisibility: (fn) => { h.visibility = fn; return disposable(); },
    onDidDispose: (fn) => { h.disposeView = fn; return disposable(); },
  };
  h.mount = async () => { h.provider.resolveWebviewView(h.view); if (h.provider.pending) await h.provider.pending; };
  h.stored = stored;
  h.context = context;
  h.register = () => registerServerViews(context, {});
  return h;
}

module.exports = { monitorHarness };
