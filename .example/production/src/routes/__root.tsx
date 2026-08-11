import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";
import { ThemeProvider, themeBootScript } from "@/components/theme";
import { Toaster } from "@/components/ui/sonner";
import appCss from "@/styles.css?url";

const description =
  "Konsol kasir produksi untuk membuat tagihan QRIS GoPay dan ShopeePay lewat package merchantid.";

/** Coral registration mark on near-black - the drafting motif at 16px. */
const favicon =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230f0f0f'/%3E%3Cpath d='M16 8.5v15M8.5 16h15' stroke='%23e93954' stroke-width='2.6' stroke-linecap='round'/%3E%3C/svg%3E";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1, viewport-fit=cover",
      },
      { title: "MerchantId Console · kasir QRIS" },
      { name: "description", content: description },
      { name: "color-scheme", content: "light dark" },
      { name: "robots", content: "noindex, nofollow" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: favicon, type: "image/svg+xml" },
    ],
  }),
  component: RootDocument,
  notFoundComponent: NotFound,
});

function RootDocument() {
  return (
    <html lang="id" suppressHydrationWarning>
      <head>
        <HeadContent />
        {/* Applies the stored theme before first paint to avoid a flash. */}
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body>
        <ThemeProvider>
          <Outlet />
          <Toaster />
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  );
}

function NotFound() {
  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="font-mono text-[0.625rem] uppercase tracking-[0.08em] text-muted-foreground">
        404
      </p>
      <h1 className="text-lg font-semibold tracking-[-0.025em]">
        Halaman tidak ditemukan
      </h1>
      <a
        href="/"
        className="inline-flex h-7 items-center rounded-md border border-border px-2.5 text-xs font-medium hover:bg-input/50"
      >
        Kembali ke kasir
      </a>
    </main>
  );
}
