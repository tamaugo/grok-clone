# Architecture

grokbot-clone is a web app (`web/`) plus a Node server (`server/`) that runs every Bot's agent loop. Each Bot turn is a headless Claude Code process, so the model is whatever your Claude subscription provides. Each Bot acts on its own virtual desktop on the same machine and uses apps added as MCP servers. It is a single-user install with no sign-in: the server listens on localhost and you reach it over Tailscale.

## Components

| Piece | Where | What it does |
|---|---|---|
| API + realtime | `server/src/routes*.ts`, `lib/hub.ts` | JSON over HTTP, plus one Server-Sent Events stream (`GET /api/events`) carrying row updates, live state, roster changes and computer state |
| Agent loop | `server/src/agent/loop.ts` | Per-Bot serial queue. Each turn builds the system prompt, runs Claude Code, and writes its streamed output into the transcript |
| Claude runner | `server/src/agent/claude.ts` | Spawns `claude -p --output-format stream-json` in the Bot's own folder and resumes the Bot's saved session. If the session is gone, the turn starts a new one. Enforces the RAM safeguards below |
| Bot tools | `server/src/agent/tools.ts`, `agent/mcp.ts` | A small MCP server (Streamable HTTP) that gives each running turn the Bot's own tools: `computer_*` and `open_browser`, memory (`remember`/`recall`), routines, tasks, `send_to_bot`, subagents, group chats, `ask_user`, `request_app_connection`, `stay_silent`. Each turn gets a one-off bearer token that stops working when the turn ends. Shell, files and web access come from Claude Code itself |
| Memory | `server/src/agent/memory.ts`, `agent/prompt.ts` | Durable facts saved with `remember`. A bounded, relevance-ranked memory section goes into each turn's system prompt. Conversation compaction is handled by Claude Code's session |
| Computers | `server/src/computer.ts` | One headless Chromium per Bot (1280x800, its own persistent profile), started with Playwright. The Bot's `browser_*` tools act on elements by ref from an accessibility snapshot (`page.ariaSnapshot({ mode: 'ai' })`), with pixel clicks and screenshots as a fallback. New tabs and popups become the active tab; downloads go to the Library. At most 2 run at once, and a browser sleeps after 15 minutes with no viewers |
| Viewer | `server/src/viewer.ts` | WebSocket at `/api/bots/:id/screen`. The server streams the active tab with CDP `Page.startScreencast` as binary JPEG frames, plus JSON state (URL, title). In *control* mode the client sends mouse, wheel, key, paste and navigation messages, which become CDP `Input.*` events; in *watch* mode the server ignores input |
| Connected apps | `server/src/apps.ts` | Each app is an MCP server (http, sse or a local command) with optional headers or env values. They are added to every Bot's Claude Code session as `mcp__app_<slug>__<tool>`. Header and env values stay on the server |
| Approvals | `server/src/agent/approvals.ts` | See below |
| Scheduling | `server/src/routines.ts`, `proactive.ts` | Cron routines (croner) and proactive check-ins for the primary Bot |
| Dictation | `web/src/voice/dictation.ts` | Browser speech recognition in the composer (⌘/Ctrl+D) |
| UI | `web/src` | React + zustand. Sidebar, chat, details panel (activity, tasks, library), modals, settings (General / Computer / Permissions / Connected apps), viewer |

## RAM safeguards

Each running Bot is a Claude process of roughly 300-500 MB, so the runner is conservative:
- At most 2 Claude processes run at once (`GROKBOT_MAX_CONCURRENT`).
- A new one starts only when at least 600 MB is available (`GROKBOT_MIN_FREE_MB`). Waiting Bots show "In line: …".
- A turn is stopped after 45 minutes (`GROKBOT_TURN_TIMEOUT_MIN`).
- On the VM, the systemd service is capped at `MemoryHigh=2400M`, `MemoryMax=2900M` and `MemorySwapMax=1500M`.

## Transcript model

A conversation is an append-mostly list of **rows**: `seq` (position), `updatedSeq` (a per-Bot revision counter), `kind` and a JSON `body`.

- **Streaming:** a streaming reply is the same row rewritten with a higher `updatedSeq`, so clients just upsert by `seq`.
- **Resetting:** a per-Bot `generation` counter resets the conversation ("new conversation"), and the Bot starts a fresh Claude session.
- **Model history:** it lives in the Bot's Claude Code session (resumed each turn), not in our database.

Row kinds:
- `message`: user or assistant, optionally *from* another Bot
- `tool-call`: shown in the UI only as an activity line and a collapsible step list, with screenshot thumbnails for browser steps
- `card`: approval, question, connect
- `event`: routine created or run, group changes
- `notice`: for example when a Claude usage limit stops a turn

## Approvals

Claude Code calls our `permission_prompt` MCP tool (`--permission-prompt-tool`) before any tool that isn't pre-allowed:
- A Bot's own computer, shell and files run freely.
- Connected-app tools whose name reads as read-only (`get`, `list`, `search`, …) run automatically.
- Anything else posts an **approval card** and waits (up to 30 minutes).
  - **Allow once** runs the call.
  - **Always allow** stores a per-tool policy, which you can remove in Settings → Permissions.
  - **Deny** tells the model not to retry.
- A new user message closes any pending approval as expired.

## Bots working together

- **`send_to_bot`:** delivers a message to another Bot's queue. The reply comes back the same way.
- **Subagents:** hidden child Bots with their own context. They share their parent's working folder, report back with `send_to_bot`, and are removed with `stop_subagent`.
- **Group chats:** a Bot row with `kind='room'` and a member list. A user message goes to the @mentioned members, or to all members. Each member answers in the group with `post_to_group`.

## Data

SQLite (`data/grokbot.db`, WAL) holds:
- the local user and Bots
- rows (transcripts)
- approvals and policies
- routines, tasks, memories, skills
- connected apps

Each Bot's files live in its own folder under `BOTS_ROOT` (default `~/bots`), with a `library/` folder for saved work. Secrets such as app tokens stay on the server. Claude's own login is stored by the Claude Code CLI on the host.

## External services

| Service | Used for | Notes |
|---|---|---|
| Claude Code CLI | Every Bot turn | Uses your Claude subscription and its usage limits. When a limit is hit, the Bot posts a notice with the retry time and re-runs the turn after the reset (`agent/limits.ts`). A new message or stop cancels the retry |
| MCP servers you add | Connected apps | Token or key, or an OAuth sign-in (`server/src/oauth.ts`: discovery, dynamic client registration, PKCE; tokens are refreshed before each turn and stay on the server) |
| Tailscale | Reaching the server | Optional; `tailscale serve` exposes the localhost port to your tailnet only |
