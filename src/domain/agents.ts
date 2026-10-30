import type { AgentCtx, Deps } from './deps';
import type { Agent } from './types';

export const AGENT_ID_RE = /^[A-Za-z0-9._:-]{3,64}$/;

export async function touchAgent(d: Deps, ctx: AgentCtx): Promise<Agent> {
  const now = d.clock.now().toISOString();
  const existing = await d.store.getAgent(ctx.agentId);
  const a: Agent = existing
    ? { ...existing, platform: ctx.platform, displayName: ctx.displayName, lastSeen: now }
    : { id: ctx.agentId, platform: ctx.platform, displayName: ctx.displayName, trust: 'new', firstSeen: now, lastSeen: now };
  await d.store.upsertAgent(a);
  return a;
}

export async function promoteIfEarned(d: Deps, agentId: string) {
  const a = await d.store.getAgent(agentId);
  if (!a || a.trust !== 'new') return;
  const n = await d.store.countCompletedByAgentSince(agentId, '');
  if (n >= 3) await d.store.upsertAgent({ ...a, trust: 'known' });
}

export async function setTrust(d: Deps, agentId: string, trust: Agent['trust']) {
  const a = await d.store.getAgent(agentId);
  if (!a) return null;
  const next = { ...a, trust };
  await d.store.upsertAgent(next);
  return next;
}
