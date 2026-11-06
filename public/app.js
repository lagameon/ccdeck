import { Terminal } from "/vendor/xterm.mjs";
import { FitAddon } from "/vendor/addon-fit.mjs";
import { WebLinksAddon } from "/vendor/addon-web-links.mjs";
import { marked } from "/vendor/marked.mjs";
import DOMPurify from "/vendor/purify.mjs";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// External images in transcripts could be tracking beacons: keep them as text, load nothing.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "IMG") {
    const src = node.getAttribute("src") || "";
    if (!src.startsWith("data:")) { node.removeAttribute("src"); node.removeAttribute("srcset"); node.setAttribute("alt", `[external image not loaded: ${src}]`); }
  }
  if (node.tagName === "A") { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer"); }
});
const md = (s) => DOMPurify.sanitize(marked.parse(String(s ?? ""), { breaks: true, gfm: true }));
// Layout follows width, not device type: an iPad with a keyboard or a MacBook gets the desktop layout.
const wide = () => innerWidth >= 900;
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

function ago(t) {
  const ms = Date.now() - (typeof t === "number" ? t : Date.parse(t));
  if (!isFinite(ms)) return "";
  const s = ms / 1000;
  if (s < 60) return "now"; if (s < 3600) return `${Math.floor(s / 60)}m`; if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
function toast(msg, ms = 2500) { const t = $("#toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("on"), ms); }
async function api(path, body) {
  const r = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || d.out || r.statusText);
  return d;
}
const short = (p) => (p || "").replace(/^\/Users\/[^/]+/, "~");
const needsText = (n) => (n == null ? "" : typeof n === "string" ? n : n.text || n.question || JSON.stringify(n));
const outText = (o) => (o == null ? "" : typeof o === "string" ? o : o.result || o.text || o.headline || JSON.stringify(o));
const isBlocked = (j) => j.tempo === "blocked" || j.state === "blocked" || (j.needs && j.state !== "done");
const jobState = (j) => (isBlocked(j) ? "blocked" : j.state);

// ───────────── state + polling + notifications ─────────────
let data = { jobs: [], transcripts: [], tmux: [], cwds: [], ptys: [] };
let prevJobState = null;
const showAll = { done: false, tr: false };

async function poll() {
  try {
    data = await api("/api/sessions");
    notifyTransitions();
    const v = route().view;
    if (v === "list") { await loadStats(); renderDash(); } else refreshMeta();
    renderSide();
    const blocked = data.jobs.filter(isBlocked).length;
    document.title = blocked ? `(${blocked}) ccdeck` : "ccdeck";
  } catch (e) { console.warn(e); }
}
function notifyTransitions() {
  const now = new Map(data.jobs.map((j) => [j.id, jobState(j)]));
  if (prevJobState) for (const [id, st] of now) {
    const was = prevJobState.get(id);
    if (was && was !== st && (st === "blocked" || st === "done")) {
      const j = data.jobs.find((x) => x.id === id);
      const msg = st === "blocked" ? `needs you: ${needsText(j.needs) || j.detail}` : `done: ${outText(j.output) || j.detail}`;
      // System notifications now come from the server (Web Push), so only an in-page toast here.
      toast(`${j.name} — ${msg}`, 5000);
      navigator.vibrate?.(120);
    }
  }
  prevJobState = now;
}
// ───────────── push notifications (server → this device) ─────────────
const b64ToU8 = (b) => { const s = atob((b + "=".repeat((4 - (b.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };
async function pushState() {
  if (!window.isSecureContext || !("serviceWorker" in navigator) || !("PushManager" in window)) return "unsupported";
  const reg = await navigator.serviceWorker.getRegistration(); const sub = await reg?.pushManager.getSubscription();
  return sub ? "on" : "off";
}
async function refreshBell() { const st = await pushState().catch(() => "off"); $("#notif").textContent = st === "on" ? "🔔" : "🔕"; $("#notif").title = st === "on" ? "Push on for this device — click to send a test" : "Enable push notifications on this device"; }
$("#notif").onclick = async () => {
  try {
    if (!window.isSecureContext) {
      const ios = /iPhone|iPad/.test(navigator.userAgent);
      return toast(ios ? "Push needs the HTTPS address, opened from the Home Screen app (see README)" : "Push needs HTTPS or localhost (see README)", 6000);
    }
    if (!("PushManager" in window)) return toast("This browser has no Web Push. On iPhone: Share → Add to Home Screen, then open ccdeck from the Home Screen.", 7000);
    const reg = await navigator.serviceWorker.register("/sw.js"); await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      if ((await Notification.requestPermission()) !== "granted") return toast("Notifications were not allowed");
      const { publicKey } = await api("/api/push/key");
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(publicKey) });
      const label = `${/iPhone/.test(navigator.userAgent) ? "iPhone" : /iPad/.test(navigator.userAgent) ? "iPad" : /Mac/.test(navigator.userAgent) ? "Mac" : "device"} · ${navigator.userAgent.match(/(Chrome|Safari|Firefox|Edg)\/[\d.]+/)?.[0] || ""}`;
      await api("/api/push/subscribe", { subscription: sub.toJSON(), label });
    }
    const r = await api("/api/push/test", {});
    toast(`Test sent to ${r.push} device(s)${r.telegram === null ? "" : `, Telegram ${r.telegram ? "ok" : "failed"}`}`, 4000);
  } catch (e) { toast(`Push setup failed: ${e.message}`, 6000); }
  refreshBell();
};

// ───────────── all sessions as one flat list (sidebar, switcher) ─────────────
function allItems() {
  const order = { blocked: 0, working: 1 };
  const jobs = [...data.jobs].sort((a, b) => (order[jobState(a)] ?? 2) - (order[jobState(b)] ?? 2));
  return [
    ...jobs.map((j) => ({ href: `#/job/${j.id}`, group: jobState(j) === "blocked" ? "Needs you" : jobState(j) === "working" ? "Running" : "Finished", cls: jobState(j), name: j.name, sub: isBlocked(j) ? needsText(j.needs) || j.detail : j.detail, age: j.updatedAt, key: `${j.name} ${j.id} ${j.detail} ${j.cwd}` })),
    ...data.transcripts.map((t) => ({ href: `#/t/${t.sessionId}`, group: "Interactive", cls: "", name: t.title, sub: t.lastPrompt, age: t.mtime, key: `${t.title} ${t.lastPrompt} ${t.cwd}` })),
    ...data.tmux.map((s) => ({ href: `#/tmux/${encodeURIComponent(s.name)}`, group: "tmux", cls: "", name: `tmux: ${s.name}`, sub: `${s.command} · ${short(s.path)}`, age: s.activity, key: `tmux ${s.name} ${s.path}` })),
    { href: "#/shell", group: "tmux", cls: "", name: "shell (tmux ccdeck)", sub: "persistent shell", age: "", key: "shell ccdeck" },
  ];
}
function itemHtml(it, extra = "") {
  return `<a class="si ${it.cls} ${extra}" href="${it.href}"><div class="n"><b>${esc(it.name)}</b><i>${ago(it.age)}</i></div><div class="d">${esc(it.sub)}</div></a>`;
}
function match(it, q) { return !q || q.toLowerCase().split(/\s+/).every((w) => it.key.toLowerCase().includes(w) || it.name.toLowerCase().includes(w)); }

function renderSide() {
  const side = $("#side"); if (side.hidden) return;
  const q = $("#sideFilter").value.trim(); const here = location.hash;
  let html = "", group = "";
  for (const it of allItems().filter((i) => match(i, q))) {
    if (it.group !== group) { group = it.group; html += `<div class="sg">${esc(group)}</div>`; }
    html += itemHtml(it, it.href === here ? "on" : "");
  }
  const el = $("#sideList"); const y = el.scrollTop; el.innerHTML = html; el.scrollTop = y;
}
$("#sideFilter").addEventListener("input", renderSide);

// ───────────── dashboard ─────────────
function jobCard(j) {
  const st = jobState(j);
  const live = data.ptys.includes(`job:${j.id}`) ? `<span class="chip live">attached</span>` : "";
  const nt = isBlocked(j) ? needsText(j.needs) : "";
  const needs = nt ? `<div class="needs">⚑ ${esc(nt)}</div>` : "";
  const res = j.state === "done" && outText(j.output) ? `<div class="result">${esc(outText(j.output).slice(0, 220))}</div>` : "";
  const ot = outText(j.output);
  const dup = (nt && nt === j.detail) || (j.state === "done" && ot && (ot.startsWith(j.detail) || j.detail.startsWith(ot.slice(0, 40))));
  const detail = dup ? "" : `<div class="l2">${esc(j.detail || j.intent)}</div>`;
  return `<a class="card ${st}" href="#/job/${j.id}">
    <div class="l1"><span class="name">${esc(j.name)}</span>${live}<span class="chip ${st}">${esc(st)}</span><span class="age">${ago(j.updatedAt)}</span><button class="x" data-rm="${j.id}" title="Close and remove from the list (transcript is kept)">×</button></div>
    ${detail}${needs}${res}<div class="l2">${esc(j.id)} · ${esc(short(j.cwd))}</div></a>`;
}
const trCard = (t) => `<a class="card" href="#/t/${t.sessionId}"><div class="l1"><span class="name">${esc(t.title)}</span><span class="age">${ago(t.mtime)}</span></div><div class="l2">${esc(t.lastPrompt)}</div><div class="l2">${esc(short(t.cwd))}</div></a>`;
const tmuxCard = (s) => `<a class="card" href="#/tmux/${encodeURIComponent(s.name)}"><div class="l1"><span class="name">tmux: ${esc(s.name)}</span>${s.attached ? `<span class="chip live">${s.attached} attached</span>` : ""}<span class="age">${ago(s.activity)}</span></div><div class="l2">${esc(s.command)} · ${esc(short(s.path))} · ${s.windows} win</div></a>`;
function section(title, items, render, opt = {}) {
  let list = items, more = "";
  if (opt.limit && !showAll[opt.key] && items.length > opt.limit) { list = items.slice(0, opt.limit); more = `<button class="more" data-more="${opt.key}">show ${items.length - opt.limit} more</button>`; }
  const body = list.length ? list.map(render).join("") : `<div class="empty">${opt.empty || "none"}</div>`;
  return `<div><h2>${title}<span class="count">${items.length}</span></h2>${body}${more}</div>`;
}
// ───────────── overview (today tiles + 14-day charts) ─────────────
let stats = null;
async function loadStats() { try { stats = await api("/api/stats?days=14"); } catch (e) { console.warn(e); } }
function dashSkeleton() {
  if ($("#overview")) return;
  $("#dash").innerHTML = `<div id="overview"></div><div id="dashBody"></div>`;
}
const fmtTok = (n) => n >= 1e9 ? (n / 1e9).toFixed(1) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n);
let overviewSig = "";
function renderOverview() {
  const st = stats; const el = $("#overview"); if (!el) return;
  const jobsNow = { run: data.jobs.filter((j) => !isBlocked(j) && j.state === "working").length, wait: data.jobs.filter(isBlocked).length,
    doneToday: data.jobs.filter((j) => j.state === "done" && (j.updatedAt || "").slice(0, 10) === new Date().toISOString().slice(0, 10)).length };
  const sig = JSON.stringify([st?.updatedAt, st?.quota, jobsNow, wide()]); if (sig === overviewSig) return; overviewSig = sig;
  if (!st?.ready) { el.innerHTML = `<div class="empty">building usage stats…</div>`; return; }
  const t = st.days[st.days.length - 1];
  const tile = (label, val, sub = "") => `<div class="tile"><div class="tv">${val}</div><div class="tl">${label}</div>${sub ? `<div class="ts2">${sub}</div>` : ""}</div>`;
  // Optional quota tiles (config.quotaUrl). Each account carries its own state: never show a stale number as current.
  const q = st.quota;
  const pct = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Math.max(0, Math.min(100, Math.round(Number(v)))));
  const hrs = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : 0);
  for (const b of (st.quota?.bars || [])) { b.h = pct(b.h); b.w = pct(b.w); b.ageHours = hrs(b.ageHours); }
  if (st.quota) st.quota.ageHours = hrs(st.quota.ageHours);
  const qBar = (b) => b.state === "ok"
    ? tile(`Quota ${esc(b.label)} (7d)`, b.w == null ? "–" : `${b.w}%`, (b.h == null ? "no 5-hour limit" : `5-hour window ${b.h}%`) + (b.codex && b.ageHours ? `; snapshot ${b.ageHours}h old` : ""))
    : b.codex && b.state === "stale"
    ? tile(`Quota ${esc(b.label)} (7d)`, b.w == null ? "–" : `${b.w}%`, `snapshot ${b.ageHours}h old (updates only when Codex is used)`)
    : `<div class="tile warn"><div class="tv">⚠</div><div class="tl">Quota ${esc(b.label)}</div><div class="ts2">${esc(b.state === "auth" ? "login expired — sign in to this account again" : b.note || b.state)}${b.ageHours ? `; data is ${b.ageHours}h old` : ""}</div></div>`;
  const quota = !q ? "" : q.bars.length ? (q.ok ? q.bars.map(qBar).join("")
      : `<div class="tile warn"><div class="tv">⚠</div><div class="tl">Quota unavailable</div><div class="ts2">data is ${q.ageHours}h old${q.err ? " (collector error)" : ""}; not showing stale numbers</div></div>`)
    : `<div class="tile warn"><div class="tv">⚠</div><div class="tl">Quota</div><div class="ts2">${esc(q.err || "no data")}</div></div>`;
  const models = Object.entries(t.models || {}).sort((a, b) => b[1] - a[1]).map(([m, v]) => `${esc(m)} ${fmtTok(v)}`).join(" · ");
  el.innerHTML = `<h2>Today<span class="count">${esc(t.date)}</span><span class="ov-upd">stats updated ${ago(st.updatedAt) === "now" ? "just now" : `${ago(st.updatedAt)} ago`}</span></h2>
    <div class="tiles">
      ${tile("running", jobsNow.run)}${tile("needs you", jobsNow.wait)}${tile("done today", jobsNow.doneToday)}
      ${tile("active sessions", t.sessions)}${tile("your messages", t.prompts)}${tile("Claude turns", t.turns, `${t.tools} tool calls`)}
      ${tile("output tokens", fmtTok(t.out), models)}${tile("input tokens", fmtTok(t.inp + t.cr), `${fmtTok(t.cr)} from cache`)}
      ${quota}
    </div>
    <div class="charts">
      ${barChart("Output tokens per day (14 days)", st.days, (d) => d.out, (d) => `${d.date}<br>output ${fmtTok(d.out)} · input ${fmtTok(d.inp + d.cr)}<br>${d.turns} turns · ${d.tools} tool calls`, fmtTok)}
      ${barChart("Active sessions per day (14 days)", st.days, (d) => d.sessions, (d) => `${d.date}<br>${d.sessions} active sessions · ${d.prompts} messages from you`, String)}
    </div>
    ${st.top.length ? `<div class="top-s"><div class="tl">Top sessions by tokens today</div>${st.top.map((x) => `<a href="${x.href}"><span>${esc(x.name)}</span><b>${fmtTok(x.tokens)}</b></a>`).join("")}</div>` : ""}`;
  el.querySelectorAll(".bar").forEach((b) => {
    b.addEventListener("mouseenter", (e) => showTip(b.dataset.tip, e)); b.addEventListener("mousemove", (e) => showTip(b.dataset.tip, e));
    b.addEventListener("mouseleave", hideTip); b.addEventListener("click", (e) => showTip(b.dataset.tip, e));
  });
}
// Single-series column chart: thin columns (≤24px), 4px rounded top, hairline baseline, peak labelled, tooltip per column.
function barChart(title, days, val, tip, fmt) {
  const W = 320, H = 110, padB = 18, padT = 14, n = days.length, slot = W / n, bw = Math.min(16, slot - 4);
  const max = Math.max(1, ...days.map(val)); const peak = days.reduce((a, d, i) => (val(d) > val(days[a]) ? i : a), 0);
  const bars = days.map((d, i) => {
    const v = val(d), h = v ? Math.max(2, (v / max) * (H - padB - padT)) : 0, x = i * slot + (slot - bw) / 2, y = H - padB - h;
    const r = Math.min(4, h / 2);
    const path = h ? `M${x},${H - padB} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${H - padB} Z` : "";
    return `<g class="bar" data-tip="${esc(tip(d))}"><rect x="${i * slot}" y="0" width="${slot}" height="${H}" fill="transparent"/>${path ? `<path d="${path}"/>` : ""}
      ${i === peak && v ? `<text x="${x + bw / 2}" y="${y - 3}" text-anchor="middle" class="peak">${fmt(v)}</text>` : ""}
      ${i % 2 === (n - 1) % 2 ? `<text x="${x + bw / 2}" y="${H - 4}" text-anchor="middle" class="ax">${d.date.slice(5).replace("-", "/")}</text>` : ""}</g>`;
  }).join("");
  return `<figure class="chart"><figcaption>${esc(title)}</figcaption><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">
    <line x1="0" x2="${W}" y1="${H - padB}" y2="${H - padB}" class="base"/>${bars}</svg></figure>`;
}
function showTip(html, e) { const t = $("#tip"); t.innerHTML = html; t.hidden = false; const x = Math.min(innerWidth - t.offsetWidth - 8, e.clientX + 12); t.style.left = x + "px"; t.style.top = (e.clientY - t.offsetHeight - 10) + "px"; }
function hideTip() { $("#tip").hidden = true; }

function renderDash() {
  dashSkeleton(); renderOverview();
  const blocked = data.jobs.filter(isBlocked);
  const working = data.jobs.filter((j) => !isBlocked(j) && j.state === "working");
  const rest = data.jobs.filter((j) => !isBlocked(j) && j.state !== "working");
  const el = $("#dashBody"); const y = $("#dash").scrollTop;
  const hint = wide() ? `<div class="hint">Open any session to get <b>Chat</b> · <b>Terminal</b> · <b>Split</b> (both side by side) · <b>Changes</b> (this session's diffs).
    <kbd>⌘K</kbd> switch session · <kbd>Alt+1–4</kbd> switch view · <kbd>Alt+N</kbd> new · <kbd>/</kbd> type a message</div>` : "";
  el.innerHTML = hint + `<div class="cols"><div class="col">` +
    section("Needs you", blocked, jobCard, { empty: "nothing waiting on you" }) +
    section("Running", working, jobCard) +
    `</div><div class="col">` +
    section("Finished background sessions", rest, jobCard, { limit: 8, key: "done" }) +
    section("Interactive sessions (resume)", data.transcripts, trCard, { limit: 8, key: "tr" }) +
    section("tmux", data.tmux, tmuxCard, { empty: "no tmux sessions" }) +
    `<p><button id="shellBtn">Open shell (tmux “ccdeck”)</button></p></div></div>`;
  $("#dash").scrollTop = y;
  el.querySelectorAll("[data-more]").forEach((b) => (b.onclick = () => { showAll[b.dataset.more] = true; renderDash(); }));
  $("#shellBtn").onclick = () => (location.hash = "#/shell");
  el.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); removeJob(b.dataset.rm); }));
}
async function removeJob(id) {
  const j = data.jobs.find((x) => x.id === id); if (!j) return;
  const running = j.state !== "done";
  const keep = "The transcript is kept: the conversation stays resumable under “Interactive sessions”.";
  if (!confirm(running ? `“${j.name}” is still running or waiting for you.\nStop it and remove it from the list?\n\n${keep}` : `Remove “${j.name}” from the list?\n\n${keep}`)) return;
  try { await api("/api/rm", { id }); toast("removed"); if (location.hash === `#/job/${id}`) location.hash = ""; await poll(); } catch (e) { toast(e.message, 5000); }
}

