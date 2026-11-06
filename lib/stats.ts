#!/usr/bin/env bun
// Daily activity + token usage from Claude Code transcripts (~/.claude/projects/**.jsonl, incl. subagents).
// Incremental: files are append-only, so each run reads only bytes added since the last run.
// Output: KB/stats_cache.json (per-file offsets + per-local-day aggregates). Read-only on the transcripts.
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, renameSync, openSync, readSync, closeSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const PROJECTS = join(HOME, ".claude/projects");
const KB = process.env.CCDECK_DATA_DIR || join(HOME, ".local/share/ccdeck");
const CACHE = join(KB, "stats_cache.json");
const KEEP_DAYS = 35;
const SKIP_OLDER_MS = 31 * 86400000;

type Day = { out: number; inp: number; cr: number; cw: number; turns: number; prompts: number; tools: number; sessions: Record<string, number>; models: Record<string, number> };
type Cache = { files: Record<string, { size: number; off: number }>; days: Record<string, Day>; updatedAt?: string; lastRunMs?: number };
const cache: Cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : { files: {}, days: {} };
const localDay = (ts: string) => new Date(ts).toLocaleDateString("sv"); // YYYY-MM-DD in the Mac's timezone
const dayOf = (d: string): Day => (cache.days[d] ||= { out: 0, inp: 0, cr: 0, cw: 0, turns: 0, prompts: 0, tools: 0, sessions: {}, models: {} });

function* walk(dir: string): Generator<string> {
  let ents: string[] = []; try { ents = readdirSync(dir); } catch { return; }
  for (const e of ents) { const p = join(dir, e); let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) yield* walk(p); else if (e.endsWith(".jsonl")) yield p; }
}
// Main session id: <project>/<sid>.jsonl, or <project>/<sid>/subagents/agent-*.jsonl → the parent sid.
const sessionOf = (p: string) => p.includes("/subagents/") ? basename(dirname(dirname(p))) : basename(p, ".jsonl");

const t0 = Date.now(); let bytes = 0, files = 0;
for (const p of walk(PROJECTS)) {
  let st; try { st = statSync(p); } catch { continue; }
  if (Date.now() - st.mtimeMs > SKIP_OLDER_MS && !cache.files[p]) continue;
  const f = (cache.files[p] ||= { size: 0, off: 0 });
  if (st.size < f.off) f.off = st.size; // rewritten/truncated: can't un-count, just move on
  if (st.size === f.off) continue;
  const sid = sessionOf(p); const isSub = p.includes("/subagents/");
  const fd = openSync(p, "r"); const seen: string[] = [];
  try {
    const CH = 8 << 20; let pos = f.off, rem = "";
    while (pos < st.size) {
      const buf = Buffer.alloc(Math.min(CH, st.size - pos)); const n = readSync(fd, buf, 0, buf.length, pos); if (!n) break;
      pos += n; bytes += n;
      const lines = (rem + buf.subarray(0, n).toString("utf8")).split("\n"); rem = lines.pop() || "";
      for (const line of lines) {
        const hasUsage = line.includes('"usage"'), isUser = !isSub && line.startsWith('{') && line.includes('"type":"user"');
        if (!hasUsage && !isUser) continue;
        let d: any; try { d = JSON.parse(line); } catch { continue; }
        if (!d.timestamp) continue;
        const day = dayOf(localDay(d.timestamp));
        if (d.type === "assistant" && d.message?.usage) {
          // Tool calls live on every line (one content block per line) — count them all…
          day.tools += (d.message.content || []).filter((b: any) => b?.type === "tool_use").length;
          // …but the usage is repeated on each line of the same message, so count it once.
          const id = d.message.id || d.requestId || d.uuid;
          if (seen.includes(id)) continue; seen.push(id); if (seen.length > 64) seen.shift();
          const u = d.message.usage;
          const out = u.output_tokens || 0, inp = u.input_tokens || 0, cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0;
          day.out += out; day.inp += inp; day.cr += cr; day.cw += cw; day.turns++;
          day.sessions[sid] = (day.sessions[sid] || 0) + out + inp + cw;
          const m = String(d.message.model || "?").replace(/^claude-/, ""); day.models[m] = (day.models[m] || 0) + out;
        } else if (isUser && d.type === "user" && typeof d.message?.content === "string" && !d.isMeta && !d.message.content.startsWith("<")) {
          day.prompts++; day.sessions[sid] ||= 0;
        }
      }
    }
    // Leave a trailing partial line for the next run.
    f.off = st.size - Buffer.byteLength(rem, "utf8"); f.size = st.size; files++;
  } finally { closeSync(fd); }
}
// Prune old days and files no longer present.
const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toLocaleDateString("sv");
for (const d of Object.keys(cache.days)) if (d < cutoff) delete cache.days[d];
for (const p of Object.keys(cache.files)) if (!existsSync(p)) delete cache.files[p];
cache.updatedAt = new Date().toISOString(); cache.lastRunMs = Date.now() - t0;
writeFileSync(CACHE + ".tmp", JSON.stringify(cache), { mode: 0o600 }); renameSync(CACHE + ".tmp", CACHE);
console.log(JSON.stringify({ files, mb: Math.round(bytes / 1e6), ms: Date.now() - t0, days: Object.keys(cache.days).length }));
