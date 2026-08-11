import { useState, type FormEvent } from "react";
import { CaretRight } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useConsole } from "@/lib/console-store";
import type {
  AuthStage,
  ProviderId,
  ProviderSnapshot,
  SelectOption,
} from "@/lib/types";
import {
  completeShopeeLogin,
  requestProviderOtp,
  selectShopeeStore,
  verifyProviderOtp,
} from "@/server/functions";

const STAGE_FLOW: Record<
  ProviderId,
  Array<{ stage: AuthStage; label: string }>
> = {
  gopay: [
    { stage: "signed-out", label: "Nomor" },
    { stage: "otp", label: "OTP" },
    { stage: "ready", label: "Siap" },
  ],
  shopee: [
    { stage: "signed-out", label: "Nomor" },
    { stage: "otp", label: "OTP" },
    { stage: "merchant", label: "Merchant" },
    { stage: "store", label: "Store" },
    { stage: "ready", label: "Siap" },
  ],
};

/** A drawn rail, not a filled progress bar. Coral marks only the current step. */
function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="flex items-center gap-1.5" aria-label="Tahap login">
      {steps.map((step, index) => {
        const state =
          index < current ? "done" : index === current ? "current" : "todo";
        return (
          <li key={step} className="flex items-center gap-1.5">
            <span
              aria-current={state === "current" ? "step" : undefined}
              className={
                state === "current"
                  ? "font-mono text-[0.625rem] uppercase tracking-[0.08em] text-primary"
                  : state === "done"
                    ? "font-mono text-[0.625rem] uppercase tracking-[0.08em] text-foreground/70"
                    : "font-mono text-[0.625rem] uppercase tracking-[0.08em] text-muted-foreground/60"
              }
            >
              {step}
            </span>
            {index < steps.length - 1 ? (
              <CaretRight
                aria-hidden="true"
                className="size-2.5 text-muted-foreground/40"
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function OptionSelect({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label}>
      <Select
        value={value || options[0]?.id || ""}
        onChange={(event) => onChange(event.target.value)}
        disabled={options.length === 0}
        required
      >
        {options.length === 0 ? <option value="">Kosong</option> : null}
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
            {option.detail ? ` - ${option.detail}` : ""}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** The pre-`ready` login flow for the active provider. */
export function LoginPanel({ provider }: { provider: ProviderSnapshot }) {
  const { pendingAction, isBusy, run } = useConsole();
  const [phone, setPhone] = useState("");
  const [channel, setChannel] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [merchantId, setMerchantId] = useState("");
  const [storeId, setStoreId] = useState("");
  const isShopee = provider.id === "shopee";

  const steps = STAGE_FLOW[provider.id];
  const stepIndex = Math.max(
    0,
    steps.findIndex((step) => step.stage === provider.authStage),
  );

  const submitOtpRequest = (event: FormEvent) => {
    event.preventDefault();
    void run(
      `request-otp-${provider.id}`,
      () =>
        requestProviderOtp({
          data: {
            providerId: provider.id,
            phoneNumber: phone,
            channel: isShopee && channel ? Number(channel) : undefined,
            password: isShopee && password ? password : undefined,
          },
        }),
      "OTP dikirim",
    );
  };

  const submitOtpVerify = async (event: FormEvent) => {
    event.preventDefault();
    const ok = await run(
      `verify-otp-${provider.id}`,
      () => verifyProviderOtp({ data: { providerId: provider.id, otp } }),
      "OTP terverifikasi",
    );
    if (ok) setOtp("");
  };

  const submitMerchant = (event: FormEvent) => {
    event.preventDefault();
    const selected = merchantId || provider.merchants[0]?.id;
    if (!selected) return;
    void run(
      "complete-shopee-login",
      () =>
        completeShopeeLogin({
          data: { merchantId: selected, storeId: storeId || undefined },
        }),
      "Merchant dipilih",
    );
  };

  const submitStore = (event: FormEvent) => {
    event.preventDefault();
    const selected = storeId || provider.stores[0]?.id;
    if (!selected) return;
    void run(
      "select-shopee-store",
      () => selectShopeeStore({ data: { storeId: selected } }),
      "Store aktif",
    );
  };

  return (
    <Card aria-label={`Login ${provider.label}`}>
      <CardHeader>
        <CardTitle>Masuk ke {provider.label}</CardTitle>
        <span className="font-mono text-[0.625rem] uppercase tracking-[0.08em] text-muted-foreground">
          {steps[stepIndex]?.label}
        </span>
      </CardHeader>
      <CardContent>
        <Stepper steps={steps.map((step) => step.label)} current={stepIndex} />

        {provider.authStage === "signed-out" ? (
          <form className="flex flex-col gap-3.5" onSubmit={submitOtpRequest}>
            <Field label="Nomor HP" htmlFor="login-phone">
              <Input
                id="login-phone"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                inputMode="tel"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="08xxxxxxxxxx"
                maxLength={32}
                required
              />
            </Field>
            {isShopee ? (
              <>
                <Field label="Password" htmlFor="login-password">
                  <Input
                    id="login-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    type="password"
                    autoComplete="current-password"
                    placeholder="Kosongkan bila akun tanpa password"
                    maxLength={128}
                  />
                </Field>
                <Field label="Kanal OTP">
                  <Select
                    value={channel}
                    onChange={(event) => setChannel(event.target.value)}
                  >
                    <option value="">Otomatis</option>
                    <option value="3">WhatsApp</option>
                    <option value="1">SMS</option>
                    <option value="2">Telepon</option>
                  </Select>
                </Field>
              </>
            ) : null}
            <div className="flex justify-end">
              <Button type="submit" disabled={isBusy || phone.trim().length < 8}>
                Kirim OTP
              </Button>
            </div>
          </form>
        ) : null}

        {provider.authStage === "otp" ? (
          <form className="flex flex-col gap-3.5" onSubmit={submitOtpVerify}>
            <Field label="Kode OTP" htmlFor="login-otp">
              <Input
                id="login-otp"
                className="h-11 text-center font-mono text-lg tracking-[0.4em]"
                value={otp}
                onChange={(event) =>
                  setOtp(event.target.value.replace(/\s/g, ""))
                }
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                minLength={4}
                maxLength={12}
                autoFocus
                required
              />
            </Field>
            <div className="flex justify-end">
              <Button type="submit" disabled={isBusy || otp.length < 4}>
                Verifikasi
              </Button>
            </div>
          </form>
        ) : null}

        {provider.authStage === "merchant" ? (
          <form className="flex flex-col gap-3.5" onSubmit={submitMerchant}>
            <OptionSelect
              label="Merchant"
              options={provider.merchants}
              value={merchantId}
              onChange={setMerchantId}
            />
            <div className="flex justify-end">
              <Button
                type="submit"
                disabled={isBusy || provider.merchants.length === 0}
              >
                Lanjut
              </Button>
            </div>
          </form>
        ) : null}

        {provider.authStage === "store" ? (
          <form className="flex flex-col gap-3.5" onSubmit={submitStore}>
            {provider.stores.length === 0 ? (
              <p className="text-xs leading-relaxed text-muted-foreground">
                Merchant ini belum mengembalikan store. Jalankan Discovery dari
                kartu sesi untuk memuat ulang, atau ganti merchant.
              </p>
            ) : null}
            <OptionSelect
              label="Store"
              options={provider.stores}
              value={storeId}
              onChange={setStoreId}
            />
            <div className="flex justify-end">
              <Button
                type="submit"
                disabled={isBusy || provider.stores.length === 0}
              >
                Gunakan store
              </Button>
            </div>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}
