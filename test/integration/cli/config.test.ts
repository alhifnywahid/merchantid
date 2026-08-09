import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLI_CONFIG_VERSION,
  readConfig,
  resolveConfigPath,
  updateConfig,
  updateProviderConfig,
  writeConfig,
} from "../../../src/cli/config.js";
import { ConfigError } from "../../../src/core/errors.js";

let directory = "";
let configPath = "";
let originalConfigEnv: string | undefined;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "merchantid-config-test-"));
  configPath = join(directory, "nested", "config.json");
  originalConfigEnv = process.env.MERCHANTID_CONFIG;
});

afterEach(() => {
  if (originalConfigEnv === undefined) delete process.env.MERCHANTID_CONFIG;
  else process.env.MERCHANTID_CONFIG = originalConfigEnv;
  rmSync(directory, { recursive: true, force: true });
});

describe("MerchantId CLI config", () => {
  it("uses only MERCHANTID_CONFIG as its explicit path override", () => {
    process.env.MERCHANTID_CONFIG = configPath;
    expect(resolveConfigPath()).toBe(configPath);
  });

  it("returns a clean versioned config when the file is missing", () => {
    expect(readConfig(configPath)).toEqual({
      version: CLI_CONFIG_VERSION,
      providers: {},
    });
  });

  it("writes newline-terminated JSON and creates parent directories", () => {
    writeConfig(
      {
        version: CLI_CONFIG_VERSION,
        defaultProvider: "gopay",
        providers: { gopay: { defaultMerchantId: "merchant-test" } },
      },
      configPath,
    );

    const text = readFileSync(configPath, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toMatchObject({
      version: 1,
      defaultProvider: "gopay",
    });
  });

  it.each([
    ["not-json", /not valid JSON/],
    ["[]", /JSON object/],
    [JSON.stringify({ version: 2, providers: {} }), /Unsupported/],
    [
      JSON.stringify({ version: 1, providers: [] }),
      /providers must be an object/,
    ],
  ])("rejects malformed config %#", (contents, message) => {
    mkdirSync(join(directory, "nested"), { recursive: true });
    writeFileSync(configPath, contents, { encoding: "utf8", flag: "w" });
    expect(() => readConfig(configPath)).toThrowError(ConfigError);
    expect(() => readConfig(configPath)).toThrow(message);
  });

  it("merges top-level and provider updates without deleting other providers", () => {
    writeConfig(
      {
        version: 1,
        providers: {
          gopay: { defaultMerchantId: "go-1" },
          shopee: { staticQris: "synthetic-qris" },
        },
      },
      configPath,
    );

    updateConfig({ defaultProvider: "shopee" }, configPath);
    const next = updateProviderConfig(
      "gopay",
      { defaultMerchantId: "go-2" },
      configPath,
    );

    expect(next).toEqual({
      version: 1,
      defaultProvider: "shopee",
      providers: {
        gopay: { defaultMerchantId: "go-2" },
        shopee: { staticQris: "synthetic-qris" },
      },
    });
  });
});
