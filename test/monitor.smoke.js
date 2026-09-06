const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { monitorHarness } = require("./monitor-harness");

async function main() {
  const origin = "https://server-monitor.test";
  const now = Date.now();
  const base = { state: "online", mode: "agent", tool: "Codex", cwd: "/projects/alpha", session: "task-alpha", startedAt: now - 3600000, memoryBytes: 140 * 1024 ** 2, cpuPercent: 3.5 };
  const fixtures = {
    agents: { sampledAt: now, agents: [
      { ...base, key: "boot:1:10", pid: 101, name: "Implement account settings" },
      { ...base, key: "boot:2:10", pid: 102, name: "project-beta", tool: "Claude", cwd: "/projects/beta", session: "" },
      { ...base, key: "boot:3:10", pid: 103, name: "a-very-long-project-name-for-layout-testing", state: "paused", cwd: "/projects/project-with-a-long-directory-name/workers/validation", session: "", cpuPercent: 0 },
      { ...base, key: "boot:4:10", pid: 104, name: "VS Code agent service", mode: "service", session: "" },
    ] },
    resources: { sampledAt: now, hostname: "dev-server", cores: 4, arch: "x64", platform: "linux", release: "example-kernel", cpuModel: "Example CPU with a long model description", cpuPercent: 26.7, memory: { used: 6 * 1024 ** 3, total: 16 * 1024 ** 3, available: 10 * 1024 ** 3, swapTotal: 4 * 1024 ** 3, swapUsed: 3.8 * 1024 ** 3 }, disks: [{ path: "/", paths: ["/", "/projects"], total: 512 * 1024 ** 3, available: 30 * 1024 ** 3, percent: 94 }], uptime: 86450, load: [0.3, 0.5, 0.8] },
  };
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM });
  try {
    for (const kind of ["agents", "resources"]) {
      const h = monitorHarness(kind);
      const html = h.provider.html({ cspSource: origin, asWebviewUri: (uri) => origin + "/" + path.basename(uri.pathname) });
      const context = await browser.newContext({ timezoneId: "UTC" });
      await context.addInitScript(() => { window.sent = []; window.acquireVsCodeApi = () => ({ postMessage: (message) => window.sent.push(message) }); });
      await context.route(origin + "/**", (route) => {
        const name = new URL(route.request().url()).pathname.slice(1);
        if (["codicon.css", "server-monitor.css", "server-monitor.js"].includes(name)) {
          return route.fulfill({ contentType: name.endsWith(".css") ? "text/css" : "text/javascript", body: fs.readFileSync(path.join(__dirname, "../media", name), "utf8") });
        }
        return route.fulfill({ contentType: "text/html", body: html });
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
      await page.goto(origin + "/");
      const render = (data) => page.evaluate(({ data, kind }) => window.dispatchEvent(new MessageEvent("message", { data: { type: "data", kind, data } })), { data, kind });
      const screenshots = path.join(__dirname, "../screenshots");
      fs.mkdirSync(screenshots, { recursive: true });
      for (const theme of ["dark", "light"]) {
        await page.addStyleTag({ content: `:root {
          --vscode-font-family: Arial, sans-serif;
          --vscode-foreground: ${theme === "dark" ? "#cccccc" : "#222222"};
          --vscode-descriptionForeground: ${theme === "dark" ? "#b2b2b2" : "#616161"};
          --vscode-editorWidget-background: ${theme === "dark" ? "#252526" : "#f3f3f3"};
          --vscode-input-foreground: ${theme === "dark" ? "#cccccc" : "#222222"};
          --vscode-input-background: ${theme === "dark" ? "#333333" : "#f8f8f8"};
          --vscode-testing-iconPassed: ${theme === "dark" ? "#73c991" : "#388a34"};
          --vscode-charts-blue: #3794ff;
          --vscode-charts-yellow: ${theme === "dark" ? "#cca700" : "#8a7100"};
        } body { background: ${theme === "dark" ? "#1e1e1e" : "#ffffff"}; }` });
        for (const width of [220, 340, 760]) {
          await page.setViewportSize({ width, height: 800 });
          await render(fixtures[kind]);
          await page.evaluate(() => document.fonts.ready);
          const layout = await page.evaluate(() => ({
            overflow: document.documentElement.scrollWidth > innerWidth,
            textOverflow: [...document.querySelectorAll(".agent, .directory, .agent-name, .host, .metric, .metric-detail, .facts, header")]
              .filter((node) => node.scrollWidth > node.clientWidth + 1).map((node) => node.className),
            icon: getComputedStyle(document.querySelector(".codicon-refresh"), "::before").content,
            font: document.fonts.check("16px codicon"),
          }));
          assert.equal(layout.overflow, false, JSON.stringify({ kind, theme, width, layout }));
          assert.deepEqual(layout.textOverflow, [], JSON.stringify({ kind, theme, width, layout }));
          assert.notEqual(layout.icon, "none");
          assert.equal(layout.font, true);
          await page.screenshot({ path: path.join(screenshots, kind + "-" + theme + "-" + width + ".png") });
        }
      }
      if (kind === "agents") {
        assert.equal(await page.locator(".agent").count(), 4);
        await page.locator("#search").fill("workers");
        assert.equal(await page.locator(".agent").count(), 1);
        await render(fixtures.agents);
        assert.equal(await page.locator("#search").inputValue(), "workers");
        assert.equal(await page.locator("#search").evaluate((node) => node === document.activeElement), true);
        await page.locator("#search").fill("");
        await page.locator("#tool").selectOption("Claude");
        assert.equal(await page.locator(".agent").count(), 1);
        assert.equal(await page.locator('[data-action="terminal"]').isDisabled(), true);
        await page.locator("#tool").selectOption("");
        for (const type of ["name", "folder", "terminal"]) {
          await page.locator('.agent [data-action="' + type + '"]').first().click();
          assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { type, key: "boot:1:10" });
        }
        const many = { ...fixtures.agents, agents: Array.from({ length: 25 }, (_, index) => ({ ...base, key: "test:" + index, pid: index, name: "project-" + index })) };
        await render(many);
        await page.evaluate(() => window.scrollTo(0, 500));
        const scroll = await page.evaluate(() => scrollY);
        await render(many);
        assert.equal(await page.evaluate(() => scrollY), scroll);
        await render({ ...fixtures.agents, agents: [{ ...fixtures.agents.agents[0], name: '<img src=x onerror="alert(1)">' }] });
        assert.equal(await page.locator("img").count(), 0);
        await render({ ...fixtures.agents, agents: [] });
        assert.equal(await page.locator("#agents").textContent(), "No supported agents found");
      } else {
        assert.equal(await page.locator(".metric").count(), 4);
        assert.equal(await page.locator(".high").count(), 2);
        await render({ ...fixtures.resources, cpuPercent: null, disks: [{ path: "/missing", paths: ["/missing"], error: "EACCES" }] });
        assert.equal(await page.locator(".cpu output").textContent(), "Sampling...");
        assert.equal(await page.locator(".disk output").textContent(), "Unavailable");
      }
      await page.locator("#refresh").click();
      assert.equal(await page.evaluate(() => window.sent.at(-1).type), "refresh");
      await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "error", message: "Probe unavailable" } })));
      assert.equal(await page.locator("#error").isVisible(), true);
      await render(fixtures[kind]);
      assert.equal(await page.locator("#error").isVisible(), false);
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log("PASS: 12 monitor layouts, icons, filters, labels, action routing, scroll/focus preservation, error states, and text escaping.");
  } finally { await browser.close(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
