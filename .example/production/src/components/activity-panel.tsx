import { Trash } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useConsole } from "@/lib/console-store";
import { formatDateTime } from "@/lib/format";
import type { ActivityTone } from "@/lib/types";
import { clearConsoleActivity } from "@/server/functions";
import { cn } from "@/lib/utils";

const TONE_DOT: Record<ActivityTone, string> = {
  info: "bg-muted-foreground/50",
  success: "bg-accent-foreground",
  warning: "bg-foreground",
  danger: "bg-destructive",
};

/** The append-only server activity log, filtered to the active provider. */
export function ActivityPanel() {
  const { snapshot, isBusy, pendingAction, run } = useConsole();
  const activity = snapshot.activity.filter(
    (item) =>
      item.providerId === undefined ||
      item.providerId === snapshot.activeProviderId,
  );

  return (
    <Card aria-label="Aktivitas">
      <CardHeader>
        <CardTitle>Aktivitas</CardTitle>
        {activity.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={isBusy}
            className={
              pendingAction === "clear-activity" ? "opacity-60" : undefined
            }
            onClick={() =>
              void run(
                "clear-activity",
                () => clearConsoleActivity(),
                "Catatan dihapus",
              )
            }
          >
            <Trash aria-hidden="true" className="size-3.5" />
            Hapus
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {activity.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            Belum ada aktivitas.
          </p>
        ) : (
          <ol className="flex flex-col gap-3" aria-live="polite">
            {activity.map((item) => (
              <li key={item.id} className="flex gap-2.5">
                <span
                  aria-hidden="true"
                  className={cn(
                    "mt-1 size-1.5 shrink-0 rounded-full",
                    TONE_DOT[item.tone],
                  )}
                />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-xs font-medium leading-tight">
                    {item.title}
                  </span>
                  <span className="text-[0.6875rem] leading-snug text-muted-foreground">
                    {item.message}
                  </span>
                  <time
                    dateTime={new Date(item.at).toISOString()}
                    className="font-mono text-[0.5625rem] uppercase tracking-[0.06em] text-muted-foreground/70"
                  >
                    {formatDateTime(item.at)}
                  </time>
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
