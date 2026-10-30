// Approval queue. Anything that moves money or changes the catalog outside a normal buyer checkout lands here
// and only executes when a merchant (authenticated) approves it. The ops agent can only *propose*.
import type { Deps } from './deps';
import { emit } from './deps';
import { declineHeld, refundSession, releaseHeld } from './checkout';
import { DomainError, type Approval, type ApprovalKind, type Category, type Product, type Roast } from './types';

export async function proposeApproval(d: Deps, a: { kind: ApprovalKind; sessionId?: string | null; payload: Record<string, unknown>; reason: string; requestedBy: Approval['requestedBy'] }) {
  const ap: Approval = { id: d.ids.id('apr'), kind: a.kind, status: 'pending', sessionId: a.sessionId ?? null, payload: a.payload, reason: a.reason.slice(0, 300), requestedBy: a.requestedBy, decidedBy: null, result: null, createdAt: d.clock.now().toISOString(), decidedAt: null };
  await d.store.insertApproval(ap);
  await emit(d, 'approval.proposed', { sessionId: ap.sessionId, data: { approvalId: ap.id, kind: ap.kind, requestedBy: ap.requestedBy } });
  return ap;
}

export interface ProductProposal { name: string; category: Category; roast?: Roast | null; origin?: string | null; priceCents: number; costCents: number; stock: number; description: string }

async function execute(d: Deps, a: Approval): Promise<Record<string, unknown>> {
  switch (a.kind) {
    case 'order_release': {
      const s = await releaseHeld(d, String(a.payload.sessionId));
      return { sessionStatus: s.status, orderId: s.paypalOrderId };
    }
    case 'refund': {
      const r = await refundSession(d, String(a.payload.sessionId), a.payload.amountCents == null ? null : Number(a.payload.amountCents), String(a.payload.note ?? 'Refund approved by merchant'));
      return r as unknown as Record<string, unknown>;
    }
    case 'create_product': {
      const p = a.payload as unknown as ProductProposal;
      const sku = `PP-NEW-${p.name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20)}`;
      if (await d.store.getProduct(sku)) throw new DomainError('exists', `SKU ${sku} exists`, 409);
      const pp = await d.payments.createCatalogProduct({ requestId: `${a.id}-product`, name: p.name, description: p.description, category: 'FOOD_RETAIL_AND_SERVICE' });
      const prod: Product = { sku, name: p.name, category: p.category, roast: p.roast ?? null, origin: p.origin ?? null, process: null, tastingNotes: null, description: p.description, weightOz: 12, priceCents: p.priceCents, costCents: p.costCents, stock: p.stock, negotiable: p.category !== 'reserve' && p.category !== 'gear', maxDiscountBps: p.category === 'blend' ? 1200 : p.category === 'single_origin' ? 1000 : 0, paypalProductId: pp.id, active: true, createdAt: d.clock.now().toISOString() };
      await d.store.upsertProduct(prod);
      return { sku, paypalProductId: pp.id };
    }
    case 'restock': {
      const ok = await d.store.adjustStock(String(a.payload.sku), Number(a.payload.qty));
      if (!ok) throw new DomainError('restock_failed', 'Restock failed');
      return { sku: a.payload.sku, added: a.payload.qty };
    }
  }
}

export async function decideApproval(d: Deps, id: string, decision: 'approve' | 'reject', by: string, note = '') {
  const a = await d.store.getApproval(id);
  if (!a) throw new DomainError('not_found', 'Unknown approval', 404);
  if (a.status !== 'pending') throw new DomainError('already_decided', `Approval is ${a.status}`, 409);
  const now = d.clock.now().toISOString();
  if (decision === 'reject') {
    if (a.kind === 'order_release' && a.payload.sessionId) await declineHeld(d, String(a.payload.sessionId), note || 'declined');
    const next: Approval = { ...a, status: 'rejected', decidedBy: by, decidedAt: now, result: { note } };
    await d.store.updateApproval(next);
    await emit(d, 'approval.rejected', { sessionId: a.sessionId, data: { approvalId: id, kind: a.kind } });
    return next;
  }
  try {
    const result = await execute(d, a);
    const next: Approval = { ...a, status: 'executed', decidedBy: by, decidedAt: now, result };
    await d.store.updateApproval(next);
    await emit(d, 'approval.executed', { sessionId: a.sessionId, data: { approvalId: id, kind: a.kind, result } });
    return next;
  } catch (e) {
    const next: Approval = { ...a, status: 'failed', decidedBy: by, decidedAt: now, result: { error: (e as Error).message } };
    await d.store.updateApproval(next);
    await emit(d, 'approval.failed', { sessionId: a.sessionId, data: { approvalId: id, kind: a.kind, error: (e as Error).message } });
    return next;
  }
}
