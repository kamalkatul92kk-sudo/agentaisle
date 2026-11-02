# AgentAisle: demo video script (target 2:45, hard limit < 3:00)

> **As recorded (Nov 2, 2026), v4:** the finished cut is https://youtu.be/s_W2hhFQJGc (2:48). It replaces https://youtu.be/0LZBDRTz6PQ (Oct 29–30, 2026), which stays up but is superseded. v4 shows the real model (Llama 3.3 70B on Cloudflare Workers AI) and the 109-test suite. It was recorded **read-only**, with no merchant token: the new row comes from the real hourly simulator run, Approve is hovered but not clicked, and nothing is typed into the Ops agent. The narration is synthetic (xAI Grok Text to Speech, voice "Ara") with burned-in captions. See `video/NOTES.md`. To re-record with your own voice, follow the script below.

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

**Narration:** the v4 lines as voiced (about 337 words, 2:48 total). Say "sandbox" and "fictional" on camera. IDs are never read aloud; point at them on screen.

| # | Time | Screen | Narration |
|---|---|---|---|
| 1 | 0:00–0:20 | Title card, then the live console with the sandbox banner and the model name in the header | "AI agents are starting to shop for people. AgentAisle is an agent-ready storefront, where buyer agents shop, haggle, and pay with PayPal, and the merchant sees everything, live. This is a sandbox demo, with a fictional Texas coffee roaster. No real money moves." |
| 2 | 0:20–0:42 | Live desk during the real hourly simulator run: a new row arrives, the ticker shows "+1 new", then the row is clicked and the event log shows the "model" badges on negotiation messages. | "Every hour, a built-in simulator sends new buyer agents through our MCP server. A real model, Llama 3.3 70B, on Workers AI, picks each cart and haggles, but code never goes below the merchant's floor price. Here they land, live, in AG Grid." |
| 3 | 0:42–1:05 | Hover the lifecycle bar and the PayPal ID column, then point at a webhook badge. | "Every row shows the payment lifecycle: checkout, PayPal order, capture, verified webhook, and refund. This column holds the real PayPal sandbox order and capture IDs, right there on screen. This badge only appears once the webhook from PayPal passes signature verification. Forged webhooks get rejected." |
| 4 | 1:05–1:24 | Choose the **Needs attention** preset, then the Approvals tab; hover Approve. | "Agents with a stored PayPal mandate pay on their own, within per-order and monthly caps. Anything risky, like a new agent with a big basket, gets held. It waits in the approval queue, and the merchant approves or rejects it, with one click." |
| 5 | 1:24–1:42 | Click the refunded row. The inspector shows the event log with the 🔏 webhook rows and the refund proposed by the ops agent. Then open the **Ops agent** tab (nothing typed). | "Click any row for the full story: the negotiation rounds, the capture, both PayPal webhooks, and a refund our ops assistant proposed and a human approved. The assistant uses the same model, but can only propose, and prompt-injected "refund everything" notes do nothing." |
| 6 | 1:42–2:03 | Agents & rollups tab: switch the segment Persona → Platform, sort Revenue, then toggle dark mode. | "Rollups group sessions by persona, agent, or platform: conversion, refund rate, a revenue sparkline, and a chart that follows the grid's filter. It's all AG Grid and AG Charts Community, themed with the Theming API, in light and dark mode." |
| 7 | 2:03–2:22 | Terminal replay: `npm run verify:grid` (0 mismatches), then `npm test` (109 passed, 5 skipped). | "We reconcile the grid against PayPal's own records, row by row. Zero mismatches. Our suite runs 109 tests, including 13 agent-safety scenarios and 24 AI tests, like malformed model replies and prompt injection." |
| 8 | 2:22–2:48 | Architecture card (with Workers AI), then the end card with the repo URL and live URL | "It runs on a Cloudflare Worker with Workers AI, D1, and a Durable Object for spending limits, plus PayPal Orders v2, Vault, and verified webhooks. Code still owns prices, limits, approvals, and PayPal, with a rules fallback. AgentAisle: let agents shop, and keep the merchant in control." |

**Notes:**
- If the simulate burst has not settled by shot 3, cut or speed up the wait. Keep the final cut under 2:55.
- Do not show the user's real name, email or computer desktop beyond the browser and terminal.
- Captions: upload the narration above as the YouTube transcript for accessibility.
