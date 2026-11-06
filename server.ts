// ccdeck — remote control for Claude Code over Tailscale.
// One Bun process: HTTP API + static UI + WebSocket PTY hub + transcript tail.
import { readdirSync, statSync, existsSync, openSync, readSync, closeSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import webpush from "web-push";
import { Terminal as HeadlessTerm } from "@xterm/headless";
import { parseMenu } from "./menu";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { ServerWebSocket } from "bun";

const HOME = homedir();
const CLAUDE_DIR = join(HOME, ".claude");
const JOBS_DIR = join(CLAUDE_DIR, "jobs");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
const PUBLIC = join(import.meta.dir, "public");
const NM = join(import.meta.dir, "node_modules");

// Configuration: ~/.config/ccdeck/config.json (env vars override). See config.example.json.
const CONF_DIR = process.env.CCDECK_CONFIG_DIR || join(HOME, ".config/ccdeck");
const CONFIG: Record<string, any> = (() => { try { return JSON.parse(readFileSync(join(CONF_DIR, "config.json"), "utf8")); } catch { return {}; } })();
const PORT = Number(process.env.CCDECK_PORT || CONFIG.port || 7690);
// The ONE Tailscale login allowed in. Required — ccdeck gives a shell, so there is no default.
const OWNER: string = process.env.CCDECK_OWNER || CONFIG.owner || "";
if (!OWNER) {
  console.error(`[ccdeck] refusing to start: set "owner" (your Tailscale login, e.g. you@example.com) in ${join(CONF_DIR, "config.json")} or CCDECK_OWNER.`);
  process.exit(1);
}
const TAILSCALE = process.env.CCDECK_TAILSCALE || CONFIG.tailscale || (process.platform === "darwin" ? "/Applications/Tailscale.app/Contents/MacOS/Tailscale" : "tailscale");
const CLAUDE_BIN = process.env.CCDECK_CLAUDE || CONFIG.claude || join(HOME, ".local/bin/claude");
const BIND_TS = (process.env.CCDECK_BIND_TS ?? (CONFIG.bindTailscale === false ? "0" : "1")) !== "0"; // also listen on the Tailscale IP
const DATA_DIR = process.env.CCDECK_DATA_DIR || CONFIG.dataDir || join(HOME, ".local/share/ccdeck");

// ───────────────────────────── helpers ─────────────────────────────
function run(cmd: string[], opts: { cwd?: string; timeoutMs?: number } = {}): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(cmd, { cwd: opts.cwd, env: childEnv(), stdout: "pipe", stderr: "pipe", timeout: opts.timeoutMs ?? 15000 });
  return { code: p.exitCode ?? -1, out: p.stdout.toString(), err: p.stderr.toString() };
}
function childEnv(): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env.TMUX; delete env.TMUX_PANE; delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
  env.TERM = "xterm-256color"; env.COLORTERM = "truecolor"; env.LANG = env.LANG || "en_US.UTF-8";
  env.PATH = [join(HOME, ".local/bin"), join(HOME, ".bun/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin", env.PATH || ""].join(":");
  return env;
}
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const readJson = (p: string) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

function readHead(path: string, bytes: number): string {
  const fd = openSync(path, "r"); try { const b = Buffer.alloc(bytes); const n = readSync(fd, b, 0, bytes, 0); return b.subarray(0, n).toString("utf8"); } finally { closeSync(fd); }
}
function readTail(path: string, bytes: number): string {
  const size = statSync(path).size; const start = Math.max(0, size - bytes);
  const fd = openSync(path, "r"); try { const b = Buffer.alloc(size - start); readSync(fd, b, 0, b.length, start); return b.toString("utf8"); } finally { closeSync(fd); }
}

// ───────────────────────────── auth ─────────────────────────────
// Loopback = local user (or `tailscale serve`, which forwards identity headers).
// Tailnet peers are checked with `tailscale whois`: must be OWNER's own, untagged device.
const whoisCache = new Map<string, { ok: boolean; who: string; at: number }>();
function authorize(req: Request, ip: string | undefined): { ok: boolean; who: string } {
  if (!ip) return { ok: false, who: "?" };
  const addr = ip.replace(/^::ffff:/, "");
  if (addr === "127.0.0.1" || addr === "::1") {
    // Via `tailscale serve`: it always adds X-Forwarded-For + Tailscale-Headers-Info, but sends
    // Tailscale-User-Login only for user-owned nodes — tagged nodes arrive WITHOUT it, so a missing
    // login on a proxied request must be a denial, never "local".
    const fwd = req.headers.get("x-forwarded-for");
    const proxied = fwd !== null || req.headers.has("tailscale-headers-info") || req.headers.has("tailscale-user-login");
    if (!proxied) return { ok: true, who: "local" };
    const login = req.headers.get("tailscale-user-login");
    if (login !== OWNER) { console.warn(`[auth] denied proxied request (login=${login ?? "none"}, from=${fwd})`); return { ok: false, who: login || "tagged/unknown" }; }
    const peer = (fwd || "").split(",").map((s) => s.trim()).filter(Boolean).pop();
    if (!peer) return { ok: false, who: login };
    if (peer === "127.0.0.1" || peer === "::1") return { ok: true, who: `${login}@local` };
    return whoisCheck(peer);
  }
  return whoisCheck(addr);
}
function whoisCheck(addr: string): { ok: boolean; who: string } {
  const c = whoisCache.get(addr);
  if (c && Date.now() - c.at < 5 * 60_000) return c;
  let res = { ok: false, who: addr, at: Date.now() };
  const r = run([TAILSCALE, "whois", "--json", addr], { timeoutMs: 5000 });
  if (r.code === 0) {
    try {
      const d = JSON.parse(r.out);
      const tags = d?.Node?.Tags || [];
      const login = d?.UserProfile?.LoginName || "";
      res = { ok: login === OWNER && tags.length === 0, who: `${login}@${d?.Node?.ComputedName || d?.Node?.Name || addr}`, at: Date.now() };
    } catch {}
  }
  whoisCache.set(addr, res);
  if (!res.ok) console.warn(`[auth] denied ${addr} (${res.who})`);
  return res;
}
// Block cross-site requests (a page on another origin poking the API / WS from an allowed device).
// DNS-rebinding guard: a page on another site could re-point its own hostname at 127.0.0.1 and then
// talk to ccdeck "same-origin". So the Host header must be one of ccdeck's own names.
const ALLOWED_HOSTS = new Set<string>(["localhost", "127.0.0.1", "[::1]", ...((CONFIG.allowedHosts || []) as string[])]);
function learnTailscaleNames() {
  const r = run([TAILSCALE, "status", "--json"], { timeoutMs: 5000 });
  try {
    const d = JSON.parse(r.out); const self = d?.Self || {};
    for (const ip of self.TailscaleIPs || []) ALLOWED_HOSTS.add(ip.includes(":") ? `[${ip}]` : ip);
    const dns = String(self.DNSName || "").replace(/\.$/, ""); if (dns) { ALLOWED_HOSTS.add(dns); ALLOWED_HOSTS.add(dns.split(".")[0]); }
    if (self.HostName) ALLOWED_HOSTS.add(String(self.HostName).toLowerCase());
  } catch {}
}
learnTailscaleNames();
function hostAllowed(req: Request): boolean {
  const h = (req.headers.get("host") || "").toLowerCase();
  const name = h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.split(":")[0];
  return ALLOWED_HOSTS.has(name);
}
// Fetch metadata (sent by all modern browsers, incl. on no-cors GETs where Origin is absent):
// API and WebSocket calls must come from ccdeck's own page; any cross-site embedding is refused.
function fetchSiteOk(req: Request, path: string): boolean {
  const site = req.headers.get("sec-fetch-site"); const dest = req.headers.get("sec-fetch-dest") || "";
  if (path.startsWith("/api/") || path.startsWith("/ws/")) return !site || site === "same-origin" || site === "none";
  if (["iframe", "frame", "embed", "object"].includes(dest)) return site === "same-origin" || !site;
  return true; // top-level navigation from a link (e.g. a notification) is fine
}
function sameOrigin(req: Request): boolean {
  const o = req.headers.get("origin");
  if (!o) return true;
  try { return new URL(o).host === req.headers.get("host"); } catch { return false; }
}

