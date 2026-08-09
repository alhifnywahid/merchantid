import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { HttpError } from "../../../src/core/errors.js";

describe("HttpError", () => {
  const secretBody = { access_token: "super-secret-token-value" };

  it("keeps the body readable for callers that inspect a failure", () => {
    const error = new HttpError(422, "boom", secretBody, { host: "api.test" });

    expect(error.body).toEqual(secretBody);
    expect(error.status).toBe(422);
  });

  it("does not leak the body when the error is logged", () => {
    // `console.error(err)` formats via util.inspect, which prints an error's
    // own *enumerable* properties. An enumerable body would put the provider's
    // entire response — credentials included — into the caller's logs.
    const error = new HttpError(422, "boom", secretBody, { host: "api.test" });

    const printed = inspect(error);
    expect(printed).not.toContain("super-secret-token-value");
    expect(printed).not.toContain("access_token");
    expect(Object.keys(error)).not.toContain("body");
    expect(JSON.stringify(error)).not.toContain("super-secret-token-value");
  });
});
