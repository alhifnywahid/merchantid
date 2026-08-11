import { useMemo } from "react";
import { ArrowsClockwise, X } from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useConsole } from "@/lib/console-store";
import {
  formatCurrency,
  formatDateTime,
  paymentStatusLabel,
  paymentStatusVariant,
  shortId,
} from "@/lib/format";
import type { PaymentView, ProviderId } from "@/lib/types";
import { cancelConsolePayment, reconcileProvider } from "@/server/functions";

function PaymentRow({ payment }: { payment: PaymentView }) {
  const { pendingAction, isBusy, run } = useConsole();
  return (
    <article className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-dashed border-border py-2.5 last:border-b-0">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-xs font-medium">
          {payment.reference || shortId(payment.id)}
        </span>
        <Badge variant={paymentStatusVariant(payment.status)}>
          {paymentStatusLabel(payment.status)}
        </Badge>
      </div>
      <span className="font-mono text-sm tabular-nums">
        {formatCurrency(payment.uniqueAmount)}
      </span>
      <div className="col-span-2 flex items-center justify-between gap-3">
        <span className="font-mono text-[0.625rem] uppercase tracking-[0.06em] text-muted-foreground">
          {formatDateTime(payment.createdAt)}
          {payment.transactionId ? ` · ${shortId(payment.transactionId)}` : ""}
        </span>
        {payment.status === "pending" ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={isBusy}
            className={
              pendingAction === `cancel-${payment.id}`
                ? "opacity-60"
                : undefined
            }
            onClick={() => {
              if (!window.confirm("Batalkan tagihan ini?")) return;
              void run(
                `cancel-${payment.id}`,
                () => cancelConsolePayment({ data: { paymentId: payment.id } }),
                "Tagihan dibatalkan",
              );
            }}
          >
            <X aria-hidden="true" className="size-3.5" />
            Batalkan
          </Button>
        ) : null}
      </div>
    </article>
  );
}

/** The ledger: every payment in the active provider's scope, newest first. */
export function LedgerPanel({ providerId }: { providerId: ProviderId }) {
  const { snapshot, pendingAction, isBusy, run } = useConsole();
  const payments = useMemo(
    () =>
      snapshot.payments.filter((payment) => payment.provider === providerId),
    [snapshot.payments, providerId],
  );

  const totals = useMemo(() => {
    let paid = 0;
    let pending = 0;
    for (const payment of payments) {
      if (payment.status === "paid") paid += payment.uniqueAmount;
      else if (payment.status === "pending") pending += payment.uniqueAmount;
    }
    return { paid, pending };
  }, [payments]);

  return (
    <Card aria-label="Riwayat pembayaran">
      <CardHeader>
        <CardTitle>Riwayat</CardTitle>
        <Button
          variant="outline"
          size="sm"
          disabled={isBusy}
          className={
            pendingAction === `reconcile-${providerId}`
              ? "opacity-60"
              : undefined
          }
          onClick={() =>
            void run(
              `reconcile-${providerId}`,
              () => reconcileProvider({ data: { providerId } }),
              "Rekonsiliasi selesai",
            )
          }
        >
          <ArrowsClockwise aria-hidden="true" className="size-3.5" />
          Rekonsiliasi
        </Button>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-0.5 rounded-md border border-border p-2.5">
            <span className="text-[0.625rem] uppercase tracking-[0.06em] text-muted-foreground">
              Lunas
            </span>
            <span className="font-mono text-base tabular-nums text-accent-foreground">
              {formatCurrency(totals.paid)}
            </span>
          </div>
          <div className="flex flex-col gap-0.5 rounded-md border border-border p-2.5">
            <span className="text-[0.625rem] uppercase tracking-[0.06em] text-muted-foreground">
              Menunggu
            </span>
            <span className="font-mono text-base tabular-nums">
              {formatCurrency(totals.pending)}
            </span>
          </div>
        </div>

        {payments.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            Belum ada tagihan untuk scope ini.
          </p>
        ) : (
          <div className="flex flex-col">
            {payments.map((payment) => (
              <PaymentRow key={payment.id} payment={payment} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
