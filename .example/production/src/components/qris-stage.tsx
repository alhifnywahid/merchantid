import { useEffect, useMemo, useState } from "react";
import { ArrowsClockwise, Check, X } from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useConsole } from "@/lib/console-store";
import {
  formatCountdown,
  formatCurrency,
  paymentStatusLabel,
  paymentStatusVariant,
} from "@/lib/format";
import type { PaymentView, ProviderId } from "@/lib/types";
import { cancelConsolePayment, reconcileProvider } from "@/server/functions";

function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

/**
 * The scan surface. Shows the newest pending payment for the active provider as
 * a large framed QR with a live countdown, plus reconcile/cancel. When nothing
 * is pending it collapses to a quiet prompt - the till is idle, not broken.
 */
export function QrisStage({
  payment,
  providerId,
}: {
  payment?: PaymentView;
  providerId: ProviderId;
}) {
  const { pendingAction, isBusy, run } = useConsole();
  const isPending = payment?.status === "pending";
  const now = useNow(isPending);

  const remaining = payment ? payment.expiresAt - now : 0;
  const expiringSoon = isPending && remaining <= 60_000;

  const qrDataUri = useMemo(() => {
    if (!payment?.qrSvg) return undefined;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(payment.qrSvg)}`;
  }, [payment?.qrSvg]);

  const reconcile = () =>
    void run(
      `reconcile-${providerId}`,
      () => reconcileProvider({ data: { providerId } }),
      "Rekonsiliasi selesai",
    );

  if (!payment) {
    return (
      <Card
        aria-label="Layar QRIS"
        className="items-center justify-center text-center"
      >
        <CardContent className="min-h-64 items-center justify-center py-10">
          <div className="frame grid size-40 place-items-center rounded-lg border border-dashed border-border">
            <span className="max-w-28 text-xs leading-relaxed text-muted-foreground">
              Buat tagihan untuk menampilkan QR di sini
            </span>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card aria-label="Layar QRIS">
      <CardHeader>
        <CardTitle>{payment.reference || "Tagihan"}</CardTitle>
        <Badge variant={paymentStatusVariant(payment.status)}>
          {paymentStatusLabel(payment.status)}
        </Badge>
      </CardHeader>
      <CardContent className="items-center gap-4 text-center">
        <div className="flex flex-col items-center gap-0.5">
          <span className="font-mono text-3xl font-semibold tabular-nums tracking-tight">
            {formatCurrency(payment.uniqueAmount)}
          </span>
          <span className="text-[0.6875rem] text-muted-foreground">
            {formatCurrency(payment.baseAmount)} + {payment.uniqueOffset} kode
            unik
          </span>
        </div>

        {isPending && qrDataUri ? (
          <div className="frame rounded-lg bg-white p-3">
            <img
              src={qrDataUri}
              alt={`QR pembayaran ${payment.reference ?? payment.id}`}
              className="size-52"
              width={208}
              height={208}
            />
          </div>
        ) : (
          <div className="grid size-52 place-items-center rounded-lg border border-dashed border-border">
            {payment.status === "paid" ? (
              <Check
                aria-hidden="true"
                className="size-16 text-accent-foreground"
              />
            ) : (
              <X
                aria-hidden="true"
                className="size-16 text-muted-foreground/50"
              />
            )}
          </div>
        )}

        {isPending ? (
          <span
            className={
              expiringSoon
                ? "font-mono text-sm tabular-nums text-destructive"
                : "font-mono text-sm tabular-nums text-muted-foreground"
            }
            aria-live="polite"
          >
            Kedaluwarsa dalam {formatCountdown(remaining)}
          </span>
        ) : null}

        <div className="flex w-full items-center justify-center gap-1.5 border-t border-border pt-3">
          <Button
            variant="outline"
            size="sm"
            disabled={isBusy}
            className={
              pendingAction === `reconcile-${providerId}`
                ? "opacity-60"
                : undefined
            }
            onClick={reconcile}
          >
            <ArrowsClockwise aria-hidden="true" className="size-3.5" />
            Cek status
          </Button>
          {isPending ? (
            <Button
              variant="destructive"
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
                  () =>
                    cancelConsolePayment({ data: { paymentId: payment.id } }),
                  "Tagihan dibatalkan",
                );
              }}
            >
              <X aria-hidden="true" className="size-3.5" />
              Batalkan
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
