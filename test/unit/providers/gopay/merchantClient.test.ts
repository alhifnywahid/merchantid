import { describe, expect, it } from "vitest";
import { HttpClient, type FetchLike } from "../../../../src/http/httpClient.js";
import { MerchantClient } from "../../../../src/api/merchantClient.js";

/** Minimal Response stand-in: HttpClient only reads `status` and `text()`. */
function reply(status: number, body: unknown): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { status, text: async () => text } as unknown as Response;
}

/**
 * Queue a scripted sequence of responses and record the requests made.
 * Extended from the httpClient.test.ts helper to also capture method and
 * body, because MerchantClient's contract includes the POST search payload.
 */
function scriptedFetch(replies: Response[]): {
  fetch: FetchLike;
  requests: Array<{ url: string; method?: string; body?: string }>;
} {
  const requests: Array<{ url: string; method?: string; body?: string }> = [];
  let index = 0;

  const fetch = (async (input: unknown, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const next = replies[index++];
    if (!next) throw new Error("scriptedFetch: no reply left for this request");
    return next;
  }) as unknown as FetchLike;

  return { fetch, requests };
}

function makeClient(replies: Response[]): {
  client: MerchantClient;
  requests: Array<{ url: string; method?: string; body?: string }>;
} {
  const { fetch, requests } = scriptedFetch(replies);
  const http = new HttpClient({ baseUrl: "https://api.test", fetch });
  return { client: new MerchantClient(http), requests };
}

describe("MerchantClient.getCurrentUser", () => {
  it("GETs /v1/users/me and normalizes the user envelope", async () => {
    const envelope = {
      user: {
        id: 42,
        email: "owner@example.com",
        full_name: "Owner Name",
        phone: "+62811111111",
        merchant_id: "G-MERCHANT-1",
        roles: ["owner", "finance"],
      },
    };
    const { client, requests } = makeClient([reply(200, envelope)]);

    const user = await client.getCurrentUser();

    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url).toBe("https://api.test/v1/users/me");
    expect(user.id).toBe(42);
    // merchantId comes from the snake_case `merchant_id`; it is what the rest
    // of the library uses to scope every merchant call.
    expect(user.merchantId).toBe("G-MERCHANT-1");
    expect(user.email).toBe("owner@example.com");
    expect(user.fullName).toBe("Owner Name");
    expect(user.phone).toBe("+62811111111");
    expect(user.roles).toEqual(["owner", "finance"]);
    // `raw` preserves the whole response envelope (including the `user`
    // wrapper), not just the inner object, for advanced consumers.
    expect(user.raw).toEqual(envelope);
  });

  it("tolerates a response without a user object", async () => {
    const { client } = makeClient([reply(200, {})]);

    const user = await client.getCurrentUser();

    expect(user.id).toBeUndefined();
    expect(user.merchantId).toBeUndefined();
    expect(user.email).toBeUndefined();
    expect(user.fullName).toBeUndefined();
    expect(user.phone).toBeUndefined();
    // roles must always be an array so callers can iterate without guards.
    expect(user.roles).toEqual([]);
  });

  it("defaults roles to an empty array when the field is absent", async () => {
    const { client } = makeClient([
      reply(200, { user: { id: 7, merchant_id: "G-1" } }),
    ]);

    const user = await client.getCurrentUser();

    expect(user.roles).toEqual([]);
    expect(user.merchantId).toBe("G-1");
  });
});

