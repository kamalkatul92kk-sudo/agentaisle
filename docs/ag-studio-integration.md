# AG Studio integration plan

The merchant console (`web/`) has two layers:

1. **Custom widgets** (`web/src/widgets/`). These are React components built on AG Grid Community and AG Charts Community. They work today with no license and handle the operational actions: approving, rejecting, revoking and replaying.
2. **AG Studio** (`web/src/studio/`). This is a self-serve analytics canvas over the same data, loaded lazily from `ag-studio` 3.x.

## Data contract

`toStudioData(snapshot, events)` in `web/src/studio/dataSources.ts` turns the `/api/merchant/dashboard` and `/api/merchant/events` payloads into an `AgDataSourcesDefinition`. The types are shared with the worker through `src/shared/contracts.ts`.

| Studio table | Source | Backs widget |
|---|---|---|
| `sessions` | dashboard.sessions | LiveDesk, Rollups, SessionReplay |
| `agents` | dashboard.agents | Agents |
| `events` | /events | SessionReplay, LiveDesk inspector |
| `products` | dashboard.products (no cost field) | Catalog KPIs |
| `funnel` | dashboard.funnel | Funnel |
| `demand_gaps` | dashboard.demandGaps | DemandGaps |
| `approvals` | dashboard.approvals | ApprovalQueue |
| `mandates` | dashboard.mandates | MandateGauges |

Relationships (many-to-one): `sessions.agentId → agents.id`, `events.sessionId → sessions.id`, `approvals.sessionId → sessions.id`.

Money is stored as integer cents in the API. It is converted to dollars with `currencyFormat` only in the Studio layer.

## Licensing

- **No key:** Studio runs in evaluation mode with a watermark and a console notice. This was verified locally on Oct 28, 2026.
- **Public build (default):** the Studio tab and the `ag-studio` bundle are left out unless `VITE_ENABLE_AG_STUDIO=true`. The trial EULA covers internal evaluation only, and an unlicensed watermarked build should not be published.
- **Trial key:** the repo owner starts the free 45-day AG Studio trial (planned for Oct 31 or later). Put the key in `web/.env.local` as `VITE_AG_STUDIO_LICENSE_KEY=...` and set `VITE_ENABLE_AG_STUDIO=true`. That file is gitignored. Never commit the key. The code calls `AgStudioLicenseManager.setLicenseKey()` only when the variable is set.
- AG Studio is commercial software and pulls in `ag-grid-enterprise` and `ag-charts-enterprise`. The custom widgets use only the Community packages (MIT), so the repo stays MIT-clean.

## Shipping a default report

1. Build the layout in edit mode, then click **Save layout**. This stores `getState()` in localStorage under `agentaisle.studioReport`.
2. Export that JSON to `web/src/studio/defaultReport.json` and pass it as `initialState`, so judges see a curated report in view mode.
3. Suggested pages: Agent revenue (KPI + revenue by platform), Funnel and drop-off, Demand gaps, and Trust and safety (held/rejected by reason, mandate utilization).

## Fallback

If Studio is unavailable (license, bundle size or runtime issue), the AG Studio tab can be hidden. All operational features stay on the Community widgets.
