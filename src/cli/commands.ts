import { ConfigError } from "../core/errors.js";
import type { SessionState, StoredMerchant } from "../core/types.js";
import { GopayProvider } from "../providers/gopay/gopayProvider.js";
import { isValidQrisChecksum, staticToDynamicQris } from "../qris/qris.js";
import { ShopeeProvider } from "../providers/shopee/shopeeProvider.js";
import type {
  ShopeeMerchantSummary,
  ShopeeSession,
  ShopeeStore,
} from "../providers/shopee/types.js";
import { createConsoleLogger } from "../utils/logger.js";
import type {
  CliConfig,
  GopayCliProviderConfig,
  ShopeeCliProviderConfig,
} from "./config.js";
import {
  readConfig,
  resolveConfigPath,
  updateConfig,
  updateProviderConfig,
} from "./config.js";
import { prompt, promptRequired } from "./prompt.js";

type CliProviderId = "gopay" | "shopee";

const PROVIDERS: readonly CliProviderId[] = ["gopay", "shopee"];

export function isCliProviderId(
  value: string | undefined,
): value is CliProviderId {
  return value === "gopay" || value === "shopee";
}

/** Interactive provider-aware OTP login. */
export async function loginCommand(requestedProvider?: string): Promise<void> {
  const configPath = resolveConfigPath();
  const config = readConfig(configPath);
  const providerId = await chooseLoginProvider(config, requestedProvider);
  if (providerId === "gopay") {
    await loginGopay(config, configPath);
  } else {
    await loginShopee(config, configPath);
  }
  if (!config.defaultProvider) {
    updateConfig({ defaultProvider: providerId }, configPath);
  }
}

async function loginGopay(
  config: CliConfig,
  configPath: string,
): Promise<void> {
  const existing = config.providers.gopay ?? {};
  const phone = await promptRequired(
    "Phone number (without country code, e.g. 81234567890): ",
  );
  const countryCode = (await prompt("Country code [62]: ")) || "62";

  const gopay = new GopayProvider({
    logger: createConsoleLogger("warn"),
    deviceId: existing.session?.deviceId,
    onTokenRefreshed: async (session) => {
      updateProviderConfig("gopay", { session }, configPath);
    },
  });

  process.stdout.write("Requesting GoPay OTP...\n");
  const otpResult = await gopay.requestOtp(phone, countryCode);
  if (debugEnabled()) {
    process.stderr.write(
      `[debug] GoPay OTP challenge received: ${otpResult.otpToken ? "yes" : "no"}\n`,
    );
  }
  if (!otpResult.otpToken) {
    throw new ConfigError("GoPay did not return an OTP challenge token");
  }

  const otp = await promptRequired("Enter the OTP you received: ");
  await gopay.verifyOtp({
    otp,
    otpToken: otpResult.otpToken,
    phoneNumber: phone,
    countryCode,
  });

  const session = gopay.exportSession();
  const merchants = await collectGopayProviders(gopay);
  updateProviderConfig(
    "gopay",
    {
      session,
      merchants,
      defaultMerchantId:
        chooseKnownId(
          merchants.map((merchant) => merchant.id),
          existing.defaultMerchantId,
        ) ?? merchants[0]?.id,
    } satisfies GopayCliProviderConfig,
    configPath,
  );

  process.stdout.write(
    `\nGoPay login successful. Config saved to ${configPath}\n`,
  );
  process.stdout.write(`Merchants found: ${merchants.length}\n`);
}

async function collectGopayProviders(
  gopay: GopayProvider,
): Promise<StoredMerchant[]> {
  const merchants = await gopay.listMerchants();
  if (merchants.length > 0) return merchants;

  const profile = await gopay.getMerchantProfile().catch(() => undefined);
  if (!profile) return [];
  return [
    {
      id: profile.id,
      merchantName: profile.merchantName,
      outletName: profile.outletName,
      phone: profile.phone,
      email: profile.email,
      outlets: profile.outlets,
      qrString: profile.outlets.find((outlet) => outlet.qrString)?.qrString,
      raw: profile.raw,
    },
  ];
}

