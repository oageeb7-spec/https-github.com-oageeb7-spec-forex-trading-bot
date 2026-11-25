(() => {
  const $ = id => document.getElementById(id);
  const RAW = "https://raw.githubusercontent.com/msitarzewski/agency-agents/main/";
  const GH = "https://github.com/msitarzewski/agency-agents/blob/main/";
  const esc = s => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const fmt = n => n.toLocaleString("en-US");
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  };

  let data, bySlug = new Map(), divMap = new Map();
  let state = { q: "", div: store.get("agency.div", "all"), sort: store.get("agency.sort", "div") };
  let team = new Set(store.get("agency.team", []));
  let current = null;

  fetch(window.AGENCY_DATA_URL || "agents.json").then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(init)
    .catch(() => { $("count").textContent = "The roster file (agents.json) did not load. Serve this folder over HTTP, e.g. python3 -m http.server, and reload."; });

  function init(d) {
    data = d;
    d.divisions.forEach(x => divMap.set(x.id, x));
    d.agents.forEach(a => { a._hay = (a.name + " " + a.description + " " + a.vibe + " " + a.division + " " + a.group).toLowerCase(); bySlug.set(a.slug, a); });
    team = new Set([...team].filter(s => bySlug.has(s)));
    if (state.div !== "all" && !divMap.has(state.div)) state.div = "all";
    $("t-agents").textContent = fmt(d.agents.length);
    $("t-divs").textContent = d.divisions.length;
    const words = d.agents.reduce((s, a) => s + a.words, 0);
    $("t-words").textContent = words >= 1e6 ? (words / 1e6).toFixed(1) + "M" : Math.round(words / 1000) + "k";
    const src = d.commit ? `synced from ${d.commit} · ${d.commitDate}` : "";
    $("src").textContent = src; $("foot-src").textContent = src;
    $("sort").value = state.sort;
    $("h-count").textContent = fmt(d.agents.length);
    renderWall(); renderDepts(); initAutopilot();
    renderChips(); render(); renderTeam(); route(); initEngine();
  }

  // The wall: every agent as one tile, grouped by department
  function renderWall() {
    let i = 0;
    $("wall").innerHTML = data.divisions.map(x => data.agents.filter(a => a.division === x.id).map(a =>
      `<button class="tile" data-open="${a.slug}" data-tip="${a.slug}" style="--c:${x.color};--i:${i++}" aria-label="${esc(a.name)}, ${esc(x.label)}">${esc(a.emoji || "")}</button>`).join("")).join("");
    $("legend").innerHTML = data.divisions.map(x => `<button data-dept="${x.id}" style="--c:${x.color}"><i></i>${esc(x.label)}</button>`).join("");
    $("mark-dots").innerHTML = data.divisions.slice(0, 9).map(x => `<i style="--c:${x.color}"></i>`).join("");
    const tip = $("tip"), box = $("wall").parentElement;
    const showTip = t => {
      const a = bySlug.get(t.dataset.tip); if (!a) return;
      tip.innerHTML = `${esc(a.name)}<small>${esc(divMap.get(a.division).label)}</small>`;
      const r = t.getBoundingClientRect(), b = box.getBoundingClientRect();
      const x = Math.min(Math.max(r.left - b.left + r.width / 2, 110), b.width - 110);
      tip.style.left = x + "px"; tip.style.top = (r.top - b.top) + "px"; tip.classList.add("on");
    };
    $("wall").addEventListener("pointerover", e => { const t = e.target.closest(".tile"); if (t) showTip(t); });
    $("wall").addEventListener("focusin", e => { const t = e.target.closest(".tile"); if (t) showTip(t); });
    $("wall").addEventListener("pointerleave", () => tip.classList.remove("on"));
    $("wall").addEventListener("focusout", () => tip.classList.remove("on"));
  }
  function renderDepts() {
    $("depts").innerHTML = data.divisions.map(x => {
      const faces = data.agents.filter(a => a.division === x.id).slice(0, 6).map(a => a.emoji).join("");
      return `<button class="dept" data-dept="${x.id}" style="--c:${x.color}" aria-label="${esc(x.label)}, ${x.count} agents">
        <span class="dept-top"><span class="dept-n">${x.count}</span><span class="dept-sw"></span></span>
        <span class="dept-faces" aria-hidden="true">${esc(faces)}</span>
        <span class="dept-name">${esc(x.label)}</span></button>`;
    }).join("");
  }
  function pickDept(id) {
    state.div = id; store.set("agency.div", id); state.q = ""; $("q").value = "";
    renderChips(); render();
    $("roster").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }

  function renderChips() {
    const all = `<button class="chip" data-div="all" aria-pressed="${state.div === "all"}">All departments <small>${data.agents.length}</small></button>`;
    $("chips").innerHTML = all + data.divisions.map(x =>
      `<button class="chip" data-div="${x.id}" style="--c:${x.color}" aria-pressed="${state.div === x.id}"><i></i>${esc(x.label)} <small>${x.count}</small></button>`).join("");
  }

  function filtered() {
    const terms = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    const res = terms.map(t => new RegExp("(^|[^a-z0-9])" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    let list = data.agents.filter(a => (state.div === "all" || a.division === state.div) && res.every(r => r.test(a._hay)));
    if (state.sort === "az") list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    else if (state.sort === "long") list = [...list].sort((a, b) => b.words - a.words);
    if (terms.length) { // name matches first
      const n = a => terms.every(t => a.name.toLowerCase().includes(t)) ? 0 : 1;
      list = [...list].sort((a, b) => n(a) - n(b));
    }
    return list;
  }

  function card(a) {
    const d = divMap.get(a.division);
    const blurb = a.vibe || a.description;
    const on = team.has(a.slug);
    return `<article class="card" style="--c:${d.color}">
      <div class="card-hd"><div class="ava" aria-hidden="true">${esc(a.emoji || "•")}</div>
        <div style="min-width:0"><h3><button data-open="${a.slug}">${esc(a.name)}</button></h3>
        <span class="div-label"><i></i>${esc(d.label)}${a.group ? " · " + esc(a.group) : ""}</span></div></div>
      <p>${esc(blurb)}</p>
      <div class="card-ft"><button class="card-go" data-open="${a.slug}">Give it a job <span>→</span></button>
        <button class="pick" data-pick="${a.slug}" aria-pressed="${on}" aria-label="${on ? "Remove" : "Add"} ${esc(a.name)} ${on ? "from" : "to"} team">${on ? "✓ On team" : "+ Add to team"}</button></div>
    </article>`;
  }

  function render() {
    const list = filtered();
    $("grid").innerHTML = list.map(card).join("");
    $("empty").hidden = list.length > 0;
    const scope = state.div === "all" ? "across all departments" : "in " + divMap.get(state.div).label;
    $("wall").classList.toggle("dim", state.div !== "all");
    document.querySelectorAll("#wall .tile").forEach(t => t.classList.toggle("on", state.div !== "all" && bySlug.get(t.dataset.tip).division === state.div));
    $("count").textContent = `${fmt(list.length)} ${list.length === 1 ? "agent" : "agents"} ${scope}${state.q ? ` matching “${state.q}”` : ""}`;
  }

  // Team
  function toggleTeam(slug) {
    team.has(slug) ? team.delete(slug) : team.add(slug);
    store.set("agency.team", [...team]);
    document.querySelectorAll(`[data-pick="${slug}"]`).forEach(b => {
      const on = team.has(slug), a = bySlug.get(slug);
      b.setAttribute("aria-pressed", on); b.textContent = on ? "✓ On team" : "+ Add to team";
      b.setAttribute("aria-label", `${on ? "Remove" : "Add"} ${a.name} ${on ? "from" : "to"} team`);
    });
    if (current && current.slug === slug) syncDrawerPick();
    renderTeam();
  }
  function script() {
    const lines = ["#!/usr/bin/env bash", "# Install your Agency team for Claude Code", "set -e", "mkdir -p ~/.claude/agents"];
    [...team].map(s => bySlug.get(s)).forEach(a => lines.push(`curl -fsSL -o ~/.claude/agents/${a.path.split("/").pop()} ${RAW}${a.path}`));
    lines.push(`echo "Installed ${team.size} agent${team.size === 1 ? "" : "s"} to ~/.claude/agents"`);
    return lines.join("\n");
  }
  function renderTeam() {
    const members = [...team].map(s => bySlug.get(s));
    $("tray").classList.toggle("on", members.length > 0);
    $("tray-n").textContent = `${members.length} ${members.length === 1 ? "agent" : "agents"}`;
    $("tray-names").textContent = members.map(a => a.name).join(", ");
    $("team-sub").textContent = members.length ? `${members.length} specialists picked` : "No one picked yet. Add agents from the roster.";
    $("team-script").value = members.length ? script() : "";
    $("team-list").innerHTML = members.map(a => `<li><a href="#${a.slug}">${esc(a.name)}</a> · ${esc(divMap.get(a.division).label)} <button class="pick" data-pick="${a.slug}" aria-pressed="true" aria-label="Remove ${esc(a.name)} from team">✓ On team</button></li>`).join("");
  }

  // Drawer
  function renderMd(src) {
    if (window.marked && window.DOMPurify) return DOMPurify.sanitize(marked.parse(src, { gfm: true }));
    return `<pre>${esc(src)}</pre>`;
  }
  function syncDrawerPick() { $("d-pick").textContent = team.has(current.slug) ? "✓ On team (remove)" : "Add to team"; }
  function openAgent(a) {
    current = a;
    const d = divMap.get(a.division);
    $("drawer").style.setProperty("--c", d.color);
    $("d-ava").textContent = a.emoji || "•";
    $("d-name").textContent = a.name;
    $("d-div").innerHTML = `<i></i>${esc(d.label)}${a.group ? " · " + esc(a.group) : ""} · ${fmt(a.words)} words`;
    $("d-vibe").textContent = a.vibe || a.description;
    $("d-path").textContent = a.path;
    $("d-gh").href = GH + a.path;
    a._briefShown = false;
    syncDrawerPick();
    showTab("work"); renderLog(a);
    show("drawer");
    document.title = a.name + " · Desk Six";
  }
  function show(id) {
    ["drawer", "team"].forEach(x => { const on = x === id; $(x).classList.toggle("on", on); $(x).setAttribute("aria-hidden", !on); });
    $("scrim").classList.toggle("on", !!id);
    document.body.style.overflow = id ? "hidden" : "";
    if (id) setTimeout(() => (id === "drawer" && !$("composer").hidden ? $("ask") : $(id).querySelector(".close")).focus(), 50);
  }
  function closeAll() {
    show(null); current = null; document.title = "Desk Six";
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  }
  function route() {
    if (!data) return;
    const h = decodeURIComponent(location.hash.slice(1));
    if (h === "team") { show("team"); return; }
    const a = bySlug.get(h);
    a ? openAgent(a) : (current || $("team").classList.contains("on")) && show(null);
  }
  addEventListener("hashchange", route);

  // Copy
  let tt;
  function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(tt); tt = setTimeout(() => t.classList.remove("on"), 1800); }
  function copy(text, done, fallbackEl) {
    const ok = () => toast(done);
    const fail = () => {
      if (fallbackEl) { fallbackEl.focus(); fallbackEl.select(); toast("Selected. Press Ctrl+C or ⌘C to copy."); }
      else { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
        let r = false; try { r = document.execCommand("copy"); } catch {} ta.remove(); r ? ok() : toast("Copy was blocked here. Select the text instead."); }
    };
    try { navigator.clipboard.writeText(text).then(ok, fail); } catch { fail(); }
  }

  // ---------- Making agents work ----------
  const MODELS = { quick: "claude-haiku-5-5", default: "claude-sonnet-5-5", complex: "claude-opus-5-5" };
  const FATAL = ["not_granted", "sampling_disabled", "not_declared", "capability_disabled", "capability_removed"];
  const engine = { kind: "pending", sample: null };
  const getKey = () => { try { return localStorage.getItem("agency.key") || ""; } catch { return ""; } };
  const setKey = k => { try { k ? localStorage.setItem("agency.key", k) : localStorage.removeItem("agency.key"); } catch {} };

  async function initEngine() {
    let s = null;
    if (window.claude && typeof window.claude.use === "function") { try { s = await window.claude.use("sample"); } catch {} }
    if (s) { engine.kind = "claude"; engine.sample = s; }
    else engine.kind = getKey() ? "key" : "none";
    engineUI();
  }
  function engineUI() {
    const t = { pending: "Connecting to Claude…", claude: "Runs on your Claude account", key: "Runs on your Anthropic API key", none: "Not connected", off: "Claude access is off for this page" }[engine.kind];
    $("engine").textContent = t; $("engine2").textContent = t;
    const pill = $("nav-engine"); pill.classList.toggle("live", engine.kind === "claude" || engine.kind === "key");
    pill.querySelector("span").textContent = { pending: "Connecting", claude: "Agents online", key: "Agents online", none: "Add a key to run agents", off: "Agents offline" }[engine.kind];
    $("connect").hidden = engine.kind !== "none";
    $("composer").hidden = engine.kind === "none";
    $("key-forget").hidden = engine.kind !== "key";
    const ready = engine.kind === "claude" || engine.kind === "key";
    if (!running) $("send").disabled = !ready;
    if (!jobRun) $("job-run").disabled = !ready;
    $("engine3").textContent = engine.kind === "none" ? "Add an API key: open any agent" : t;
    if (!apRun) $("ap-run").disabled = !ready;
  }
  function handleFatal(e) { if (FATAL.includes(e && e.code)) { engine.kind = "off"; engineUI(); } }

  function rules(a) {
    return `You are now working as "${a.name}", a specialist at Desk Six (${divMap.get(a.division).label} division). Below is your full agent definition. Adopt its identity, expertise, communication style, rules and workflow completely.

How to work:
- Do the actual job. Put the real, complete deliverable (code, copy, plan, analysis, review, document) in your reply, not a description of what you would do.
- If important details are missing, state short assumptions and proceed. Ask at most one or two clarifying questions, and only after delivering a first version.
- Use Markdown: headings, lists, tables and fenced code blocks where they help.
- You cannot browse the web, run code or remember earlier sessions. Work from what the user gives you, and say so when a task needs live data.

<agent_definition>
${a.body.slice(0, 80000)}
</agent_definition>`;
  }

  function mergeTurns(turns) {
    const out = [];
    for (const t of turns) { const l = out[out.length - 1]; if (l && l.role === t.role) l.content += "\n\n" + t.content; else out.push({ role: t.role, content: t.content }); }
    return out;
  }
  async function runAgent(system, turns, opts) {
    if (engine.kind === "claude") {
      const r = await engine.sample([{ role: "user", content: system }, ...turns.map(t => ({ role: t.role, content: t.content }))],
        { cache: false, signal: opts.signal, onText: opts.onText, modelTier: opts.tier });
      return { text: r.text, truncated: r.truncated };
    }
    if (engine.kind === "key") return runWithKey(system, turns, opts);
    throw { code: "not_connected", message: "Connect Claude first." };
  }
  async function runWithKey(system, turns, { onText, signal, tier }) {
    let res;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", signal,
        headers: { "content-type": "application/json", "x-api-key": getKey(), "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({ model: MODELS[tier] || MODELS.default, max_tokens: 8192, system, messages: mergeTurns(turns), stream: true })
      });
    } catch (e) { throw { code: signal && signal.aborted ? "cancelled" : "upstream_error", message: "Could not reach api.anthropic.com" }; }
    if (!res.ok) {
      let m = ""; try { m = (await res.json()).error.message; } catch {}
      throw { code: res.status === 401 || res.status === 403 ? "bad_key" : res.status === 429 ? "rate_limited" : "upstream_error", message: m || "HTTP " + res.status };
    }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "", text = "", stop = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = chunk.split("\n").find(l => l.startsWith("data:"));
          if (!line) continue;
          let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
          if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") { text += ev.delta.text; onText && onText({ text, delta: ev.delta.text }); }
          else if (ev.type === "message_delta" && ev.delta) stop = ev.delta.stop_reason || stop;
          else if (ev.type === "error") throw { code: "upstream_error", message: (ev.error && ev.error.message) || "Stream error", text };
        }
      }
    } catch (e) {
      if (e && e.code) throw e;
      throw { code: signal && signal.aborted ? "cancelled" : "upstream_error", message: "Connection dropped", text: text || undefined };
    }
    if (!text) throw { code: "empty_completion", message: "No text" };
    return { text, truncated: stop === "max_tokens" };
  }
  function errCopy(e) {
    const c = e && e.code;
    const m = {
      not_granted: "Claude access was declined for this page. Reload the page to be asked again.",
      sampling_disabled: "Claude isn't available on this account.",
      rate_limited: e && e.reason === "usage_limit" ? "You've reached your Claude usage limit. Try again later." : "Too many requests right now. Wait a moment, then run it again.",
      session_expired: "Your session expired. Sign in to claude.ai again.",
      refused: "Claude declined this request. Rephrase the task and try again.",
      prompt_too_large: "This conversation is too long. Start a new chat.",
      bad_key: "That API key was rejected. Forget it and save a valid key.",
      empty_completion: "No answer came back. Try rephrasing the task.",
      not_connected: "Connect Claude first."
    }[c];
    return m || "The run was interrupted. Run it again." + (engine.kind === "key" && e && e.message ? ` (${e.message})` : "");
  }

  // Starters
  const STARTERS = {
    engineering: ["Review this code for bugs, security and design problems:\n\n", "Design the architecture for: ", "Write a step-by-step implementation plan for: "],
    design: ["Critique this UI and give concrete fixes: ", "Create a design brief and visual direction for: ", "Write the UX copy for: "],
    marketing: ["Write a launch plan for: ", "Write 5 ready-to-post social posts about: ", "Audit this landing page copy and rewrite it:\n\n"],
    "paid-media": ["Build a paid campaign plan with budget split for: ", "Write 5 ad variations for: ", "Audit this campaign and tell me what to change:\n\n"],
    sales: ["Write a 4-email cold outreach sequence for: ", "Help me handle this objection: ", "Build a discovery call script for: "],
    product: ["Write a PRD for: ", "Prioritize these feature ideas and explain why:\n\n", "Turn this feedback into product insights:\n\n"],
    "project-management": ["Build a project plan with milestones for: ", "Write a status report from these notes:\n\n", "Identify the risks in this plan:\n\n"],
    testing: ["Write a test plan for: ", "Write test cases for this code:\n\n", "Review this feature for edge cases: "],
    security: ["Threat-model this system: ", "Review this code for vulnerabilities:\n\n", "Write a security checklist for: "],
    support: ["Draft a reply to this customer message:\n\n", "Write a help-center article about: ", "Build a support playbook for: "],
    finance: ["Build a simple financial model outline for: ", "Analyze these numbers and tell me what stands out:\n\n", "Write a budget plan for: "],
    "game-development": ["Design the core game loop for: ", "Write a game design document outline for: ", "Help me implement this mechanic: "],
    academic: ["Analyze this topic from your discipline: ", "Critique this argument:\n\n", "Design a study to answer: "],
    research: ["Synthesize these findings into insights:\n\n", "Design a research plan for: ", "Summarize and critique:\n\n"]
  };
  function renderStarters(a, show) {
    const box = $("starters");
    if (!show) { box.innerHTML = ""; return; }
    const list = STARTERS[a.division] || ["Here is my situation. Give me your plan: ", "Review this and tell me what to fix:\n\n", "Create a deliverable for: "];
    box.innerHTML = `<button type="button" data-go="intro">What can you do for me?</button>` + list.map((s, i) => `<button type="button" data-fill="${i}">${esc(s.replace(/[:\s]+$/, ""))}…</button>`).join("");
    box._list = list;
  }

  // Chat
  const chats = {};
  let running = null;
  const loadChat = slug => chats[slug] || (chats[slug] = store.get("agency.chat." + slug, []).filter(t => t && t.content));
  const saveChat = slug => store.set("agency.chat." + slug, chats[slug].slice(-30));
  function msgEl(t, a) {
    const d = document.createElement("div");
    d.className = "msg " + (t.role === "user" ? "user" : "ai");
    if (t.role === "user") d.textContent = t.content;
    else {
      d.innerHTML = `<div class="md"></div><div class="msg-ft"><span class="mono"></span><button type="button" data-copyans>Copy</button></div>`;
      d.querySelector(".md").innerHTML = renderMd(t.content);
      d.querySelector(".mono").textContent = a.name + (t.note ? " · " + t.note : "");
      d._text = t.content;
    }
    return d;
  }
  function renderLog(a, note) {
    const log = $("log"), turns = loadChat(a.slug);
    log.innerHTML = "";
    if (!turns.length) {
      const p = document.createElement("p"); p.className = "hello";
      p.innerHTML = `<strong></strong> is ready to work. <span></span> Describe the job below, or start from a suggestion.`;
      p.querySelector("strong").textContent = a.name; p.querySelector("span").textContent = a.description;
      log.append(p);
    }
    turns.forEach(t => log.append(msgEl(t, a)));
    if (running && running.slug === a.slug) log.append(running.el);
    if (note) { const n = document.createElement("p"); n.className = "note"; n.textContent = note; log.append(n); }
    renderStarters(a, !turns.length);
    log.scrollTop = log.scrollHeight;
  }
  function setBusy(b) { $("send").textContent = b ? "Stop" : "Run"; $("send").disabled = false; $("chat-clear").disabled = b; if (!b) engineUI(); }
  async function send(text) {
    const a = current;
    text = (text || "").trim();
    if (!a || !text || running || !(engine.kind === "claude" || engine.kind === "key")) return;
    const turns = loadChat(a.slug);
    turns.push({ role: "user", content: text }); saveChat(a.slug);
    $("ask").value = "";
    const el = document.createElement("div"); el.className = "msg ai";
    el.innerHTML = `<div class="md"><p class="thinking">Working on it…</p></div><div class="msg-ft"><span class="mono"></span><button type="button" data-stop>Stop</button></div>`;
    el.querySelector(".mono").textContent = a.name + " · working";
    const ctl = new AbortController();
    running = { ctl, slug: a.slug, el }; setBusy(true);
    renderLog(a);
    const md = el.querySelector(".md"), log = $("log");
    let raf = 0, latest = "", note = "";
    const paint = () => {
      raf = 0;
      const near = log.scrollHeight - log.scrollTop - log.clientHeight < 140;
      md.innerHTML = renderMd(latest);
      if (near && current && current.slug === a.slug) log.scrollTop = log.scrollHeight;
    };
    try {
      const history = turns.slice(-20);
      while (history.length && history[0].role !== "user") history.shift();
      const r = await runAgent(rules(a), history, { signal: ctl.signal, tier: $("tier").value, onText: ({ text }) => { latest = text; if (!raf) raf = requestAnimationFrame(paint); } });
      turns.push({ role: "assistant", content: r.text, note: r.truncated ? "cut short, ask it to continue" : "" });
    } catch (e) {
      if (e && e.text) turns.push({ role: "assistant", content: e.text, note: e.code === "cancelled" ? "stopped" : "interrupted" });
      if (!e || e.code !== "cancelled") note = errCopy(e);
      handleFatal(e);
    } finally {
      cancelAnimationFrame(raf);
      running = null; saveChat(a.slug); setBusy(false);
      if (current && current.slug === a.slug) renderLog(a, note);
      else if (note) toast(note);
    }
  }
  function showTab(which) {
    const work = which === "work";
    $("tab-work").setAttribute("aria-selected", work); $("tab-brief").setAttribute("aria-selected", !work);
    $("pane-work").hidden = !work; $("pane-brief").hidden = work;
    if (!work && current && !current._briefShown) {
      const a = current;
      $("d-md").innerHTML = (a.vibe && a.description ? `<blockquote><p>${esc(a.description)}</p></blockquote>` : "") + renderMd(a.body);
      $("d-md").querySelectorAll("a[href^='http']").forEach(l => { l.target = "_blank"; l.rel = "noopener"; });
      $("pane-brief").scrollTop = 0;
      bySlug.forEach(x => x._briefShown = false); a._briefShown = true;
    }
  }

  // Team job
  let jobRun = null, jobReport = "";
  async function runTeam(job) {
    job = job.trim();
    const members = [...team].map(s => bySlug.get(s));
    if (!members.length) return toast("Add agents to your team first");
    if (!job) { $("job").focus(); return toast("Describe the job first"); }
    if (!(engine.kind === "claude" || engine.kind === "key")) return toast(engine.kind === "none" ? "Connect Claude first: open any agent to add your key" : "Claude isn't available here");
    const log = $("job-log"); log.innerHTML = "";
    const boxes = members.map((a, i) => {
      const b = document.createElement("div"); b.className = "job-step";
      b.innerHTML = `<h4><span></span><span></span><small>${i + 1} of ${members.length}</small></h4><div class="md"><p class="thinking">Waiting for teammates…</p></div>`;
      b.querySelectorAll("h4 span")[0].textContent = a.emoji || "•"; b.querySelectorAll("h4 span")[1].textContent = a.name;
      log.append(b); return b;
    });
    const ctl = new AbortController(); jobRun = ctl;
    $("job-run").textContent = "Stop"; $("job-copy").hidden = true;
    jobReport = `# Team job\n\n${job}\n\nTeam: ${members.map(m => m.name).join(", ")}`;
    const done = [];
    for (let i = 0; i < members.length; i++) {
      const a = members[i], md = boxes[i].querySelector(".md");
      md.innerHTML = `<p class="thinking">Working on it…</p>`;
      const prior = done.map(d => `## ${d.name}\n\n${d.text.slice(0, 12000)}`).join("\n\n");
      const prompt = `TEAM JOB:\n${job}\n\nYou are member ${i + 1} of ${members.length} on this team: ${members.map(m => m.name).join(", ")}.\n\n` +
        (prior ? `Your teammates have already delivered the work below. Build on it, don't repeat it, and fix anything in your area that's wrong.\n\n<teammate_work>\n${prior}\n</teammate_work>\n\n`
               : "You go first. Lay groundwork the teammates after you can build on.\n\n") +
        "Deliver your part of the job from your specialty now. Open with a one-line heading that names your contribution.";
      let raf = 0, latest = "";
      try {
        const r = await runAgent(rules(a), [{ role: "user", content: prompt }], { signal: ctl.signal, tier: "default",
          onText: ({ text }) => { latest = text; if (!raf) raf = requestAnimationFrame(() => { raf = 0; md.innerHTML = renderMd(latest); }); } });
        cancelAnimationFrame(raf);
        md.innerHTML = renderMd(r.text);
        done.push({ name: a.name, text: r.text });
        jobReport += `\n\n---\n\n## ${a.name}\n\n${r.text}`;
      } catch (e) {
        cancelAnimationFrame(raf);
        md.innerHTML = (e && e.text ? renderMd(e.text) : "") + `<p class="note">${esc(e && e.code === "cancelled" ? "Stopped." : errCopy(e))}</p>`;
        handleFatal(e);
        for (let j = i + 1; j < members.length; j++) boxes[j].querySelector(".md").innerHTML = `<p class="note">Didn't run.</p>`;
        break;
      }
    }
    jobRun = null; $("job-run").textContent = "Run team"; $("job-copy").hidden = !done.length; engineUI();
  }

  // ---------- Autopilot ----------
  const DIRECTOR = "agents-orchestrator";
  const IDEAS = [
    "Earn my first $1,000 selling Notion templates to freelancers",
    "Launch a $49/month website audit service for local restaurants",
    "Grow a remote-jobs newsletter to 1,000 subscribers and sell sponsorships",
    "Sell a $29 guide that teaches small shops to use AI for customer support"
  ];
  const GUARD = "Ground rules for the whole team: use only legitimate, legal business methods. No spam, fake reviews, deception, scraping personal data or get-rich-quick schemes. Never invent results, customers, testimonials or statistics; label every projected number as an estimate and state its assumptions. Nobody on the team can browse, post, send, buy or take payments: produce ready-to-use assets and say exactly what the human must do to launch them.";
  let apRun = null, apState = store.get("agency.autopilot", null);

  function director() { return bySlug.get(DIRECTOR) || data.agents.find(a => a.division === "project-management") || data.agents[0]; }
  function rosterIndex() {
    return data.agents.filter(a => a.slug !== DIRECTOR).map(a => `${a.slug} | ${a.name} | ${(a.vibe || a.description).slice(0, 90)}`).join("\n");
  }
  function extractJSON(t) {
    try { return JSON.parse(t); } catch {}
    const m = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (m) { try { return JSON.parse(m[1]); } catch {} }
    const i = t.indexOf("{"), j = t.lastIndexOf("}");
    if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch {} }
    return null;
  }
  function apSave() { if (apState) store.set("agency.autopilot", apState); }
  function apReport() {
    if (!apState) return "";
    let r = `# Autopilot launch kit\n\n**Goal:** ${apState.goal}\n\n**Strategy:** ${apState.summary || ""}`;
    if (apState.kit) r += `\n\n---\n\n${apState.kit}`;
    apState.steps.forEach((st, i) => { if (st.text) r += `\n\n---\n\n## ${i + 1}. ${st.title} (${st.name})\n\n${st.text}`; });
    return r;
  }

  function stepEl(st, i) {
    const d = document.createElement("details");
    d.className = "ap-step" + (st.kind === "kit" ? " kit" : "");
    const a = bySlug.get(st.slug), dv = a && divMap.get(a.division);
    d.style.setProperty("--c", dv ? dv.color : "var(--ink)");
    d.open = st.status === "working" || st.kind === "kit" || (st.kind === "plan" && st.status === "done" && !apState.steps.some(x => x.status === "done"));
    d.innerHTML = `<summary><span class="ap-num"></span><span class="ava" aria-hidden="true"></span><span class="ap-who"><b></b><small></small></span><span class="state"></span></summary><div class="md"></div>`;
    d.querySelector(".ap-num").textContent = st.kind === "task" ? String(i + 1).padStart(2, "0") : st.kind === "plan" ? "PLAN" : "KIT";
    d.querySelector(".ava").textContent = st.emoji || "•";
    d.querySelector("b").textContent = st.kind === "kit" ? "Launch kit" : st.title;
    d.querySelector("small").textContent = st.name;
    const s = d.querySelector(".state"); s.textContent = st.status; s.className = "state " + st.status;
    const md = d.querySelector(".md");
    md.innerHTML = st.text ? renderMd(st.text) : st.status === "working" ? `<p class="thinking">${st.kind === "plan" ? "Planning the work and choosing specialists…" : "Working on it…"}</p>` : st.status === "failed" ? "" : `<p class="note">Waiting for the teammates before.</p>`;
    if (st.error) md.insertAdjacentHTML("beforeend", `<p class="note">${esc(st.error)}</p>`);
    return d;
  }
  function renderBoard() {
    const b = $("ap-board"); b.innerHTML = "";
    if (!apState) {
      b.innerHTML = `<div class="ap-empty">
        <div class="flow"><span><b>01</b>Plan</span><i></i><span><b>02</b>Specialists deliver</span><i></i><span><b>03</b>Launch kit</span></div>
        <p>Write a goal on the left, or pick an example. The Orchestrator turns it into a plan, picks specialists from all ${data.agents.length} agents, and runs them one after another. Each step appears here as it finishes, and the last run stays saved in this browser.</p></div>`;
      $("ap-copy").hidden = true; return;
    }
    const d = director();
    b.append(stepEl({ kind: "plan", title: "The plan", name: d.name, emoji: d.emoji, slug: d.slug, status: apState.planStatus, text: apState.summary ? `**Strategy:** ${apState.summary}\n\n` + apState.steps.map((x, i) => `${i + 1}. **${x.title}**, ${x.name}`).join("\n") : "", error: apState.planError }, 0));
    apState.steps.forEach((st, i) => b.append(stepEl({ ...st, kind: "task" }, i)));
    if (apState.kitStatus) b.append(stepEl({ kind: "kit", name: d.name + " · your next steps", emoji: "🚀", slug: d.slug, status: apState.kitStatus, text: apState.kit, error: apState.kitError }, 0));
    $("ap-copy").hidden = !apState.steps.some(x => x.text);
  }
  function live(update) { // re-render only the step that is working, throttled
    if (live.raf) return; live.raf = requestAnimationFrame(() => { live.raf = 0; update(); });
  }

  async function runAutopilot(goal) {
    goal = goal.trim();
    if (!goal) { $("ap-goal").focus(); return toast("Write a goal first"); }
    if (!(engine.kind === "claude" || engine.kind === "key")) return toast(engine.kind === "none" ? "Connect Claude first: open any agent to add your API key" : "Claude isn't available here");
    const size = +$("ap-size").value || 6, d = director();
    const ctl = new AbortController(); apRun = ctl;
    $("ap-run").textContent = "Stop autopilot"; $("ap-goal").disabled = true;
    apState = { goal, summary: "", steps: [], planStatus: "working", kitStatus: "", kit: "", at: Date.now() };
    renderBoard();
    const fail = (e) => { handleFatal(e); return e && e.code === "cancelled" ? "Stopped." : errCopy(e); };
    try {
      // 1. Plan
      let plan = null;
      try {
        const prompt = `${GUARD}\n\nAUTOPILOT GOAL: ${goal}\n\nPlan how this agency reaches the goal. Choose ${size} tasks (no more) for specialists from the roster below, using their slugs exactly. Order the tasks so each builds on the ones before. Every task must produce one concrete, ready-to-use asset, such as: target customer and offer with pricing, landing page copy, a product outline, an email sequence, a content calendar, ad variations, a sales script, a financial projection. Prefer the most specific specialist for each task.\n\nReply with only JSON, no other text:\n{"summary": "one short paragraph of strategy", "tasks": [{"agent": "slug", "title": "short asset name", "brief": "exactly what to produce, 1-3 sentences"}]}\n\nROSTER (slug | name | speciality):\n${rosterIndex()}`;
        const r = await runAgent(rules(d), [{ role: "user", content: prompt }], { signal: ctl.signal, tier: "default" });
        plan = extractJSON(r.text);
      } catch (e) { apState.planStatus = "failed"; apState.planError = fail(e); return; }
      const tasks = (plan && Array.isArray(plan.tasks) ? plan.tasks : []).filter(t => t && bySlug.has(String(t.agent))).slice(0, size);
      if (!tasks.length) { apState.planStatus = "failed"; apState.planError = "The plan came back unreadable. Start the autopilot again, or make the goal more specific."; return; }
      apState.summary = String(plan.summary || "");
      apState.steps = tasks.map(t => { const a = bySlug.get(String(t.agent)); return { slug: a.slug, name: a.name, emoji: a.emoji, title: String(t.title || "Task").slice(0, 80), brief: String(t.brief || ""), status: "queued", text: "" }; });
      apState.planStatus = "done"; apSave(); renderBoard();
      const planText = apState.steps.map((x, i) => `${i + 1}. ${x.title} (${x.name}): ${x.brief}`).join("\n");

      // 2. Specialists
      for (let i = 0; i < apState.steps.length; i++) {
        const st = apState.steps[i], a = bySlug.get(st.slug);
        st.status = "working"; renderBoard();
        let budget = 40000;
        const prior = apState.steps.slice(0, i).filter(x => x.text).reverse().map(x => { const t = x.text.slice(0, Math.min(8000, Math.max(0, budget))); budget -= t.length; return t ? `## ${x.title} (${x.name})\n\n${t}` : ""; }).filter(Boolean).reverse().join("\n\n");
        const prompt = `${GUARD}\n\nAUTOPILOT GOAL: ${goal}\n\nSTRATEGY: ${apState.summary}\n\nFULL PLAN:\n${planText}\n\nYOUR TASK (#${i + 1}): ${st.title}\n${st.brief}\n\n` +
          (prior ? `Work your teammates already delivered (build on it, keep names, prices and positioning consistent, don't repeat it):\n<teammate_work>\n${prior}\n</teammate_work>\n\n` : "You go first; set foundations the others can build on.\n\n") +
          "Deliver your asset now, complete and ready to use. Open with a one-line heading naming it.";
        try {
          const r = await runAgent(rules(a), [{ role: "user", content: prompt }], { signal: ctl.signal, tier: "default",
            onText: ({ text }) => { st.text = text; live(renderBoard); } });
          st.text = r.text; st.status = "done";
        } catch (e) {
          st.status = "failed"; if (e && e.text) st.text = e.text; st.error = fail(e);
          apState.steps.slice(i + 1).forEach(x => x.status = "skipped");
          return;
        }
        apSave(); renderBoard();
      }

      // 3. Launch kit
      apState.kitStatus = "working"; renderBoard();
      const all = apState.steps.map((x, i) => `## ${i + 1}. ${x.title} (${x.name})\n\n${x.text.slice(0, 6000)}`).join("\n\n");
      const prompt = `${GUARD}\n\nAUTOPILOT GOAL: ${goal}\n\nYour team has delivered everything below. Write the LAUNCH KIT for the human who will take this to market. Use these sections:\n\n## What the team built\nOne line per asset.\n\n## Launch checklist\nNumbered, concrete actions in order, starting today, each naming the asset to use. Include the exact accounts or tools to set up (for example Stripe, Gumroad, Lemon Squeezy, a website builder, an email tool) and roughly how long each step takes.\n\n## How the money comes in\nPrice, how payment is collected, and a clearly labelled estimate of the first 30 to 90 days with every assumption stated. Be conservative and honest.\n\n## Measure and adjust\nThe three numbers to watch and what to change if they are low.\n\n## Risks\nThe main risks and how to reduce them.\n\n<team_work>\n${all}\n</team_work>`;
      try {
        const r = await runAgent(rules(d), [{ role: "user", content: prompt }], { signal: ctl.signal, tier: "default",
          onText: ({ text }) => { apState.kit = text; live(renderBoard); } });
        apState.kit = r.text; apState.kitStatus = "done";
      } catch (e) { apState.kitStatus = "failed"; if (e && e.text) apState.kit = e.text; apState.kitError = fail(e); }
    } finally {
      apRun = null; apSave(); renderBoard();
      $("ap-run").textContent = "Start autopilot"; $("ap-goal").disabled = false; engineUI();
      if (apState && apState.kitStatus === "done") toast("Launch kit ready");
    }
  }
  function initAutopilot() {
    $("ap-ideas").innerHTML = IDEAS.map((t, i) => `<button type="button" data-idea="${i}">${esc(t)}</button>`).join("");
    if (apState) {
      $("ap-goal").value = apState.goal || "";
      // a run interrupted by closing the page can't resume
      if (apState.planStatus === "working") { apState.planStatus = "failed"; apState.planError = "This run was interrupted."; }
      apState.steps.forEach(x => { if (x.status === "working") { x.status = "failed"; x.error = "This run was interrupted."; } });
      if (apState.kitStatus === "working") { apState.kitStatus = "failed"; apState.kitError = "This run was interrupted."; }
    }
    renderBoard();
  }

  // Events
  document.addEventListener("click", e => {
    const p = e.target.closest("[data-pick]"); if (p) { e.preventDefault(); toggleTeam(p.dataset.pick); return; }
    const o = e.target.closest("[data-open]"); if (o) { location.hash = o.dataset.open; return; }
    if (e.target.closest("[data-stop]")) { running && running.ctl.abort(); return; }
    const ca = e.target.closest("[data-copyans]"); if (ca) { copy(ca.closest(".msg")._text, "Answer copied"); return; }
    const go = e.target.closest("[data-go]"); if (go) { send("Introduce yourself in a few lines, then list the concrete deliverables you can produce for me, with one short example of your work."); return; }
    const fill = e.target.closest("[data-fill]"); if (fill) { const v = $("starters")._list[+fill.dataset.fill]; $("ask").value = v; $("ask").focus(); $("ask").setSelectionRange(v.length, v.length); return; }
    const idea = e.target.closest("[data-idea]"); if (idea) { $("ap-goal").value = IDEAS[+idea.dataset.idea]; $("ap-goal").focus(); return; }
    const dp = e.target.closest("[data-dept]"); if (dp) { pickDept(dp.dataset.dept); return; }
    const c = e.target.closest(".chip"); if (c) { state.div = c.dataset.div; store.set("agency.div", state.div); renderChips(); render(); }
  });
  $("q").addEventListener("input", e => { state.q = e.target.value.trim(); render(); });
  $("sort").addEventListener("change", e => { state.sort = e.target.value; store.set("agency.sort", state.sort); render(); });
  $("scrim").addEventListener("click", closeAll);
  $("d-close").addEventListener("click", closeAll);
  $("team-close").addEventListener("click", closeAll);
  $("d-pick").addEventListener("click", () => current && toggleTeam(current.slug));
  $("d-copy").addEventListener("click", () => current && copy(current.body, "Prompt copied"));
  $("d-cmd").addEventListener("click", () => current && copy(`mkdir -p ~/.claude/agents && curl -fsSL -o ~/.claude/agents/${current.path.split("/").pop()} ${RAW}${current.path}`, "Install command copied"));
  $("tab-work").addEventListener("click", () => showTab("work"));
  $("tab-brief").addEventListener("click", () => showTab("brief"));
  $("composer").addEventListener("submit", e => { e.preventDefault(); running ? running.ctl.abort() : send($("ask").value); });
  $("ask").addEventListener("keydown", e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!running) send($("ask").value); } });
  $("chat-clear").addEventListener("click", () => { if (!current || running) return; chats[current.slug] = []; saveChat(current.slug); renderLog(current); $("ask").focus(); });
  $("key-form").addEventListener("submit", e => { e.preventDefault(); const k = $("key-in").value.trim(); if (!k) return; setKey(k); $("key-in").value = ""; engine.kind = "key"; engineUI(); toast("Key saved in this browser"); $("ask").focus(); });
  $("key-forget").addEventListener("click", () => { setKey(""); engine.kind = "none"; engineUI(); toast("Key removed"); });
  $("job-form").addEventListener("submit", e => { e.preventDefault(); jobRun ? jobRun.abort() : runTeam($("job").value); });
  $("job-copy").addEventListener("click", () => copy(jobReport, "Report copied"));
  $("ap-form").addEventListener("submit", e => { e.preventDefault(); apRun ? apRun.abort() : runAutopilot($("ap-goal").value); });
  $("ap-copy").addEventListener("click", () => copy(apReport(), "Launch kit copied"));
  $("tray-open").addEventListener("click", () => { location.hash = "team"; });
  $("tray-clear").addEventListener("click", clearTeam);
  $("team-clear").addEventListener("click", clearTeam);
  $("team-copy").addEventListener("click", () => team.size ? copy(script(), "Install script copied", $("team-script")) : toast("Add agents to your team first"));
  function clearTeam() { const s = [...team]; team.clear(); store.set("agency.team", []); s.forEach(x => document.querySelectorAll(`[data-pick="${x}"]`).forEach(b => { b.setAttribute("aria-pressed", false); b.textContent = "+ Add to team"; })); if (current) syncDrawerPick(); renderTeam(); toast("Team cleared"); }
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && $("scrim").classList.contains("on") && !(e.target.tagName === "TEXTAREA" && e.target.value)) closeAll();
    else if (e.key === "/" && document.activeElement.tagName !== "INPUT" && document.activeElement.tagName !== "TEXTAREA") { e.preventDefault(); $("q").focus(); }
  });
})();
