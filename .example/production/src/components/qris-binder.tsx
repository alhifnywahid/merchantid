import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { useConsole } from "@/lib/console-store";
import type { ProviderSnapshot } from "@/lib/types";
import { saveStaticQris } from "@/server/functions";

/**
 * The QRIS source step. GoPay derives its static payload from the selected
 * outlet during discovery, so there is nothing to enter — the operator only
 * needs to pick an outlet. Shopee has no discovery endpoint for the store QRIS,
 * so its payload is pasted once and validated server-side.
 */
export function QrisBinder({ provider }: { provider: ProviderSnapshot }) {
  const { isBusy, run } = useConsole();
  const [payload, setPayload] = useState("");

  if (provider.id === "gopay") {
    return (
      <Card aria-label="Sumber QRIS">
        <CardHeader>
          <CardTitle>Sumber QRIS</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Outlet aktif belum menyertakan QRIS statis. Pilih outlet lain di
            kartu sesi, atau jalankan Discovery untuk memuat ulang QRIS-nya.
          </p>
        </CardContent>
      </Card>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const ok = await run(
      "save-qris-shopee",
      () => saveStaticQris({ data: { providerId: "shopee", payload } }),
      "QRIS terikat ke scope",
    );
    if (ok) setPayload("");
  };

  return (
    <Card aria-label="Sumber QRIS">
      <CardHeader>
        <CardTitle>Sumber QRIS</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-3.5" onSubmit={submit}>
          <Field
            label="Payload QRIS statis"
            hint="Shopee belum punya endpoint discovery QRIS, jadi payload store diisi manual sekali."
          >
            <Textarea
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
          <div className="flex justify-end">
            <Button
              type="submit"
              disabled={isBusy || payload.trim().length < 16}
            >
              Simpan QRIS
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