// ───────────────────────────── session index ─────────────────────────────
type Job = {
  kind: "job"; id: string; sessionId: string; name: string; state: string; tempo: string;
  detail: string; needs: unknown; output: unknown; intent: string; cwd: string;
  createdAt: string; updatedAt: string; pid?: number;
};
let agentsCache: { at: number; byId: Map<string, any> } = { at: 0, byId: new Map() };
function agentsInfo() {
  if (Date.now() - agentsCache.at < 15_000) return agentsCache.byId;
  const r = run([CLAUDE_BIN, "agents", "--json", "--all"], { timeoutMs: 15000 });
  const byId = new Map<string, any>();
  try { for (const a of JSON.parse(r.out)) byId.set(a.id, a); } catch {}
  agentsCache = { at: Date.now(), byId };
  return byId;
}
function listJobs(): Job[] {
  if (!existsSync(JOBS_DIR)) return [];
  const agents = agentsInfo();
  const out: Job[] = [];
  for (const id of readdirSync(JOBS_DIR)) {
    const s = readJson(join(JOBS_DIR, id, "state.json"));
    if (!s) continue;
    out.push({
      kind: "job", id, sessionId: s.sessionId || s.resumeSessionId || "", name: s.name || s.intent?.slice(0, 60) || id,
      state: s.state || "?", tempo: s.tempo || "", detail: s.detail || "", needs: s.needs ?? null, output: s.output ?? null,
      intent: s.intent || "", cwd: s.cwd || s.originCwd || HOME, createdAt: s.createdAt || "", updatedAt: s.updatedAt || "",
      pid: agents.get(id)?.pid,
    });
  }
  return out.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

type Transcript = { kind: "transcript"; sessionId: string; title: string; cwd: string; lastPrompt: string; mtime: number; size: number; project: string };
const transcriptMeta = new Map<string, { mtime: number; meta: Transcript }>();
const sessionFileCache = new Map<string, string>();
function findSessionFile(sessionId: string): string | null {
  if (!/^[0-9a-f-]{8,64}$/i.test(sessionId)) return null;
  const c = sessionFileCache.get(sessionId); if (c && existsSync(c)) return c;
  for (const proj of readdirSync(PROJECTS_DIR)) {
    const p = join(PROJECTS_DIR, proj, `${sessionId}.jsonl`);
    if (existsSync(p)) { sessionFileCache.set(sessionId, p); return p; }
  }
  return null;
}
function transcriptInfo(path: string, project: string): Transcript | null {
  const st = statSync(path);
  const cached = transcriptMeta.get(path);
  if (cached && cached.mtime === st.mtimeMs) return cached.meta;
  const sessionId = basename(path, ".jsonl");
  let title = "", cwd = "", lastPrompt = "";
  const scan = (text: string) => {
    for (const line of text.split("\n")) {
      if (!line.startsWith("{")) continue;
      let d: any; try { d = JSON.parse(line); } catch { continue; }
      if (d.type === "ai-title" && d.aiTitle) title = d.aiTitle;
      if (d.type === "custom-title" && d.customTitle) title = d.customTitle;
      if (d.cwd && !cwd) cwd = d.cwd;
      if (d.type === "last-prompt" && d.lastPrompt) lastPrompt = d.lastPrompt;
      if (d.type === "user" && typeof d.message?.content === "string" && !d.isMeta && !d.message.content.startsWith("<")) lastPrompt = d.message.content;
    }
  };
  scan(readHead(path, 48_000)); scan(readTail(path, 160_000));
  if (!title && !lastPrompt) return null;
  const meta: Transcript = { kind: "transcript", sessionId, title: title || lastPrompt.slice(0, 70), cwd, lastPrompt: lastPrompt.slice(0, 300), mtime: st.mtimeMs, size: st.size, project };
  transcriptMeta.set(path, { mtime: st.mtimeMs, meta });
  sessionFileCache.set(sessionId, path);
  return meta;
}
function listTranscripts(limit = 40, exclude: Set<string>): Transcript[] {
  const files: { p: string; m: number; proj: string }[] = [];
  for (const proj of readdirSync(PROJECTS_DIR)) {
    const dir = join(PROJECTS_DIR, proj);
    let ents: string[] = []; try { ents = readdirSync(dir); } catch { continue; }
    for (const f of ents) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(dir, f);
      try { files.push({ p, m: statSync(p).mtimeMs, proj }); } catch {}
    }
  }
  files.sort((a, b) => b.m - a.m);
  const out: Transcript[] = [];
  for (const f of files) {
    if (out.length >= limit) break;
    const sid = basename(f.p, ".jsonl");
    if (exclude.has(sid)) continue;
    try { const t = transcriptInfo(f.p, f.proj); if (t) out.push(t); } catch {}
  }
  return out;
}