// ───────────── routing ─────────────
function route() {
  const [, view, id] = location.hash.split("/");
  return view ? { view, id: id && decodeURIComponent(id) } : { view: "list" };
}
let cur = null;
window.addEventListener("hashchange", go);
$("#back").onclick = () => (location.hash = "");

function applyLayout() {
  const inSession = route().view !== "list";
  $("#side").hidden = !wide();
  document.body.classList.toggle("wide", wide());
  $("#back").hidden = !inSession || wide();
}
function go() {
  teardown();
  const r = route(); const inSession = r.view !== "list";
  $("#dash").hidden = inSession; $("#session").hidden = !inSession;
  $("#tabs").hidden = !inSession; document.body.classList.toggle("in-session", inSession); applyLayout();
  if (!inSession) { renderSide(); $("#subtitle").textContent = ""; renderDash(); loadStats().then(renderDash); return; }
  if (r.view === "job") {
    const j = data.jobs.find((x) => x.id === r.id);
    cur = { kind: "job", id: r.id, target: `job:${r.id}`, sessionId: j?.sessionId, title: j?.name || r.id };
  } else if (r.view === "t") {
    const t = data.transcripts.find((x) => x.sessionId === r.id);
    cur = { kind: "transcript", id: r.id, sessionId: r.id, title: t?.title || r.id };
  } else if (r.view === "tmux") cur = { kind: "tmux", id: r.id, target: `tmux:${r.id}`, title: `tmux: ${r.id}` };
  else if (r.view === "shell") cur = { kind: "shell", id: "ccdeck", target: "shell:", title: "shell (tmux ccdeck)" };
  else { location.hash = ""; return; }
  $("#subtitle").textContent = cur.title;
  const has = { chat: !!cur.sessionId, term: !!cur.target, split: !!(cur.sessionId && cur.target), changes: !!cur.sessionId };
  document.querySelectorAll("#tabs .tab").forEach((b) => (b.hidden = !has[b.dataset.tab]));
  cur.has = has;
  refreshMeta(); renderKeys(); renderSide();
  $("#input").placeholder = cur.kind === "transcript" ? "Message → resumes this session in the background…" : wide() ? "Message…  (Enter send · Shift+Enter newline)" : "Message…  (⌘/Ctrl+Enter to send)";
  const saved = store.get(`tab:${cur.kind}:${wide() ? "w" : "n"}`);
  setTab(saved && has[saved] && (saved !== "split" || wide()) ? saved : has.chat ? (wide() && has.split && cur.kind === "job" ? "split" : "chat") : "term");
}
addEventListener("resize", () => {
  applyLayout(); renderSide();
  if (cur?.tab === "split" && !wide()) setTab("chat");
});