async function loginShopee(
  config: CliConfig,
  configPath: string,
): Promise<void> {
  const existing = config.providers.shopee ?? {};
  const phone = await promptRequired(
    "Phone number in international format (e.g. 6281234567890): ",
  );
  // Password-protected accounts never receive an OTP until the password step
  // is accepted, so ask for it up front. Leaving it blank is valid: accounts
  // without a password skip the second factor entirely.
  const password = await prompt(
    "Account password (leave blank if the account has none): ",
  );

  const shopee = new ShopeeProvider({
    staticQris: existing.staticQris,
    staticQrisScope: existing.staticQrisScope,
    logger: createConsoleLogger("warn"),
    // A device-risk report can be supplied programmatically via
    // `ShopeeProvider({ deviceReport })`. The CLI does not ship one: Shopee
    // grades the report and may withhold OTP delivery for a request it does
    // not recognise. If no code arrives, see `importSession()` in the README
    // for adopting a session from a normal browser login instead.
    onSessionUpdated: async (session) => {
      updateProviderConfig("shopee", { session }, configPath);
    },
  });

  process.stdout.write("Requesting Shopee OTP...\n");
  const challenge = await shopee.requestOtp(phone, {
    password: password || undefined,
  });
  if (debugEnabled()) {
    process.stderr.write(
      `[debug] Shopee OTP channel ${challenge.channel}; available channels: ${challenge.availableChannels.join(",")}\n`,
    );
  }
  const otp = await promptRequired("Enter the OTP you received: ");
  const verification = await shopee.verifyOtp({ challenge, otp });
  const merchantId = await chooseShopeeMerchant(
    verification.merchants,
    existing.session?.merchant.id,
  );
  const preferredStoreId =
    existing.session?.merchant.id === merchantId
      ? existing.session.storeId
      : undefined;
  let session = await shopee.completeLogin({ verification, merchantId });
  const preferredStoreAvailable =
    preferredStoreId !== undefined &&
    session.stores.some((store) => store.id === preferredStoreId);
  if (preferredStoreAvailable && session.storeId !== preferredStoreId) {
    session = await shopee.selectStore(preferredStoreId);
  } else if (
    session.stores.length > 0 &&
    (!session.storeId ||
      (preferredStoreId !== undefined && !preferredStoreAvailable))
  ) {
    const storeId = await chooseShopeeStore(session.stores);
    session = await shopee.selectStore(storeId);
  }

  updateProviderConfig(
    "shopee",
    { session } satisfies ShopeeCliProviderConfig,
    configPath,
  );
  process.stdout.write(
    `\nShopee login successful. Config saved to ${configPath}\n`,
  );
  process.stdout.write(
    `Merchant: ${session.merchant.id}:${session.merchant.name}; stores: ${session.stores.length}\n`,
  );
  if (!hasShopeeStaticQris(existing, session)) {
    process.stdout.write(
      "No static QRIS configured for the selected store. Run `merchid set-qris --provider shopee` before creating QR payments.\n",
    );
  }
}

async function chooseLoginProvider(
  config: CliConfig,
  requested?: string,
): Promise<CliProviderId> {
  if (requested !== undefined) {
    if (!isCliProviderId(requested)) {
      throw new ConfigError(`Unsupported CLI provider: ${requested}`);
    }
    return requested;
  }
  if (isCliProviderId(config.defaultProvider)) return config.defaultProvider;
  const answer = (await prompt("Provider [gopay/shopee] [gopay]: ")) || "gopay";
  if (!isCliProviderId(answer)) {
    throw new ConfigError(`Unsupported CLI provider: ${answer}`);
  }
  return answer;
}

async function chooseShopeeMerchant(
  merchants: readonly ShopeeMerchantSummary[],
  preferredId?: string,
): Promise<string> {
  if (
    preferredId &&
    merchants.some(
      (merchant) =>
        merchant.id === preferredId && merchant.isActive && !merchant.isBanned,
    )
  ) {
    return preferredId;
  }
  const usable = merchants.filter(
    (merchant) => merchant.isActive && !merchant.isBanned,
  );
  if (usable.length === 1) return usable[0]!.id;

  process.stdout.write(
    `${JSON.stringify(
      usable.map((merchant) => ({ id: merchant.id, name: merchant.name })),
      null,
      2,
    )}\n`,
  );
  const selected = await promptRequired("Shopee merchant id: ");
  if (!usable.some((merchant) => merchant.id === selected)) {
    throw new ConfigError("Selected Shopee merchant is not accessible");
  }
  return selected;
}

async function chooseShopeeStore(
  stores: readonly ShopeeStore[],
): Promise<string> {
  if (stores.length === 1) return stores[0]!.id;
  process.stdout.write(
    `${JSON.stringify(
      stores.map((store) => ({
        id: store.id,
        name: store.name,
        status: store.status,
      })),
      null,
      2,
    )}\n`,
  );
  const selected = await promptRequired("Shopee store id: ");
  if (!stores.some((store) => store.id === selected)) {
    throw new ConfigError("Selected Shopee store is not accessible");
  }
  return selected;
}