type TmuxS = { kind: "tmux"; name: string; windows: number; attached: number; activity: number; path: string; command: string };
function listTmux(): TmuxS[] {
  const r = run(["tmux", "list-sessions", "-F", "#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_activity}\t#{pane_current_path}\t#{pane_current_command}"], { timeoutMs: 3000 });
  if (r.code !== 0) return [];
  return r.out.trim().split("\n").filter(Boolean).map((l) => {
    const [name, w, a, act, path, command] = l.split("\t");
    return { kind: "tmux", name, windows: +w, attached: +a, activity: +act * 1000, path, command } as TmuxS;
  });
}

// ───────────────────────────── transcript parsing ─────────────────────────────
type Ev =
  | { k: "user"; id: string; ts: string; text: string }
  | { k: "assistant"; id: string; ts: string; text: string }
  | { k: "tool"; id: string; ts: string; name: string; summary: string; input: string; toolId: string }
  | { k: "result"; id: string; ts: string; toolId: string; text: string; isError: boolean }
  | { k: "system"; id: string; ts: string; text: string };

function clip(s: string, n: number) { return s.length > n ? s.slice(0, n) + `\n… [${s.length - n} more chars]` : s; }
function toolSummary(name: string, inp: any): string {
  if (!inp || typeof inp !== "object") return "";
  const pick = inp.command ?? inp.file_path ?? inp.pattern ?? inp.description ?? inp.url ?? inp.query ?? inp.prompt ?? inp.skill ?? inp.path ?? "";
  return String(pick).split("\n")[0].slice(0, 200);
}
function resultText(c: any): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (x?.type === "text" ? x.text : x?.type === "image" ? "[image]" : "")).join("\n");
  return "";
}
function parseLine(line: string): Ev[] {
  if (!line.startsWith("{")) return [];
  let d: any; try { d = JSON.parse(line); } catch { return []; }
  if (d.isSidechain) return [];
  const ts = d.timestamp || "", uuid = d.uuid || "";
  const evs: Ev[] = [];
  if (d.type === "user") {
    const c = d.message?.content;
    if (typeof c === "string") {
      if (d.isMeta) return [];
      if (c.startsWith("<task-notification>") || c.startsWith("<system-reminder>")) evs.push({ k: "system", id: uuid, ts, text: clip(c.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(), 400) });
      else if (c.startsWith("<command-name>") || c.startsWith("<local-command")) evs.push({ k: "system", id: uuid, ts, text: clip(c.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(), 300) });
      else evs.push({ k: "user", id: uuid, ts, text: c });
    } else if (Array.isArray(c)) {
      c.forEach((b: any, i: number) => {
        if (b?.type === "tool_result") evs.push({ k: "result", id: `${uuid}:${i}`, ts, toolId: b.tool_use_id, text: clip(resultText(b.content), 4000), isError: !!b.is_error });
        else if (b?.type === "text" && !d.isMeta && !String(b.text).startsWith("<")) evs.push({ k: "user", id: `${uuid}:${i}`, ts, text: b.text });
      });
    }
  } else if (d.type === "assistant") {
    const c = d.message?.content;
    if (Array.isArray(c)) c.forEach((b: any, i: number) => {
      if (b?.type === "text" && b.text?.trim()) evs.push({ k: "assistant", id: `${uuid}:${i}`, ts, text: b.text });
      else if (b?.type === "tool_use") evs.push({ k: "tool", id: `${uuid}:${i}`, ts, name: b.name, summary: toolSummary(b.name, b.input), input: clip(JSON.stringify(b.input, null, 2), 3000), toolId: b.id });
    });
  }
  return evs;
}

// Incremental reader per websocket: tracks byte offset, emits complete lines only.
class Tail {
  off = 0; rem = ""; skipPartial = false;
  constructor(public path: string, maxInitial = 4_000_000) {
    try { const size = statSync(path).size; if (size > maxInitial) { this.off = size - maxInitial; this.skipPartial = true; } } catch {}
  }
  readNew(): Ev[] {
    let size = 0; try { size = statSync(this.path).size; } catch { return []; }
    if (size < this.off) { this.off = 0; this.rem = ""; }
    if (size === this.off) return [];
    const fd = openSync(this.path, "r");
    try {
      const b = Buffer.alloc(size - this.off); readSync(fd, b, 0, b.length, this.off); this.off = size;
      const text = this.rem + b.toString("utf8");
      const lines = text.split("\n"); this.rem = lines.pop() || "";
      if (this.skipPartial) { lines.shift(); this.skipPartial = false; } // started mid-line
      return lines.flatMap(parseLine);
    } finally { closeSync(fd); }
  }
}

