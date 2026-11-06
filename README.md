# ccdeck

A self-hosted web remote for **Claude Code background sessions**, reachable only inside your **Tailscale** tailnet. Open it on your phone, iPad or another laptop to see every session, read them as a chat, jump into the real terminal, answer Claude's menus with a tap, and get a push notification when a session needs you.

It is built directly on Claude Code's own background sessions (`claude --bg`, `claude attach`), so sessions you start anywhere — terminal, another ccdeck tab, a script — show up automatically. Nothing is proxied through a third-party server.

> Not affiliated with Anthropic. ccdeck reads Claude Code's local files and drives its CLI; those are not stable public interfaces (see [Limitations](#limitations)).

## Features

- **Dashboard** — background sessions grouped as *Needs you* / *Running* / *Finished*, with the question each one is waiting on or its result line; recent interactive transcripts (resumable); tmux sessions. The tab title shows how many sessions are waiting on you.
- **Chat view** — the session transcript rendered as a conversation (Markdown, tool calls folded with their output), updating live. Readable on a phone, unlike a TUI.
- **Terminal view** — the real Claude Code TUI (`claude attach <id>`) in xterm.js. One PTY per session on the server, shared by all your devices (tmux-style); the screen is replayed when you reconnect (mosh-style). A key bar provides Esc, ⇧Tab, arrows, 1/2/3, ^C for touch keyboards.
- **Menus as buttons** — when Claude shows a numbered menu (a multiple-choice question, a permission prompt), the Chat view shows it as tappable buttons. The server keeps a headless terminal mirror of each attached session to see it.
- **Composer** — works with CJK input methods; text is pasted into the session and submitted.
- **Split view & changes** — on wide screens (≥ 900 px: laptop, iPad landscape) a session sidebar, chat beside the live terminal, and a *Changes* tab with the diffs of the files *this* session edited.
- **Continue / start / stop / close** — resume an interactive transcript as a background session, start a new one in a chosen directory, stop one, or close it (×). Closing runs `claude rm`; the transcript stays, so the conversation remains resumable.
- **Push notifications** — Web Push (iOS/iPadOS Home Screen app, desktop browsers) and optionally a Telegram bot, sent by the server when a session becomes *blocked* or *done*. Tapping opens that session.
- **Overview** — today's tiles (running / waiting / done, active sessions, your messages, Claude turns and tool calls, output and input tokens by model) and 14-day charts, built incrementally from your local transcripts. Optional subscription-quota tiles from a [quotad](#optional-quota-tiles)-compatible endpoint.
- **Keyboard** — ⌘K session switcher, Alt+1–4 Chat / Terminal / Split / Changes, Alt+N new session, `/` focus the composer.

## Requirements

