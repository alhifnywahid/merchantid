import { Link } from "@tanstack/react-router";
import { Storefront, Receipt } from "@phosphor-icons/react";
import { ThemeSwitch } from "@/components/theme-switch";
import { useConsole } from "@/lib/console-store";
import { setActiveProvider } from "@/server/functions";
import type { ProviderId } from "@/lib/types";
import { cn } from "@/lib/utils";

const PROVIDERS: Array<{ id: ProviderId; label: string }> = [
  { id: "gopay", label: "GoPay" },
  { id: "shopee", label: "ShopeePay" },
];

const NAV = [
  { to: "/", label: "Kasir", icon: Storefront },
  { to: "/riwayat", label: "Riwayat", icon: Receipt },
] as const;

/**
 * The instrument chrome: a hairline-ruled top bar carrying the brand mark, the
 * two workspace routes, the active-provider selector, and the theme switch.
 * The provider selector lives here because it scopes every surface below it.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { snapshot, isBusy, pendingAction, run } = useConsole();

  const changeProvider = (id: ProviderId) => {
    if (id === snapshot.activeProviderId || isBusy) return;
    void run(`provider-${id}`, () =>
      setActiveProvider({ data: { providerId: id } }),
    );
  };

  return (
    <div className="mx-auto flex min-h-[100dvh] max-w-5xl flex-col px-4 sm:px-6">
      <header className="flex items-center justify-between gap-4 py-3.5">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="grid size-6 place-items-center rounded-md bg-foreground text-background"
          >
            <span className="text-[0.8125rem] font-semibold leading-none">
              M
            </span>
          </span>
          <span className="text-sm font-semibold tracking-[-0.025em]">
            MerchantId <span className="text-muted-foreground">Console</span>
          </span>
        </div>
        <ThemeSwitch />
      </header>

      <div className="rule-dashed" role="presentation" />

      <div className="flex flex-wrap items-center justify-between gap-3 py-2.5">
        <nav className="flex items-center gap-px" aria-label="Ruang kerja">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="group inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-[background-color,color] duration-150 hover:text-foreground data-[status=active]:bg-secondary data-[status=active]:text-foreground"
              activeOptions={{ exact: item.to === "/" }}
            >
              <item.icon aria-hidden="true" className="size-3.5" />
              {item.label}
            </Link>
          ))}
        </nav>

        <div
          role="group"
          aria-label="Provider aktif"
          className="inline-flex items-center gap-px overflow-hidden rounded-md border border-border bg-border"
        >
          {PROVIDERS.map((provider) => {
            const active = snapshot.activeProviderId === provider.id;
            const connected = snapshot.providers[provider.id].authenticated;
            return (
              <button
                key={provider.id}
                type="button"
                aria-pressed={active}
                disabled={isBusy}
                onClick={() => changeProvider(provider.id)}
                className={cn(
                  "inline-flex min-h-[1.625rem] items-center gap-1.5 bg-background px-2.5 text-xs font-medium transition-[background-color,color] duration-150 disabled:cursor-not-allowed",
                  active
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                  pendingAction === `provider-${provider.id}` && "opacity-60",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-[0.3125rem] rounded-full",
                    connected
                      ? "bg-accent-foreground"
                      : "bg-muted-foreground/40",
                  )}
                />
                {provider.label}
                <span className="sr-only">
                  {connected ? "terhubung" : "belum login"}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="rule-dashed" role="presentation" />

      <main className="flex-1 py-5">{children}</main>

      <div className="rule-dashed" role="presentation" />
      <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3 font-mono text-[0.625rem] uppercase tracking-[0.08em] text-muted-foreground">
        <span>{snapshot.storageLabel}</span>
        <span aria-hidden="true">·</span>
        <span>merchantid · file:../..</span>
      </footer>
    </div>
  );
}
