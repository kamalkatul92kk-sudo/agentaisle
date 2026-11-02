# AgentAisle: Devpost write-up (draft)

> Paste each section into the matching Devpost field. Every number below comes from real PayPal **sandbox** runs on Oct 28–29, 2026 (CT). The merchant, Pecan Plume Coffee Co., is **fictional** and based in Texas. No real money moves.

**Project name:** AgentAisle

**Tagline (≤ 200 chars):** An agent-ready storefront: AI buyer agents shop, haggle within merchant rules and pay with PayPal, while the merchant watches every order, capture and verified webhook live in AG Grid.

**Live demo:** https://agentaisle-demo.kamalkatul92-kk.workers.dev (PayPal sandbox, fictional merchant; read-only without the merchant token)

**Repo:** https://github.com/kamalkatul92kk-sudo/agentaisle

**Video:** https://youtu.be/0LZBDRTz6PQ (2:44, 1080p, synthetic narration + burned-in captions; cover image `submission/video/cover.png`)

---

## Inspiration

AI agents are starting to shop for people. They compare products, negotiate, and soon they will pay on their own using a saved payment method. Small merchants are not ready for that.
- They can't tell which agent is buying.
- They can't stop an agent from talking a price below cost.
- They can't cap what a delegated agent spends.
- They can't see whether a PayPal capture really happened.

We wanted to show a small shop, a fictional Texas coffee roaster, that sells safely to AI agents and can **see** what those agents are doing in real time.

## What it does

**For buyer agents:**
- AgentAisle exposes the shop as an **MCP server**, with a matching REST checkout API.
- Agents can search the catalog, build a cart, **negotiate**, and check out.

**Two PayPal payment modes:**
- **Buyer-absent mandate:** the buyer saves PayPal once with **PayPal Vault v3**. Agents can then pay on their own, within per-order caps, monthly caps and category limits. Those caps are enforced in a strongly consistent Durable Object.
- **Approval link:** each order uses PayPal **Orders v2** and the buyer approves it.

**Guardrails:**
- Floor prices that no amount of haggling breaks.
- Velocity and new-agent risk holds.
- Per-agent session isolation.
- Idempotent payments, with double-capture protection.
- Prompt-injected buyer notes can't change prices, links or actions.
- The built-in "ops agent" only **proposes** refunds; a human approves them.

**PayPal webhooks:** every event (`PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`, vault token events and others) is checked with PayPal's `verify-webhook-signature` before it is stored. Forged or unsigned events get a 401. When a vault token is deleted, the mandate is revoked.

**Merchant console** (AG Grid + AG Charts Community, MIT):
- **Live desk grid.** Rows update in place as agent sessions move through checkout, PayPal order, capture, verified webhook and refund. Changed cells flash, and a row lights up when a signed webhook lands. Each row shows:
  - a 5-step payment lifecycle bar;
  - the PayPal order and capture IDs;
  - a verified-webhook badge.
- **Views.** Quick filter, presets (Needs attention, Refunds, Webhook-verified, High value, External agents), and saved views that remember columns, filters and search.
- **Totals and export.** A pinned totals row and CSV export.
- **Session inspector.** Click a row to see a lifecycle stepper and a nested grid of that session's full event log, with verified PayPal webhooks highlighted.
- **Rollups.** Group by persona, agent, platform, status or payment mode. Columns include conversion and refund-rate bars, AOV and revenue sparklines, plus a linked AG Charts bar chart that follows the grid's filter and sort.
- **Other tabs.** Light and dark themes (AG Grid Theming API), an approvals queue, mandate spend gauges, a funnel, demand gaps, and a full session replay.

**Traffic simulator:** seeded buyer-agent personas generate realistic traffic on demand and on an hourly cron. Ten personas: espresso-nerd, budget-brewer, pod-seeker, gift-shopper, office-manager, big-spender, light-roast-fan, oat-milk-seeker, plus a token **forger** and a prompt **injector**.

## How we built it

- **Backend:**
  - Cloudflare Worker (Hono) on the free plan;
  - **D1** for the catalog, sessions, orders, events and approvals;
  - a **Durable Object** (`MandateLedger`) for spend caps;
  - an hourly cron for the simulator.
- **MCP:** a stateless streamable-HTTP MCP server (`@modelcontextprotocol/sdk`) with 9 tools:
  - search_catalog, get_product, store_policies;
  - create/update/get/cancel_checkout;
  - negotiate, complete_checkout.
