import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LabRuntime, runLabAction } from "../src/server/lab.server";
import { resetStoredLab } from "../src/server/storage.server";

beforeEach(async () => {
  await resetStoredLab();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LabRuntime live boundaries", () => {
  it("advertises real provider requests without making one during startup", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const runtime = await LabRuntime.create();
    const snapshot = await runtime.snapshot();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(snapshot.activity[0]).toMatchObject({
      title: "Local package active",
    });
    expect(snapshot.activity[0]?.message).toContain("file:../..");
    expect(snapshot.activity[0]?.message).toContain("request nyata");
  });

  it("redacts compound sensitive labels before returning an error", async () => {
    const error = await runLabAction(async () => {
      throw new Error(
        "otp_token: do-not-expose challengeToken=hidden-value phone_number=phone-secret-value",
      );
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw error;
    expect(error.message).toContain("otp_token=[redacted]");
    expect(error.message).toContain("challengeToken=[redacted]");
    expect(error.message).toContain("phone_number=[redacted]");
    expect(error.message).not.toContain("do-not-expose");
    expect(error.message).not.toContain("hidden-value");
    expect(error.message).not.toContain("phone-secret-value");
  });
});
