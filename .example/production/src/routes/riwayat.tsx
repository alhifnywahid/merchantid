import { createFileRoute, Link } from "@tanstack/react-router";
import { ActivityPanel } from "@/components/activity-panel";
import { AppShell } from "@/components/app-shell";
import { LedgerPanel } from "@/components/ledger-panel";
import { Button } from "@/components/ui/button";
import { ConsoleProvider, useConsole } from "@/lib/console-store";
import { getConsoleSnapshot } from "@/server/functions";

export const Route = createFileRoute("/riwayat")({
  loader: () => getConsoleSnapshot(),
  component: LedgerRoute,
});

function LedgerRoute() {
  const snapshot = Route.useLoaderData();
  return (
    <ConsoleProvider initialSnapshot={snapshot}>
      <AppShell>
        <Ledger />
      </AppShell>
    </ConsoleProvider>
  );
}

function Ledger() {
  const { snapshot } = useConsole();
  const provider = snapshot.providers[snapshot.activeProviderId];

  if (!provider.authenticated) {
    return (
      <div className="panel-in mx-auto flex max-w-md flex-col items-center gap-3 py-12 text-center">
        <p className="text-sm text-muted-foreground">
          Login {provider.label} untuk melihat riwayat pembayarannya.
        </p>
        <Button asChild variant="outline">
          <Link to="/">Ke kasir</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="panel-in grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] lg:items-start">
      <LedgerPanel providerId={snapshot.activeProviderId} />
      <ActivityPanel />
    </div>
  );
}