/** Print one stored provider session, masking every credential by default. */
export function sessionCommand(
  requestedProvider?: string,
  reveal = false,
): void {
  const config = readConfig();
  const providerId = resolveConfiguredProvider(config, requestedProvider);
  if (!providerId) {
    process.stdout.write(
      "No provider session stored. Run `merchid login` first.\n",
    );
    return;
  }

  const session =
    providerId === "gopay"
      ? config.providers.gopay?.session
      : config.providers.shopee?.session;
  if (!session) {
    process.stdout.write(
      `No ${providerId} session stored. Run \`merchid login --provider ${providerId}\` first.\n`,
    );
    return;
  }

  const view = reveal
    ? session
    : providerId === "gopay"
      ? maskGopaySession(session as SessionState)
      : maskShopeeSession(session as ShopeeSession);
  process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
  if (!reveal) {
    process.stderr.write(
      "Credentials are masked. Re-run with --reveal only in a private terminal.\n",
    );
  }
}

function maskGopaySession(session: SessionState): unknown {
  return {
    ...session,
    tokens: {
      ...session.tokens,
      accessToken: maskSecret(session.tokens.accessToken),
      refreshToken: maskSecret(session.tokens.refreshToken),
    },
    // The device id is bound to the session and is replayable alongside it.
    deviceId: session.deviceId ? maskSecret(session.deviceId) : undefined,
  };
}

function maskShopeeSession(session: ShopeeSession): unknown {
  return {
    ...session,
    cookies: session.cookies.map((cookie) => ({
      ...cookie,
      value: maskSecret(cookie.value),
    })),
    // `switchCredential` is reusable account-session material: it can mint a
    // merchant token for any of the account's merchants without a second OTP.
    // Printing it while the command claims "credentials are masked" would be a
    // lie, so it is masked field by field.
    switchCredential: session.switchCredential
      ? {
          tocNonce: maskSecret(session.switchCredential.tocNonce),
          spcClientId: maskSecret(session.switchCredential.spcClientId),
          deviceFingerprint: maskSecret(
            session.switchCredential.deviceFingerprint,
          ),
        }
      : undefined,
  };
}

function maskSecret(secret: string | undefined): string {
  if (!secret) return "";
  if (secret.length <= 12) return "***";
  return `${secret.slice(0, 6)}...${secret.slice(-4)} (${secret.length} chars)`;
}

/** List merchant and outlet/store metadata without printing QR payloads. */
export function merchantsCommand(requestedProvider?: string): void {
  const config = readConfig();
  const providerId = resolveConfiguredProvider(config, requestedProvider);
  if (!providerId) {
    process.stdout.write(
      "No provider configured. Run `merchid login` first.\n",
    );
    return;
  }

  if (providerId === "gopay") {
    const provider = config.providers.gopay ?? {};
    const view = (provider.merchants ?? []).map((merchant) => ({
      id: merchant.id,
      merchantName: merchant.merchantName,
      default: merchant.id === provider.defaultMerchantId,
      outlets: merchant.outlets.map((outlet) => ({
        id: outlet.popId,
        name: outlet.name,
        hasQris: Boolean(outlet.qrString),
      })),
    }));
    process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
    return;
  }

  const provider = config.providers.shopee ?? {};
  const session = provider.session;
  const view = session
    ? [
        {
          id: session.merchant.id,
          merchantName: session.merchant.name,
          stores: session.stores.map((store) => ({
            ...store,
            default: store.id === session.storeId,
          })),
          hasQris: hasShopeeStaticQris(provider, session),
        },
      ]
    : [];
  process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
}

export function storesCommand(requestedProvider?: string): void {
  merchantsCommand(requestedProvider);
}

/** Set the default GoPay merchant stored by the provider-aware CLI. */
export function setMerchantCommand(
  merchantId: string,
  requestedProvider?: string,
): void {
  const path = resolveConfigPath();
  const config = readConfig(path);
  const providerId = resolveConfiguredProvider(config, requestedProvider);
  if (providerId !== "gopay") {
    throw new ConfigError(
      "Shopee merchant selection requires a new login token exchange",
    );
  }
  if (!merchantId) throw new ConfigError("merchantId is required");
  const provider = config.providers.gopay ?? {};
  if (
    !(provider.merchants ?? []).some((merchant) => merchant.id === merchantId)
  ) {
    throw new ConfigError(`GoPay merchant is not stored: ${merchantId}`);
  }
  updateProviderConfig("gopay", { defaultMerchantId: merchantId }, path);
  process.stdout.write(`Default GoPay merchant set: ${merchantId}\n`);
}

