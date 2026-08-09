import { describe, expect, it } from "vitest";
import { ShopeeCookieJar } from "../../../../src/providers/shopee/cookieJar.js";

const PARTNER = "https://partner.shopee.co.id/";

function jarWith(setCookie: string[]): ShopeeCookieJar {
  const jar = new ShopeeCookieJar();
  jar.updateFromResponse(
    PARTNER,
    new Headers(setCookie.map((v) => ["set-cookie", v])),
  );
  return jar;
}

describe("ShopeeCookieJar scoping", () => {
  it("sends a host-only cookie to its own host and nowhere else", () => {
    const jar = jarWith(["session=abc; Path=/"]);

    expect(jar.getCookieHeader(PARTNER)).toBe("session=abc");
    expect(
      jar.getCookieHeader("https://shopeepay.shopee.co.id/merchant"),
    ).toBeUndefined();
  });

  it("honours an explicit registrable Domain across subdomains", () => {
    const jar = jarWith(["session=abc; Domain=shopee.co.id; Path=/"]);

    expect(jar.getCookieHeader("https://shopeepay.shopee.co.id/x")).toBe(
      "session=abc",
    );
  });

  it("refuses to widen a cookie to a public suffix", () => {
    // `Domain=co.id` would otherwise attach this cookie to every *.co.id host
    // the client is redirected to. The attribute is dropped, leaving the
    // strictly safer host-only scope.
    const jar = jarWith(["session=abc; Domain=co.id; Path=/"]);

    expect(jar.getCookieHeader(PARTNER)).toBe("session=abc");
    expect(jar.getCookieHeader("https://unrelated.co.id/")).toBeUndefined();
  });

  it("refuses a bare TLD Domain the same way", () => {
    const jar = jarWith(["session=abc; Domain=id; Path=/"]);

    expect(jar.getCookieHeader("https://unrelated.id/")).toBeUndefined();
  });

  it("withholds a Secure cookie from plaintext requests", () => {
    const jar = jarWith(["session=abc; Path=/; Secure"]);

    expect(jar.getCookieHeader("http://partner.shopee.co.id/")).toBeUndefined();
    expect(jar.getCookieHeader(PARTNER)).toBe("session=abc");
  });

  it("drops a cookie deleted with Max-Age=0", () => {
    const jar = jarWith(["session=abc; Path=/"]);
    jar.updateFromResponse(
      PARTNER,
      new Headers([["set-cookie", "session=abc; Path=/; Max-Age=0"]]),
    );

    expect(jar.getCookieHeader(PARTNER)).toBeUndefined();
  });
});

describe("ShopeeCookieJar injection safety", () => {
  it("rejects a value containing a semicolon", () => {
    // `getCookieHeader` joins pairs with "; ", so a semicolon in a value would
    // smuggle extra cookies into every outgoing request.
    const jar = jarWith(["session=abc; evil=1; Path=/"]);

    // Only the first pair is the value; the parser must not keep an injected one.
    expect(jar.getCookieHeader(PARTNER)).toBe("session=abc");
  });

  it("rejects an injected value supplied through restore()", () => {
    const jar = new ShopeeCookieJar();
    jar.restore([
      {
        name: "session",
        value: "abc; admin=true",
        domain: "partner.shopee.co.id",
        path: "/",
        hostOnly: true,
      },
    ]);

    expect(jar.getCookieHeader(PARTNER)).toBeUndefined();
  });

  it("rejects control characters in a name or value", () => {
    const jar = new ShopeeCookieJar();
    jar.restore([
      {
        name: "bad\nname",
        value: "x",
        domain: "partner.shopee.co.id",
        path: "/",
        hostOnly: true,
      },
    ]);

    expect(jar.snapshot()).toHaveLength(0);
  });
});
