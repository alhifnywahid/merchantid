import { useState, type FormEvent } from "react";
import { ArrowsClockwise, ShieldCheck, SignOut } from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { useConsole } from "@/lib/console-store";
import { formatDateTime, shortId } from "@/lib/format";
import type { ProviderSnapshot, SelectOption } from "@/lib/types";
import {
  logoutProvider,
  refreshDiscovery,
  refreshProviderSession,
  selectGopayMerchant,
  selectShopeeStore,
  switchShopeeMerchant,
} from "@/server/functions";

function ScopeForm({
  label,
  options,
  current,
  actionId,
  submit,
}: {
  label: string;
  options: SelectOption[];
  current?: string;
  actionId: string;
  submit: (id: string) => void;
}) {
  const { pendingAction, isBusy } = useConsole();
  const [value, setValue] = useState("");
  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        const selected = value || current || options[0]?.id;
        if (selected) submit(selected);
      }}
    >
      <Field label={label} className="flex-1">
        <Select
          value={value || current || ""}
          onChange={(event) => setValue(event.target.value)}
        >
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
              {option.detail ? ` — ${option.detail}` : ""}
            </option>
          ))}
        </Select>
      </Field>
      <Button
        type="submit"
        variant="outline"
        disabled={isBusy}
        className={pendingAction === actionId ? "opacity-60" : undefined}
      >
        Terapkan
      </Button>
    </form>
  );
}

/** The live-session card: scope summary, scope controls, session maintenance. */
export function SessionPanel({ provider }: { provider: ProviderSnapshot }) {
  const { pendingAction, isBusy, run } = useConsole();
  const expired =
    provider.sessionExpiresAt !== undefined &&
    provider.sessionExpiresAt <= Date.now();

  const scopeText = provider.scope
    ? [
        provider.scope.provider,
        provider.scope.accountId && shortId(provider.scope.accountId),
        shortId(provider.scope.merchantId),
      ]
        .filter(Boolean)
        .join(" / ")
    : "Belum dipilih";

  const rows: Array<{ key: string; value: string; mono?: boolean }> = [
    {
      key: "Fingerprint",
      value: shortId(provider.sessionFingerprint),
      mono: true,
    },
    {
      key: "Kedaluwarsa",
      value: formatDateTime(provider.sessionExpiresAt),
      mono: true,
    },
    { key: "Scope", value: scopeText, mono: true },
    { key: "QRIS", value: provider.hasStaticQris ? "Terikat" : "Belum ada" },
  ];

  return (
    <Card aria-label="Sesi provider">
      <CardHeader>
        <CardTitle>Sesi {provider.label}</CardTitle>
        <Badge variant={expired ? "danger" : "success"}>
          {expired ? "Kedaluwarsa" : "Aktif"}
        </Badge>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-1 gap-y-2 sm:grid-cols-2 sm:gap-x-4">
          {rows.map((row) => (
            <div
              key={row.key}
              className="flex items-baseline justify-between gap-3 border-b border-dashed border-border pb-2"
            >
              <dt className="text-[0.6875rem] uppercase tracking-[0.06em] text-muted-foreground">
                {row.key}
              </dt>
              <dd
                className={
                  row.mono
                    ? "truncate font-mono text-xs tabular-nums"
                    : "truncate text-xs"
                }
                title={row.value}
              >
                {row.value}
              </dd>
            </div>
          ))}
        </dl>

        {provider.id === "gopay" && provider.merchants.length > 0 ? (
          <ScopeForm
            label="Outlet aktif"
            options={provider.merchants}
            current={provider.selectedMerchantId}
            actionId="select-gopay-merchant"
            submit={(id) =>
              void run(
                "select-gopay-merchant",
                () => selectGopayMerchant({ data: { merchantId: id } }),
                "Scope diperbarui",
              )
            }
          />
        ) : null}

        {provider.id === "shopee" && provider.merchants.length > 1 ? (
          <ScopeForm
            label="Merchant"
            options={provider.merchants}
            current={provider.selectedMerchantId}
            actionId="switch-shopee-merchant"
            submit={(id) =>
              void run(
                "switch-shopee-merchant",
                () => switchShopeeMerchant({ data: { merchantId: id } }),
                "Merchant diganti",
              )
            }
          />
        ) : null}

        {provider.id === "shopee" && provider.stores.length > 0 ? (
          <ScopeForm
            label="Store"
            options={provider.stores}
            current={provider.selectedStoreId}
            actionId="select-shopee-store"
            submit={(id) =>
              void run(
                "select-shopee-store",
                () => selectShopeeStore({ data: { storeId: id } }),
                "Store diperbarui",
              )
            }
          />
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              disabled={isBusy}
              className={
                pendingAction === `discovery-${provider.id}`
                  ? "opacity-60"
                  : undefined
              }
              onClick={() =>
                void run(
                  `discovery-${provider.id}`,
                  () => refreshDiscovery({ data: { providerId: provider.id } }),
                  "Discovery diperbarui",
                )
              }
            >
              <ArrowsClockwise aria-hidden="true" className="size-3.5" />
              Discovery
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={isBusy}
              className={
                pendingAction === `refresh-session-${provider.id}`
                  ? "opacity-60"
                  : undefined
              }
              onClick={() =>
                void run(
                  `refresh-session-${provider.id}`,
                  () =>
                    refreshProviderSession({
                      data: { providerId: provider.id },
                    }),
                  "Sesi diperiksa",
                )
              }
            >
              <ShieldCheck aria-hidden="true" className="size-3.5" />
              Periksa sesi
            </Button>
          </div>
          <Button
            variant="destructive"
            size="sm"
            disabled={isBusy}
            className={
              pendingAction === `logout-${provider.id}`
                ? "opacity-60"
                : undefined
            }
            onClick={() => {
              if (
                !window.confirm(
                  `Hapus sesi ${provider.label} dan payment lokalnya?`,
                )
              )
                return;
              void run(
                `logout-${provider.id}`,
                () => logoutProvider({ data: { providerId: provider.id } }),
                "Sesi dihapus",
              );
            }}
          >
            <SignOut aria-hidden="true" className="size-3.5" />
            Keluar
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