// ───────────────────────────── PTY hub ─────────────────────────────
// One PTY per target, shared by all viewers (tmux-like). Output kept in a ring buffer
// so a reconnecting / second device gets the screen back (mosh-like).
type WsAuth = { who: string; peer?: string }; // peer = tailnet address to re-check (absent for plain local)
type WsData = ({ kind: "pty"; key: string } | { kind: "tail"; tail: Tail; timer?: Timer }) & WsAuth;
const openSockets = new Set<ServerWebSocket<WsData>>();
const RING = 400_000;
class Pty {
  proc: any; chunks: Uint8Array[] = []; bytes = 0; clients = new Set<ServerWebSocket<WsData>>();
  cols = 120; rows = 36; lastOut = Date.now(); lastClientAt = Date.now(); exited = false;
  // Server-side mirror of the screen, so the Chat view can see menus that only exist in the TUI.
  screen = new HeadlessTerm({ cols: 120, rows: 36, allowProposedApi: true, scrollback: 0 });
  constructor(public key: string, cmd: string[], cwd: string) {
    this.proc = Bun.spawn(cmd, {
      cwd: existsSync(cwd) ? cwd : HOME, env: childEnv(),
      terminal: { cols: this.cols, rows: this.rows, data: (_t: any, d: Uint8Array) => this.onData(d) },
      onExit: () => { this.exited = true; for (const c of this.clients) { try { c.send(JSON.stringify({ t: "exit" })); } catch {} } ptys.delete(this.key); },
    } as any);
  }
  onData(d: Uint8Array) {
    const copy = new Uint8Array(d); this.lastOut = Date.now(); this.screen.write(copy);
    this.chunks.push(copy); this.bytes += copy.length;
    while (this.bytes > RING && this.chunks.length > 1) this.bytes -= this.chunks.shift()!.length;
    for (const c of this.clients) { try { c.sendBinary(copy); } catch {} }
  }
  write(s: string) { if (!this.exited) this.proc.terminal.write(s); }
  resize(cols: number, rows: number) {
    cols = Math.max(20, Math.min(400, cols | 0)); rows = Math.max(5, Math.min(200, rows | 0));
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols; this.rows = rows; try { this.proc.terminal.resize(cols, rows); this.screen.resize(cols, rows); } catch {}
  }
  // Force a full repaint (TUIs redraw on SIGWINCH).
  nudge() { const c = this.cols, r = this.rows; try { this.proc.terminal.resize(c - 1, r); setTimeout(() => { try { this.proc.terminal.resize(c, r); } catch {} }, 60); } catch {} }
  lines(): string[] { const b = this.screen.buffer.active; const out: string[] = []; for (let i = 0; i < this.screen.rows; i++) out.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? ""); return out; }
  replay(): Uint8Array { const out = new Uint8Array(this.bytes); let o = 0; for (const c of this.chunks) { out.set(c, o); o += c.length; } return out; }
  kill() { try { this.proc.kill(); } catch {} }
}
const ptys = new Map<string, Pty>();

function targetCommand(key: string): { cmd: string[]; cwd: string } | null {
  const [kind, ...rest] = key.split(":"); const arg = rest.join(":");
  if (kind === "job") {
    if (!/^[0-9a-f]{6,12}$/.test(arg)) return null;
    const s = readJson(join(JOBS_DIR, arg, "state.json"));
    return { cmd: [CLAUDE_BIN, "attach", arg], cwd: s?.cwd || HOME };
  }
  if (kind === "tmux") {
    if (!/^[\w.@%+-]{1,64}$/.test(arg)) return null;
    return { cmd: ["tmux", "attach-session", "-t", arg], cwd: HOME };
  }
  if (kind === "shell") {
    // Persistent shell = a tmux session, so it outlives ccdeck restarts.
    const cwd = arg && existsSync(arg) ? arg : HOME;
    return { cmd: ["tmux", "new-session", "-A", "-s", "ccdeck", "-c", cwd], cwd };
  }
  return null;
}
// All shell targets share one tmux session, so they share one key (otherwise every distinct
// "shell:<x>" string would spawn another attach process).
const normKey = (k: string) => (k.startsWith("shell:") ? "shell:" : k);
const MAX_PTYS = 24;
function getPty(key: string): Pty | null {
  key = normKey(key);
  let p = ptys.get(key);
  if (p && !p.exited) return p;
  const t = targetCommand(key); if (!t) return null;
  if (ptys.size >= MAX_PTYS) {
    // Reap the longest-unwatched attach client without viewers; refuse if every PTY is in use.
    const idle = [...ptys.values()].filter((x) => x.clients.size === 0).sort((x, y) => x.lastClientAt - y.lastClientAt)[0];
    if (!idle) return null; idle.kill(); ptys.delete(idle.key);
  }
  p = new Pty(key, t.cmd, t.cwd); ptys.set(key, p);
  console.log(`[pty] spawn ${key}: ${t.cmd.join(" ")}`);
  return p;
}
// Reap attach clients nobody has watched for 30 min (the Claude session itself keeps running).
setInterval(() => {
  for (const [k, p] of ptys) if (p.clients.size === 0 && Date.now() - p.lastClientAt > 30 * 60_000) { console.log(`[pty] reap ${k}`); p.kill(); ptys.delete(k); }
}, 60_000);

async function waitQuiet(p: Pty, quietMs = 1200, maxMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) { if (Date.now() - p.lastOut > quietMs) return; await Bun.sleep(150); }
}


