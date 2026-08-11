import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// This console consumes the published `merchantid` package from npm, so it is a
// self-contained app - no link to the repo root. `merchantid` is externalized
// for SSR so Node loads the installed package from node_modules directly.
const srcRoot = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  server: {
    // Loopback only. The server functions drive real provider APIs with no
    // authentication of their own - on a LAN, `requestOtp` would be an open
    // relay sending real OTPs from the operator's merchant account to any
    // number a caller supplies.
    host: "127.0.0.1",
    port: 5180,
    strictPort: true,
    fs: {
      // Stored provider credentials live under `data/`, which Vite's default
      // deny list does not cover, so they are denied explicitly from `/@fs/`.
      deny: ["**/data/**", "**/*session*.json", "**/.env*", "**/.flow/**"],
    },
  },
  resolve: {
    alias: {
      "@": srcRoot,
    },
  },
  ssr: {
    external: ["merchantid"],
  },
  plugins: [tanstackStart(), tailwindcss(), react()],
});
