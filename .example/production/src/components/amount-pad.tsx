import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useConsole } from "@/lib/console-store";
import { formatCurrency } from "@/lib/format";
import type { ProviderSnapshot } from "@/lib/types";
import { createConsolePayment } from "@/server/functions";
import { cn } from "@/lib/utils";

const QUICK_AMOUNTS = [10_000, 25_000, 50_000, 100_000];

const EXPIRY_OPTIONS = [
  { value: "5", label: "5 menit" },
  { value: "15", label: "15 menit" },
  { value: "30", label: "30 menit" },
  { value: "60", label: "1 jam" },
];

/**
 * The till surface: quick-amount chips, a large numeric field, an optional
 * reference and expiry, and the create action. This is the primary action of
 * the whole console, so the amount field is display-sized and the button is
 * `lg`.
 */
export function AmountPad({ provider }: { provider: ProviderSnapshot }) {
  const { isBusy, run } = useConsole();
  const [amount, setAmount] = useState("25000");
  const [reference, setReference] = useState("");
  const [expiry, setExpiry] = useState("15");

  const numeric = Number(amount);
  const valid = Number.isSafeInteger(numeric) && numeric > 0;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    const ok = await run(
      "create-payment",
      () =>
        createConsolePayment({
          data: {
            providerId: provider.id,
            amount: numeric,
            reference: reference.trim() || undefined,
            expiresInMinutes: Number(expiry),
          },
        }),
      "Tagihan dibuat",
    );
    if (ok) setReference("");
  };

  return (
    <Card aria-label="Buat tagihan">
      <CardHeader>
        <CardTitle>Tagihan baru</CardTitle>
        <span className="font-mono text-[0.625rem] uppercase tracking-[0.08em] text-muted-foreground">
          {provider.label}
        </span>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <div className="flex flex-wrap gap-1.5">
            {QUICK_AMOUNTS.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setAmount(String(value))}
                className={cn(
                  "rounded-md border px-2.5 py-1 font-mono text-xs tabular-nums transition-[background-color,border-color,color] duration-150",
                  numeric === value
                    ? "border-primary/40 bg-accent text-accent-foreground"
                    : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                )}
              >
                {value.toLocaleString("id-ID")}
              </button>
            ))}
          </div>

          <Field
            label="Nominal"
            htmlFor="amount"
            hint={
              valid ? formatCurrency(numeric) : "Bilangan bulat lebih dari 0"
            }
          >
            <div className="flex items-center gap-2 rounded-md border border-input bg-foreground/[0.04] px-3 focus-within:border-primary">
              <span className="font-mono text-lg text-muted-foreground">
                Rp
              </span>
              <input
                id="amount"
                value={amount}
                onChange={(event) =>
                  setAmount(event.target.value.replace(/[^\d]/g, ""))
                }
                inputMode="numeric"
                aria-invalid={valid ? undefined : true}
                className="h-12 w-full bg-transparent font-mono text-2xl tabular-nums outline-none"
                required
              />
            </div>
          </Field>

          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <Field label="Referensi" htmlFor="reference">
              <Input
                id="reference"
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                placeholder="ORDER-4718"
                maxLength={120}
                autoComplete="off"
              />
            </Field>
            <Field label="Berlaku">
              <Select
                value={expiry}
                onChange={(event) => setExpiry(event.target.value)}
              >
                {EXPIRY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Button type="submit" size="lg" disabled={isBusy || !valid}>
            Buat tagihan
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
