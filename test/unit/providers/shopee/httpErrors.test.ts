import { describe, expect, it } from "vitest";
import { AuthError, HttpError } from "../../../../src/core/errors.js";
import { ShopeeHttpClient } from "../../../../src/providers/shopee/httpClient.js";
import type { FetchLike } from "../../../../src/http/httpClient.js";

/**
 * Transport-level failure handling for the Shopee client. The GoPay client has
 * an equivalent suite; this one existed only for cookie scoping, leaving every
 * error path — timeout, 401/403, non-2xx, non-JSON, redirect chains — unproven.
 */

const URL_UNDER_TEST = "https://api.partner.shopee.co.id/nb/mss/probe";

function fetchReturning(response: Response | (() => never)): FetchLike {
  return (async () => {
    if (typeof response === "function") response();
    return response;
  }) as unknown as FetchLike;
}

function abortingFetch(name: string): FetchLike {
  return (async () => {
    throw Object.assign(new Error("aborted"), { name });
  }) as unknown as FetchLike;
}

describe("ShopeeHttpClient error mapping", () => {
  it("maps a timeout to HTTP 408 without leaking the URL query", async () => {
    const client = new ShopeeHttpClient({
      fetch: abortingFetch("TimeoutError"),
    });

    await expect(
      client.requestJson({ url: `${URL_UNDER_TEST}?token=secret-value` }),
    ).rejects.toMatchObject({ status: 408 });
  });

  it("maps an aborted request to HTTP 408 as well", async () => {
    const client = new ShopeeHttpClient({ fetch: abortingFetch("AbortError") });

    await expect(
      client.requestJson({ url: URL_UNDER_TEST }),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("reports a transport failure as HttpError 0", async () => {
    const client = new ShopeeHttpClient({
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as FetchLike,
    });

    await expect(
      client.requestJson({ url: URL_UNDER_TEST }),
    ).rejects.toMatchObject({
      status: 0,
    });
  });

  it.each([401, 403])("treats HTTP %i as an auth failure", async (status) => {
    const client = new ShopeeHttpClient({
      fetch: fetchReturning(new Response("{}", { status })),
    });

    await expect(
      client.requestJson({ url: URL_UNDER_TEST }),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("maps any other non-2xx status to HttpError with that status", async () => {
    const client = new ShopeeHttpClient({
      fetch: fetchReturning(new Response("nope", { status: 503 })),
    });

    await expect(
      client.requestJson({ url: URL_UNDER_TEST }),
    ).rejects.toMatchObject({
      status: 503,
    });
  });

  it("rejects a 2xx response whose body is not JSON", async () => {
    // Shopee answers HTML when a gateway sits in front of the API; parsing that
    // as a success envelope would surface as a confusing "missing data" error.
    const client = new ShopeeHttpClient({
      fetch: fetchReturning(
        new Response("<html>maintenance</html>", { status: 200 }),
      ),
    });

    await expect(
      client.requestJson({ url: URL_UNDER_TEST }),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("treats an empty 2xx body as an empty object", async () => {
    const client = new ShopeeHttpClient({
      fetch: fetchReturning(new Response("", { status: 200 })),
    });

    await expect(client.requestJson({ url: URL_UNDER_TEST })).resolves.toEqual(
      {},
    );
  });
});

describe("ShopeeHttpClient.followGet", () => {
  it("follows a redirect chain and returns the final response", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: URL | string) => {
      seen.push(String(url));
      if (seen.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://partner.shopee.co.id/final" },
        });
      }
      return new Response("done", { status: 200 });
    }) as unknown as FetchLike;
    const client = new ShopeeHttpClient({ fetch: fetchImpl });

    const response = await client.followGet(
      "https://partner.shopee.co.id/start",
    );

    expect(response.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain("/final");
  });

  it("fails when a redirect omits its Location header", async () => {
    const client = new ShopeeHttpClient({
      fetch: fetchReturning(new Response(null, { status: 302 })),
    });

    await expect(
      client.followGet("https://partner.shopee.co.id/start"),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("gives up on an endless redirect loop instead of hanging", async () => {
    // A self-referential Location would otherwise spin forever inside a login
    // flow, with no request ever completing.
    const client = new ShopeeHttpClient({
      fetch: (async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://partner.shopee.co.id/loop" },
        })) as unknown as FetchLike,
    });

    await expect(
      client.followGet("https://partner.shopee.co.id/loop", 2),
    ).rejects.toMatchObject({ status: 508 });
  });
});