// ───────────────────────────── actions ─────────────────────────────
function parseBgId(code: number, text: string): string | null {
  if (code !== 0) return null;
  const known = new Set(existsSync(JOBS_DIR) ? readdirSync(JOBS_DIR) : []);
  for (const m of text.matchAll(/\b([0-9a-f]{8})\b/g)) if (known.has(m[1])) return m[1];
  return null;
}
async function actNew(body: any) {
  const cwd = String(body.cwd || HOME); if (!existsSync(cwd)) return json({ error: `cwd not found: ${cwd}` }, 400);
  const prompt = String(body.prompt || "").trim(); if (!prompt) return json({ error: "prompt required" }, 400);
  const cmd = [CLAUDE_BIN, "--bg"];
  if (body.name) cmd.push("-n", String(body.name).slice(0, 80));
  if (body.permissionMode) cmd.push("--permission-mode", String(body.permissionMode));
  if (body.model) cmd.push("--model", String(body.model));
  cmd.push("--", prompt);
  const r = run(cmd, { cwd, timeoutMs: 60000 });
  agentsCache.at = 0;
  return json({ ok: r.code === 0, id: parseBgId(r.code, r.out + r.err), out: (r.out + r.err).trim().slice(0, 2000) }, r.code === 0 ? 200 : 500);
}
async function actResume(body: any) {
  const sid = String(body.sessionId || ""); const file = findSessionFile(sid);
  if (!file) return json({ error: "session not found" }, 404);
  const meta = transcriptInfo(file, basename(join(file, "..")));
  const cwd = meta?.cwd && existsSync(meta.cwd) ? meta.cwd : HOME;
  const cmd = [CLAUDE_BIN, "--bg", "--resume", sid];
  if (body.prompt) cmd.push("--", String(body.prompt));
  const r = run(cmd, { cwd, timeoutMs: 60000 });
  agentsCache.at = 0;
  return json({ ok: r.code === 0, id: parseBgId(r.code, r.out + r.err), out: (r.out + r.err).trim().slice(0, 2000) }, r.code === 0 ? 200 : 500);
}
async function actSend(body: any) {
  const key = normKey(String(body.target || "")); const text = String(body.text ?? "");
  const fresh = !ptys.get(key) || ptys.get(key)!.exited;
  const p = getPty(key); if (!p) return json({ error: "bad target" }, 400);
  if (fresh) await waitQuiet(p, 1500, 12000);
  if (text) p.write(`\x1b[200~${text}\x1b[201~`);
  if (body.enter !== false) { await Bun.sleep(text ? 200 : 0); p.write("\r"); }
  return json({ ok: true });
}
function actKeys(body: any) {
  const p = getPty(String(body.target || "")); if (!p) return json({ error: "bad target" }, 400);
  p.write(String(body.data || "")); return json({ ok: true });
}
function actRm(body: any) {
  // "×" in the UI: remove a background session from the list. `claude rm` keeps the transcript, so the
  // conversation stays resumable from "Interactive sessions". A running session is stopped first.
  const id = String(body.id || ""); if (!/^[0-9a-f]{6,12}$/.test(id)) return json({ error: "bad id" }, 400);
  const st = readJson(join(JOBS_DIR, id, "state.json"));
  let out = "";
  if (st && st.state !== "done") out += (run([CLAUDE_BIN, "stop", id], { timeoutMs: 30000 }).out + "\n");
  const p = ptys.get(`job:${id}`); if (p) { p.kill(); ptys.delete(`job:${id}`); }
  const r = run([CLAUDE_BIN, "rm", id], { timeoutMs: 30000 }); agentsCache.at = 0;
  return json({ ok: r.code === 0, out: (out + r.out + r.err).trim() }, r.code === 0 ? 200 : 500);
}

// ───────────────────────────── usage stats ─────────────────────────────
const STATS_CACHE = join(DATA_DIR, "stats_cache.json");
let statsRunning = false;
function refreshStats() {
  if (statsRunning) return; statsRunning = true;
  const p = Bun.spawn(["nice", "-n", "10", "bun", join(import.meta.dir, "lib/stats.ts")], { stdout: "ignore", stderr: "pipe", env: { ...childEnv(), CCDECK_DATA_DIR: DATA_DIR } });
  p.exited.then(() => { statsRunning = false; });
}
setInterval(refreshStats, 5 * 60_000); setTimeout(refreshStats, 5000);
// Optional: subscription quota from a quotad-compatible endpoint ({ts, err, bars:[{id,label,h,w,state,note,age}]}).
async function quotaStatus() {
  if (!CONFIG.quotaUrl) return null;
  try {
    const q: any = await (await fetch(CONFIG.quotaUrl, { signal: AbortSignal.timeout(3000) })).json();
    const ageH = (Date.now() / 1000 - q.ts) / 3600;
    return { ok: !q.err && ageH < 1, ageHours: Math.round(ageH * 10) / 10, err: q.err || "", bars: (q.bars || []).map((b: any) => ({ label: b.label, codex: b.id === "codex", h: b.h, w: b.w, state: b.state, note: b.note, ageHours: Math.round((b.age || 0) / 360) / 10 })) };
  } catch (e: any) { return { ok: false, ageHours: null, err: `quota endpoint unreachable: ${e?.message}`, bars: [] }; }
}
async function statsApi(daysN: number) {
  if (!existsSync(STATS_CACHE)) { refreshStats(); return { ready: false }; }
  const c = JSON.parse(readFileSync(STATS_CACHE, "utf8"));
  const days: any[] = [];
  for (let i = daysN - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toLocaleDateString("sv"); const x = c.days[d];
    days.push(x ? { date: d, out: x.out, inp: x.inp + x.cw, cr: x.cr, turns: x.turns, prompts: x.prompts, tools: x.tools, sessions: Object.keys(x.sessions).length, models: x.models } : { date: d, out: 0, inp: 0, cr: 0, turns: 0, prompts: 0, tools: 0, sessions: 0, models: {} });
  }
  const today = c.days[new Date().toLocaleDateString("sv")];
  const names = new Map<string, { name: string; href: string }>();
  for (const j of listJobs()) if (j.sessionId) names.set(j.sessionId, { name: j.name, href: `#/job/${j.id}` });
  const top = today ? Object.entries(today.sessions as Record<string, number>).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([sid, tok]) => {
    const n = names.get(sid); if (n) return { ...n, tokens: tok };
    const f = findSessionFile(sid); const t = f ? transcriptInfo(f, basename(join(f, ".."))) : null;
    return { name: t?.title || sid.slice(0, 8), href: `#/t/${sid}`, tokens: tok };
  }) : [];
  return { ready: true, updatedAt: c.updatedAt, days, top, quota: await quotaStatus() };
}

function actStop(body: any) {
  const id = String(body.id || ""); if (!/^[0-9a-f]{6,12}$/.test(id)) return json({ error: "bad id" }, 400);
  const r = run([CLAUDE_BIN, "stop", id], { timeoutMs: 30000 }); agentsCache.at = 0;
  return json({ ok: r.code === 0, out: (r.out + r.err).trim() });
}

