import { describe, expect, it } from "vitest";
import { ShopeeHttpClient } from "../../../../src/providers/shopee/httpClient.js";
import { ShopeeCookieJar } from "../../../../src/providers/shopee/cookieJar.js";
import { jsonResponse, scriptedFetch } from "../../../helpers/http.js";

/** A dashboard token cookie scoped to `.shopee.co.id`, as Shopee sets on login. */
function tokenCookieJar(): ShopeeCookieJar {
  return new ShopeeCookieJar([
    {
      name: "__shopee_partner_website_x_token_live",
      value: "stale-login-merchant-token",
      domain: "shopee.co.id",
      path: "/",
      hostOnly: false,
      secure: true,
      expiresAt: Date.now() + 3_600_000,
    },
  ]);
}

describe("ShopeeHttpClient cookie scoping", () => {
  it("omits cookies on the header-authenticated partner API host", async () => {
    // The dashboard token cookie matches `.shopee.co.id`, so a naive jar would
    // attach it to api.partner.shopee.co.id. After a merchant switch that cookie
    // still holds the previous merchant's token and, sent alongside a fresh
    // X-Merchant-Token, makes the server reject the call with 200020. The client
    // must mirror the browser, which never cookies this host.
    const { fetch, requests } = scriptedFetch([
      jsonResponse(200, { errorCode: 0, data: {} }),
    ]);
    const http = new ShopeeHttpClient({ cookieJar: tokenCookieJar(), fetch });

    await http.requestJson({
      method: "POST",
      url: "https://api.partner.shopee.co.id/nb/mss/web-api/PartnerAccountServer/GetUserInfo",
      body: {},
    });

    expect(requests[0]?.headers.cookie).toBeUndefined();
  });

  it("still sends cookies to the shopeepay host", async () => {
    const { fetch, requests } = scriptedFetch([
      jsonResponse(200, { code: 0, data: {} }),
    ]);
    const http = new ShopeeHttpClient({ cookieJar: tokenCookieJar(), fetch });

    await http.requestJson({
      method: "POST",
      url: "https://shopeepay.shopee.co.id/merchant/v1/partner-web/get-store-list",
      body: {},
    });

    expect(requests[0]?.headers.cookie).toContain(
      "__shopee_partner_website_x_token_live=",
    );
  });

  it("stamps the browser identity on partner API requests", async () => {
    // The `SGW` partner gateway rejects non-browser-looking XHRs with a generic
    // error (90004 on the mer-detect service). Every partner API call must carry
    // the same User-Agent / fetch-metadata the web client sends, not a bare Node
    // fetch, or the merchant switch silently fails.
    const { fetch, requests } = scriptedFetch([
      jsonResponse(200, { errorCode: 0, data: {} }),
    ]);
    const http = new ShopeeHttpClient({ cookieJar: tokenCookieJar(), fetch });

    await http.requestJson({
      method: "POST",
      url: "https://api.partner.shopee.co.id/nb/mss/mer-detect-api/PartnerMerchantDetectServer/SwitchMerchant",
      body: { target_tob_uid: "90002" },
    });

    const headers = requests[0]?.headers ?? {};
    expect(headers["user-agent"]).toContain("Firefox");
    expect(headers["accept-language"]).toContain("id");
    expect(headers["sec-fetch-site"]).toBe("same-site");
  });
});
