import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { ConfigError } from "../core/errors.js";
import type { SessionState, StoredMerchant } from "../core/types.js";
import type {
  ShopeeSession,
  ShopeeStaticQrisScope,
} from "../providers/shopee/types.js";

export const CLI_CONFIG_VERSION = 1 as const;

export interface GopayCliProviderConfig {
  session?: SessionState;
  merchants?: StoredMerchant[];
  defaultMerchantId?: string;
  staticQris?: string;
}

export interface ShopeeCliProviderConfig {
  session?: ShopeeSession;
  staticQris?: string;
  staticQrisScope?: ShopeeStaticQrisScope;
}

interface CliProviderConfigs {
  gopay?: GopayCliProviderConfig;
  shopee?: ShopeeCliProviderConfig;
  [providerId: string]: unknown;
}

/** Versioned, provider-keyed CLI configuration. */
export interface CliConfig {
  version: typeof CLI_CONFIG_VERSION;
  defaultProvider?: string;
  providers: CliProviderConfigs;
}

function emptyConfig(): CliConfig {
  return { version: CLI_CONFIG_VERSION, providers: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve the only supported MerchID CLI configuration path. */
export function resolveConfigPath(): string {
  const configured = process.env.MERCHID_CONFIG;
  if (configured?.trim()) return configured;
  return join(homedir(), ".merchid", "config.json");
}

/** Read and validate the current MerchID configuration schema. */
export function readConfig(path = resolveConfigPath()): CliConfig {
  if (!existsSync(path)) return emptyConfig();

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new ConfigError("MerchID config is not valid JSON", { path, cause });
  }

  if (!isRecord(parsed)) {
    throw new ConfigError("MerchID config must be a JSON object");
  }
  if (parsed.version !== CLI_CONFIG_VERSION) {
    throw new ConfigError(
      `Unsupported MerchID config version: ${String(parsed.version)}`,
    );
  }
  if (!isRecord(parsed.providers)) {
    throw new ConfigError("MerchID config providers must be an object");
  }

  return {
    version: CLI_CONFIG_VERSION,
    defaultProvider:
      typeof parsed.defaultProvider === "string"
        ? parsed.defaultProvider
        : undefined,
    providers: { ...parsed.providers },
  };
}

/** Write credentials with owner-only permissions where the filesystem allows. */
export function writeConfig(
  config: CliConfig,
  path = resolveConfigPath(),
): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows and some filesystems do not implement POSIX permission bits.
  }
}

/** Merge a top-level update while preserving every provider entry. */
export function updateConfig(
  patch: Partial<CliConfig>,
  path = resolveConfigPath(),
): CliConfig {
  const current = readConfig(path);
  const next: CliConfig = {
    ...current,
    ...patch,
    version: CLI_CONFIG_VERSION,
    providers: { ...current.providers, ...patch.providers },
  };
  writeConfig(next, path);
  return next;
}

/** Merge one provider's data without touching credentials owned by others. */
export function updateProviderConfig(
  providerId: string,
  patch: object,
  path = resolveConfigPath(),
): CliConfig {
  const current = readConfig(path);
  const existing = current.providers[providerId];
  const previous = isRecord(existing) ? existing : {};
  const next: CliConfig = {
    ...current,
    providers: {
      ...current.providers,
      [providerId]: { ...previous, ...patch },
    },
  };
  writeConfig(next, path);
  return next;
}
