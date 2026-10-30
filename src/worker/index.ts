import { createApp } from './app';
import { buildRuntime, type WorkerEnv } from './runtime';
import { DurableLedgerClient } from './ledgerDO';
import { runSimulation } from '../sim/simulator';
import { seedCatalogIfEmpty } from '../domain/catalogService';

export { MandateLedger } from './ledgerDO';

const app = createApp((c) => buildRuntime(c.env as unknown as WorkerEnv, c.req.url, new DurableLedgerClient((c.env as unknown as WorkerEnv).MANDATE_LEDGER)));

export default {
  fetch: (req: Request, env: WorkerEnv, ctx: ExecutionContext) => app.fetch(req, env, ctx),
  async scheduled(_ev: ScheduledController, env: WorkerEnv, ctx: ExecutionContext) {
    if (env.SIMULATOR_ENABLED !== 'true') return;
    const rt = buildRuntime(env, null, new DurableLedgerClient(env.MANDATE_LEDGER));
    await seedCatalogIfEmpty(rt.deps);
    ctx.waitUntil(runSimulation(rt.deps, async (req) => app.fetch(req, env, ctx), { sessions: rt.simSessionsPerTick, secret: rt.simSecret, simVaultId: rt.simVaultId }).then((r) => console.log('sim tick', JSON.stringify({ ...r, results: undefined }))));
  },
} satisfies ExportedHandler<WorkerEnv>;
