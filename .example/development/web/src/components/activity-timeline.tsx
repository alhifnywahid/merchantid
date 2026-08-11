import type { ActivityView } from "../lib/lab-types";
import { clearLabActivity } from "../server/functions";
import { Button, formatDateTime, type RunLabAction } from "./lab-ui";

interface ActivityTimelineProps {
  activity: ActivityView[];
  pendingAction?: string;
  runAction: RunLabAction;
}

export function ActivityTimeline({
  activity,
  pendingAction,
  runAction,
}: ActivityTimelineProps) {
  return (
    <details className="disclosure disclosure--panel">
      <summary>
        <span>
          Aktivitas <span className="disclosure__count">{activity.length}</span>
        </span>
        <span className="disclosure__marker" aria-hidden="true">
          +
        </span>
      </summary>

      <div className="disclosure__body">
        <div className="timeline" aria-live="polite">
          {activity.map((item) => (
            <article className="timeline__item" key={item.id}>
              <span
                className="timeline__tone"
                data-tone={item.tone}
                aria-hidden="true"
              />
              <div>
                <strong className="timeline__event">{item.title}</strong>
                <p className="timeline__message">{item.message}</p>
                <time
                  className="timeline__time"
                  dateTime={new Date(item.at).toISOString()}
                >
                  {formatDateTime(item.at)}
                </time>
              </div>
            </article>
          ))}
        </div>

        <div className="form__footer">
          <Button
            tone="ghost"
            busy={pendingAction === "clear-activity"}
            disabled={pendingAction !== undefined}
            onClick={() =>
              void runAction(
                "clear-activity",
                () => clearLabActivity(),
                "Catatan dihapus",
              )
            }
          >
            Hapus catatan
          </Button>
        </div>
      </div>
    </details>
  );
}
