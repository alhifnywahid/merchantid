import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Payment } from "merchantid";

const renameControl = vi.hoisted(() => ({ remainingFailures: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (renameControl.remainingFailures > 0) {
        renameControl.remainingFailures -= 1;
        throw new Error("forced atomic rename failure");
      }
      return actual.rename(...args);
    },
  };
});

import {
  JsonPaymentStore,
  createDefaultState,
  loadLabState,
  resetStoredLab,
  saveLabState,
} from "../src/server/storage.server";

function paymentFixture(): Payment {
  return {
    id: "payment-persistence-regression",
    scope: { provider: "gopay", merchantId: "merchant-test" },
    baseAmount: 10_000,
    uniqueOffset: 1,
    uniqueAmount: 10_001,
    status: "pending",
    createdAt: 1_700_000_000_000,
    expiresAt: 1_700_000_300_000,
  };
}

beforeEach(async () => {
  renameControl.remainingFailures = 0;
  await resetStoredLab();
});

describe("lab state persistence", () => {
  it("removes legacy v1 state and payments before returning v2 defaults", async () => {
    const dataDirectory = process.env.MERCHANTID_LAB_DATA_DIR;
    if (!dataDirectory)
      throw new Error("test data directory was not configured");
    const statePath = join(dataDirectory, "lab-state.json");
    const paymentPath = join(dataDirectory, "payments.json");
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        mode: "live",
        activeProviderId: "shopee",
        gopay: {
          merchants: [
            {
              id: "legacy-merchant",
              label: "Legacy Merchant",
            },
          ],
        },
        shopee: {},
        activity: [
          {
            id: "legacy-activity",
            at: 1_700_000_000_000,
            tone: "info",
            title: "Legacy state",
            message: "Must be discarded",
          },
        ],
        startedAt: 1_700_000_000_000,
      }),
      "utf8",
    );
    await writeFile(paymentPath, JSON.stringify([paymentFixture()]), "utf8");

    const state = await loadLabState();

    expect(state).toMatchObject({
      version: 2,
      activeProviderId: "gopay",
      gopay: { merchants: [] },
      shopee: {},
      activity: [],
    });
    expect(state).not.toHaveProperty("mode");
    await expect(readFile(statePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(paymentPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("recovers the write queue after a failed atomic rename", async () => {
    renameControl.remainingFailures = 1;
    const rejected = {
      ...createDefaultState(),
      activeProviderId: "shopee" as const,
    };
    await expect(saveLabState(rejected)).rejects.toThrow(
      "forced atomic rename failure",
    );

    const recovered = {
      ...createDefaultState(),
      activeProviderId: "shopee" as const,
    };
    await expect(saveLabState(recovered)).resolves.toBeUndefined();
    await expect(loadLabState()).resolves.toMatchObject({
      version: 2,
      activeProviderId: "shopee",
    });
  });
});

describe("JsonPaymentStore", () => {
  it("commits memory only after disk persistence and permits a retry", async () => {
    const store = new JsonPaymentStore();
    const payment = paymentFixture();
    renameControl.remainingFailures = 1;

    await expect(store.create(payment)).rejects.toThrow(
      "forced atomic rename failure",
    );
    await expect(store.get(payment.id)).resolves.toBeUndefined();

    await expect(store.create(payment)).resolves.toBeUndefined();
    await expect(store.get(payment.id)).resolves.toMatchObject({
      id: payment.id,
      status: "pending",
      uniqueAmount: payment.uniqueAmount,
    });
  });
});