describe("MerchantClient.getMerchant", () => {
  it("GETs /v1/merchants/{id} and normalizes the profile and outlets", async () => {
    const popWithQr = {
      pop_id: "POP-1",
      name: "Main outlet",
      status: "active",
      gopay: {
        status: "enabled",
        gopay_receiver_id: "RCV-1",
        aspi_qr_string: "00020101ASPI-QR-1",
      },
    };
    const popWithoutGopay = { pop_id: "POP-2", name: "Warehouse" };
    const payload = {
      id: "G-MERCHANT-1",
      merchant_name: "Kopi Enak",
      outlet_name: "Kopi Enak Pusat",
      phone: "+62822222222",
      email: "kopi@example.com",
      server_key: "sk-123",
      client_key: "ck-456",
      timezone: "Asia/Jakarta",
      pops: [popWithQr, popWithoutGopay],
    };
    const { client, requests } = makeClient([reply(200, payload)]);

    const profile = await client.getMerchant("G-MERCHANT-1");

    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url).toBe("https://api.test/v1/merchants/G-MERCHANT-1");

    expect(profile.id).toBe("G-MERCHANT-1");
    expect(profile.merchantName).toBe("Kopi Enak");
    expect(profile.outletName).toBe("Kopi Enak Pusat");
    expect(profile.phone).toBe("+62822222222");
    expect(profile.email).toBe("kopi@example.com");
    expect(profile.serverKey).toBe("sk-123");
    expect(profile.clientKey).toBe("ck-456");
    expect(profile.timezone).toBe("Asia/Jakarta");
    expect(profile.raw).toEqual(payload);

    expect(profile.outlets).toHaveLength(2);
    expect(profile.outlets[0]).toMatchObject({
      popId: "POP-1",
      name: "Main outlet",
      status: "active",
      receiverId: "RCV-1",
      qrString: "00020101ASPI-QR-1",
    });
    // Each outlet keeps its own raw pop payload for advanced consumers.
    expect(profile.outlets[0]?.raw).toEqual(popWithQr);
    // A pop without a gopay block still yields an outlet; the QR fields are
    // simply absent instead of crashing the whole profile fetch.
    expect(profile.outlets[1]).toMatchObject({ popId: "POP-2" });
    expect(profile.outlets[1]?.receiverId).toBeUndefined();
    expect(profile.outlets[1]?.qrString).toBeUndefined();
  });

  it("extracts qrString from aspi_qr_string, never from gopay_qr_string", async () => {
    // The ASPI string is the EMVCo QRIS payload the library injects amounts
    // into. The gopay_qr_string variant is a different artifact and must not
    // leak into `qrString`, or downstream QR building would fail.
    const { client } = makeClient([
      reply(200, {
        id: "G-1",
        pops: [
          {
            pop_id: "POP-1",
            gopay: { gopay_qr_string: "https://gopay.link/xyz" },
          },
        ],
      }),
    ]);

    const profile = await client.getMerchant("G-1");

    expect(profile.outlets[0]?.qrString).toBeUndefined();
  });

  it("does not crash on a minimal payload without pops or optional fields", async () => {
    const { client } = makeClient([reply(200, { id: "G-BARE" })]);

    const profile = await client.getMerchant("G-BARE");

    expect(profile.id).toBe("G-BARE");
    // merchantName is normalized to an empty string, not undefined, so
    // consumers can render it without a null check.
    expect(profile.merchantName).toBe("");
    expect(profile.outlets).toEqual([]);
    expect(profile.outletName).toBeUndefined();
    expect(profile.serverKey).toBeUndefined();
  });

  it("defaults a missing pop_id to an empty string", async () => {
    const { client } = makeClient([
      reply(200, { id: "G-1", pops: [{ name: "No id outlet" }] }),
    ]);

    const profile = await client.getMerchant("G-1");

    expect(profile.outlets[0]?.popId).toBe("");
    expect(profile.outlets[0]?.name).toBe("No id outlet");
  });
});