- **PayPal (sandbox):** REST adapter for Orders v2 (create, capture, refund, status), Vault v3 (setup tokens, payment tokens, and save-during-purchase with `store_in_vault: ON_SUCCESS`), and webhook signature verification. The adapter sits behind a `PaymentGateway` interface, with a mock adapter for offline tests.
- **Frontend:** React + Vite, **AG Grid Community 36** and **AG Charts Community 14**.
  - The grid uses `applyTransactionAsync` with a tested row-diff, async transactions and cell flashing.
  - It also has custom cell renderers, an external filter for presets, column state and filter-model save and restore, pinned rows and columns, CSV export, and the Theming API.
  - Rollups and sparklines are computed in our own tested code, so we stay within the MIT Community packages.
- **AG Studio:** an AG Studio report over the same data model lives behind a build flag and is turned on only with a licence key.
- **Tests:** 109 vitest tests, including:
  - 13 agent-safety scenarios (over-cap, floor price, cross-agent access, forged mandates, idempotent replay, prompt injection, velocity holds, "refund all" refusal, and more);
  - the MCP contract;
  - PayPal REST against a fake server;
  - a signed-webhook-to-grid integration test;
  - a guard that fails if any AG Grid Enterprise feature slips in;
  - 24 AI-layer tests with mocked models (valid, malformed and slow replies, below-floor and over-cap proposals, prompt injection, daily budget).

**Real sandbox results (Oct 28, 2026):**

| Check | Result |
|---|---|
| Vault Path A (save without purchase, then buyer-absent charge) | **GO**. Charge order 7P6698986E288602L, capture 2CY33934AM602533C, refund 0GY14680GL041674E; an idempotent retry returned the same order ID. |
| Vault Path B (save during first purchase) | **GO**. Order 8RT90986YJ463003L, then a buyer-absent charge with capture 13X51369AJ284720G and refund 6V861553N8648070L. |
| Per-order approval fallback | **PASS**. Order 1YE03627T73257805, capture 5EG91529U3877015X. Capture before approval was refused with ORDER_NOT_APPROVED. |
| Public demo run (simulated agents) | 7 sessions: 5 captured, 1 held for review, 1 awaiting buyer approval. One order (9VY24158T0351754Y / capture 4SF52972AV589344K) was refunded through the approval queue with refund 19K57194B82609801. |
| Grid vs PayPal reconciliation (`npm run verify:grid`) | Oct 28: 6 of 6 sessions match, 0 mismatches. Oct 29, 2:21 PM CT, after a day of hourly simulator traffic: 22 grid rows with PayPal IDs checked, **0 mismatches** (15 captured, 1 of them refunded; 2 awaiting buyer approval; 5 never-approved orders that PayPal has already expired, so no money moved). |
| Webhooks | 6 genuine PayPal sandbox webhooks (5 × CAPTURE.COMPLETED, 1 × CAPTURE.REFUNDED) verified and shown on the live grid. Forged webhooks get a 401. |

## Challenges we ran into

- **Buyer-absent payments without double charges.** A capture retried after a timeout must not charge twice. We check the PayPal order status first and use a stable `PayPal-Request-Id`, a compare-and-set on the session, and one payment per session.
- **Webhook verification on Workers.** PayPal's verify call needs the exact raw body, so we splice the raw bytes in verbatim instead of re-serialising JSON.
- **Vault flows that pause for a human.** The go/no-go scripts report `PENDING_BUYER_APPROVAL` and can resume later without creating new PayPal objects.
- **Rich grids on the free tier.** We wanted grouping, sparklines and live updates without Enterprise modules. We used transactions, custom renderers and our own rollup logic, and added a test that guards the licence boundary.
- **Keeping a public demo safe.** The demo is readable by anyone, but every action (simulate, approve, refund, revoke, reset) needs the merchant token, and no secrets are exposed.

## Accomplishments that we're proud of

- An end-to-end agent purchase on the real PayPal sandbox, with no human in the loop at payment time: mandate, then capture, then verified webhook, then approved refund.
- A live grid that matches PayPal's own records row by row: 22 of 22 rows with PayPal IDs on Oct 29, with 0 mismatches.
- 13 adversarial agent-safety scenarios that pass, including prompt injection and token forgery.
- The whole stack runs on the Cloudflare free plan and the PayPal sandbox at zero cost.

