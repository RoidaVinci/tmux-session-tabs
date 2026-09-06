const fs = require("node:fs/promises");
const os = require("node:os");

function cpuSnapshot(cpus) {
  return cpus.reduce((sum, cpu) => {
    sum.idle += cpu.times.idle;
    sum.total += Object.values(cpu.times).reduce((total, value) => total + value, 0);
    return sum;
  }, { idle: 0, total: 0 });
}

function cpuUsage(before, after) {
  if (!before || after.total <= before.total) return null;
  const percent = 100 * (1 - (after.idle - before.idle) / (after.total - before.total));
  return Math.min(100, Math.max(0, percent));
}

function parseMemory(text) {
  const values = Object.create(null);
  for (const line of text.split("\n")) {
    const match = line.match(/^(\w+):\s+(\d+)\s+kB$/);
    if (match) values[match[1]] = Number(match[2]) * 1024;
  }
  if (!values.MemTotal) throw new Error("Memory counters are unavailable.");
  const available = Math.min(values.MemTotal, values.MemAvailable ?? (
    (values.MemFree || 0) + (values.Buffers || 0) + (values.Cached || 0) + (values.SReclaimable || 0) - (values.Shmem || 0)
  ));
  return {
    total: values.MemTotal,
    available: Math.max(0, available),
    used: Math.max(0, values.MemTotal - available),
    swapTotal: values.SwapTotal || 0,
    swapUsed: Math.max(0, (values.SwapTotal || 0) - (values.SwapFree || 0)),
  };
}

function diskUsage(stat) {
  const total = Number(stat.blocks) * Number(stat.bsize);
  const used = Math.max(0, (Number(stat.blocks) - Number(stat.bfree)) * Number(stat.bsize));
  const available = Math.max(0, Number(stat.bavail) * Number(stat.bsize));
  return { total, used, available, percent: used + available ? 100 * used / (used + available) : 0 };
}

async function readDisks(paths) {
  const disks = new Map();
  for (const directory of new Set(paths)) {
    try {
      const [stat, usage] = await Promise.all([fs.stat(directory), fs.statfs(directory)]);
      const key = String(stat.dev);
      if (disks.has(key)) disks.get(key).paths.push(directory);
      else disks.set(key, { key, path: directory, paths: [directory], ...diskUsage(usage) });
    } catch (error) {
      disks.set(directory, { key: directory, path: directory, paths: [directory], error: error.code || "Unavailable" });
    }
  }
  return [...disks.values()];
}

class ResourceSampler {
  constructor() {
    this.previousCpu = undefined;
  }

  async read(workspacePaths = []) {
    const cpus = os.cpus();
    const current = cpuSnapshot(cpus);
    const percent = cpuUsage(this.previousCpu, current);
    this.previousCpu = current;
    const [memory, disks] = await Promise.all([
      process.platform === "linux" ? fs.readFile("/proc/meminfo", "utf8").then(parseMemory) : Promise.resolve({
        total: os.totalmem(), used: os.totalmem() - os.freemem(), available: os.freemem(), swapTotal: 0, swapUsed: 0,
      }),
      readDisks([process.platform === "win32" ? os.homedir() : "/", os.homedir(), ...workspacePaths]),
    ]);
    return {
      hostname: os.hostname(), platform: os.platform(), arch: os.arch(), release: os.release(),
      cpuModel: cpus[0]?.model || "Unknown CPU", cores: cpus.length, cpuPercent: percent,
      load: os.loadavg(), uptime: os.uptime(), memory, disks, sampledAt: Date.now(),
    };
  }
}

module.exports = { ResourceSampler, cpuSnapshot, cpuUsage, parseMemory, diskUsage, readDisks };