// ───────────────────────────── per-session changes ─────────────────────────────
// Files this session edited (from its own Edit/Write tool calls, incl. subagents), each with
// its current git diff vs HEAD. Session-scoped on purpose: many sessions share one dirty tree.
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const repoRootCache = new Map<string, string | null>();
function repoRoot(dir: string): string | null {
  if (repoRootCache.has(dir)) return repoRootCache.get(dir)!;
  const r = run(["git", "-C", dir, "rev-parse", "--show-toplevel"], { timeoutMs: 5000 });
  const root = r.code === 0 ? r.out.trim() : null; repoRootCache.set(dir, root); return root;
}
function sessionChanges(sessionId: string) {
  const file = findSessionFile(sessionId); if (!file) return null;
  const touched = new Map<string, { last: string; tool: string; n: number }>();
  let started = "";
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!started) { const m = line.match(/"timestamp":"([^"]+)"/); if (m) started = m[1]; }
    if (!line.includes('"tool_use"')) continue;
    let d: any; try { d = JSON.parse(line); } catch { continue; }
    for (const b of d.message?.content || []) {
      if (b?.type !== "tool_use" || !EDIT_TOOLS.has(b.name)) continue;
      const p = b.input?.file_path || b.input?.notebook_path; if (!p) continue;
      const t = touched.get(p); touched.set(p, { last: d.timestamp || "", tool: b.name, n: (t?.n || 0) + 1 });
    }
  }
  const files = [...touched.entries()].sort((a, b) => b[1].last.localeCompare(a[1].last)).slice(0, 80).map(([path, info]) => {
    const exists = existsSync(path);
    const dir = join(path, "..");
    const root = existsSync(dir) ? repoRoot(dir) : null;
    let status = exists ? "" : "deleted", diff = "", add = 0, del = 0;
    if (root) {
      const st = run(["git", "-C", root, "status", "--porcelain=v1", "--", path], { timeoutMs: 5000 }).out.trim();
      status = st.slice(0, 2).trim() || (exists ? "clean" : "deleted");
      if (status === "??") {
        status = "new"; try { const c = readFileSync(path, "utf8"); diff = c.slice(0, 30000).split("\n").map((l) => "+" + l).join("\n"); add = c.split("\n").length; } catch {}
      } else {
        let base = "HEAD";
        if (status === "clean" && started) {
          // Already committed: diff from just before the first commit this session made to the file.
          const shas = run(["git", "-C", root, "log", `--since=${started}`, "--format=%H", "--", path], { timeoutMs: 8000 }).out.trim().split("\n").filter(Boolean);
          if (shas.length) { base = `${shas.at(-1)}^`; status = "committed"; }
        }
        if (status !== "clean") diff = run(["git", "-C", root, "diff", base, "--no-color", "--", path], { timeoutMs: 8000 }).out;
        for (const l of diff.split("\n")) { if (l.startsWith("+") && !l.startsWith("+++")) add++; else if (l.startsWith("-") && !l.startsWith("---")) del++; }
        if (diff.length > 60000) diff = diff.slice(0, 60000) + "\n… [diff truncated]";
      }
    } else status = exists ? "not in git" : "deleted";
    return { path, rel: root ? path.slice(root.length + 1) : path.replace(HOME, "~"), repo: root ? basename(root) : null, ...info, status, add, del, diff };
  });
  return { files };
}

// ───────────────────────────── push notifications ─────────────────────────────
// Server-side, so they arrive with every page closed. Channels: Web Push (PWA / desktop
// browser; tap opens the session) and optionally a dedicated Telegram bot.
// State lives in ~/.config/ccdeck (outside the repo): vapid.json, subscriptions.json, config.json.
mkdirSync(CONF_DIR, { recursive: true }); mkdirSync(DATA_DIR, { recursive: true });
function confRead(name: string, dflt: any) { return readJson(join(CONF_DIR, name)) ?? dflt; }
function confWrite(name: string, v: any) { const p = join(CONF_DIR, name); writeFileSync(p, JSON.stringify(v, null, 2), { mode: 0o600 }); chmodSync(p, 0o600); }
try { chmodSync(CONF_DIR, 0o700); if (existsSync(join(CONF_DIR, "config.json"))) chmodSync(join(CONF_DIR, "config.json"), 0o600); } catch {}
let vapid = confRead("vapid.json", null);
if (!vapid) { vapid = webpush.generateVAPIDKeys(); confWrite("vapid.json", vapid); }
// Apple rejects a "localhost" subject with 403 BadJwtToken, so use the real HTTPS origin.
// VAPID subject: Apple's push service rejects "localhost" subjects (403 BadJwtToken) → use the real HTTPS origin.
webpush.setVapidDetails(process.env.CCDECK_VAPID_SUBJECT || CONFIG.baseUrl || `mailto:${OWNER}`, vapid.publicKey, vapid.privateKey);
type Sub = { subscription: any; label: string; at: string };
let subs: Sub[] = confRead("subscriptions.json", []);
const notifyConf = () => confRead("config.json", {}) as { baseUrl?: string; telegram?: { token: string; chatId: string }; notifyDone?: boolean };