describe("MerchantClient.searchMerchants", () => {
  it("POSTs the search query with the default page size of 200", async () => {
    const { client, requests } = makeClient([reply(200, { hits: [] })]);

    await expect(client.searchMerchants()).resolves.toEqual([]);

    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url).toBe("https://api.test/v1/merchants/search");

    const body = JSON.parse(requests[0]?.body ?? "{}") as {
      from?: number;
      size?: number;
      _source?: string[];
    };
    expect(body.from).toBe(0);
    expect(body.size).toBe(200);
    // The _source projection must keep the fields normalization depends on;
    // dropping `pops` would silently strip every outlet QR from the results.
    expect(body._source).toEqual(
      expect.arrayContaining(["id", "merchant_name", "pops"]),
    );
  });

  it("passes an explicit limit through as the page size", async () => {
    const { client, requests } = makeClient([reply(200, { hits: [] })]);

    await client.searchMerchants(25);

    const body = JSON.parse(requests[0]?.body ?? "{}") as { size?: number };
    expect(body.size).toBe(25);
  });

  it("maps hits into StoredMerchant records with normalized outlets", async () => {
    const hit = {
      id: "G-MERCHANT-2",
      merchant_name: "Warung Dua",
      outlet_name: "Warung Dua Cabang",
      phone: "+62833333333",
      email: "warung@example.com",
      business_type: "food",
      merchant_type: "individual",
      service_area: "Bandung",
      pops: [
        {
          pop_id: "POP-A",
          name: "Front counter",
          status: "active",
          gopay: {
            gopay_receiver_id: "RCV-A",
            aspi_qr_string: "00020101ASPI-A",
          },
        },
      ],
    };
    const { client } = makeClient([reply(200, { hits: [hit] })]);

    const merchants = await client.searchMerchants();

    expect(merchants).toHaveLength(1);
    expect(merchants[0]).toMatchObject({
      id: "G-MERCHANT-2",
      merchantName: "Warung Dua",
      outletName: "Warung Dua Cabang",
      phone: "+62833333333",
      email: "warung@example.com",
      businessType: "food",
      merchantType: "individual",
      serviceArea: "Bandung",
      qrString: "00020101ASPI-A",
    });
    expect(merchants[0]?.outlets[0]).toMatchObject({
      popId: "POP-A",
      name: "Front counter",
      status: "active",
      receiverId: "RCV-A",
      qrString: "00020101ASPI-A",
    });
    expect(merchants[0]?.raw).toEqual(hit);
  });

  it("picks the first outlet with a non-empty QR as the primary qrString", async () => {
    // Outlet 1 has no gopay block and outlet 2 carries an empty string; both
    // must be skipped, because an empty qrString would break QR generation
    // downstream while looking present in truthiness-free checks.
    const { client } = makeClient([
      reply(200, {
        hits: [
          {
            id: "G-1",
            merchant_name: "Multi outlet",
            pops: [
              { pop_id: "POP-1" },
              { pop_id: "POP-2", gopay: { aspi_qr_string: "" } },
              { pop_id: "POP-3", gopay: { aspi_qr_string: "00020101ASPI-3" } },
            ],
          },
        ],
      }),
    ]);

    const merchants = await client.searchMerchants();

    expect(merchants[0]?.qrString).toBe("00020101ASPI-3");
    expect(merchants[0]?.outlets).toHaveLength(3);
  });

  it("leaves qrString undefined when no outlet has a QR", async () => {
    const { client } = makeClient([
      reply(200, {
        hits: [{ id: "G-1", merchant_name: "No QR", pops: [{ pop_id: "P" }] }],
      }),
    ]);

    const merchants = await client.searchMerchants();

    expect(merchants[0]?.qrString).toBeUndefined();
  });

  it("returns an empty list and normalized defaults on sparse payloads", async () => {
    // First call: the hits array is absent entirely. Second call: a hit with
    // only an id. Neither shape may crash the multi-merchant enumeration.
    const { client } = makeClient([
      reply(200, {}),
      reply(200, { hits: [{ id: "G-SPARSE" }] }),
    ]);

    await expect(client.searchMerchants()).resolves.toEqual([]);

    const merchants = await client.searchMerchants();
    expect(merchants).toHaveLength(1);
    expect(merchants[0]?.id).toBe("G-SPARSE");
    expect(merchants[0]?.merchantName).toBe("");
    expect(merchants[0]?.outlets).toEqual([]);
    expect(merchants[0]?.qrString).toBeUndefined();
  });
});
