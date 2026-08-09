import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { samePaymentScope } from "merchid";
import type { Payment, PaymentScope, PaymentStore } from "merchid";
import type { ActivityView, ProviderId } from "../lib/lab-types";
import type {
  SessionState,
  ShopeeSession,
  ShopeeStaticQrisScope,
} from "merchid";

// Anchored to this file, not `process.cwd()`. Deriving it from the working
// directory meant launching the lab from the repo root wrote real provider
// credentials to `<repo>/data/`, a path the root .gitignore did not cover.
// `.example/web/data/` is ignored by `.example/.gitignore`, so the credentials
// stay out of git wherever the dev server is started from.
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DATA_DIRECTORY = process.env.MERCHID_LAB_DATA_DIR
  ? resolve(process.env.MERCHID_LAB_DATA_DIR)
  : resolve(APP_ROOT, "data");
const STATE_FILE = resolve(DATA_DIRECTORY, "lab-state.json");
const PAYMENT_FILE = resolve(DATA_DIRECTORY, "payments.json");

export interface StoredGopayMerchant {
  id: string;
  label: string;
  detail?: string;
  staticQris?: string;
}

export interface StoredGopayState {
  session?: SessionState;
  merchants: StoredGopayMerchant[];
  selectedMerchantId?: string;
  staticQris?: string;
}

export interface StoredShopeeState {
  session?: ShopeeSession;
  staticQris?: string;
  staticQrisScope?: ShopeeStaticQrisScope;
}

export interface StoredLabState {
  version: 2;
  activeProviderId: ProviderId;
  gopay: StoredGopayState;
  shopee: StoredShopeeState;
  activity: ActivityView[];
  startedAt: number;
}

export function createDefaultState(): StoredLabState {
  return {
    version: 2,
    activeProviderId: "gopay",
    gopay: { merchants: [] },
    shopee: {},
    activity: [],
    startedAt: Date.now(),
  };
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function loadLabState(): Promise<StoredLabState> {
  const parsed = await readJson<
    (Partial<StoredLabState> & { version?: unknown }) | undefined
  >(STATE_FILE, undefined);
  if (!parsed) return createDefaultState();
  if (parsed.version !== 2) {
    await resetStoredLab();
    return createDefaultState();
  }

  const defaults = createDefaultState();
  return {
    version: 2,
    activeProviderId: parsed.activeProviderId === "shopee" ? "shopee" : "gopay",
    gopay: {
      ...(parsed.gopay ?? defaults.gopay),
      merchants: Array.isArray(parsed.gopay?.merchants)
        ? parsed.gopay.merchants
        : [],
    },
    shopee: { ...(parsed.shopee ?? defaults.shopee) },
    activity: Array.isArray(parsed.activity) ? parsed.activity.slice(-60) : [],
    startedAt:
      Number.isFinite(parsed.startedAt) && (parsed.startedAt ?? 0) > 0
        ? (parsed.startedAt as number)
        : defaults.startedAt,
  };
}

let stateWriteQueue: Promise<void> = Promise.resolve();

export function saveLabState(state: StoredLabState): Promise<void> {
  const snapshot = structuredClone(state);
  const result = stateWriteQueue.then(() => writeJson(STATE_FILE, snapshot));
  stateWriteQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function clonePayment(payment: Payment): Payment {
  return {
    ...payment,
    scope: payment.scope ? { ...payment.scope } : undefined,
    transaction: payment.transaction
      ? { ...payment.transaction, raw: undefined }
      : undefined,
    metadata: payment.metadata ? { ...payment.metadata } : undefined,
  };
}

/** Single-process JSON store for the local development lab. */
export class JsonPaymentStore implements PaymentStore {
  private readonly payments = new Map<string, Payment>();
  private loaded = false;
  private loadPromise?: Promise<void>;
  private mutationQueue: Promise<void> = Promise.resolve();

  private ensureLoaded(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    this.loadPromise ??= readJson<Payment[]>(PAYMENT_FILE, [])
      .then((stored) => {
        for (const payment of stored) {
          this.payments.set(payment.id, clonePayment(payment));
        }
        this.loaded = true;
      })
      .catch((error: unknown) => {
        this.loadPromise = undefined;
        throw error;
      });
    return this.loadPromise;
  }

  private runMutation(
    mutate: (payments: Map<string, Payment>) => void,
  ): Promise<void> {
    const result = this.mutationQueue.then(async () => {
      await this.ensureLoaded();
      const candidate = new Map(
        [...this.payments].map(([id, payment]) => [id, clonePayment(payment)]),
      );
      mutate(candidate);
      await writeJson(PAYMENT_FILE, [...candidate.values()].map(clonePayment));
      this.payments.clear();
      for (const [id, payment] of candidate) {
        this.payments.set(id, clonePayment(payment));
      }
    });
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async waitForStableState(): Promise<void> {
    await this.ensureLoaded();
    await this.mutationQueue;
  }

  create(payment: Payment): Promise<void> {
    return this.runMutation((payments) => {
      payments.set(payment.id, clonePayment(payment));
    });
  }

  update(payment: Payment): Promise<void> {
    return this.runMutation((payments) => {
      payments.set(payment.id, clonePayment(payment));
    });
  }

  async get(id: string): Promise<Payment | undefined> {
    await this.waitForStableState();
    const payment = this.payments.get(id);
    return payment ? clonePayment(payment) : undefined;
  }

  async listActive(scope?: PaymentScope): Promise<Payment[]> {
    await this.waitForStableState();
    return [...this.payments.values()]
      .filter(
        (payment) =>
          payment.status === "pending" &&
          (!scope ||
            (payment.scope !== undefined &&
              samePaymentScope(payment.scope, scope))),
      )
      .map(clonePayment);
  }

  async all(): Promise<Payment[]> {
    await this.waitForStableState();
    return [...this.payments.values()]
      .map(clonePayment)
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  removeProvider(providerId: ProviderId): Promise<void> {
    return this.runMutation((payments) => {
      for (const [id, payment] of payments) {
        if (payment.scope?.provider === providerId) payments.delete(id);
      }
    });
  }

  clear(): Promise<void> {
    return this.runMutation((payments) => payments.clear());
  }
}

export async function resetStoredLab(): Promise<void> {
  await rm(STATE_FILE, { force: true });
  await rm(PAYMENT_FILE, { force: true });
}

export const storageLabel = "./data (gitignored)";