type Note = { title: string; body: string; url: string; tag: string };
async function sendAll(n: Note): Promise<{ push: number; pushFailed: number; telegram: boolean | null }> {
  let push = 0, pushFailed = 0;
  const dead = new Set<string>();
  await Promise.all(subs.map(async (s) => {
    try { await webpush.sendNotification(s.subscription, JSON.stringify(n), { TTL: 6 * 3600, urgency: "high", timeout: 20000 }); push++; }
    catch (e: any) { pushFailed++; if (e?.statusCode === 404 || e?.statusCode === 410) dead.add(s.subscription.endpoint); console.warn(`[push] ${s.label}: ${e?.statusCode || e?.message}`); }
  }));
  if (dead.size) { subs = subs.filter((s) => !dead.has(s.subscription.endpoint)); confWrite("subscriptions.json", subs); }
  let telegram: boolean | null = null;
  const c = notifyConf();
  if (c.telegram?.token && c.telegram?.chatId) {
    const link = `${(c.baseUrl || `http://127.0.0.1:${PORT}`).replace(/\/$/, "")}${n.url}`;
    try {
      const r = await fetch(`https://api.telegram.org/bot${c.telegram.token}/sendMessage`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: c.telegram.chatId, text: `${n.title}\n${n.body}\n${link}`, disable_web_page_preview: true }),
      });
      telegram = r.ok; if (!r.ok) console.warn(`[telegram] ${r.status} ${await r.text()}`);
    } catch (e: any) { telegram = false; console.warn(`[telegram] ${e?.message}`); }
  }
  console.log(`[notify] ${n.title} — push ${push}/${push + pushFailed}${telegram === null ? "" : `, telegram ${telegram}`}`);
  return { push, pushFailed, telegram };
}
const jobStateOf = (j: Job) => (j.tempo === "blocked" || j.state === "blocked" || (j.needs && j.state !== "done") ? "blocked" : j.state);
const textOf = (v: any) => (v == null ? "" : typeof v === "string" ? v : v.text || v.question || v.result || v.headline || JSON.stringify(v));
let lastStates: Map<string, string> | null = null;
function watchJobs() {
  let jobs: Job[]; try { jobs = listJobs(); } catch { return; }
  const now = new Map(jobs.map((j) => [j.id, jobStateOf(j)]));
  if (lastStates) for (const j of jobs) {
    const st = now.get(j.id)!, prev = lastStates.get(j.id);
    if (st === prev) continue;
    const hide = !!notifyConf().hideBody; // optional lock-screen privacy for all sessions
    if (st === "blocked") sendAll({ title: hide ? "⚑ A session needs you" : `⚑ ${j.name}`, body: hide ? "needs your reply" : (textOf(j.needs) || j.detail || "needs your input").slice(0, 300), url: `/#/job/${j.id}`, tag: j.id });
    else if (st === "done" && prev !== undefined && notifyConf().notifyDone !== false) sendAll({ title: hide ? "✓ A session finished" : `✓ ${j.name}`, body: hide ? "finished" : (textOf(j.output) || j.detail || "finished").slice(0, 300), url: `/#/job/${j.id}`, tag: j.id });
  }
  lastStates = now;
}
setInterval(watchJobs, 5000); watchJobs();



// ───────────────────────────── static ─────────────────────────────
const VENDOR: Record<string, string> = {
  "xterm.mjs": "@xterm/xterm/lib/xterm.mjs",
  "xterm.css": "@xterm/xterm/css/xterm.css",
  "addon-fit.mjs": "@xterm/addon-fit/lib/addon-fit.mjs",
  "addon-web-links.mjs": "@xterm/addon-web-links/lib/addon-web-links.mjs",
  "marked.mjs": "marked/lib/marked.esm.js",
  "purify.mjs": "dompurify/dist/purify.es.mjs",
};
const SEC_HEADERS = {
  "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'",
  "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
};
function staticFile(path: string): Response | null {
  if (path.startsWith("/vendor/")) {
    const rel = VENDOR[path.slice(8)]; if (!rel) return null;
    return new Response(Bun.file(join(NM, rel)), { headers: { "cache-control": "max-age=86400", ...SEC_HEADERS } });
  }
  const name = path === "/" ? "index.html" : path.slice(1);
  if (name.includes("..") || name.includes("/")) return null;
  const f = join(PUBLIC, name);
  if (!existsSync(f)) return null;
  return new Response(Bun.file(f), { headers: { "cache-control": "no-cache", ...SEC_HEADERS } });
}

// ───────────────────────────── server ─────────────────────────────
async function handle(req: Request, server: any): Promise<Response | undefined> {
  if (!hostAllowed(req)) return new Response("forbidden: unknown Host header (add it to allowedHosts in config.json)\n", { status: 403 });
  const ip = server.requestIP(req)?.address;
  const auth = authorize(req, ip);
  if (!auth.ok) return new Response("forbidden: not an authorised Tailscale identity\n", { status: 403 });
  const url = new URL(req.url); const path = url.pathname;
  if (!fetchSiteOk(req, path)) return new Response("forbidden: cross-site request\n", { status: 403 });

  if (path === "/ws/pty" || path === "/ws/tail") {
    if (!sameOrigin(req)) return new Response("bad origin", { status: 403 });
    if (path === "/ws/pty") {
      const key = normKey(url.searchParams.get("target") || "");
      if (!targetCommand(key)) return new Response("bad target", { status: 400 });
      if (server.upgrade(req, { data: { kind: "pty", key, who: auth.who, peer: authPeer(req, ip) } })) return;
    } else {
      const file = findSessionFile(url.searchParams.get("session") || "");
      if (!file) return new Response("no session", { status: 404 });
      if (server.upgrade(req, { data: { kind: "tail", tail: new Tail(file), who: auth.who, peer: authPeer(req, ip) } })) return;
    }
    return new Response("upgrade failed", { status: 400 });
  }

  if (path.startsWith("/api/")) {
    if (req.method !== "GET" && !sameOrigin(req)) return json({ error: "bad origin" }, 403);
    if (path === "/api/sessions") {
      const jobs = listJobs();
      const jobSids = new Set(jobs.map((j) => j.sessionId));
      const transcripts = listTranscripts(Number(url.searchParams.get("limit") || 40), jobSids);
      const tmux = listTmux();
      const cwds = [...new Set([...jobs.map((j) => j.cwd), ...transcripts.map((t) => t.cwd)].filter(Boolean))].slice(0, 25);
      return json({ jobs, transcripts, tmux, cwds, ptys: [...ptys.keys()], who: auth.who, now: Date.now() });
    }
    if (path === "/api/job") {
      const id = url.searchParams.get("id") || "";
      const j = listJobs().find((x) => x.id === id);
      return j ? json(j) : json({ error: "not found" }, 404);
    }
    if (path === "/api/stats") return json(await statsApi(Math.min(31, Math.max(7, Number(url.searchParams.get("days")) || 14))));
    if (path === "/api/push/key") return json({ publicKey: vapid.publicKey, devices: subs.map((x) => ({ label: x.label, at: x.at, endpoint: x.subscription.endpoint.slice(0, 60) })), telegram: !!notifyConf().telegram?.token });
    if (path === "/api/changes") {
      const c = sessionChanges(url.searchParams.get("session") || "");
      return c ? json(c) : json({ error: "not found" }, 404);
    }
    if (path === "/api/transcript-meta") {
      const f = findSessionFile(url.searchParams.get("session") || "");
      return f ? json(transcriptInfo(f, basename(join(f, "..")))) : json({ error: "not found" }, 404);
    }
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const ref = [body.id, body.target, body.sessionId].filter((x) => typeof x === "string" && /^[\w:.\-]{1,80}$/.test(x)).join(" ");
      console.log(`[act] ${auth.who} ${path}${ref ? " " + ref : ""}`);
      if (path === "/api/push/subscribe") {
        const sub = body.subscription;
        if (!sub?.endpoint || !/^https:\/\//.test(String(sub.endpoint)) || !sub.keys?.p256dh || !sub.keys?.auth) return json({ error: "invalid subscription" }, 400);
        subs = subs.filter((x) => x.subscription.endpoint !== sub.endpoint);
        subs.push({ subscription: sub, label: String(body.label || auth.who).slice(0, 80), at: new Date().toISOString() });
        confWrite("subscriptions.json", subs); return json({ ok: true, devices: subs.length });
      }
      if (path === "/api/push/unsubscribe") { subs = subs.filter((x) => x.subscription.endpoint !== body.endpoint); confWrite("subscriptions.json", subs); return json({ ok: true }); }
      if (path === "/api/push/test") return json(await sendAll({ title: "🔔 ccdeck test", body: `Notifications work on this channel (${new Date().toLocaleTimeString()}).`, url: "/", tag: "ccdeck-test" }));
      if (path === "/api/prompt") {
        // Ensures an attach client exists so the screen mirror is live, then reports the current menu (if any).
        const key = normKey(String(body.target || ""));
        if (!targetCommand(key)) return json({ error: "bad target" }, 400);
        const fresh = !ptys.get(key) || ptys.get(key)!.exited;
        const p = getPty(key); if (!p) return json({ error: "too many open terminals" }, 429);
        p.lastClientAt = Date.now();
        if (fresh) await waitQuiet(p, 800, 6000);
        return json({ menu: parseMenu(p.lines()) });
      }
      if (path === "/api/new") return actNew(body);
      if (path === "/api/resume") return actResume(body);
      if (path === "/api/send") return actSend(body);
      if (path === "/api/keys") return actKeys(body);
      if (path === "/api/stop") return actStop(body);
      if (path === "/api/rm") return actRm(body);
    }
    return json({ error: "not found" }, 404);
  }
  return staticFile(path) ?? staticFile("/")!;
}