function refreshMeta() {
  if (!cur) return;
  const m = $("#meta");
  if (cur.kind === "job") {
    const j = data.jobs.find((x) => x.id === cur.id);
    if (!j) { m.innerHTML = `<span>${esc(cur.id)}</span>`; return; }
    if (!cur.sessionId && j.sessionId) { cur.sessionId = j.sessionId; go(); return; }
    const st = jobState(j); const nt = isBlocked(j) ? needsText(j.needs) : "";
    m.innerHTML = `<b class="meta-name">${esc(j.name)}</b><span class="chip ${st}">${esc(st)}</span><span class="meta-detail" onclick="this.classList.toggle('open')">${esc(j.detail)}</span><span>${esc(short(j.cwd))}</span><span>${esc(j.id)}</span>
      <span class="spacer"></span><button id="stopBtn" class="danger">Stop</button><button id="rmBtn" title="Close and remove from the list (transcript is kept)">× Close</button>${nt && nt !== j.detail ? `<div class="needs">⚑ ${esc(nt)}</div>` : ""}`;
    $("#rmBtn").onclick = () => removeJob(j.id);
    $("#stopBtn").onclick = async () => { if (!confirm(`Stop session ${j.name}? (conversation is kept)`)) return; try { await api("/api/stop", { id: j.id }); toast("stopped"); poll(); } catch (e) { toast(e.message); } };
  } else if (cur.kind === "transcript") {
    const t = data.transcripts.find((x) => x.sessionId === cur.id);
    m.innerHTML = `<b class="meta-name">${esc(cur.title)}</b><span class="chip">interactive transcript</span><span>${esc(short(t?.cwd))}</span><span class="spacer"></span><button id="resumeBtn">Resume in background</button>`;
    $("#resumeBtn").onclick = () => resume("");
  } else m.innerHTML = `<b class="meta-name">${esc(cur.title)}</b><span class="chip">${esc(cur.kind)}</span><span>persistent — closing this page does not stop it</span>`;
}

