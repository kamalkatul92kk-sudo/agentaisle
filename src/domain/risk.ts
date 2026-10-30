import type { Agent, CheckoutSession } from './types';

export const RISK = {
  holdAboveCents: 12000,
  newAgentHoldAboveCents: 6000,
  velocityWindowMin: 10,
  velocityMaxOrders: 3,
};

export type RiskDecision = { action: 'allow' } | { action: 'hold'; reason: string } | { action: 'reject'; reason: string };

/** Policy for buyer-absent (mandate) charges. Hard caps are enforced separately by the ledger. */
export function assessMandateCharge(s: CheckoutSession, agent: Agent, recentCompletedByAgent: number): RiskDecision {
  if (agent.trust === 'blocked') return { action: 'reject', reason: 'agent_blocked' };
  if (recentCompletedByAgent >= RISK.velocityMaxOrders) return { action: 'hold', reason: `velocity: ${recentCompletedByAgent} orders from this agent in ${RISK.velocityWindowMin} min` };
  if (s.totalCents > RISK.holdAboveCents) return { action: 'hold', reason: `order total above $${RISK.holdAboveCents / 100} review threshold` };
  if (agent.trust === 'new' && s.totalCents > RISK.newAgentHoldAboveCents) return { action: 'hold', reason: `new agent with order above $${RISK.newAgentHoldAboveCents / 100}` };
  return { action: 'allow' };
}

export function assessApprovalLink(_s: CheckoutSession, agent: Agent): RiskDecision {
  if (agent.trust === 'blocked') return { action: 'reject', reason: 'agent_blocked' };
  return { action: 'allow' }; // buyer approves every order on PayPal, so no buyer-absent risk
}
