import type { LabSnapshot, PaymentView } from "../lib/lab-types";
import { cancelLabPayment, reconcileProvider } from "../server/functions";
import {
  Badge,
  Button,
  Card,
  CardHead,
  MetaList,
  formatCurrency,
  formatDateTime,
  paymentStatusTone,
  shortId,
  type MetaEntry,
  type RunLabAction,
} from "./lab-ui";

interface PaymentLedgerProps {
  payments: PaymentView[];
  pendingAction?: string;
  providerId: LabSnapshot["activeProviderId"];
  runAction: RunLabAction;
}

export function PaymentLedger({
  payments,
  pendingAction,
  providerId,
  runAction,
}: PaymentLedgerProps) {
  return (
    <Card aria-label="Ledger pembayaran">
      <CardHead
        title="Ledger"
        action={
          <Button
            tone="outline"
            busy={pendingAction === `reconcile-${providerId}`}
            disabled={pendingAction !== undefined}
            onClick={() =>
              void runAction(
                `reconcile-${providerId}`,
                () => reconcileProvider({ data: { providerId } }),
                "Rekonsiliasi selesai",
              )
            }
          >
            Rekonsiliasi
          </Button>
        }
      />

      <div className="ledger__grid">
        {payments.map((payment) => (
          <PaymentRecord
            key={payment.id}
            payment={payment}
            pendingAction={pendingAction}
            runAction={runAction}
          />
        ))}
      </div>
    </Card>
  );
}

function PaymentRecord({
  payment,
  pendingAction,
  runAction,
}: {
  payment: PaymentView;
  pendingAction?: string;
  runAction: RunLabAction;
}) {
  const encodedQr = payment.qrSvg
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(payment.qrSvg)}`
    : undefined;

  const entries: MetaEntry[] = [
    { key: "Dibuat", value: formatDateTime(payment.createdAt), mono: true },
    { key: "Kedaluwarsa", value: formatDateTime(payment.expiresAt), mono: true },
  ];
  if (payment.transactionId) {
    entries.push({
      key: "Transaksi",
      value: shortId(payment.transactionId),
      mono: true,
      title: payment.transactionId,
    });
  }

  return (
    <article className="receipt">
      <div className="receipt__head">
        <strong className="receipt__reference">
          {payment.reference || shortId(payment.id)}
        </strong>
        <Badge tone={paymentStatusTone(payment.status)}>
          {paymentStatusLabel(payment.status)}
        </Badge>
      </div>

      <div className="receipt__body">
        <div className="receipt__amount">
          <span className="eyebrow">Harus dibayar</span>
          <strong className="receipt__total">
            {formatCurrency(payment.uniqueAmount)}
          </strong>
          <span className="receipt__basis">
            {formatCurrency(payment.baseAmount)} + {payment.uniqueOffset}
          </span>
        </div>
        {encodedQr ? (
          <div className="receipt__qr frame">
            <img
              src={encodedQr}
              alt={`QR pembayaran ${payment.reference ?? shortId(payment.id)}`}
            />
          </div>
        ) : null}
      </div>

      <MetaList entries={entries} label="Waktu pembayaran" />

      {payment.status === "pending" ? (
        <Button
          tone="destructive"
          busy={pendingAction === `cancel-${payment.id}`}
          disabled={pendingAction !== undefined}
          onClick={() => {
            if (!window.confirm("Batalkan pembayaran ini?")) return;
            void runAction(
              `cancel-${payment.id}`,
              () => cancelLabPayment({ data: { paymentId: payment.id } }),
              "Pembayaran dibatalkan",
            );
          }}
        >
          Batalkan
        </Button>
      ) : null}
    </article>
  );
}

function paymentStatusLabel(status: PaymentView["status"]): string {
  if (status === "paid") return "Lunas";
  if (status === "pending") return "Menunggu";
  if (status === "cancelled") return "Batal";
  return "Kedaluwarsa";
}
