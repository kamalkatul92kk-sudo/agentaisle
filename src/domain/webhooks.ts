import type { Deps } from './deps';
import { emit } from './deps';
import { captureApprovedOrder } from './checkout';
import { DomainError } from './types';

export interface PayPalWebhookEvent { id: string; event_type: string; resource: any; create_time?: string }

export async function handleWebhook(d: Deps, headers: Headers, rawBody: string) {
  if (rawBody.length > 256_000) throw new DomainError('too_large', 'payload too large', 413);
  if (!(await d.payments.verifyWebhook(headers, rawBody))) throw new DomainError('bad_signature', 'Webhook signature verification failed', 401);
  let ev: PayPalWebhookEvent;
  try { ev = JSON.parse(rawBody); } catch { throw new DomainError('bad_json', 'Invalid JSON', 400); }
  if (!ev?.id || !ev.event_type) throw new DomainError('bad_event', 'Missing id or event_type', 400);
  const now = d.clock.now().toISOString();
  const fresh = await d.store.markWebhookSeen(ev.id, ev.event_type, now, 'received');
  if (!fresh) return { duplicate: true, type: ev.event_type };
  const r = ev.resource ?? {};
  let outcome: Record<string, unknown> = { handled: false };
  let sessionId: string | undefined; let agentId: string | undefined;
  switch (ev.event_type) {
    case 'CHECKOUT.ORDER.APPROVED': {
      const s = await captureApprovedOrder(d, r.id).catch((e) => ({ status: `error:${(e as Error).message}` }) as { status: string; id?: string; agentId?: string });
      sessionId = s.id; agentId = s.agentId;
      outcome = { handled: true, orderId: r.id, sessionStatus: s.status };
      break;
    }
    case 'PAYMENT.CAPTURE.COMPLETED':
    case 'PAYMENT.CAPTURE.DENIED':
    case 'PAYMENT.CAPTURE.REVERSED': {
      const p = await d.store.getPaymentByCapture(r.id);
      if (p) {
        sessionId = p.sessionId;
        // Webhooks can arrive late/out of order: a CAPTURE.COMPLETED after a refund must not un-refund the payment.
        const late = ev.event_type.endsWith('COMPLETED') && (p.status === 'refunded' || p.status === 'partially_refunded');
        p.status = late ? p.status : ev.event_type.endsWith('COMPLETED') ? 'completed' : ev.event_type.endsWith('DENIED') ? 'failed' : 'refunded';
        if (ev.event_type.endsWith('REVERSED')) p.refundedCents = p.amountCents;
        p.updatedAt = now; await d.store.updatePayment(p);
        if (ev.event_type.endsWith('DENIED')) {
          const s = await d.store.getSession(p.sessionId);
          if (s) { s.status = 'failed'; s.rejectReason = 'capture_denied'; s.updatedAt = now; await d.store.updateSession(s); }
        }
        outcome = { handled: true, paymentStatus: p.status };
      }
      break;
    }
    case 'CHECKOUT.ORDER.COMPLETED': {
      // Order captured (by us or elsewhere). captureApprovedOrder re-reads the order and reconciles a COMPLETED order
      // without issuing another capture, so this is safe to run after our own capture too.
      const s = await d.store.getSessionByOrderId(r.id);
      if (s) {
        const done = s.status === 'completed' ? s : await captureApprovedOrder(d, r.id).catch((e) => ({ ...s, status: `error:${(e as Error).message}` }));
        sessionId = s.id; agentId = s.agentId;
        outcome = { handled: true, orderId: r.id, sessionStatus: done.status };
      } else outcome = { handled: false, orderId: r.id, reason: 'unknown_order' };
      break;
    }
    case 'PAYMENT.CAPTURE.REFUNDED': {
      // resource = the refund. Its "up" link points at the capture; seller_payable_breakdown carries the capture's
      // running refunded total, which also covers refunds issued outside AgentAisle (e.g. from the PayPal dashboard).
      const captureId = (r.links as { rel: string; href: string }[] | undefined)?.find((l) => l.rel === 'up')?.href.split('/').pop() ?? null;
      const p = captureId ? await d.store.getPaymentByCapture(captureId) : null;
      const total = Math.round(Number(r.seller_payable_breakdown?.total_refunded_amount?.value ?? r.amount?.value ?? 0) * 100);
      if (p) {
        sessionId = p.sessionId;
        const extra = total - p.refundedCents;
        if (extra > 0) { // a refund we did not record ourselves
          p.refundedCents = Math.min(p.amountCents, total); p.status = p.refundedCents >= p.amountCents ? 'refunded' : 'partially_refunded'; p.updatedAt = now;
          await d.store.updatePayment(p);
          const s = await d.store.getSession(p.sessionId);
          if (s?.mandateId) await d.ledger.credit(s.mandateId, extra, now);
        }
        outcome = { handled: true, captureId, refundId: r.id ?? null, refundedCents: p.refundedCents, reconciled: extra > 0 };
      } else outcome = { handled: false, captureId, refundId: r.id ?? null, reason: 'unknown_capture' };
      break;
    }
    case 'VAULT.PAYMENT-TOKEN.DELETED': {
      for (const m of await d.store.listMandates()) if (m.vaultId === r.id && m.status !== 'revoked') await d.store.updateMandate({ ...m, status: 'revoked' });
      outcome = { handled: true };
      break;
    }
    case 'VAULT.PAYMENT-TOKEN.CREATED':
      outcome = { handled: true };
      break;
  }
  await emit(d, `webhook.${ev.event_type}`, { sessionId, agentId, data: { eventId: ev.id, ...outcome } });
  return { duplicate: false, type: ev.event_type, ...outcome };
}