// ───────────── tabs ─────────────
document.querySelectorAll("#tabs .tab").forEach((b) => (b.onclick = () => setTab(b.dataset.tab, true)));
function setTab(tab, byUser) {
  if (!cur || !cur.has[tab]) return;
  cur.tab = tab;
  // Remember only explicit choices — an automatic fallback (e.g. Terminal while the transcript id
  // is still unknown) must not overwrite the user's preferred view.
  if (byUser) store.set(`tab:${cur.kind}:${wide() ? "w" : "n"}`, tab);
  document.querySelectorAll("#tabs .tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  const showChat = tab === "chat" || tab === "split", showTerm = tab === "term" || tab === "split";
  $("#panes").classList.toggle("split", tab === "split");
  $("#chat").hidden = !showChat; $("#term").hidden = !showTerm; $("#changes").hidden = tab !== "changes";
  $("#keys").hidden = !cur.target || tab === "changes" || (wide() && tab === "chat");
  $("#composer").hidden = tab === "changes";
  if (showChat && !cur.tailWs) openChat();
  if (showChat && cur.target && !cur.promptTimer) { pollPrompt(); cur.promptTimer = setInterval(pollPrompt, 1500); }
  if (!showChat && cur.promptTimer) { clearInterval(cur.promptTimer); cur.promptTimer = null; $("#promptCard").hidden = true; }
  if (showTerm) { if (!cur.term) openTerm(); else setTimeout(() => fitTerm(true), 30); }
  if (tab === "changes") loadChanges();
}

// ───────────── chat (rendered transcript, live) ─────────────
function openChat() {
  const ev = $("#events"); ev.innerHTML = `<div class="empty">loading…</div>`;
  cur.toolEls = new Map(); cur.lastTs = 0;
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/tail?session=${encodeURIComponent(cur.sessionId)}`);
  cur.tailWs = ws; const ctx = cur;
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data); if (d.t !== "events" || ctx !== cur) return;
    const chat = $("#chat"); const stick = d.initial || chat.scrollHeight - chat.scrollTop - chat.clientHeight < 120;
    if (d.initial) ev.innerHTML = d.truncated ? `<div class="empty">(older messages omitted)</div>` : "";
    for (const e of d.evs) addEvent(e);
    if (stick) chat.scrollTop = chat.scrollHeight; else if (d.evs.length) $("#jump").hidden = false;
    if (!d.initial && d.evs.some((e) => e.k === "tool" && /Edit|Write/.test(e.name)) && cur.tab === "changes") loadChanges();
  };
  ws.onclose = () => { if (ctx === cur && !ctx.closing) { ctx.tailWs = null; setTimeout(() => ctx === cur && !ctx.tailWs && openChat(), 2000); } };
}
$("#chat").addEventListener("scroll", () => { const c = $("#chat"); if (c.scrollHeight - c.scrollTop - c.clientHeight < 60) $("#jump").hidden = true; });
$("#jump").onclick = () => { const c = $("#chat"); c.scrollTop = c.scrollHeight; $("#jump").hidden = true; };

function addEvent(e) {
  const ev = $("#events");
  const t = Date.parse(e.ts);
  if (t && t - cur.lastTs > 20 * 60_000) { const d = document.createElement("div"); d.className = "ts-label"; d.textContent = new Date(t).toLocaleString(); ev.appendChild(d); }
  if (t) cur.lastTs = t;
  if (e.k === "result") {
    const det = cur.toolEls.get(e.toolId); if (!det) return;
    const st = det.querySelector(".st"); st.textContent = e.isError ? "error" : "✓"; st.className = `st ${e.isError ? "err" : ""}`;
    const pre = document.createElement("pre"); pre.textContent = e.text || "(no output)"; det.appendChild(pre);
    return;
  }
  const div = document.createElement("div"); div.className = `ev ${e.k}`;
  if (e.k === "user" || e.k === "system") div.textContent = e.text;
  else if (e.k === "assistant") div.innerHTML = md(e.text);
  else if (e.k === "tool") {
    const det = document.createElement("details"); det.className = "tool";
    det.innerHTML = `<summary><span class="tn">${esc(e.name)}</span><span class="ts">${esc(e.summary)}</span><span class="st pending">…</span></summary>`;
    const pre = document.createElement("pre"); pre.textContent = e.input; det.appendChild(pre);
    cur.toolEls.set(e.toolId, det); div.appendChild(det);
  }
  ev.appendChild(div);
}

// ───────────── changes (files this session edited, with diffs) ─────────────
async function loadChanges() {
  const el = $("#changes"); const ctx = cur;
  if (!el.dataset.loaded) el.innerHTML = `<div class="empty">loading…</div>`;
  let d; try { d = await api(`/api/changes?session=${encodeURIComponent(cur.sessionId)}`); } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  if (ctx !== cur) return;
  const open = new Set([...el.querySelectorAll("details.file[open]")].map((x) => x.dataset.p));
  el.dataset.loaded = "1";
  const totA = d.files.reduce((s, f) => s + f.add, 0), totD = d.files.reduce((s, f) => s + f.del, 0);
  el.innerHTML = `<div class="chg-head"><span>${d.files.length} file(s) edited by this session</span><span class="add">+${totA}</span><span class="del">−${totD}</span><span class="spacer"></span><span>diff vs HEAD, current disk state</span><button id="chgRefresh">⟳</button></div>` +
    (d.files.length ? "" : `<div class="empty">This session hasn't edited any files.</div>`) +
    d.files.map((f) => `<details class="file" data-p="${esc(f.path)}" ${open.has(f.path) ? "open" : ""}><summary>
      <span class="stat ${esc(f.status)}">${esc(f.status)}</span><span class="p" title="${esc(f.path)}">${esc(f.rel)}</span>
      ${f.repo ? `<span class="stat">${esc(f.repo)}</span>` : ""}<span class="add">+${f.add}</span><span class="del">−${f.del}</span><span class="stat">${ago(f.last)}</span></summary>
      ${f.diff ? diffHtml(f.diff) : `<div class="empty" style="padding:4px 10px 8px">${f.status === "clean" ? "no uncommitted changes (already committed or reverted)" : "no diff available"}</div>`}</details>`).join("");
  $("#chgRefresh").onclick = loadChanges;
}
function diffHtml(diff) {
  return `<div class="diff">${diff.split("\n").map((l) => {
    const c = l.startsWith("@@") ? "h" : l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ") || l.startsWith("index ") ? "m" : l.startsWith("+") ? "a" : l.startsWith("-") ? "r" : "";
    return `<div class="${c}">${esc(l) || " "}</div>`;
  }).join("")}</div>`;
}

// ───────────── terminal (shared PTY over WebSocket) ─────────────
function openTerm() {
  const term = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace', fontSize: wide() ? 13 : 11, cursorBlink: true,
    scrollback: 10000, allowProposedApi: true, macOptionIsMeta: true,
    theme: { background: "#0b0d11", foreground: "#e6e8ee", cursor: "#d97757", selectionBackground: "#33415580" },
  });
  const fit = new FitAddon(); term.loadAddon(fit); term.loadAddon(new WebLinksAddon());
  term.open($("#xterm"));
  // Let the page's own shortcuts through even when the terminal has focus.
  term.attachCustomKeyEventHandler((e) => !(e.type === "keydown" && ((e.metaKey && e.key === "k") || (e.altKey && /^Digit[1-4]$/.test(e.code)))));
  cur.term = term; cur.fit = fit;
  term.onData((d) => sendPty({ t: "in", d }));
  const ro = new ResizeObserver(() => fitTerm()); ro.observe($("#term")); cur.ro = ro;
  connectPty(cur);
  setTimeout(() => fitTerm(true), 50);
  if (wide() && cur.tab === "term") term.focus();
}
function connectPty(ctx) {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/pty?target=${encodeURIComponent(ctx.target)}`);
  ws.binaryType = "arraybuffer"; ctx.ptyWs = ws;
  ws.onopen = () => { ctx.retry = 0; ctx.term.reset(); fitTerm(true); };
  ws.onmessage = (m) => {
    if (typeof m.data === "string") { const d = JSON.parse(m.data); if (d.t === "exit") { ctx.term.write("\r\n\x1b[33m[process exited — reopen the session to restart it]\x1b[0m\r\n"); ctx.exited = true; } return; }
    ctx.term.write(new Uint8Array(m.data));
  };
  ws.onclose = () => {
    if (ctx !== cur || ctx.closing || ctx.exited) return;
    const wait = Math.min(8000, 500 * 2 ** (ctx.retry = (ctx.retry || 0) + 1));
    ctx.term.write(`\r\n\x1b[90m[disconnected — reconnecting in ${wait / 1000}s]\x1b[0m`);
    setTimeout(() => ctx === cur && connectPty(ctx), wait);
  };
}
function sendPty(m) { const ws = cur?.ptyWs; if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
function fitTerm(force) {
  if (!cur?.term || $("#term").hidden) return;
  try { cur.fit.fit(); } catch {}
  const { cols, rows } = cur.term;
  if (force || cols !== cur.cols || rows !== cur.rows) { cur.cols = cols; cur.rows = rows; sendPty({ t: "resize", cols, rows }); }
}
// Whichever device you touch last owns the PTY size (tmux "latest client").
addEventListener("focus", () => fitTerm(true));
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { fitTerm(true); poll(); } });

// ───────────── key bar (touch keyboards lack Esc / Tab / arrows / ctrl) ─────────────
const KEYS = [
  ["Esc", "\x1b"], ["⇧Tab", "\x1b[Z"], ["Tab", "\t"], ["↑", "\x1b[A"], ["↓", "\x1b[B"], ["←", "\x1b[D"], ["→", "\x1b[C"],
  ["⏎", "\r"], ["1", "1"], ["2", "2"], ["3", "3"], ["^C", "\x03"], ["^D", "\x04"], ["^R", "\x12"], ["/", "/"], ["^B", "\x02"],
];
function renderKeys() {
  const k = $("#keys");
  if (!cur.target) { k.innerHTML = ""; return; }
  k.innerHTML = KEYS.map(([l], i) => `<button data-k="${i}">${esc(l)}</button>`).join("") + `<button data-redraw>⟳ redraw</button>`;
  k.querySelectorAll("[data-k]").forEach((b) => (b.onclick = async (ev) => {
    ev.preventDefault(); const seq = KEYS[+b.dataset.k][1];
    if (cur.ptyWs?.readyState === 1) sendPty({ t: "in", d: seq });
    else await api("/api/keys", { target: cur.target, data: seq }).catch((e) => toast(e.message));
    if (wide()) cur.term?.focus();
  }));
  k.querySelector("[data-redraw]").onclick = () => sendPty({ t: "redraw" });
}

// ───────────── composer ─────────────
const input = $("#input");
input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, innerHeight * 0.4) + "px"; });
input.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return; // IME candidate selection
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey || (wide() && !e.shiftKey))) { e.preventDefault(); $("#composer").requestSubmit(); }
});
$("#composer").onsubmit = async (e) => {
  e.preventDefault();
  const text = input.value; if (!text.trim() && cur.kind === "transcript") return;
  const btn = $("#send"); btn.disabled = true;
  try {
    if (cur.kind === "transcript") await resume(text);
    else if (cur.ptyWs?.readyState === 1) { sendPty({ t: "in", d: `\x1b[200~${text}\x1b[201~` }); setTimeout(() => sendPty({ t: "in", d: "\r" }), 150); }
    else await api("/api/send", { target: cur.target, text });
    input.value = ""; input.style.height = "auto"; toast("sent");
  } catch (err) { toast(err.message); } finally { btn.disabled = false; }
};
async function resume(prompt) {
  if (!confirm("Resume this conversation as a background session? (If it is still open in a terminal, Claude starts a copy.)")) return;
  const r = await api("/api/resume", { sessionId: cur.id, prompt });
  toast(r.out.split("\n")[0] || "resumed");
  await poll();
  if (r.id) location.hash = `#/job/${r.id}`;
}

// ───────────── menus in Chat view (AskUserQuestion, permission prompts) ─────────────
// The server mirrors the TUI screen; when it shows a numbered menu, render it as buttons.
async function pollPrompt() {
  const ctx = cur; if (!ctx?.target || ctx.promptBusy) return;
  ctx.promptBusy = true;
  try {
    const d = await api("/api/prompt", { target: ctx.target });
    if (ctx === cur) renderPrompt(d.menu);
  } catch {} finally { ctx.promptBusy = false; }
}
function renderPrompt(m) {
  const el = $("#promptCard");
  const sig = m ? JSON.stringify(m) : "";
  if (sig === cur.promptSig) return; cur.promptSig = sig;
  if (!m) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  el.innerHTML = `<div class="pc-head"><span class="chip blocked">waiting for your choice</span>${m.tabs ? `<span class="pc-tabs">${esc(m.tabs)}</span>` : ""}</div>
    ${m.title ? `<div class="pc-title">${esc(m.title)}</div>` : ""}
    <div class="pc-opts">${m.options.map((o) => `<button class="pc-opt ${o.selected ? "sel" : ""}" data-n="${o.n}"><b>${o.n}.</b> ${esc(o.label)}${o.desc ? `<small>${esc(o.desc)}</small>` : ""}</button>`).join("")}</div>
    <div class="pc-foot"><button data-k="up">↑</button><button data-k="down">↓</button><button data-k="enter">⏎ Enter</button><button data-k="esc">Esc</button><span>${esc(m.footer)}</span></div>`;
  const send = async (data) => {
    try {
      if (cur.ptyWs?.readyState === 1) sendPty({ t: "in", d: data }); else await api("/api/keys", { target: cur.target, data });
      setTimeout(pollPrompt, 400); setTimeout(pollPrompt, 1200);
    } catch (e) { toast(e.message); }
  };
  el.querySelectorAll(".pc-opt").forEach((b) => (b.onclick = () => { b.classList.add("sending"); send(b.dataset.n); }));
  const K = { up: "\x1b[A", down: "\x1b[B", enter: "\r", esc: "\x1b" };
  el.querySelectorAll("[data-k]").forEach((b) => (b.onclick = () => send(K[b.dataset.k])));
}

function teardown() {
  if (!cur) return;
  cur.closing = true; clearInterval(cur.promptTimer); $("#promptCard").hidden = true; $("#promptCard").innerHTML = "";
  cur.tailWs?.close(); cur.ptyWs?.close(); cur.ro?.disconnect(); cur.term?.dispose();
  cur = null; $("#events").innerHTML = ""; $("#xterm").innerHTML = ""; $("#changes").innerHTML = ""; delete $("#changes").dataset.loaded; $("#jump").hidden = true;
}

// ───────────── new session ─────────────
function openNew() {
  $("#cwdList").innerHTML = data.cwds.map((c) => `<option value="${esc(c)}">`).join("");
  if (!$("#newCwd").value) $("#newCwd").value = data.cwds[0] || "";
  $("#newDlg").showModal(); $("#newPrompt").focus();
}
$("#newBtn").onclick = openNew;
$("#newPrompt").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $("#newDlg").close("ok"); } });
$("#newDlg").addEventListener("close", async () => {
  if ($("#newDlg").returnValue !== "ok") return;
  try {
    const r = await api("/api/new", { cwd: $("#newCwd").value, name: $("#newName").value, prompt: $("#newPrompt").value, permissionMode: $("#newMode").value });
    toast(r.out.split("\n")[0] || "started"); $("#newPrompt").value = ""; $("#newName").value = "";
    await poll(); if (r.id) location.hash = `#/job/${r.id}`;
  } catch (e) { toast(e.message, 5000); }
});

// ───────────── ⌘K quick switcher ─────────────
let findSel = 0, findItems = [];
function openFind() { $("#findInput").value = ""; renderFind(); $("#findDlg").showModal(); $("#findInput").focus(); }
function renderFind() {
  findItems = allItems().filter((i) => match(i, $("#findInput").value.trim())).slice(0, 40);
  findSel = Math.min(findSel, Math.max(0, findItems.length - 1));
  $("#findList").innerHTML = findItems.map((it, i) => itemHtml(it, i === findSel ? "sel" : "")).join("") || `<div class="empty" style="padding:8px">no match</div>`;
  $("#findList .sel")?.scrollIntoView({ block: "nearest" });
}
$("#findBtn").onclick = openFind;
$("#findInput").addEventListener("input", () => { findSel = 0; renderFind(); });
$("#findInput").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); findSel = Math.min(findSel + 1, findItems.length - 1); renderFind(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); findSel = Math.max(findSel - 1, 0); renderFind(); }
  else if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); const it = findItems[findSel]; if (it) { $("#findDlg").close(); location.hash = it.href; } }
});
$("#findList").addEventListener("click", (e) => { if (e.target.closest("a")) $("#findDlg").close(); });
$("#findDlg").addEventListener("click", (e) => { if (e.target === $("#findDlg")) $("#findDlg").close(); });

// ───────────── global shortcuts (MacBook / iPad keyboard) ─────────────
addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openFind(); return; }
  if (e.altKey && /^Digit[1-4]$/.test(e.code) && cur) { e.preventDefault(); setTab(["chat", "term", "split", "changes"][+e.code.slice(5) - 1], true); return; }
  if (e.altKey && e.code === "KeyN") { e.preventDefault(); openNew(); return; }
  const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName) || document.activeElement?.closest?.(".xterm");
  if (!typing && cur && e.key === "/" ) { e.preventDefault(); input.focus(); }
  if (!typing && !cur && e.key === "/") { e.preventDefault(); openFind(); }
});

if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("/sw.js").then(refreshBell).catch(() => {});
else refreshBell();
await poll();
go();
setInterval(poll, 4000);
