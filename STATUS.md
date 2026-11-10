# Status

A self-hosted Grok Bot clone. Bots run on the Claude Code CLI using a Claude subscription. There is no xAI, Orgo, Composio or sign-in. It runs on one VM and is reached only through Tailscale.

## Done

- **Claude Code backend.** Each Bot turn runs headless with `claude -p --output-format stream-json` and resumes the Bot's own session. If a saved session is gone, the turn starts a new one.
- **Model per Bot.** You pick Default, Fable, Opus, Sonnet or Haiku when creating a Bot, and can change it in the Bot's settings. Default uses `CLAUDE_MODEL`, or your account's default. Subagents use their parent's model and thinking level unless `spawn_subagent` is given `model` and/or `effort` (validated against `BOT_MODELS` / `BOT_EFFORTS`); `list_subagents` shows each one's model and effort.
- **Thinking level per Bot.** Low, Medium, High, Extra high or Max, passed to the CLI as `--effort`. You set it when creating a Bot and in its settings. The old "Max" label (`xhigh`) is now "Extra high", and a real Max level was added.
- **RAM safeguards.**
  - At most 2 Claude processes run at once.
  - A new one starts only when at least 600 MB is free.
  - A turn is stopped after 45 minutes.
  - The systemd service is capped at `MemoryHigh=2400M`, `MemoryMax=2900M` and `MemorySwapMax=1500M`.
  - Waiting Bots show "In line: …".
  - When a turn hits a Claude usage limit, the Bot posts a notice with the retry time and re-runs the same turn after the reset (up to 5 tries, within 6 hours). Sending a message or pressing stop cancels it. Retries are kept in memory, so a server restart forgets them. Not yet tested against a real limit.
- **Bot computers.**
  - Each Bot gets a headless Chromium at 1280x800 with its own persistent profile, with at most 2 at a time. This replaced the Xvfb + openbox + x11vnc desktop, following how T3 Code's preview browser works.
  - A browser sleeps after 15 minutes with no viewers.
  - The Bot uses `browser_*` tools: it reads an accessibility snapshot and clicks or types by element ref, with screenshots and pixel clicks as a fallback. New tabs become the active tab, and downloads go to the Library.
  - The live viewer is a CDP screencast over a WebSocket, with Watch and Take control modes, an address bar, and back/forward/reload. Deployed to the VM and confirmed working there.
- **Connected apps.** Each app is an MCP server, either http/sse or a local command. The catalog lists Zapier, Notion, GitHub, Brave Search, Context7, Exa, Stripe, DeepWiki, Hugging Face, Cloudflare Docs, Linear and Sentry, and you can add any other MCP server.
- **Sign-in (OAuth) apps.** Hosted MCP servers that only offer a sign-in now work (`server/src/oauth.ts`): discovery, dynamic client registration, PKCE, and a token refresh before each turn. A custom app can choose "Sign in at the app instead". Tested end to end against a mock server; not yet tried with a real Linear, Sentry or Notion account.
- **Approvals.**
  - App actions that change data post an Allow once / Always allow / Deny card. This uses Claude's `--permission-prompt-tool`.
  - Read-only actions run without asking.
  - "Always allow" rules can be removed in Settings → Permissions.
- **Rebuilt Grok Bot features.** Routines, check-ins, tasks, memories, skills, subagents, groups, the Bot-to-Bot messages, the library, ask_user question cards, connect-app cards and dictation (browser speech recognition, ⌘/Ctrl+D).
- **Image attachments (screenshots).**
  - In any Bot chat or group, paste an image (⌘/Ctrl+V), drop one on the composer, or use + → Attach image. Thumbnails show with a remove (×) button, up to 10 per message. A message can be images only.
  - `POST /api/bots/:id/uploads` takes the raw image. Only PNG, JPEG, GIF and WebP are accepted, checked by magic bytes, at most 10 MB each. Files are saved in that chat's `library/uploads/` and served by `GET /api/bots/:id/uploads/:name`.
  - The message row stores `attachments`. The Bot's turn prompt lists each image's absolute path and asks it to open them with the Read tool. In groups, every responding member gets the paths.
  - Verified with a throwaway server and a stub CLI: upload, the 415 and 413 rejections, path traversal, and the image paths in the CLI's stdin for a Bot chat and a group. Not yet checked: a real paste in a browser, or a real Claude turn reading the image.
