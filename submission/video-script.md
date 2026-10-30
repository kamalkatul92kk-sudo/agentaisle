# AgentAisle: demo video script (target 2:40, hard limit < 3:00)

> **As recorded (Oct 29, 2026):** the finished cut is {{VIDEO_URL}} (2:43.7). It was recorded **read-only**, with no merchant token: the new rows come from the real hourly simulator run, and Approve is hovered but not clicked. The narration is synthetic (Piper TTS, public-domain LJ Speech voice) with burned-in captions. See `video/NOTES.md`. To re-record with your own voice, follow the script below.

**Rules:**
- The video must be **under 3 minutes**; judges need not watch past 3:00.
- Upload it to **YouTube as Public**.
- No copyrighted music and no third-party trademarks without permission. PayPal, AG Grid and Cloudflare appear only as the tools used.
- Use silence or royalty-free/no music.

**Setup before recording:**
- Open https://agentaisle-demo.kamalkatul92-kk.workers.dev in a 1440×900 window, light theme, Live tab.
- Paste the merchant token so the buttons work.
- Never show the token, `.dev.vars` or the PayPal developer dashboard secrets on screen.
- Have a terminal ready in the repo for shot 7.

**Narration:** about 330 words, roughly 130 wpm. Say "sandbox" and "fictional" on camera.

| # | Time | Screen | Narration |
|---|---|---|---|
| 1 | 0:00–0:15 | Title card, then the live console with the sandbox banner visible | "AI agents are starting to shop for people. AgentAisle is an agent-ready storefront: buyer agents shop, haggle and pay with PayPal, and the merchant sees everything live. This is a sandbox demo with a fictional Texas coffee roaster. No real money moves." |
| 2 | 0:15–0:35 | Click **Simulate 10 agents**. New rows slide into the Live desk, cells flash, and the ticker shows "+n new". | "Here, ten simulated buyer agents hit the shop through our MCP server. Each one searches, builds a cart and negotiates, but never below the merchant's floor price. Rows update in place in AG Grid as each session moves forward." |
| 3 | 0:35–0:55 | Hover the lifecycle bar and the PayPal ID column, then point at a webhook badge. | "Every row shows the payment lifecycle: checkout, PayPal order, capture, verified webhook, refund. These are real PayPal sandbox order and capture IDs. This badge only appears after PayPal's signed webhook passes signature verification; forged webhooks are rejected." |
| 4 | 0:55–1:20 | Choose the **Needs attention** preset, open a held row, then the Approvals tab and approve or reject. | "Agents with a saved PayPal mandate pay on their own, inside per-order and monthly caps. Anything risky, like a new agent with a big basket or a burst of orders, is held. The merchant approves it with one click." |
| 5 | 1:20–1:45 | Back on Live, click the refunded row. The inspector opens and scrolls the event log to the 🔏 webhook rows. | "Click any row for the full story: negotiation rounds, capture, the refund our ops agent proposed and a human approved, and both PayPal webhooks. The ops agent can't refund on its own, and prompt-injected 'refund everything' notes do nothing." |
| 6 | 1:45–2:10 | Agents & rollups tab: switch the segment Persona → Platform, sort Revenue, then toggle dark mode. | "Rollups group sessions by persona, agent or platform: conversion, refund rate, a revenue sparkline, and a chart that follows the grid's filter. It's all AG Grid and AG Charts Community, themed with the Theming API, in light and dark." |
| 7 | 2:10–2:30 | Terminal: `npm run verify:grid` (shows 0 mismatches), then `npm test` (85 passed). | "We reconcile the grid against PayPal's own records: six of six match. The test suite includes thirteen adversarial agent-safety scenarios, like over-cap, forged mandates and prompt injection." |
| 8 | 2:30–2:45 | Architecture diagram from the README, then the end card with the repo URL and live URL | "It's built on a Cloudflare Worker with D1 and a Durable Object for spend caps, plus PayPal Orders v2, Vault and verified webhooks, all on free tiers. AgentAisle: let agents shop, and keep the merchant in control." |

**Notes:**
- If the simulate burst has not settled by shot 3, cut or speed up the wait. Keep the final cut under 2:55.
- Do not show the user's real name, email or computer desktop beyond the browser and terminal.
- Captions: upload the narration above as the YouTube transcript for accessibility.
