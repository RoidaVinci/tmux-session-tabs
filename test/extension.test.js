const test = require("node:test");
const assert = require("node:assert/strict");
const { harness, session } = require("./harness");
const legacyKey = "tmuxSessionTabs.rememberedSessions";
const openKey = "tmuxSessionTabs.openTerminals.v1";
const catalogKey = "tmuxSessionTabs.sessionCatalog";
const kills = (h) => h.calls.filter((call) => call[0] === "kill-session");

test("groups live states, sorts by activity then name, and keeps missing sessions OFF", async () => {
  const h = harness([
    session("zebra", "$1", 0, 800), session("alpha", "$2", 0, 800),
    session("newest-background", "$3", 0, 900), session("attached", "$4", 1, 100),
    session("open-here", "$5", 1, 50),
  ], { [catalogKey]: { old: { name: "old", lastActivity: 1000 } } });
  await h.ready;
  h.openTerminal({ name: "tmux: open-here" });
  await h.provider.refresh();
  assert.deepEqual(Array.from(h.provider.sessions, (s) => s.name), [
    "open-here", "attached", "newest-background", "alpha", "zebra", "old",
  ]);
  assert.deepEqual(Array.from(h.provider.sessions, (s) => s.state), ["open", "active", "idle", "idle", "idle", "off"]);
  h.sessions = [];
  await h.provider.refresh();
  assert.equal(h.provider.sessions.length, 6);
  assert.ok(h.provider.sessions.every((s) => s.state === "off"));
  assert.equal(kills(h).length, 0);
});

test("cancelling either confirmation or entering a non-exact name never kills", async () => {
  for (const [confirm, typed] of [[undefined, "demo"], ["Continue", undefined], ["Continue", "demo "], ["Continue", "DEMO"]]) {
    const h = harness([session("demo", "$11")], {}, { workspaceState: { [openKey]: ["demo"] } });
    await h.ready;
    await h.provider.refresh();
    h.confirm = confirm;
    h.typed = typed;
    await h.provider.deleteSession("demo");
    assert.equal(kills(h).length, 0);
    assert.equal(h.sessions.length, 1);
    assert.ok(h.context.globalState.get(catalogKey).demo);
    assert.ok(h.context.workspaceState.get(openKey).includes("demo"));
  }
});

test("confirmed deletion targets the unique ID and preserves similarly named sessions", async () => {
  const h = harness([session("demo", "$11"), session("demo-long", "$12")], {}, { workspaceState: { [openKey]: ["demo", "demo-long"] } });
  await h.ready;
  await h.provider.refresh();
  h.confirm = "Continue";
  h.typed = "demo";
  await h.provider.deleteSession("demo");
  assert.deepEqual(kills(h), [["kill-session", "-t", "$11"]]);
  assert.deepEqual(h.sessions.map((s) => s.name), ["demo-long"]);
  assert.equal(h.context.globalState.get(catalogKey).demo, undefined);
  assert.deepEqual(Array.from(h.context.workspaceState.get(openKey)), ["demo-long"]);
  assert.equal(h.inputOptions.validateInput("demo"), undefined);
  assert.ok(h.inputOptions.validateInput("Demo"));
});

test("a replacement or newly started session during confirmation is never killed", async () => {
  for (const initial of [[session("demo", "$11")], []]) {
    const h = harness(initial);
    await h.ready;
    await h.provider.refresh();
    h.confirm = "Continue";
    h.typed = "demo";
    h.onInput = () => { h.sessions = [session("demo", "$99")]; };
    await h.provider.deleteSession("demo");
    assert.equal(kills(h).length, 0);
    assert.equal(h.sessions[0].id, "$99");
    assert.ok(h.warnings.some(([message]) => message.includes("changed during confirmation")));
  }
  const h = harness([session("demo", "$11")]);
  await h.ready;
  h.confirm = "Continue";
  h.typed = "demo";
  h.onInput = () => { h.sessions[0].created = 200; };
  await h.provider.deleteSession("demo");
  assert.equal(kills(h).length, 0);
});

test("removing an OFF entry only removes history", async () => {
  const h = harness([], { [catalogKey]: { demo: { name: "demo", lastActivity: 100 } } });
  await h.ready;
  await h.provider.refresh();
  h.confirm = "Continue";
  h.typed = "demo";
  await h.provider.deleteSession("demo");
  assert.equal(kills(h).length, 0);
  assert.equal(h.provider.sessions.length, 0);
});

test("initialization never opens background or attached sessions, including the old accumulated list", async () => {
  for (const legacyState of [{}, { [legacyKey]: ["demo", "other-client"] }]) {
    const h = harness([session("demo", "$11"), session("other-client", "$12", 2)], legacyState);
    await h.ready;
    assert.equal(h.terminals.length, 0);
    assert.equal(h.tracker.names.size, 0);
    assert.deepEqual(Array.from(h.provider.sessions, (s) => s.state), ["active", "idle"]);
  }
});

test("open A and B, close B, reload: only A reopens while background sessions survive", async () => {
  const sessions = [session("A", "$11"), session("B", "$12"), session("background", "$13")];
  const h = harness(sessions);
  await h.ready;
  const a = h.openTerminal({ name: "tmux: A" });
  const b = h.openTerminal({ name: "tmux: B" });
  h.closeTerminal(b, h.exitReasons.User);
  h.closeTerminal(a, h.exitReasons.Shutdown);
  await h.flush();
  await h.deactivate();
  const next = harness(sessions, {}, { workspaceState: h.workspaceSnapshot() });
  await next.ready;
  assert.deepEqual(next.terminals.map((t) => t.name), ["tmux: A"]);
  assert.equal(next.terminals[0].showCount, undefined);
  assert.equal(next.terminals[0].isTransient, true);
  assert.deepEqual(Array.from(next.terminals[0].shellArgs), ["attach-session", "-t", "$11"]);
  assert.equal(next.sessions.length, 3);
  assert.equal(kills(h).length + kills(next).length, 0);
});

