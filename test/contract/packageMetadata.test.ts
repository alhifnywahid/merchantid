import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface PackageManifest {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  bin?: Record<string, string>;
  exports?: Record<string, unknown>;
  files?: string[];
}

const manifestPath = fileURLToPath(
  new URL("../../package.json", import.meta.url),
);
const manifest = JSON.parse(
  readFileSync(manifestPath, "utf8"),
) as PackageManifest;

describe("npm package metadata contract", () => {
  it("ships as merchid without runtime dependencies", () => {
    expect(manifest.name).toBe("merchid");
    // Match the shape, not one release: pinning the literal version would make
    // every `npm version` bump fail the publish workflow's own test gate.
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    expect(manifest.dependencies ?? {}).toEqual({});
  });

  it("exposes one package root and one MerchID CLI binary", () => {
    expect(manifest.bin).toEqual({ merchid: "dist/cli.cjs" });
    // Only the root entry is importable; "./package.json" is the conventional
    // escape hatch tooling needs and does not widen the API surface.
    expect(Object.keys(manifest.exports ?? {})).toEqual([
      ".",
      "./package.json",
    ]);
  });

  it("gives CJS consumers CJS-flavoured types", () => {
    // A single top-level "types" resolves to the ESM declaration under
    // `require`, which makes the package masquerade as ESM for CJS consumers.
    const root = (manifest.exports ?? {})["."] as
      Record<string, Record<string, string>> | undefined;
    expect(root?.import?.types).toBe("./dist/index.d.ts");
    expect(root?.require?.types).toBe("./dist/index.d.cts");
  });

  it("publishes only build output and README assets from the explicit file list", () => {
    expect(manifest.files).toEqual(["dist", "assets/readme"]);
  });
});