- **Reply bubbles.** A turn with tool calls shows at most two Bot bubbles. The text before the first tool call (the "on it" acknowledgement) is the first bubble. Everything written after that is one reply bubble, with segments joined by a blank line. The merging happens in `TranscriptWriter` (server/src/agent/loop.ts). When a new segment starts and tool rows or cards were added since the last one, the reply row moves to the end of the transcript: the old row is blanked and deleted, and a new row is created with the combined text. So the reply always sits below the turn's tool steps and any ask_user card. History, the live stream and reloads all show the same thing. Unread goes up once for the reply, not once per segment. This was verified with a stub CLI (text → tool → text → tool → text gave 2 Bot rows), live in the browser and after a reload.
- **UI.** It is restored one-to-one from the original (commit 7ee6a7e): computer viewer, Computer card, cards, Connect Apps modal, and the Settings pages General / Computer / Permissions / Connected apps.
- **Verified on the VM.**
  - Chat turns and session resume.
  - Queuing when 2 Bots are already working.
  - Computer use: opened a site and clicked through.
  - The viewer in watch and control modes.
  - Approvals: list ran without asking; create waited for an answer; "always" was saved.
  - Everything came back after a reboot.

## Left to do

- [ ] Check these against the original UI in a browser:
  - [x] The approval card in chat.
  - [x] The connect-app card.
  - [x] Screenshot thumbnails on computer steps (re-check after the browser change).
  - [x] The Connect Apps modal, including the key form.
  - [x] Settings → Computer, Permissions and Connected apps.
  - [ ] The mic button: opens and ⌘D works, but recording and text insertion still need a check in a browser with a microphone.
  - [ ] Create New Bot with the Model and Thinking pickers.
  - [ ] The sign-in flow in Connect Apps (popup and "Waiting…").
- [x] Bug: `POST /api/apps` marked the connect card connected and told the Bot even when the app test failed. Fixed. `removeApp` still deletes that slug's "always allow" rules on purpose, so a different server reusing the name doesn't inherit them.
- [x] Memory card off Linux: `/api/health` now returns no free-memory number there and the card hides it. Still worth a look on the VM.
- [x] Update the README, architecture guide, `.env.example`, banner text and app title to describe the Claude Code setup (the Grok Bot name stays).
- [x] Support MCP servers that only offer a sign-in (OAuth). Still needs a real sign-in at Linear, Sentry or Notion.
- [x] Dark theme fixes: black Bots, app logo letters, Bot bubble gradient, avatar ring, white flash on load, light scrollbars.
- [ ] Run a real Claude turn through the CLI. All turn tests so far used a stub, so `--model` and `--effort` are unproven against the real binary.
- [ ] Simulate a usage limit with the stub CLI to test the retry.
- [x] Run `npm run build` (typecheck passes), commit, and deploy to the VM.
- [ ] Post the PR #2 comment on the audit: findings #3, #12 and #13 are not bugs, and the UI half of #7 was already handled.
- [ ] Decide what to do with the original Grok Bot artwork (`web/artwork/`, `web/public/assets/`); it is still the original and is covered by `THIRD_PARTY_NOTICES.md`.
- [ ] Consider removing Bots' passwordless sudo on the VM, or keep the VM dedicated to this.
- [ ] Optional: replace what was left out because it needs xAI or paid services: voice calls, X search, Slack/Google sign-in through Composio, the draft card, and the Account page. "Bot templates" in Connect Apps is also still a disabled placeholder.

## Deploy

```sh
rsync -az --delete --exclude node_modules --exclude 'web/dist' --exclude 'server/dist' --exclude data --exclude .env ./ root@<vm>:/home/grokbot/app/
ssh root@<vm> 'chown -R grokbot:grokbot /home/grokbot/app && su - grokbot -c "cd ~/app && npm install && npm run build" && systemctl restart grokbot'
```

The server listens on `127.0.0.1:8787`. To expose it on your tailnet only, run `tailscale serve --bg --https=443 http://127.0.0.1:8787`.