test("the X action closes the terminal without killing tmux or reopening on another view initialization", async () => {
  const h = harness([session("demo", "$11", 1)]);
  await h.ready;
  await h.provider.resolveWebviewView(h.provider.view);
  await h.receive({ type: "attach", name: "demo" });
  assert.equal(h.terminals.length, 1);
  await h.receive({ type: "close", name: "demo" });
  await h.flush();
  await h.provider.initialize();
  assert.equal(h.terminals.length, 0);
  assert.equal(h.sessions.length, 1);
  assert.deepEqual(Array.from(h.context.workspaceState.get(openKey)), []);
  assert.equal(kills(h).length, 0);
});

test("shutdown and unknown connection loss preserve the saved open set", async () => {
  for (const reason of [0, 1]) {
    const h = harness([session("demo", "$11")]);
    await h.ready;
    const terminal = h.openTerminal({ name: "tmux: demo" });
    h.closeTerminal(terminal, reason);
    await h.flush();
    const next = harness(h.sessions, {}, { workspaceState: h.workspaceSnapshot() });
    await next.ready;
    assert.deepEqual(next.terminals.map((t) => t.name), ["tmux: demo"]);
  }
});

test("user close, extension dispose, and process exit remove terminals even when tmux remains", async () => {
  for (const reason of [2, 3, 4]) {
    const h = harness([session("demo", "$11")]);
    await h.ready;
    const terminal = h.openTerminal({ name: "tmux: demo" });
    h.closeTerminal(terminal, reason);
    await h.flush();
    const next = harness(h.sessions, {}, { workspaceState: h.workspaceSnapshot() });
    await next.ready;
    assert.equal(next.terminals.length, 0);
    assert.equal(next.sessions.length, 1);
  }
});

test("workspace restore sets are isolated and existing terminal tabs are not duplicated", async () => {
  const sessions = [session("A", "$11"), session("B", "$12")];
  const first = harness(sessions, {}, { workspaceState: { [openKey]: ["A"] }, terminals: [{ name: "tmux: A" }] });
  const second = harness(sessions, {}, { workspaceState: { [openKey]: ["B"] } });
  await Promise.all([first.ready, second.ready]);
  assert.deepEqual(first.terminals.map((t) => t.name), ["tmux: A"]);
  assert.deepEqual(second.terminals.map((t) => t.name), ["tmux: B"]);
});

test("closing one of two views of a session keeps the other in the reopen list", async () => {
  const h = harness([session("demo", "$11")]);
  await h.ready;
  const first = h.openTerminal({ name: "tmux: demo" });
  const second = h.openTerminal({ name: "tmux: demo" });
  h.closeTerminal(first);
  await h.flush();
  assert.deepEqual(Array.from(h.context.workspaceState.get(openKey)), ["demo"]);
  second.name = "Renamed terminal";
  h.closeTerminal(second);
  await h.flush();
  assert.deepEqual(Array.from(h.context.workspaceState.get(openKey)), []);
});

test("terminal closes during startup are respected and rapid changes do not lose state", async () => {
  const h = harness([session("A", "$11"), session("B", "$12")], {}, {
    workspaceState: { [openKey]: ["A"] }, terminals: [{ name: "tmux: A" }],
  });
  h.closeTerminal(h.terminals[0]);
  h.openTerminal({ name: "tmux: B" });
  h.openTerminal({ name: "ordinary shell" });
  await h.ready;
  await h.flush();
  assert.deepEqual(h.terminals.map((t) => t.name), ["tmux: B", "ordinary shell"]);
  assert.deepEqual(Array.from(h.context.workspaceState.get(openKey)), ["B"]);
});

test("disabled restore opens nothing, and a vanished session is removed from restoration", async () => {
  const disabled = harness([session("demo", "$11")], {}, {
    workspaceState: { [openKey]: ["demo"] }, configuration: { autoRestore: false },
  });
  const missing = harness([], {}, { workspaceState: { [openKey]: ["demo"] } });
  await Promise.all([disabled.ready, missing.ready]);
  assert.equal(disabled.terminals.length, 0);
  assert.equal(missing.terminals.length, 0);
  assert.deepEqual(Array.from(missing.context.workspaceState.get(openKey)), []);
});

test("deactivation preserves the snapshot even if terminal shutdown events follow", async () => {
  const h = harness([session("demo", "$11")]);
  await h.ready;
  const terminal = h.openTerminal({ name: "tmux: demo" });
  await h.deactivate();
  h.closeTerminal(terminal, h.exitReasons.Extension);
  assert.deepEqual(Array.from(h.context.workspaceState.get(openKey)), ["demo"]);
});

test("no-server errors produce OFF entries; other failures are reported", async () => {
  const h = harness([session("demo", "$11")]);
  await h.ready;
  await h.provider.refresh();
  h.failure = "error connecting to /tmp/tmux-1000/default: No such file or directory";
  await h.provider.refresh();
  assert.equal(h.provider.sessions[0].state, "off");
  h.failure = "permission denied";
  await h.provider.refresh();
  assert.equal(h.messages.at(-1).type, "error");
});
