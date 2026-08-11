import { defineConfig } from "tsup";

export default defineConfig([
  {
    // The library entry ships both module formats: ESM for modern consumers,
    // CJS for `require`. Declarations are emitted for both (`.d.ts`/`.d.cts`)
    // so the `exports` map can hand each condition its own flavour.
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    dts: { entry: "src/index.ts" },
    clean: true,
    // Sourcemaps are deliberately omitted from the published tarball: with
    // `sourcesContent` they embedded the full TypeScript source and accounted
    // for roughly 60% of the package size, for a library whose stack traces
    // point at a single bundled file anyway.
    sourcemap: false,
    target: "node18",
    splitting: false,
    minify: false,
  },
  {
    // The CLI is only ever executed through the `bin` entry, which resolves to
    // the CJS build. An ESM twin was shipped but unreachable - nothing in
    // `exports` or `bin` pointed at it.
    entry: { cli: "src/cli.ts" },
    format: ["cjs"],
    dts: false,
    clean: false,
    sourcemap: false,
    target: "node18",
    splitting: false,
    minify: false,
  },
]);
