const test = require("node:test");
const assert = require("node:assert/strict");
const { buildAgents, identifyAgent, parseProcessStat } = require("../server/agents");

const info = { bootId: "test-boot", clockTicks: 100, pageSize: 4096, uptime: 1000, now: 2000000 };
const row = (pid, ppid, agent, extra = {}) => ({ pid, ppid, agent, state: "S", ticks: 100, startedTicks: 10000, rssPages: 256, cwd: "/projects/alpha", ...extra });
const codex = { tool: "Codex", mode: "agent", wrapper: false };

test("detects native agents and interpreter entrypoints without mistaking helpers or prompt text", () => {
  assert.equal(identifyAgent(["codex"], "/tools/codex (deleted)").tool, "Codex");
  assert.equal(identifyAgent(["node", "/tools/@openai/codex/bin/codex.js"], "/bin/node").wrapper, true);
  assert.equal(identifyAgent(["claude"], "/tools/claude/versions/1.0.0").tool, "Claude");
  assert.equal(identifyAgent(["node", "/tools/@anthropic-ai/claude-code/cli.js"], "/bin/node").tool, "Claude");
  assert.equal(identifyAgent(["python", "-m", "aider"], "/bin/python3").tool, "Aider");
  assert.equal(identifyAgent(["opencode"], "/bin/opencode").tool, "OpenCode");
  assert.equal(identifyAgent(["node", "/tools/@google/gemini-cli/dist/index.js"], "/bin/node").tool, "Gemini");
  assert.equal(identifyAgent(["codex", "-c", "setting=true", "app-server"], "/bin/codex").mode, "service");
  assert.equal(identifyAgent(["/tools/@openai/codex/bin/codex-code-mode-host"], "/tools/codex-code-mode-host"), undefined);
  assert.equal(identifyAgent(["bash", "-c", "codex"], "/bin/bash"), undefined);
  assert.equal(identifyAgent(["node", "test.js", "codex"], "/bin/node"), undefined);
});

test("parses /proc stat including spaces and parentheses in command names", () => {
  const fields = Array(22).fill("0");
  fields[0] = "S"; fields[1] = "5"; fields[11] = "250"; fields[12] = "30";
  fields[19] = "10000"; fields[21] = "256";
  assert.deepEqual(parseProcessStat("12 (agent (helper)) " + fields.join(" ")), {
    pid: 12, ppid: 5, state: "S", ticks: 280, startedTicks: 10000, rssPages: 256,
  });
  assert.throws(() => parseProcessStat("invalid"));
});

test("groups only launch wrappers and maps nested agents to their tmux pane", () => {
  const rows = [
    row(1, 0), row(2, 1, { ...codex, wrapper: true }), row(3, 2, codex),
    row(4, 3), row(5, 4, codex), row(6, 3, undefined),
  ];
  const agents = buildAgents(rows, [{ pid: 1, session: "task-alpha", window: "work" }], info);
  assert.deepEqual(agents.map((agent) => agent.pid), [3, 5]);
  assert.ok(agents.every((agent) => agent.name === "task-alpha" && agent.session === "task-alpha"));
  assert.equal(agents[0].memoryBytes, 1024 ** 2);
  assert.equal(agents[0].cpuPercent, null);
});

test("process CPU uses interval deltas and never treats sleeping as AI inactivity", () => {
  const previous = new Map([["test-boot:3:10000", { ticks: 100, sampledAt: 1998000 }]]);
  const [agent] = buildAgents([row(3, 0, codex, { ticks: 400 })], [], { ...info, previous });
  assert.equal(agent.cpuPercent, 150);
  assert.equal(agent.state, "online");
  assert.equal(agent.name, "alpha");
  assert.equal(agent.startedAt, 1100000);
  const [paused] = buildAgents([row(3, 0, codex, { state: "T" })], [], info);
  assert.equal(paused.state, "paused");
});

test("process identity protects samples and labels from PID reuse or reboot", () => {
  const previous = new Map([["test-boot:3:10000", { ticks: 100, sampledAt: 1998000 }]]);
  const [reused] = buildAgents([row(3, 0, codex, { startedTicks: 10100, ticks: 400 })], [], { ...info, previous });
  const [rebooted] = buildAgents([row(3, 0, codex, { ticks: 400 })], [], { ...info, bootId: "new-boot", previous });
  assert.equal(reused.cpuPercent, null);
  assert.equal(rebooted.cpuPercent, null);
  assert.notEqual(reused.key, "test-boot:3:10000");
  assert.notEqual(rebooted.key, "test-boot:3:10000");
});

test("services are separate from agent processes and parent cycles terminate", () => {
  const agents = buildAgents([
    row(1, 2, { ...codex, mode: "service" }), row(2, 1), row(3, 0, codex),
  ], [], info);
  assert.equal(agents.length, 2);
  assert.equal(agents[0].mode, "agent");
  assert.equal(agents[1].mode, "service");
});
