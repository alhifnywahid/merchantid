import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The lab consumes the root package through `merchantid: file:../..`, which resolves
// to the sibling `dist/` output at the repository root. `.example/web` has its
// own lockfile, so Vite treats this folder as the workspace root. Two things are
// needed for that linked package to load in dev:
//   1. Externalize `merchantid` for SSR so Node imports the built package directly
//      instead of Vite trying to serve `../../dist/*` through `/@fs/`.
//   2. Allow the repo root in the dev server file-serving list as a fallback for
//      any remaining `/@fs/` reads (for example sourcemaps).
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  server: {
    // Loopback only. The lab's server functions drive real provider APIs with
    // no authentication of their own — reachable on a LAN, `requestOtp` would
    // be an open relay that sends real OTPs from the operator's own merchant
    // account to any phone number a caller supplies.
    host: "127.0.0.1",
    port: 5179,
    strictPort: true,
    fs: {
      allow: [repoRoot],
      // Allowing the repo root also exposes it over `/@fs/`. Stored provider
      // credentials live under `data/`, which Vite's default deny list does
      // not cover, so they are denied explicitly.
      deny: ["**/data/**", "**/*session*.json", "**/.env*", "**/.flow/**"],
    },
  },
  resolve: {
    tsconfigPaths: true,
  },
  ssr: {
    external: ["merchantid"],
  },
  plugins: [tanstackStart(), tailwindcss(), react()],
});
