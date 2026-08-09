import type { Payment, PaymentScope, PaymentStore } from "../core/types.js";
import { samePaymentScope } from "../core/provider.js";

function clonePayment(payment: Payment): Payment {
  return {
    ...payment,
    scope: payment.scope ? { ...payment.scope } : undefined,
  };
}

/**
 * Default in-memory {@link PaymentStore}. Suitable for single-process usage and
 * tests. For multi-process deployments, provide a durable store (Redis, SQL)
 * implementing the same interface.
 */
export class InMemoryPaymentStore implements PaymentStore {
  private readonly payments = new Map<string, Payment>();

  create(payment: Payment): void {
    this.payments.set(payment.id, clonePayment(payment));
  }

  update(payment: Payment): void {
    this.payments.set(payment.id, clonePayment(payment));
  }

  get(id: string): Payment | undefined {
    const found = this.payments.get(id);
    return found ? clonePayment(found) : undefined;
  }

  listActive(scope?: PaymentScope): Payment[] {
    return [...this.payments.values()]
      .filter(
        (payment) =>
          payment.status === "pending" &&
          (!scope ||
            (payment.scope !== undefined &&
              samePaymentScope(payment.scope, scope))),
      )
      .map(clonePayment);
  }
}
