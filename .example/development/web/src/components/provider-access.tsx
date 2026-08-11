import { useState, type FormEvent } from "react";
import type {
  AuthStage,
  ProviderId,
  ProviderSnapshot,
  SelectOption,
} from "../lib/lab-types";
import {
  completeShopeeLogin,
  logoutProvider,
  refreshDiscovery,
  refreshProviderSession,
  requestProviderOtp,
  selectGopayMerchant,
  selectShopeeStore,
  switchShopeeMerchant,
  verifyProviderOtp,
} from "../server/functions";
import {
  Badge,
  Button,
  Card,
  CardHead,
  Field,
  MetaList,
  Select,
  Stepper,
  TextInput,
  formatDateTime,
  shortId,
  type MetaEntry,
  type RunLabAction,
} from "./lab-ui";

interface ProviderAccessProps {
  provider: ProviderSnapshot;
  pendingAction?: string;
  runAction: RunLabAction;
}

/**
 * GoPay never reaches the merchant/store stages - its scope is chosen from the
 * session card after login - so the rail is provider-shaped, not five fixed
 * steps.
 */
const stageFlow: Record<ProviderId, Array<{ stage: AuthStage; label: string }>> =
  {
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

/** One card at a time: the login flow, or the live session. Never both. */
export function ProviderAccess(props: ProviderAccessProps) {
  return props.provider.authStage === "ready" ? (
    <SessionCard {...props} />
  ) : (
    <LoginCard {...props} />
  );
}

function LoginCard({ provider, pendingAction, runAction }: ProviderAccessProps) {
  const [phoneNumber, setPhoneNumber] = useState("");
  const [channel, setChannel] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [merchantId, setMerchantId] = useState("");
  const [storeId, setStoreId] = useState("");
  const busy = pendingAction !== undefined;
  const isShopee = provider.id === "shopee";

  const steps = stageFlow[provider.id];
  const stepIndex = Math.max(
    0,
    steps.findIndex((step) => step.stage === provider.authStage),
  );

  const handleRequestOtp = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await runAction(
      `request-otp-${provider.id}`,
      () =>
        requestProviderOtp({
          data: {
            providerId: provider.id,
            phoneNumber,
            channel: isShopee && channel ? Number(channel) : undefined,
            password: isShopee && password ? password : undefined,
          },
        }),
      "OTP dikirim",
    );
  };

  const handleVerifyOtp = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const ok = await runAction(
      `verify-otp-${provider.id}`,
      () => verifyProviderOtp({ data: { providerId: provider.id, otp } }),
      "OTP terverifikasi",
    );
    if (ok) setOtp("");
  };

  const handleCompleteLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const selected = merchantId || provider.merchants[0]?.id;
    if (!selected) return;
    await runAction(
      "complete-shopee-login",
      () =>
        completeShopeeLogin({
          data: { merchantId: selected, storeId: storeId || undefined },
        }),
      "Merchant dipilih",
    );
  };

  const handleChooseStore = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const selected = storeId || provider.stores[0]?.id;
    if (!selected) return;
    await runAction(
      "select-shopee-store",
      () => selectShopeeStore({ data: { storeId: selected } }),
      "Store aktif",
    );
  };

  return (
    <Card aria-label={`Login ${provider.label}`}>
      <CardHead title="Login" />

      <div className="card__body">
        <Stepper
          steps={steps.map((step) => step.label)}
          current={stepIndex}
          label="Tahap login"
        />

        {provider.authStage === "signed-out" ? (
          <>
            <form
              className="form"
              onSubmit={(event) => void handleRequestOtp(event)}
            >
              <Field label="Nomor HP">
                <TextInput
                  value={phoneNumber}
                  onChange={(event) => setPhoneNumber(event.target.value)}
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
                  <Field label="Password">
                    <TextInput
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
              <div className="form__footer">
                <Button
                  type="submit"
                  busy={pendingAction === `request-otp-${provider.id}`}
                  disabled={busy || phoneNumber.trim().length < 8}
                >
                  Kirim OTP
                </Button>
              </div>
            </form>
          </>
        ) : null}

        {provider.authStage === "otp" ? (
          <form
            className="form"
            onSubmit={(event) => void handleVerifyOtp(event)}
          >
            <Field label="Kode OTP">
              <TextInput
                className="input--display input--otp"
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
            <div className="form__footer">
              <Button
                type="submit"
                busy={pendingAction === `verify-otp-${provider.id}`}
                disabled={busy || otp.length < 4}
              >
                Verifikasi
              </Button>
            </div>
          </form>
        ) : null}

        {provider.authStage === "merchant" ? (
          <form
            className="form"
            onSubmit={(event) => void handleCompleteLogin(event)}
          >
            <OptionField
              label="Merchant"
              options={provider.merchants}
              value={merchantId}
              onChange={setMerchantId}
            />
            <div className="form__footer">
              <Button
                type="submit"
                busy={pendingAction === "complete-shopee-login"}
                disabled={busy || provider.merchants.length === 0}
              >
                Lanjut
              </Button>
            </div>
          </form>
        ) : null}

        {provider.authStage === "store" ? (
          <form
            className="form"
            onSubmit={(event) => void handleChooseStore(event)}
          >
            {provider.stores.length === 0 ? (
              <p className="note">
                Merchant ini belum mengembalikan store apa pun. Jalankan
                Discovery untuk memuat ulang daftar store, atau keluar dan pilih
                merchant lain.
              </p>
            ) : null}
            <OptionField
              label="Store"
              options={provider.stores}
              value={storeId}
              onChange={setStoreId}
            />
            <div className="form__footer">
              <Button
                type="submit"
                busy={pendingAction === "select-shopee-store"}
                disabled={busy || provider.stores.length === 0}
              >
                Gunakan store
              </Button>
            </div>
          </form>
        ) : null}

        {/* An authenticated-but-incomplete session (no store yet) still needs a
            way out: re-run discovery, or sign out. Without these the card is a
            dead end whenever discovery returns an empty store list. */}
        {provider.authenticated ? (
          <div className="actions">
            <Button
              tone="outline"
              busy={pendingAction === `discovery-${provider.id}`}
              disabled={busy}
              onClick={() =>
                void runAction(
                  `discovery-${provider.id}`,
                  () => refreshDiscovery({ data: { providerId: provider.id } }),
                  "Discovery diperbarui",
                )
              }
            >
              Discovery
            </Button>
            <Button
              tone="destructive"
              busy={pendingAction === `logout-${provider.id}`}
              disabled={busy}
              onClick={() => {
                if (
                  !window.confirm(
                    `Hapus sesi ${provider.label} dan payment lokalnya?`,
                  )
                )
                  return;
                void runAction(
                  `logout-${provider.id}`,
                  () => logoutProvider({ data: { providerId: provider.id } }),
                  "Sesi dihapus",
                );
              }}
            >
              Keluar
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function SessionCard({
  provider,
  pendingAction,
  runAction,
}: ProviderAccessProps) {
  const [merchantId, setMerchantId] = useState("");
  const [storeId, setStoreId] = useState("");
  const busy = pendingAction !== undefined;
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

  const entries: MetaEntry[] = [
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
    {
      key: "Scope",
      value: scopeText,
      mono: true,
      title: provider.scope?.merchantId,
    },
    { key: "QRIS", value: provider.hasStaticQris ? "Terikat" : "Belum ada" },
  ];

  return (
    <Card aria-label="Sesi provider">
      <CardHead
        title="Sesi"
        action={
          <Badge tone={expired ? "danger" : "success"}>
            {expired ? "Kedaluwarsa" : "Aktif"}
          </Badge>
        }
      />

      <div className="card__body">
        <MetaList entries={entries} label="Detail sesi" />

        {provider.id === "gopay" && provider.merchants.length > 0 ? (
          <form
            className="form__inline"
            onSubmit={(event) => {
              event.preventDefault();
              const selected =
                merchantId ||
                provider.selectedMerchantId ||
                provider.merchants[0]?.id;
              if (!selected) return;
              void runAction(
                "select-gopay-merchant",
                () => selectGopayMerchant({ data: { merchantId: selected } }),
                "Scope diperbarui",
              );
            }}
          >
            <OptionField
              label="Merchant"
              options={provider.merchants}
              value={merchantId || provider.selectedMerchantId || ""}
              onChange={setMerchantId}
            />
            <Button
              type="submit"
              tone="outline"
              busy={pendingAction === "select-gopay-merchant"}
              disabled={busy}
            >
              Terapkan
            </Button>
          </form>
        ) : null}

        {provider.id === "shopee" && provider.merchants.length > 1 ? (
          <form
            className="form__inline"
            onSubmit={(event) => {
              event.preventDefault();
              const selected =
                merchantId ||
                provider.selectedMerchantId ||
                provider.merchants[0]?.id;
              if (!selected) return;
              void runAction(
                "switch-shopee-merchant",
                () => switchShopeeMerchant({ data: { merchantId: selected } }),
                "Merchant diganti",
              );
            }}
          >
            <OptionField
              label="Merchant"
              options={provider.merchants}
              value={merchantId || provider.selectedMerchantId || ""}
              onChange={setMerchantId}
            />
            <Button
              type="submit"
              tone="outline"
              busy={pendingAction === "switch-shopee-merchant"}
              disabled={busy}
            >
              Ganti
            </Button>
          </form>
        ) : null}

        {provider.id === "shopee" && provider.stores.length > 0 ? (
          <form
            className="form__inline"
            onSubmit={(event) => {
              event.preventDefault();
              const selected =
                storeId || provider.selectedStoreId || provider.stores[0]?.id;
              if (!selected) return;
              void runAction(
                "select-shopee-store",
                () => selectShopeeStore({ data: { storeId: selected } }),
                "Store diperbarui",
              );
            }}
          >
            <OptionField
              label="Store"
              options={provider.stores}
              value={storeId || provider.selectedStoreId || ""}
              onChange={setStoreId}
            />
            <Button
              type="submit"
              tone="outline"
              busy={pendingAction === "select-shopee-store"}
              disabled={busy}
            >
              Terapkan
            </Button>
          </form>
        ) : null}

        <div className="actions actions--split">
          <div className="actions">
            <Button
              tone="outline"
              busy={pendingAction === `discovery-${provider.id}`}
              disabled={busy}
              onClick={() =>
                void runAction(
                  `discovery-${provider.id}`,
                  () => refreshDiscovery({ data: { providerId: provider.id } }),
                  "Discovery diperbarui",
                )
              }
            >
              Discovery
            </Button>
            <Button
              tone="outline"
              busy={pendingAction === `refresh-session-${provider.id}`}
              disabled={busy}
              onClick={() =>
                void runAction(
                  `refresh-session-${provider.id}`,
                  () =>
                    refreshProviderSession({
                      data: { providerId: provider.id },
                    }),
                  "Sesi diperiksa",
                )
              }
            >
              Periksa sesi
            </Button>
          </div>
          <Button
            tone="destructive"
            busy={pendingAction === `logout-${provider.id}`}
            disabled={busy}
            onClick={() => {
              if (
                !window.confirm(
                  `Hapus sesi ${provider.label} dan payment lokalnya?`,
                )
              )
                return;
              void runAction(
                `logout-${provider.id}`,
                () => logoutProvider({ data: { providerId: provider.id } }),
                "Sesi dihapus",
              );
            }}
          >
            Keluar
          </Button>
        </div>
      </div>
    </Card>
  );
}

function OptionField({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  value: string;
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
