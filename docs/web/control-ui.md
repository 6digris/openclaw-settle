---
summary: "Browser-based control UI for the Gateway (chat, activity, nodes, config)"
read_when:
  - You want to operate the Gateway from a browser
  - You want Tailnet access without SSH tunnels
title: "Control UI"
sidebarTitle: "Control UI"
---

The Control UI is a small **Vite + Lit** single-page app served by the Gateway:

- default: `http://<host>:18789/`
- optional prefix: set `gateway.controlUi.basePath` (e.g. `/openclaw`)

`gateway.controlUi.enabled` hot-applies. Disable it to stop serving dashboard
pages and assets while bots and existing Gateway connections keep running.
Re-enable it to resume serving; missing assets are prepared in the background.
Changing the serving base path or asset root still requires a Gateway restart.

For unmatched HTTP paths, the app-shell fallback respects the request's `Accept` header. An explicit HTML rejection such as `text/html;q=0, */*` overrides the broader wildcard, so the request reaches the startup `503` or final `404` response. Headerless and wildcard-only requests retain the browser navigation fallback.

It speaks **directly to the Gateway WebSocket** on the same port.

If the Gateway's request queue is full, the Control UI shows "The server is busy. Please try again in a moment." Wait briefly, then retry the action.

A cold chat startup uses regional skeletons: the workspace chrome, sidebar, and chat header reveal together, followed by the transcript if history is still pending. Skeletons appear after 150 ms and stay for at least 300 ms once shown. The composer is the real control, disabled until connected. Existing cached sessions and history paint directly on warm starts, and reconnecting preserves local drafts. Skeletons use the content layout and respect your theme and reduced-motion preference.