// The tailnet address whose authorisation a connection depends on (forwarded peer behind `tailscale serve`).
function authPeer(req: Request, ip?: string): string | undefined {
  const addr = (ip || "").replace(/^::ffff:/, "");
  if (addr !== "127.0.0.1" && addr !== "::1") return addr;
  const fwd = req.headers.get("x-forwarded-for"); if (!fwd) return undefined;
  const peer = fwd.split(",").map((x) => x.trim()).filter(Boolean).pop();
  return peer && peer !== "127.0.0.1" && peer !== "::1" ? peer : undefined;
}
setInterval(() => {
  whoisCache.clear();
  for (const ws of openSockets) {
    const peer = ws.data.peer; if (!peer) continue;
    if (!whoisCheck(peer).ok) { console.warn(`[auth] closing connection from ${peer}: no longer authorised`); try { ws.close(1008, "unauthorised"); } catch {} }
  }
}, 5 * 60_000);

const websocket = {
  open(ws: ServerWebSocket<WsData>) {
    openSockets.add(ws);
    const d = ws.data;
    if (d.kind === "pty") {
      const p = getPty(d.key); if (!p) { ws.close(1011, "spawn failed"); return; }
      p.clients.add(ws); p.lastClientAt = Date.now();
      ws.send(JSON.stringify({ t: "hello", cols: p.cols, rows: p.rows }));
      const r = p.replay(); if (r.length) ws.sendBinary(r);
      setTimeout(() => p.nudge(), 120);
    } else {
      const evs = d.tail.readNew();
      ws.send(JSON.stringify({ t: "events", evs: evs.slice(-600), truncated: evs.length > 600, initial: true }));
      d.timer = setInterval(() => {
        const n = d.tail.readNew(); if (n.length) ws.send(JSON.stringify({ t: "events", evs: n }));
      }, 700);
    }
  },
  message(ws: ServerWebSocket<WsData>, msg: string | Buffer) {
    const d = ws.data; if (d.kind !== "pty") return;
    const p = ptys.get(d.key); if (!p) return;
    let m: any; try { m = JSON.parse(String(msg)); } catch { return; }
    p.lastClientAt = Date.now();
    if (m.t === "in" && typeof m.d === "string") p.write(m.d);
    else if (m.t === "resize") p.resize(m.cols, m.rows);
    else if (m.t === "redraw") p.nudge();
  },
  close(ws: ServerWebSocket<WsData>) {
    openSockets.delete(ws);
    const d = ws.data;
    if (d.kind === "pty") { const p = ptys.get(d.key); if (p) { p.clients.delete(ws); p.lastClientAt = Date.now(); } }
    else if (d.timer) clearInterval(d.timer);
  },
  idleTimeout: 120, sendPings: true,
};

function tailscaleIP(): string | null {
  const r = run([TAILSCALE, "ip", "-4"], { timeoutMs: 5000 });
  const ip = r.out.trim().split("\n")[0]; return /^100\./.test(ip) ? ip : null;
}
const hosts = ["127.0.0.1"]; if (BIND_TS) { const ip = tailscaleIP(); if (ip) hosts.push(ip); else console.warn("[ccdeck] no Tailscale IP; loopback only"); }
for (const hostname of hosts) {
  Bun.serve({ hostname, port: PORT, fetch: handle as any, websocket: websocket as any });
  console.log(`[ccdeck] listening http://${hostname}:${PORT}  (owner=${OWNER})`);
}
