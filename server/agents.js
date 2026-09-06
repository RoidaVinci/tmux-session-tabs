const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const exec = promisify(execFile);

function parseProcessStat(text) {
  const end = text.lastIndexOf(")");
  const fields = text.slice(end + 2).trim().split(/\s+/);
  if (end < 0 || fields.length < 22) throw new Error("Invalid process stat");
  return {
    pid: Number(text.slice(0, text.indexOf(" "))),
    ppid: Number(fields[1]),
    state: fields[0],
    ticks: Number(fields[11]) + Number(fields[12]),
    startedTicks: Number(fields[19]),
    rssPages: Number(fields[21]),
  };
}

function identifyAgent(argv, executable = "") {
  const executableName = path.basename(executable.replace(/ \(deleted\)$/, ""));
  const program = path.basename(argv[0] || "");
  const interpreter = /^(node(?:js)?|python[\d.]*|bun)$/.test(executableName || program);
  const entry = interpreter ? argv[1] || "" : "";
  const names = [executableName, program];
  let tool;
  let wrapper = false;
  if (names.includes("codex")) tool = "Codex";
  else if (interpreter && /(?:^|\/)@openai\/codex\/(?:bin\/)?codex(?:\.js)?$/.test(entry)) {
    tool = "Codex";
    wrapper = true;
  } else if (names.includes("claude") || (interpreter && /@anthropic-ai\/claude-code\/(?:cli|index)\.js$/.test(entry))) tool = "Claude";
  else if (names.includes("aider") || path.basename(entry) === "aider" || (interpreter && entry === "-m" && /^aider(?:\.main)?$/.test(argv[2] || ""))) tool = "Aider";
  else if (names.includes("opencode")) tool = "OpenCode";
  else if (names.includes("gemini") || (interpreter && /@google\/gemini-cli\/.+\.js$/.test(entry))) tool = "Gemini";
  else if (names.includes("cursor-agent")) tool = "Cursor";
  if (!tool) return undefined;
  const mode = tool === "Codex" && argv.slice(1, 16).some((arg) => arg === "app-server" || arg === "mcp-server") ? "service" : "agent";
  return { tool, wrapper, mode };
}

async function readPrefix(filename, size = 4096) {
  const handle = await fs.open(filename, "r");
  try {
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function readProcesses() {
  if (process.platform !== "linux") throw new Error("Agent discovery requires a Linux remote host.");
  const entries = (await fs.readdir("/proc")).filter((name) => /^\d+$/.test(name));
  const rows = [];
  // Bound /proc reads so a busy server does not exhaust file descriptors.
  for (let index = 0; index < entries.length; index += 16) {
    const batch = await Promise.all(entries.slice(index, index + 16).map(async (pid) => {
      try {
        const root = `/proc/${pid}`;
        if ((await fs.stat(root)).uid !== process.getuid()) return undefined;
        const [stat, cmdline, executable, cwd] = await Promise.all([
          fs.readFile(`${root}/stat`, "utf8"),
          readPrefix(`${root}/cmdline`),
          fs.readlink(`${root}/exe`).catch(() => ""),
          fs.readlink(`${root}/cwd`).catch(() => ""),
        ]);
        const row = parseProcessStat(stat);
        if (["Z", "X", "x"].includes(row.state)) return undefined;
        const agent = identifyAgent(cmdline.split("\0"), executable);
        return { ...row, cwd, agent };
      } catch {
        // Processes can exit between directory enumeration and metadata reads.
        return undefined;
      }
    }));
    rows.push(...batch.filter(Boolean));
  }
  return rows;
}

async function readPanes() {
  try {
    const { stdout } = await exec("tmux", ["list-panes", "-a", "-F", "#{pane_pid}\t#{session_name}\t#{window_name}\t#{pane_id}"], { timeout: 2000, maxBuffer: 1024 * 1024 });
    return stdout.trim().split("\n").filter(Boolean).map((line) => {
      const [pid, session, window, pane] = line.split("\t");
      return { pid: Number(pid), session, window, pane };
    });
  } catch {
    return [];
  }
}

function findPane(row, processes, panes) {
  const visited = new Set();
  while (row && !visited.has(row.pid)) {
    if (panes.has(row.pid)) return panes.get(row.pid);
    visited.add(row.pid);
    row = processes.get(row.ppid);
  }
  return undefined;
}

function buildAgents(rows, panes, { bootId, clockTicks, pageSize, uptime, now, previous = new Map() }) {
  const processes = new Map(rows.map((row) => [row.pid, row]));
  const paneMap = new Map(panes.map((pane) => [pane.pid, pane]));
  const candidates = rows.filter((row) => row.agent);
  const wrappedParents = new Set(candidates.filter((row) => !row.agent.wrapper).map((row) => {
    const parent = processes.get(row.ppid);
    return parent?.agent?.wrapper && parent.agent.tool === row.agent.tool ? parent.pid : undefined;
  }));
  return candidates.filter((row) => !wrappedParents.has(row.pid)).map((row) => {
    const key = `${bootId}:${row.pid}:${row.startedTicks}`;
    const before = previous.get(key);
    const elapsed = before ? (now - before.sampledAt) / 1000 : 0;
    const cpu = elapsed > 0 && row.ticks >= before.ticks ? ((row.ticks - before.ticks) / clockTicks / elapsed) * 100 : null;
    const pane = findPane(row, processes, paneMap);
    return {
      key, pid: row.pid, tool: row.agent.tool, mode: row.agent.mode,
      state: /[Tt]/.test(row.state) ? "paused" : "online",
      name: pane?.session || path.basename(row.cwd) || row.agent.tool,
      cwd: row.cwd, session: pane?.session || "", window: pane?.window || "",
      startedAt: now - Math.max(0, uptime - row.startedTicks / clockTicks) * 1000,
      memoryBytes: Math.max(0, row.rssPages * pageSize),
      cpuPercent: cpu, ticks: row.ticks, sampledAt: now,
    };
  }).sort((a, b) => (
    Number(a.mode === "service") - Number(b.mode === "service")
    || Number(a.state === "paused") - Number(b.state === "paused")
    || a.name.localeCompare(b.name) || a.pid - b.pid
  ));
}

class AgentSampler {
  constructor() {
    this.previous = new Map();
    this.systemInfo = undefined;
  }

  async read() {
    if (!this.systemInfo) {
      this.systemInfo = Promise.all([
        fs.readFile("/proc/sys/kernel/random/boot_id", "utf8"),
        exec("getconf", ["CLK_TCK"], { timeout: 2000 }),
        exec("getconf", ["PAGESIZE"], { timeout: 2000 }),
      ]).then(([boot, ticks, pages]) => ({ bootId: boot.trim(), clockTicks: Number(ticks.stdout), pageSize: Number(pages.stdout) }))
        .catch((error) => { this.systemInfo = undefined; throw error; });
    }
    const [system, rows, panes] = await Promise.all([this.systemInfo, readProcesses(), readPanes()]);
    const agents = buildAgents(rows, panes, { ...system, uptime: os.uptime(), now: Date.now(), previous: this.previous });
    this.previous = new Map(agents.map((agent) => [agent.key, { ticks: agent.ticks, sampledAt: agent.sampledAt }]));
    return agents.map(({ ticks, sampledAt, ...agent }) => agent);
  }
}

module.exports = { AgentSampler, buildAgents, identifyAgent, parseProcessStat };
