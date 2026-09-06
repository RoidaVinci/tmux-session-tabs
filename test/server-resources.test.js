const test = require("node:test");
const assert = require("node:assert/strict");
const { cpuSnapshot, cpuUsage, parseMemory, diskUsage, readDisks } = require("../server/resources");

test("CPU uses counter deltas and first samples are unavailable", () => {
  const before = cpuSnapshot([{ times: { user: 30, sys: 20, idle: 50 } }, { times: { user: 20, sys: 30, idle: 50 } }]);
  assert.deepEqual(before, { total: 200, idle: 100 });
  assert.equal(cpuUsage(undefined, before), null);
  assert.equal(cpuUsage(before, before), null);
  assert.equal(cpuUsage(before, { total: 400, idle: 250 }), 25);
});

test("memory uses available memory including reclaimable cache and reports swap", () => {
  assert.deepEqual(parseMemory("MemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 600 kB\nCached: 300 kB\nSwapTotal: 2000 kB\nSwapFree: 500 kB\n"), {
    total: 1024000, used: 409600, available: 614400, swapTotal: 2048000, swapUsed: 1536000,
  });
  const older = parseMemory("MemTotal: 1000 kB\nMemFree: 100 kB\nCached: 300 kB\nBuffers: 50 kB\nSReclaimable: 20 kB\nShmem: 10 kB\n");
  assert.equal(older.available, 460 * 1024);
  assert.equal(older.swapUsed, 0);
  assert.throws(() => parseMemory(""));
});

test("disk availability excludes reserved blocks and supports bigint counters", () => {
  const disk = diskUsage({ blocks: 1000n, bsize: 1024n, bfree: 200n, bavail: 100n });
  assert.equal(disk.total, 1024000);
  assert.equal(disk.used, 819200);
  assert.equal(disk.available, 102400);
  assert.ok(Math.abs(disk.percent - 88.88889) < 0.001);
});

test("duplicate filesystem paths are not counted twice and inaccessible paths are isolated", async () => {
  const disks = await readDisks([__dirname, __dirname + "/..", __dirname + "/missing-directory-for-monitor-test"]);
  assert.equal(disks.length, 2);
  assert.equal(disks[0].paths.length, 2);
  assert.ok(disks[0].total > 0);
  assert.equal(disks[1].error, "ENOENT");
});
