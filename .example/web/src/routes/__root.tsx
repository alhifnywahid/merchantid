import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";
import { themeBootScript } from "../components/lab-ui";
import appCss from "../styles.css?url";

const description =
  "Utility lokal live-only untuk menguji integrasi GoPay dan Shopee melalui package MerchID.";

/** Coral registration mark on near-black — the drafting motif at 16px. */
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
      { title: "MerchID Lab · konsol integrasi live" },
      { name: "description", content: description },
      { name: "color-scheme", content: "light dark" },
      {
        name: "theme-color",
        content: "#f9fafa",
        media: "(prefers-color-scheme: light)",
      },
      {
        name: "theme-color",
        content: "#0f0f0f",
        media: "(prefers-color-scheme: dark)",
      },
      { name: "robots", content: "noindex, nofollow" },
      { property: "og:type", content: "website" },
      { property: "og:title", content: "MerchID Lab" },
      { property: "og:description", content: description },
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
        {/* Applies the stored theme before first paint. */}
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}

function NotFound() {
  return (
    <main className="boot">
      <div className="boot__inner">
        <p className="eyebrow">404</p>
        <h1 className="boot__title">Rute ini tidak ada</h1>
        <div>
          <a className="btn btn--default" href="/">
            <span>Kembali ke workspace</span>
          </a>
        </div>
      </div>
    </main>
  );
}
