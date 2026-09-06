const test = require("node:test");
const assert = require("node:assert/strict");
const { monitorHarness } = require("./monitor-harness");

const agent = { key: "boot:123:100", name: "project-alpha", tool: "Codex", cwd: __dirname, session: "task-alpha", pid: 123 };

test("the two monitor views register independently and never start terminals while loading", async () => {
  const h = monitorHarness("agents", async () => [agent]);
  h.register();
  assert.deepEqual(h.registrations.map((entry) => entry.id), ["tmuxServerAgents", "tmuxServerResources"]);
  assert.equal(h.registrations[0].provider.kind, "agents");
  assert.equal(h.registrations[1].provider.kind, "resources");
  await h.mount();
  assert.equal(h.messages.at(-1).data.agents[0].cwd, __dirname);
  assert.equal(h.attached.length, 0);
  assert.equal(h.commands.length, 0);
  assert.equal(h.stored.size, 0);
});

test("hidden and disposed views stop polling", async () => {
  let reads = 0;
  const h = monitorHarness("agents", async () => { reads++; return []; });
  await h.mount();
  assert.equal(reads, 1);
  assert.equal(h.timers.size, 1);
  h.view.visible = false;
  h.visibility();
  assert.equal(h.timers.size, 0);
  h.view.visible = true;
  h.visibility();
  await h.provider.pending;
  assert.equal(reads, 2);
  h.provider.dispose();
  assert.equal(h.timers.size, 0);
  await h.provider.refresh();
  assert.equal(reads, 2);
});

test("agent labels persist separately without changing process or restore state", async () => {
  const h = monitorHarness("agents", async () => [agent]);
  await h.mount();
  h.typed = "Test the next version";
  await h.receive({ type: "name", key: agent.key });
  assert.deepEqual([...h.stored.keys()], ["tmuxSessionTabs.agentLabels"]);
  assert.equal(h.messages.at(-1).data.agents[0].name, "Test the next version");
  assert.equal(agent.name, "project-alpha");
  assert.equal(h.attached.length, 0);
  h.typed = "";
  await h.receive({ type: "name", key: agent.key });
  assert.equal(h.messages.at(-1).data.agents[0].name, "project-alpha");
  assert.ok(h.inputOptions.validateInput("x".repeat(101)));
});

test("only explicit valid actions attach or open a known agent directory", async () => {
  const h = monitorHarness("agents", async () => [agent]);
  await h.mount();
  await h.receive({ type: "terminal", key: "stale-process" });
  await h.receive({ type: "folder", key: agent.key, cwd: "/untrusted" });
  assert.equal(h.commands[0][0], "vscode.openFolder");
  assert.equal(h.commands[0][1].pathname, __dirname);
  assert.equal(h.commands[0][2].forceNewWindow, true);
  assert.equal(h.attached.length, 0);
  await h.receive({ type: "terminal", key: agent.key });
  assert.deepEqual(h.attached, ["task-alpha"]);
});

test("resource view reads the workspace disks and ignores agent actions", async () => {
  let paths;
  const h = monitorHarness("resources", async (directories) => { paths = directories; return { cores: 2 }; });
  await h.mount();
  assert.deepEqual(Array.from(paths), ["/projects/alpha"]);
  assert.equal(h.messages.at(-1).kind, "resources");
  await h.receive({ type: "terminal", key: agent.key });
  assert.equal(h.attached.length, 0);
});

test("concurrent refreshes coalesce and sampling errors preserve the previous display", async () => {
  let reads = 0;
  let resolve;
  let failing = false;
  const h = monitorHarness("agents", () => {
    reads++;
    if (failing) return Promise.reject(new Error("Probe unavailable"));
    return new Promise((done) => { resolve = done; });
  });
  h.provider.resolveWebviewView(h.view);
  const first = h.provider.refresh();
  const second = h.provider.refresh();
  assert.equal(first, second);
  resolve([agent]);
  await first;
  assert.equal(reads, 1);
  failing = true;
  await h.provider.refresh();
  assert.equal(h.messages.at(-1).type, "error");
  assert.equal(h.messages.at(-1).message, "Probe unavailable");
  assert.equal(h.provider.agents.length, 1);
});
