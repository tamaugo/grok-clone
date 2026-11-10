# Status

A self-hosted Grok Bot clone. Bots run on the Claude Code CLI using a Claude subscription. There is no xAI, Orgo, Composio or sign-in. It runs on one VM and is reached only through Tailscale.

## Done

- **Claude Code backend.** Each Bot turn runs headless with `claude -p --output-format stream-json` and resumes the Bot's own session. If a saved session is gone, the turn starts a new one.
- **RAM safeguards.**
  - At most 2 Claude processes run at once.
  - A new one starts only when at least 600 MB is free.
  - A turn is stopped after 45 minutes.
  - The systemd service is capped at `MemoryHigh=2400M`, `MemoryMax=2900M` and `MemorySwapMax=1500M`.
  - Waiting Bots show "In line: …".
- **Bot computers.**
  - Each Bot gets an Xvfb + openbox + Chromium desktop at 1280x800, with at most 2 at a time.
  - A desktop sleeps after 15 minutes with no viewers.
  - The Bot drives it with xdotool and screenshots.
  - The live viewer uses noVNC through a WebSocket relay, with Watch and Take control modes.
- **Connected apps.** Each app is an MCP server, either http/sse or a local command. The catalog lists Zapier, Notion, GitHub, Brave Search, Context7, Exa, Stripe, DeepWiki, Hugging Face and Cloudflare Docs, and you can add any other MCP server.
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
  - [ ] The approval card in chat.
  - [ ] The connect-app card.
  - [ ] Screenshot thumbnails on computer steps.
  - [ ] The Connect Apps modal, including the key form.
  - [ ] Settings → Computer, Permissions and Connected apps.
  - [ ] The mic button.
- [ ] Replace the xAI/Grok artwork and branding that is still in `assets/` and the web app.
- [ ] Support MCP servers that only offer a sign-in (OAuth), such as Linear and Notion's hosted server. Today only token or key apps work.
- [ ] Consider removing Bots' passwordless sudo on the VM, or keep the VM dedicated to this.
- [ ] Optional: replace what was left out because it needs xAI or paid services: voice calls, X search, Slack/Google sign-in through Composio, the draft card, and the Account page.
- [ ] Optional: improve how Claude usage limits are handled. Right now a Bot shows a notice in chat and stops. It could retry when the limit resets.

## Deploy

```sh
rsync -az --delete --exclude node_modules --exclude 'web/dist' --exclude 'server/dist' --exclude data --exclude .env ./ root@<vm>:/home/grokbot/app/
ssh root@<vm> 'chown -R grokbot:grokbot /home/grokbot/app && su - grokbot -c "cd ~/app && npm install && npm run build" && systemctl restart grokbot'
```

The server listens on `127.0.0.1:8787`. To expose it on your tailnet only, run `tailscale serve --bg --https=443 http://127.0.0.1:8787`.