## What we learned

- Agentic commerce needs **spending mandates** as a first-class object: caps, categories, revocation through vault webhooks, and an audit trail.
- Verified webhooks are the merchant's source of truth. Showing them next to each order builds trust faster than any chart.
- AG Grid Community goes a long way with transactions, renderers, an external filter and saved state.

## What's next for AgentAisle

- An AG Studio report and an AI-agent integration once a licence (the 45-day trial) is in place.
- More agent protocols alongside MCP.
- Disputes and chargeback webhooks.
- Multi-merchant onboarding with PayPal partner flows.
- Per-agent reputation shared across shops.

## Built with

Paste these into Devpost's "Built with" field, one tag at a time:

`paypal`, `paypal-orders-v2`, `paypal-vault`, `paypal-webhooks`, `ag-grid`, `ag-charts`, `model-context-protocol`, `cloudflare-workers`, `cloudflare-d1`, `durable-objects`, `hono`, `typescript`, `react`, `vite`, `vitest`, `zod`

## Testing instructions for judges

No login, token or install is needed. Everything runs on the PayPal **sandbox** for a **fictional** merchant; no real money moves.

1. Open https://agentaisle-demo.kamalkatul92-kk.workers.dev. The public demo is **read-only for visitors**: every write action (Simulate, Approve, Reject, Refund, Revoke, Reset, Ops agent) needs the merchant token, and the server refuses it with a 401 otherwise. Browsing, filtering, saved views, the inspector, rollups, themes and replay all work without it.
2. **Fresh traffic arrives on its own.** An hourly simulator (cron at minute 17 of every hour) sends 2 new buyer-agent sessions through the MCP server and the real PayPal sandbox. The live desk polls every 3 seconds, so rows appear and update in place without a reload.
3. **Live** tab: hover the lifecycle bar; scroll right to see the PayPal sandbox order and capture IDs and the verified-webhook badge. Try the **Views** presets (Needs attention, Refunds, Webhook-verified, High value, External agents), the quick filter, column moves, and save a view.
4. Click any row to open the **session inspector** (lifecycle stepper and the full event log, with verified PayPal webhooks highlighted). The **Refunds** preset shows an order that was refunded through the human approval queue.
5. **Approvals** tab: orders held by risk rules wait here (read-only for visitors).
6. **Agents & rollups** tab: switch the group-by (Persona, Agent, Platform, Status, Payment mode); sort or filter the grid and the linked chart follows. Use the moon/sun button to switch light/dark.
7. **Replay:** in the session inspector, click **Open full replay** to see that session's complete, timestamped event timeline.
8. To run it yourself: `npm ci && npm test` (109 tests, no PayPal account needed) and the README Quick start for a local Worker with mock payments.

## AI tools used (required by the rules)

- **In the product:** Cloudflare Workers AI, model `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, through the Worker's `AI` binding (no API key).
  - **Buyer agents:** the simulated shopping agents use the model to choose products and quantities for each persona's goal and budget, and to decide each haggling offer and what they say.
  - **Merchant replies:** the model rewords the shop's negotiation replies. The price itself is never the model's.
  - **Ops agent:** the merchant's chat assistant uses the model to pick read-only tools, rate refund risk with a short rationale, and advise on held orders. It can only *propose* actions; a human approves them.
  - **Deterministic, in code:** prices, floor prices, discounts, mandate caps, category limits, risk holds, approvals, refund amounts, PayPal calls and webhook checks. Every model reply is validated (JSON schema, timeout, code guards); on any failure the app uses the rule-based version, and the console shows a model or fallback badge on each decision.
  - Prompt injection: buyer notes reach the model only as quoted data. Tests show an injected note cannot change a price, a cap or an approval.
- **In development:**
  - An AI coding assistant (Grok Bot) helped write and test code, run the PayPal sandbox checks, draft this write-up and the docs, and record the demo video.
  - The video narration is synthetic speech generated with xAI Grok Text to Speech (voice "Ara"). It does not imitate any real person.
  - Every number, ID and screenshot in this submission comes from real runs against the PayPal sandbox; the architecture card and the terminal clip in the video replay real captured output rather than being live screen captures, and the video says so on screen.

## Disclaimer for judges

This is a hackathon **sandbox demo**. Pecan Plume Coffee Co. is a **fictional** merchant in Texas, all products and buyers are simulated, and payments run only on the PayPal sandbox. No real money moves.