- macOS or Linux with [Bun](https://bun.sh) ≥ 1.3.10 (uses Bun's built-in PTY — no native modules)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) with background sessions (`claude --bg`, `claude attach`, `claude agents --json`). Developed against **2.1.31x**.
- [Tailscale](https://tailscale.com) on the host and on every device you use ccdeck from
- `tmux` (optional, for the shell / tmux views)

## Install

```bash
git clone https://github.com/lagameon/ccdeck && cd ccdeck
bun install
mkdir -p ~/.config/ccdeck && cp config.example.json ~/.config/ccdeck/config.json
# edit ~/.config/ccdeck/config.json — at minimum set "owner" to your Tailscale login
bun server.ts
```

ccdeck listens on `127.0.0.1` and on the host's Tailscale IP (port 7690 by default) — never on your LAN. Open `http://<tailscale-ip>:7690` from another device on your tailnet.

To run it as a macOS login service, adapt `com.ccdeck.server.plist.example`.

### HTTPS (needed for push notifications and "Add to Home Screen")

Browsers only allow Web Push on HTTPS. Tailscale can provide a certificate:

1. Tailscale admin console → **DNS** → enable **HTTPS Certificates**.
2. `tailscale serve --bg --https=8443 http://127.0.0.1:7690`
3. Use `https://<machine>.<tailnet>.ts.net:8443`, and set it as `baseUrl` in the config.
4. **iPhone / iPad:** open that URL in Safari → Share → **Add to Home Screen** → open ccdeck *from the Home Screen* → tap 🔕 → Allow. (iOS only offers Web Push to Home Screen apps.) **Desktop:** open the URL and tap 🔕.

## Configuration

`~/.config/ccdeck/config.json` (environment variables `CCDECK_*` override):

| Key | Default | Meaning |
|---|---|---|
| `owner` | **required** | The one Tailscale login allowed in. ccdeck refuses to start without it. |
| `port` | `7690` | |
| `bindTailscale` | `true` | Also listen on the Tailscale IP (otherwise loopback only, e.g. behind `tailscale serve`). |
| `baseUrl` | — | Your HTTPS URL; used in notification links and as the Web Push (VAPID) subject. |
| `allowedHosts` | `[]` | Extra Host names to accept (localhost and the machine's Tailscale names/IPs are always allowed). |
| `notifyDone` | `true` | Also notify when a session finishes, not only when it needs you. |
| `hideBody` | `false` | Notifications show neither session names nor text (lock-screen privacy). |
| `claude`, `tailscale` | auto | Paths to the CLIs. |
| `quotaUrl` | — | Optional quota endpoint, see below. |
| `telegram` | — | `{ "token": "...", "chatId": "..." }` for a **dedicated** bot. |

State lives in `~/.config/ccdeck/` (push keys and subscriptions, mode 600) and `~/.local/share/ccdeck/` (usage-stats cache).

## Security model

**Anyone who gets past ccdeck's checks has the same power as you at this machine's terminal** — Claude sessions run with your permission modes, and the shell view is a shell. The checks are:

- **Network:** listens on loopback and the Tailscale IP only.
- **Identity:** every tailnet caller is resolved with `tailscale whois`; only `owner`'s own, **untagged** devices are allowed. Tagged devices (e.g. shared or managed machines on the same tailnet) are refused. Results are cached for 5 minutes, and every open WebSocket is re-checked every 5 minutes — so revoking or retagging a device takes effect within about 5 minutes, not instantly.
- **Through `tailscale serve`:** requests arrive on loopback with Tailscale's identity headers. A proxied request must carry `Tailscale-User-Login == owner` (tagged nodes arrive without it and are refused), and its `X-Forwarded-For` peer is re-checked with `whois`.
- **Browser attacks:** the `Host` header must be one of ccdeck's own names (blocks DNS rebinding); API and WebSocket calls must be same-origin according to the browser's `Sec-Fetch-Site` header (this also covers cross-site GETs), and POSTs/WebSockets additionally check `Origin`; pages are served with `X-Frame-Options: DENY` / `frame-ancestors 'none'` (no clickjacking); external images in transcripts are not loaded.
- **Plain loopback without proxy headers is trusted as "local".** On a shared multi-user machine, other local users could reach it — don't run it there.

**Files.** `~/.config/ccdeck/` is created `0700`; push keys, subscriptions and `config.json` (which may hold a Telegram token) are `0600`. The usage-stats cache in `~/.local/share/ccdeck/` (mode `0600`) holds daily token counts per session id. ccdeck logs actions and session ids, never request bodies; if you run it as a service, keep its log file private (`chmod 600`).

**What leaves the machine.** ccdeck itself only contacts: your browser vendor's push service (Apple / Google / Mozilla) with end-to-end-encrypted Web Push payloads, the Telegram API if you configure a bot, and `quotaUrl` if you set one. Claude Code and the tools it runs have their own network traffic, which ccdeck does not change.

**Notifications.** `hideBody: true` hides both the session name and its text in notifications. Push subscriptions are independent of Tailscale: removing a device from your tailnet does **not** stop notifications to it — remove its entry from `~/.config/ccdeck/subscriptions.json` (or unsubscribe in that browser) as well.

Please report security issues privately via GitHub's *Report a vulnerability* rather than a public issue.

## Optional: quota tiles

If you run a collector that exposes JSON like below, set `quotaUrl` and the overview shows per-account quota with its data age (stale numbers are never shown as current):

```json
{ "ts": 1790000000, "err": null,
  "bars": [ { "id": "acct1", "label": "WORK", "h": null, "w": 12, "state": "ok", "note": "", "age": 0 } ] }
```

`h` / `w` = 5-hour / 7-day utilisation in percent (`null` = no such window), `state` ∈ `ok | stale | auth | rate | err`, `age` = seconds since the numbers were last fetched.

## Limitations

- ccdeck depends on Claude Code internals that are **not documented interfaces**: `~/.claude/jobs/*/state.json`, the transcript JSONL format in `~/.claude/projects/`, and the output of `claude --bg` / `claude agents --json`. A Claude Code update can break parts of it.
- Menus are recognised by parsing the terminal screen (`menu.ts`); unusual menus may not be detected — the Terminal view always works.
- Single user by design (one `owner`).
- Starting a session in a directory Claude Code has never trusted fails; the CLI's message is shown as-is.

## Development

`server.ts` (API, auth, transcript parser, PTY hub, push, stats endpoint) · `menu.ts` (menu parser) · `lib/stats.ts` (incremental usage stats) · `public/` (the page; plain ES modules, no build step).

## License

MIT