export function setStoreCommand(storeId: string): void {
  if (!storeId) throw new ConfigError("storeId is required");
  const path = resolveConfigPath();
  const config = readConfig(path);
  const provider = config.providers.shopee ?? {};
  const session = provider.session;
  if (!session) throw new ConfigError("No Shopee session is stored");
  if (!session.stores.some((store) => store.id === storeId)) {
    throw new ConfigError(`Shopee store is not stored: ${storeId}`);
  }
  const nextSession = { ...session, storeId };
  updateProviderConfig(
    "shopee",
    { session: nextSession } satisfies ShopeeCliProviderConfig,
    path,
  );
  process.stdout.write(`Default Shopee store set: ${storeId}\n`);
  if (!hasShopeeStaticQris(provider, nextSession)) {
    process.stdout.write(
      "No static QRIS is bound to this store. Run `merchid set-qris shopee`.\n",
    );
  }
}

export function setProviderCommand(providerId: string): void {
  if (!isCliProviderId(providerId)) {
    throw new ConfigError(`Unsupported CLI provider: ${providerId}`);
  }
  const path = resolveConfigPath();
  updateConfig({ defaultProvider: providerId }, path);
  process.stdout.write(`Default provider set: ${providerId}\n`);
}

export async function setQrisCommand(
  requestedProvider?: string,
): Promise<void> {
  const path = resolveConfigPath();
  const config = readConfig(path);
  const providerId =
    resolveConfiguredProvider(config, requestedProvider) ??
    (await chooseLoginProvider(config, requestedProvider));
  const qris = await promptRequired("Static QRIS payload: ");
  if (!isValidQrisChecksum(qris)) {
    throw new ConfigError("Static QRIS checksum is invalid");
  }
  staticToDynamicQris(qris, 1);

  if (providerId === "shopee") {
    const session = config.providers.shopee?.session;
    if (!session?.storeId) {
      throw new ConfigError(
        "Select a Shopee merchant/store before saving its static QRIS",
      );
    }
    updateProviderConfig(
      providerId,
      {
        staticQris: qris,
        staticQrisScope: {
          merchantId: session.merchant.id,
          storeId: session.storeId,
        },
      } satisfies ShopeeCliProviderConfig,
      path,
    );
  } else {
    updateProviderConfig(providerId, { staticQris: qris }, path);
  }
  process.stdout.write(`Static QRIS saved for ${providerId}.\n`);
}

/** Show config location and redacted state for every built-in provider. */
export function whoamiCommand(): void {
  const path = resolveConfigPath();
  const config = readConfig(path);
  const gopay = config.providers.gopay ?? {};
  const shopee = config.providers.shopee ?? {};
  const summary = {
    configVersion: config.version,
    configPath: path,
    defaultProvider: config.defaultProvider ?? null,
    providers: {
      gopay: {
        loggedIn: Boolean(gopay.session?.tokens.accessToken),
        merchantCount: gopay.merchants?.length ?? 0,
        defaultMerchantId: gopay.defaultMerchantId ?? null,
        hasStaticQris: Boolean(gopay.staticQris),
      },
      shopee: {
        loggedIn: Boolean(shopee.session),
        merchantId: shopee.session?.merchant.id ?? null,
        storeCount: shopee.session?.stores.length ?? 0,
        defaultStoreId: shopee.session?.storeId ?? null,
        hasStaticQris: hasShopeeStaticQris(shopee),
        expiresAt: shopee.session?.expiresAt ?? null,
      },
    },
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

function hasShopeeStaticQris(
  provider: ShopeeCliProviderConfig,
  session = provider.session,
): boolean {
  const scope = provider.staticQrisScope;
  return Boolean(
    provider.staticQris &&
    session?.storeId &&
    scope?.merchantId === session.merchant.id &&
    scope.storeId === session.storeId,
  );
}

function resolveConfiguredProvider(
  config: CliConfig,
  requested?: string,
): CliProviderId | undefined {
  if (requested !== undefined) {
    if (!isCliProviderId(requested)) {
      throw new ConfigError(`Unsupported CLI provider: ${requested}`);
    }
    return requested;
  }
  if (isCliProviderId(config.defaultProvider)) return config.defaultProvider;
  const configured = PROVIDERS.filter((providerId) => {
    const provider = config.providers[providerId];
    return provider !== undefined;
  });
  return configured.length === 1 ? configured[0] : undefined;
}

function chooseKnownId(
  availableIds: readonly string[],
  preferredId?: string,
): string | undefined {
  return preferredId && availableIds.includes(preferredId)
    ? preferredId
    : undefined;
}

function debugEnabled(): boolean {
  return Boolean(process.env.MERCHID_DEBUG);
}
