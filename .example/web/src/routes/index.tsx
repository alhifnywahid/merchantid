import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import { ActivityTimeline } from "../components/activity-timeline";
import {
  Button,
  ThemeSwitch,
  formatDateTime,
  type RunLabAction,
} from "../components/lab-ui";
import { PaymentLedger } from "../components/payment-ledger";
import { PaymentWorkbench } from "../components/payment-workbench";
import { ProviderAccess } from "../components/provider-access";
import type { ActionResult, LabSnapshot, ProviderId } from "../lib/lab-types";
import { getLabSnapshot, setActiveProvider } from "../server/functions";

const providerIds = ["gopay", "shopee"] as const;

const providerNames: Record<ProviderId, string> = {
  gopay: "GoPay",
  shopee: "Shopee",
};

export const Route = createFileRoute("/")({
  loader: () => getLabSnapshot(),
  pendingComponent: BootState,
  errorComponent: ({ error }) => <BootError error={error} />,
  component: DevelopmentLab,
});

function DevelopmentLab() {
  const initialSnapshot = Route.useLoaderData();
  const [snapshot, setSnapshot] = useState<LabSnapshot>(initialSnapshot);
  const [pendingAction, setPendingAction] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();

  const activeProvider = snapshot.providers[snapshot.activeProviderId];
  const activity = snapshot.activity.filter(
    (item) =>
      item.providerId === undefined ||
      item.providerId === snapshot.activeProviderId,
  );
  const payments = snapshot.payments.filter(
    (payment) => payment.provider === snapshot.activeProviderId,
  );

  // Progressive disclosure: a surface appears only once it can be acted on.
  const showWorkbench =
    activeProvider.authStage === "ready" && activeProvider.scope !== undefined;

  useEffect(() => {
    if (!notice && !error) return;
    const timeout = window.setTimeout(() => {
      setNotice(undefined);
      setError(undefined);
    }, 5_000);
    return () => window.clearTimeout(timeout);
  }, [notice, error]);

  const runAction = useCallback<RunLabAction>(
    async (actionId, operation, fallbackNotice) => {
      setPendingAction(actionId);
      setError(undefined);
      try {
        const result: ActionResult = await operation();
        setSnapshot(result.snapshot);
        setNotice(result.notice ?? fallbackNotice);
        return true;
      } catch (caught) {
        setError(toSafeClientMessage(caught));
        return false;
      } finally {
        setPendingAction(undefined);
      }
    },
    [],
  );

  const changeProvider = async (providerId: ProviderId) => {
    if (providerId === snapshot.activeProviderId || pendingAction) return;
    await runAction(
      `provider-${providerId}`,
      () => setActiveProvider({ data: { providerId } }),
      `${providerNames[providerId]} aktif`,
    );
  };

  const handleTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    providerId: ProviderId,
  ) => {
    const currentIndex = providerIds.indexOf(providerId);
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % providerIds.length;
    }
    if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + providerIds.length) % providerIds.length;
    }
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = providerIds.length - 1;
    if (nextIndex === undefined) return;

    event.preventDefault();
    const nextProvider = providerIds[nextIndex];
    if (!nextProvider) return;
    document.getElementById(`provider-tab-${nextProvider}`)?.focus();
    void changeProvider(nextProvider);
  };

  return (
    <div className="lab" aria-busy={pendingAction !== undefined}>
      <a className="skip-link" href="#workspace">
        Lewati ke workspace
      </a>

      <div className="shell">
        <header className="topbar">
          <div className="brand">
            <span className="brand__mark" aria-hidden="true">
              M
            </span>
            <h1 className="brand__name">MerchantId Lab</h1>
          </div>
          <ThemeSwitch />
        </header>
      </div>

      <div className="rule" role="presentation" />

      <div className="shell">
        <p className="alert" role="note">
          Semua aksi memakai akun provider nyata.
        </p>
      </div>

      <div className="provider-bar">
        <div className="shell">
          <nav
            className="provider-switch"
            role="tablist"
            aria-label="Provider aktif"
          >
            {providerIds.map((providerId) => {
              const selected = snapshot.activeProviderId === providerId;
              const provider = snapshot.providers[providerId];
              return (
                <button
                  key={providerId}
                  id={`provider-tab-${providerId}`}
                  className="provider-switch__tab"
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={`provider-panel-${providerId}`}
                  tabIndex={selected ? 0 : -1}
                  disabled={pendingAction !== undefined}
                  onClick={() => void changeProvider(providerId)}
                  onKeyDown={(event) => handleTabKeyDown(event, providerId)}
                >
                  <span
                    className="provider-switch__dot"
                    data-live={provider.authenticated}
                    aria-hidden="true"
                  />
                  <span>{providerNames[providerId]}</span>
                  <span className="sr-only">
                    {provider.authenticated ? "terhubung" : "belum login"}
                  </span>
                </button>
              );
            })}
          </nav>
        </div>
      </div>

      <main className="workspace" id="workspace">
        <section
          key={activeProvider.id}
          id={`provider-panel-${activeProvider.id}`}
          className="shell panel"
          role="tabpanel"
          aria-label={activeProvider.label}
          tabIndex={0}
        >
          <div className="grid" data-columns={showWorkbench ? 2 : 1}>
            <ProviderAccess
              provider={activeProvider}
              pendingAction={pendingAction}
              runAction={runAction}
            />
            {showWorkbench ? (
              <>
                <div className="grid__rail" role="presentation" />
                <PaymentWorkbench
                  provider={activeProvider}
                  pendingAction={pendingAction}
                  runAction={runAction}
                />
              </>
            ) : null}
          </div>

          {payments.length > 0 ? (
            <div className="section">
              <PaymentLedger
                payments={payments}
                providerId={snapshot.activeProviderId}
                pendingAction={pendingAction}
                runAction={runAction}
              />
            </div>
          ) : null}

          {activity.length > 0 ? (
            <div className="section">
              <ActivityTimeline
                activity={activity}
                pendingAction={pendingAction}
                runAction={runAction}
              />
            </div>
          ) : null}
        </section>
      </main>

      <div className="shell">
        <div className="rule rule--inset" role="presentation" />
        <footer className="footer">
          <span>{snapshot.storageLabel}</span>
          <span>{snapshot.packageSource}</span>
          <span>{formatDateTime(snapshot.startedAt)}</span>
        </footer>
      </div>

      <div className="toast-stack">
        {notice ? (
          <div className="toast" role="status">
            <span>{notice}</span>
            <button
              className="toast__close"
              type="button"
              aria-label="Tutup"
              onClick={() => setNotice(undefined)}
            >
              ×
            </button>
          </div>
        ) : null}
        {error ? (
          <div className="toast toast--error" role="alert">
            <span>{error}</span>
            <button
              className="toast__close"
              type="button"
              aria-label="Tutup"
              onClick={() => setError(undefined)}
            >
              ×
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function BootState() {
  return (
    <main className="boot" aria-busy="true">
      <div className="boot__inner">
        <span className="skeleton" style={{ height: "1.25rem", width: "45%" }} />
        <span className="skeleton" style={{ height: "0.75rem", width: "80%" }} />
        <span className="skeleton" style={{ height: "0.75rem", width: "62%" }} />
      </div>
    </main>
  );
}

function BootError({ error }: { error: Error }) {
  return (
    <main className="boot">
      <div className="boot__inner">
        <h1 className="boot__title">Runtime gagal dimuat</h1>
        <p className="boot__body">{toSafeClientMessage(error)}</p>
        <div>
          <Button onClick={() => window.location.reload()}>Muat ulang</Button>
        </div>
      </div>
    </main>
  );
}

function toSafeClientMessage(caught: unknown): string {
  if (caught instanceof Error && caught.message.trim()) return caught.message;
  return "Aksi gagal. Periksa terminal server.";
}
