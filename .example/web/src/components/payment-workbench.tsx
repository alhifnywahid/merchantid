import { useState, type FormEvent } from "react";
import type { ProviderSnapshot } from "../lib/lab-types";
import { createLabPayment, saveStaticQris } from "../server/functions";
import {
  Button,
  Card,
  CardHead,
  Field,
  PrefixedInput,
  Select,
  TextArea,
  TextInput,
  formatCurrency,
  type RunLabAction,
} from "./lab-ui";

interface PaymentWorkbenchProps {
  provider: ProviderSnapshot;
  pendingAction?: string;
  runAction: RunLabAction;
}

/**
 * Shows the QRIS binding step or the payment form — never both. The step that
 * is not yet reachable simply is not rendered.
 */
export function PaymentWorkbench(props: PaymentWorkbenchProps) {
  return props.provider.hasStaticQris ? (
    <PaymentForm {...props} />
  ) : (
    <QrisSource {...props} />
  );
}

function QrisSource({
  provider,
  pendingAction,
  runAction,
}: PaymentWorkbenchProps) {
  const [payload, setPayload] = useState("");
  const busy = pendingAction !== undefined;

  if (provider.id === "gopay") {
    return (
      <Card aria-label="Sumber QRIS">
        <CardHead title="QRIS" />
        <div className="card__body">
          <p className="note">
            Merchant aktif belum mengembalikan QRIS statis. Jalankan discovery
            atau pilih outlet lain.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <Card aria-label="Sumber QRIS">
      <CardHead title="QRIS" />
      <div className="card__body">
        <form
          className="form"
          onSubmit={async (event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const ok = await runAction(
              `save-qris-${provider.id}`,
              () =>
                saveStaticQris({
                  data: { providerId: provider.id, payload },
                }),
              "QRIS terikat ke scope",
            );
            if (ok) setPayload("");
          }}
        >
          <Field
            label="Payload QRIS statis"
            hint="Shopee belum punya endpoint discovery QRIS, jadi payload store diisi manual."
          >
            <TextArea
              value={payload}
              onChange={(event) => setPayload(event.target.value)}
              placeholder="00020101021126…"
              rows={4}
              minLength={16}
              maxLength={8192}
              autoComplete="off"
              spellCheck={false}
              required
            />
          </Field>
          <div className="form__footer">
            <Button
              type="submit"
              busy={pendingAction === `save-qris-${provider.id}`}
              disabled={busy || payload.trim().length < 16}
            >
              Simpan QRIS
            </Button>
          </div>
        </form>
      </div>
    </Card>
  );
}

function PaymentForm({
  provider,
  pendingAction,
  runAction,
}: PaymentWorkbenchProps) {
  const [amount, setAmount] = useState("25000");
  const [reference, setReference] = useState("");
  const [expiresInMinutes, setExpiresInMinutes] = useState("5");
  const busy = pendingAction !== undefined;
  const numericAmount = Number(amount);
  const amountValid = Number.isSafeInteger(numericAmount) && numericAmount > 0;

  return (
    <Card aria-label="Buat pembayaran">
      <CardHead title="Pembayaran" />
      <div className="card__body">
        <form
          className="form"
          onSubmit={async (event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (!amountValid) return;
            const ok = await runAction(
              `create-payment-${provider.id}`,
              () =>
                createLabPayment({
                  data: {
                    providerId: provider.id,
                    amount: numericAmount,
                    reference: reference.trim() || undefined,
                    expiresInMinutes: Number(expiresInMinutes),
                  },
                }),
              "Pembayaran dibuat",
            );
            if (ok) setReference("");
          }}
        >
          <Field
            label="Nominal"
            hint={amountValid ? formatCurrency(numericAmount) : "Bilangan bulat > 0"}
          >
            <PrefixedInput
              className="input--display"
              prefix="Rp"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              type="number"
              inputMode="numeric"
              min="1"
              max="999999999"
              step="1"
              aria-invalid={amountValid ? undefined : true}
              required
            />
          </Field>

          <div className="form__row">
            <Field label="Referensi">
              <TextInput
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                placeholder="ORDER-4718"
                maxLength={120}
                autoComplete="off"
              />
            </Field>
            <Field label="Berlaku">
              <Select
                value={expiresInMinutes}
                onChange={(event) => setExpiresInMinutes(event.target.value)}
              >
                <option value="1">1 menit</option>
                <option value="5">5 menit</option>
                <option value="15">15 menit</option>
                <option value="60">1 jam</option>
              </Select>
            </Field>
          </div>

          <div className="form__footer">
            <Button
              type="submit"
              busy={pendingAction === `create-payment-${provider.id}`}
              disabled={busy || !amountValid}
            >
              Buat pembayaran
            </Button>
          </div>
        </form>
      </div>
    </Card>
  );
}
