import { createFileRoute } from "@tanstack/react-router";
import { AmountPad } from "@/components/amount-pad";
import { AppShell } from "@/components/app-shell";
import { LoginPanel } from "@/components/login-panel";
import { QrisBinder } from "@/components/qris-binder";
import { QrisStage } from "@/components/qris-stage";
import { SessionPanel } from "@/components/session-panel";
import { Button } from "@/components/ui/button";
import { ConsoleProvider, useConsole } from "@/lib/console-store";
import { getConsoleSnapshot } from "@/server/functions";

export const Route = createFileRoute("/")({
  loader: () => getConsoleSnapshot(),
  pendingComponent: BootSkeleton,
  errorComponent: BootError,
  component: CheckoutRoute,
});

function CheckoutRoute() {
  const snapshot = Route.useLoaderData();
  return (
    <ConsoleProvider initialSnapshot={snapshot}>
      <AppShell>
        <Checkout />
      </AppShell>
    </ConsoleProvider>
  );
}

function Checkout() {
  const { snapshot } = useConsole();
  const provider = snapshot.providers[snapshot.activeProviderId];
  const ready = provider.authStage === "ready" && provider.scope !== undefined;

  const activePayment = snapshot.payments.find(
    (payment) =>
      payment.provider === snapshot.activeProviderId &&
      payment.status === "pending",
  );
  const latestForProvider = snapshot.payments.find(
    (payment) => payment.provider === snapshot.activeProviderId,
  );
  const stagePayment = activePayment ?? latestForProvider;

  if (!ready) {
    // Pre-scope: the login flow gets the full width, with the session card
    // surfacing beside it once a provider is authenticated but not yet scoped.
    return (
      <div className="panel-in mx-auto grid max-w-xl gap-4">
        {provider.authStage === "ready" ? (
          <SessionPanel provider={provider} />
        ) : (
          <LoginPanel provider={provider} />
        )}
        {provider.authenticated && !ready ? (
          <QrisBinder provider={provider} />
        ) : null}
      </div>
    );
  }

  const needsQris = !provider.hasStaticQris;

  return (
    <div className="panel-in grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-start">
      <div className="flex flex-col gap-4">
        <SessionPanel provider={provider} />
        {needsQris ? (
          <QrisBinder provider={provider} />
        ) : (
          <AmountPad provider={provider} />
        )}
      </div>
      <QrisStage
        payment={stagePayment}
        providerId={snapshot.activeProviderId}
      />
    </div>
  );
}

function BootSkeleton() {
  return (
    <div className="mx-auto flex min-h-[100dvh] max-w-xl flex-col justify-center gap-3 px-6">
      <div className="h-5 w-2/5 animate-pulse rounded-md bg-muted" />
      <div className="h-40 animate-pulse rounded-lg bg-muted" />
    </div>
  );
}

function BootError({ error }: { error: Error }) {
  return (
    <div className="mx-auto flex min-h-[100dvh] max-w-xl flex-col justify-center gap-3 px-6 text-center">
      <p className="font-mono text-[0.625rem] uppercase tracking-[0.08em] text-muted-foreground">
        Runtime gagal dimuat
      </p>
      <p className="text-sm text-muted-foreground">
        {error.message.trim() || "Periksa terminal server."}
      </p>
      <div className="flex justify-center">
        <Button variant="outline" onClick={() => window.location.reload()}>
          Muat ulang
        </Button>
      </div>
    </div>
  );
}
