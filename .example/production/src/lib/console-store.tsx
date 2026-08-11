import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import type { ActionResult, ConsoleSnapshot } from "@/lib/types";

export type RunConsoleAction = (
  actionId: string,
  operation: () => Promise<ActionResult>,
  fallbackNotice?: string,
) => Promise<boolean>;

interface ConsoleContextValue {
  snapshot: ConsoleSnapshot;
  pendingAction?: string;
  isBusy: boolean;
  run: RunConsoleAction;
}

const ConsoleContext = createContext<ConsoleContextValue | undefined>(
  undefined,
);

function toSafeMessage(caught: unknown): string {
  if (caught instanceof Error && caught.message.trim()) return caught.message;
  return "Aksi gagal. Periksa terminal server.";
}

/**
 * Holds the live console snapshot on the client and funnels every mutation
 * through one queue-aware runner. A single action may be in flight at a time
 * (`pendingAction`), which the whole UI reads to disable controls - the server
 * runtime is serial, so parallel clicks would only race for the same lock.
 */
export function ConsoleProvider({
  children,
  initialSnapshot,
}: {
  children: ReactNode;
  initialSnapshot: ConsoleSnapshot;
}) {
  const [snapshot, setSnapshot] = useState<ConsoleSnapshot>(initialSnapshot);
  const [pendingAction, setPendingAction] = useState<string>();

  const run = useCallback<RunConsoleAction>(
    async (actionId, operation, fallbackNotice) => {
      setPendingAction((current) => current ?? actionId);
      try {
        const result = await operation();
        setSnapshot(result.snapshot);
        const notice = result.notice ?? fallbackNotice;
        if (notice) toast.success(notice);
        return true;
      } catch (caught) {
        toast.error(toSafeMessage(caught));
        return false;
      } finally {
        setPendingAction(undefined);
      }
    },
    [],
  );

  const value = useMemo<ConsoleContextValue>(
    () => ({
      snapshot,
      pendingAction,
      isBusy: pendingAction !== undefined,
      run,
    }),
    [snapshot, pendingAction, run],
  );

  return (
    <ConsoleContext.Provider value={value}>{children}</ConsoleContext.Provider>
  );
}

export function useConsole(): ConsoleContextValue {
  const value = useContext(ConsoleContext);
  if (!value) throw new Error("useConsole must be used within ConsoleProvider");
  return value;
}
