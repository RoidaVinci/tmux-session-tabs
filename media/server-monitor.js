(() => {
  const api = acquireVsCodeApi();
  const content = document.getElementById("content");
  const error = document.getElementById("error");
  const kind = document.body.dataset.view;
  let data;

  const bytes = (value) => {
    if (!Number.isFinite(value)) return "Unavailable";
    if (value < 1024 ** 2) return (value / 1024).toFixed(0) + " KiB";
    if (value < 1024 ** 3) return (value / 1024 ** 2).toFixed(0) + " MiB";
    return (value / 1024 ** 3).toFixed(1) + " GiB";
  };
  const duration = (seconds) => {
    const minutes = Math.max(0, Math.floor(seconds / 60));
    if (minutes < 60) return minutes + "m";
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + "h " + minutes % 60 + "m";
    return Math.floor(hours / 24) + "d " + hours % 24 + "h";
  };
  const percent = (value) => value == null ? "Sampling..." : value.toFixed(1) + "%";
  const button = (action, icon, title) => {
    const node = document.createElement("button");
    node.className = "icon-button";
    node.dataset.action = action;
    node.title = title;
    node.setAttribute("aria-label", title);
    const glyph = document.createElement("i");
    glyph.className = "codicon codicon-" + icon;
    glyph.setAttribute("aria-hidden", "true");
    node.append(glyph);
    return node;
  };

  function initializeAgents() {
    content.innerHTML = '<div class="filters"><input id="search" type="search" placeholder="Filter agents" aria-label="Filter agents"><select id="tool" aria-label="Agent tool"><option value="">All tools</option><option>Codex</option><option>Claude</option><option>Aider</option><option>OpenCode</option><option>Gemini</option><option>Cursor</option></select></div><div id="agents"></div>';
    document.getElementById("search").addEventListener("input", renderAgents);
    document.getElementById("tool").addEventListener("change", renderAgents);
    content.addEventListener("click", (event) => {
      const action = event.target.closest("button[data-action]");
      const agent = action?.closest(".agent");
      if (agent && !action.disabled) api.postMessage({ type: action.dataset.action, key: agent.dataset.key });
    });
  }

  function renderAgents() {
    if (!data) return;
    const search = document.getElementById("search").value.toLowerCase();
    const tool = document.getElementById("tool").value;
    const filtered = data.agents.filter((agent) => (!tool || agent.tool === tool)
      && [agent.name, agent.tool, agent.cwd, agent.session, String(agent.pid)].join(" ").toLowerCase().includes(search));
    document.getElementById("count").textContent = "(" + data.agents.length + ")";
    const list = document.getElementById("agents");
    const existing = new Map([...list.querySelectorAll(".agent")].map((node) => [node.dataset.key, node]));
    const keys = new Set(filtered.map((agent) => agent.key));
    for (const node of [...list.children]) if (!keys.has(node.dataset.key)) node.remove();
    if (!filtered.length) {
      list.innerHTML = '<div class="empty">' + (data.agents.length ? "No matching agents" : "No supported agents found") + '</div>';
      return;
    }
    for (const [index, agent] of filtered.entries()) {
      const row = existing.get(agent.key) || document.createElement("article");
      row.className = "agent" + (agent.mode === "service" ? " service" : "") + (agent.state === "paused" ? " paused" : "");
      row.dataset.key = agent.key;
      if (!row.children.length) {
        row.innerHTML = '<div class="agent-title"><strong class="agent-name"></strong><span class="badge"></span></div><div class="directory"></div><div class="agent-meta"><span class="tool"></span><span class="pid"></span><span class="age"></span></div><div class="agent-footer"><span class="agent-metrics"></span><div class="actions"></div></div>';
        row.querySelector(".actions").append(button("name", "edit", "Name this agent"), button("folder", "folder-opened", "Open working directory in a new window"), button("terminal", "terminal", "Open tmux session"));
      }
      row.querySelector(".agent-name").textContent = agent.name;
      const badge = row.querySelector(".badge");
      badge.textContent = agent.state === "paused" ? "PAUSED" : agent.mode === "service" ? "SERVICE" : "ONLINE";
      badge.title = agent.mode === "service" ? "Background agent service; conversations may share this process" : "Process status; does not indicate whether an AI turn is in progress";
      row.querySelector(".directory").textContent = agent.cwd || "Directory unavailable";
      row.querySelector(".directory").title = "Process working directory: " + (agent.cwd || "Unavailable");
      row.querySelector(".tool").textContent = agent.tool;
      row.querySelector(".pid").textContent = "PID " + agent.pid;
      row.querySelector(".age").textContent = duration((data.sampledAt - agent.startedAt) / 1000);
      row.querySelector(".age").title = "Started " + new Date(agent.startedAt).toLocaleString();
      const metrics = row.querySelector(".agent-metrics");
      metrics.textContent = "CPU " + (agent.cpuPercent == null ? "..." : percent(agent.cpuPercent)) + " / " + bytes(agent.memoryBytes);
      metrics.title = "CPU as a percentage of one core; resident memory of this process";
      row.querySelector('[data-action="folder"]').disabled = !agent.cwd;
      const terminal = row.querySelector('[data-action="terminal"]');
      terminal.disabled = !agent.session;
      terminal.title = agent.session ? "Open tmux session: " + agent.session : "No tmux pane found";
      terminal.setAttribute("aria-label", terminal.title);
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
    }
  }

  function metric(className, title, value, detail, usage, tooltip = "") {
    const row = document.createElement("section");
    row.className = "metric " + className + (usage >= 90 ? " high" : "");
    row.innerHTML = '<div class="metric-title"><strong></strong><output></output></div><progress max="100"></progress><span class="metric-detail"></span>';
    row.querySelector("strong").textContent = title;
    row.querySelector("output").textContent = value;
    row.querySelector(".metric-detail").textContent = detail;
    row.title = tooltip;
    const progress = row.querySelector("progress");
    progress.setAttribute("aria-label", title);
    if (usage != null) progress.value = Math.max(0, Math.min(100, usage));
    return row;
  }

  function renderResources() {
    const fragment = document.createDocumentFragment();
    const host = document.createElement("div");
    host.className = "host";
    host.innerHTML = '<strong></strong><span class="host-detail"></span>';
    host.querySelector("strong").textContent = data.hostname;
    host.querySelector(".host-detail").textContent = data.cores + " vCPUs / " + data.arch + " / " + data.platform;
    host.title = data.cpuModel + "\n" + data.release;
    fragment.append(host);
    fragment.append(metric("cpu", "CPU", percent(data.cpuPercent), data.cpuModel, data.cpuPercent));
    const memory = data.memory;
    fragment.append(metric("memory", "RAM", bytes(memory.used) + " / " + bytes(memory.total), bytes(memory.available) + " available", memory.total ? 100 * memory.used / memory.total : 0, "Uses MemAvailable, including reclaimable cache"));
    fragment.append(metric("swap", "Swap", memory.swapTotal ? bytes(memory.swapUsed) + " / " + bytes(memory.swapTotal) : "None", memory.swapTotal ? bytes(memory.swapTotal - memory.swapUsed) + " available" : "", memory.swapTotal ? 100 * memory.swapUsed / memory.swapTotal : 0));
    for (const disk of data.disks) {
      fragment.append(metric("disk", "Disk " + disk.path, disk.error ? "Unavailable" : percent(disk.percent), disk.error || bytes(disk.available) + " available / " + bytes(disk.total) + " total", disk.error ? 0 : disk.percent, disk.paths.join("\n")));
    }
    const facts = document.createElement("dl");
    facts.className = "facts";
    for (const [name, value] of [["Uptime", duration(data.uptime)], ["Load 1 / 5 / 15m", data.load.map((value) => value.toFixed(2)).join(" / ")]]) {
      const row = document.createElement("div");
      const label = document.createElement("dt");
      const text = document.createElement("dd");
      label.textContent = name;
      text.textContent = value;
      row.append(label, text);
      facts.append(row);
    }
    fragment.append(facts);
    content.replaceChildren(fragment);
  }

  if (kind === "agents") initializeAgents();
  document.getElementById("refresh").onclick = () => api.postMessage({ type: "refresh" });
  window.addEventListener("message", (event) => {
    if (event.data.type === "error") { error.textContent = event.data.message; error.hidden = false; return; }
    if (event.data.type !== "data" || event.data.kind !== kind) return;
    data = event.data.data;
    error.hidden = true;
    const updated = document.getElementById("updated");
    updated.textContent = new Date(data.sampledAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    updated.title = "Updated " + new Date(data.sampledAt).toLocaleString();
    if (kind === "agents") renderAgents();
    else renderResources();
  });
  api.postMessage({ type: "refresh" });
})();
