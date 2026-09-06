const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { harness } = require("./harness");

async function main() {
  const h = harness();
  await h.ready;
  const origin = "https://tmux-session-tabs.test";
  const html = h.provider.html({ cspSource: origin, asWebviewUri: () => origin + "/codicon.css" });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM });
  try {
    const context = await browser.newContext({ timezoneId: "UTC" });
    await context.addInitScript(() => {
      window.sent = [];
      window.acquireVsCodeApi = () => ({ postMessage: (message) => window.sent.push(message) });
    });
    await context.route(origin + "/**", (route) => route.fulfill({
      contentType: route.request().url().endsWith(".css") ? "text/css" : "text/html",
      body: route.request().url().endsWith(".css")
        ? fs.readFileSync(path.join(__dirname, "../media/codicon.css"), "utf8") : html,
    }));
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(origin + "/");
    const now = Math.floor(Date.now() / 1000);
    const sessions = [
      { name: "project-alpha", state: "open", lastActivity: now, windows: 1 },
      { name: "project-beta", state: "active", lastActivity: now - 3600, windows: 2 },
      { name: "project-with-a-long-name", state: "idle", lastActivity: now - 86400, windows: 1 },
      { name: "archived-project", state: "off", lastActivity: now - 10 * 86400, windows: 1 },
    ];
    const render = (items) => page.evaluate((value) => {
      window.dispatchEvent(new MessageEvent("message", { data: { type: "sessions", sessions: value } }));
    }, items);
    const screenshotDir = path.join(__dirname, "../screenshots");
    fs.mkdirSync(screenshotDir, { recursive: true });
    for (const theme of ["dark", "light"]) {
      await page.addStyleTag({ content: `:root {
        --vscode-font-family: Arial, sans-serif;
        --vscode-foreground: ${theme === "dark" ? "#cccccc" : "#222222"};
        --vscode-descriptionForeground: ${theme === "dark" ? "#b2b2b2" : "#616161"};
        --vscode-editorWidget-background: ${theme === "dark" ? "#252526" : "#f3f3f3"};
        --vscode-testing-iconPassed: ${theme === "dark" ? "#73c991" : "#388a34"};
        --vscode-charts-blue: ${theme === "dark" ? "#3794ff" : "#007acc"};
        --vscode-charts-yellow: ${theme === "dark" ? "#cca700" : "#8a7100"};
        --vscode-focusBorder: #007fd4;
      } body { background: ${theme === "dark" ? "#1e1e1e" : "#ffffff"}; }` });
      for (const width of [220, 340, 760]) {
        await page.setViewportSize({ width, height: 800 });
        await render(sessions);
        await page.evaluate(() => document.fonts.ready);
        const layout = await page.evaluate(() => {
          const cards = [...document.querySelectorAll(".tab")];
          const rects = cards.map((card) => card.getBoundingClientRect().toJSON());
          return {
            vertical: rects.every((rect, index) => !index || rect.top >= rects[index - 1].bottom),
            overflow: document.documentElement.scrollWidth > innerWidth,
            textOverflow: [...document.querySelectorAll(".name, .timestamp, .tab-details")]
              .filter((node) => node.scrollWidth > node.clientWidth + 1).length,
            borders: cards.map((card) => getComputedStyle(card).borderLeftColor),
            backgrounds: cards.map((card) => getComputedStyle(card.querySelector(".attach")).backgroundColor),
            offBorder: getComputedStyle(cards[3]).borderLeftStyle,
            icon: getComputedStyle(document.querySelector(".codicon-add"), "::before").content,
            font: document.fonts.check("16px codicon"),
          };
        });
        assert.equal(layout.vertical, true);
        assert.equal(layout.overflow, false, JSON.stringify({ theme, width, layout }));
        assert.equal(layout.textOverflow, 0, JSON.stringify({ theme, width, layout }));
        assert.equal(new Set(layout.borders).size, 4);
        assert.equal(new Set(layout.backgrounds).size, 4);
        assert.equal(layout.offBorder, "dashed");
        assert.notEqual(layout.icon, "none");
        assert.equal(layout.font, true);
        await page.screenshot({ path: path.join(screenshotDir, theme + "-" + width + ".png") });
      }
    }
    await page.setViewportSize({ width: 340, height: 800 });
    const first = page.locator(".tab").first();
    await first.locator(".attach").click();
    assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { type: "attach", name: "project-alpha" });
    await first.locator(".delete").click();
    assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { type: "delete", name: "project-alpha" });
    await first.locator(".close").click();
    assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { type: "close", name: "project-alpha" });
    assert.equal(await page.locator(".state-idle .close").isDisabled(), true);
    assert.equal(await page.locator(".state-active .close").isDisabled(), true);
    assert.equal(await page.locator(".restore").count(), 0);
    assert.equal(await page.locator(".state-off .attach").isDisabled(), true);
    await first.locator(".attach").focus();
    await render(sessions);
    assert.equal(await first.locator(".attach").evaluate((node) => node === document.activeElement), true);
    await page.keyboard.press("Enter");
    assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { type: "attach", name: "project-alpha" });
    for (const [id, type] of [["new", "new"], ["all", "openAll"], ["refresh", "refresh"]]) {
      await page.locator("#" + id).click();
      assert.equal(await page.evaluate(() => window.sent.at(-1).type), type);
    }
    const longList = [...sessions, ...Array.from({ length: 20 }, (_, index) => ({ ...sessions[2], name: "background-session-" + index }))];
    await render(longList);
    await page.evaluate(() => window.scrollTo(0, 500));
    const scroll = await page.evaluate(() => scrollY);
    await render(longList);
    assert.equal(await page.evaluate(() => scrollY), scroll);
    await render([{ ...sessions[0], name: '<img src=x onerror="window.injected=true">' }]);
    assert.equal(await page.locator(".name").textContent(), '<img src=x onerror="window.injected=true">');
    assert.equal(await page.locator("img").count(), 0);
    await render([]);
    assert.equal(await page.locator("#tabs").textContent(), "No tmux sessions");
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "error", message: "tmux unavailable" } })));
    assert.equal(await page.locator("#error").textContent(), "tmux unavailable");
    assert.deepEqual(errors, []);
    console.log("PASS: six layouts, state colors, icons, action routing, keyboard access, focus/scroll preservation, and safe text rendering.");
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
