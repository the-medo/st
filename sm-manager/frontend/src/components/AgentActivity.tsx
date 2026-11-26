import { Check, CircleAlert, LoaderCircle, WifiOff } from "lucide-react";
import {
  agentActivityLabel,
  type AgentCounts,
} from "../features/ovis/activity";

export type AgentActivityState = {
  counts: AgentCounts | null;
  unavailable: boolean;
};
export function AgentActivity({ counts, unavailable }: AgentActivityState) {
  const primary = counts?.attention
    ? "attention"
    : counts?.unread
      ? "unread"
      : counts?.working
        ? "working"
        : "idle";
  const Icon = unavailable
    ? WifiOff
    : primary === "attention"
      ? CircleAlert
      : primary === "unread"
        ? Check
        : LoaderCircle;
  return (
    <>
      <span
        className="st-agent-activity"
        data-unavailable={unavailable}
        aria-hidden="true"
      >
        {counts && (counts.working || counts.unread || counts.attention) ? (
          <>
            {counts.working > 0 && (
              <span data-status="working" title={`${counts.working} working`}>
                <LoaderCircle
                  size={11}
                  className={unavailable ? undefined : "st-agent-spin"}
                />
                <b>{counts.working}</b>
              </span>
            )}
            {counts.unread > 0 && (
              <span
                data-status="unread"
                title={`${counts.unread} finished and unread`}
              >
                <Check size={11} />
                <b>{counts.unread}</b>
              </span>
            )}
            {counts.attention > 0 && (
              <span
                data-status="attention"
                title={`${counts.attention} need attention`}
              >
                <CircleAlert size={11} />
                <b>{counts.attention}</b>
              </span>
            )}
          </>
        ) : (
          <span className="st-agent-quiet">
            {unavailable
              ? "Status unavailable"
              : counts
                ? "All caught up"
                : "Checking activity…"}
          </span>
        )}
        {unavailable && counts && primary !== "idle" && (
          <WifiOff
            size={12}
            className="st-agent-offline"
            aria-label="Status updates unavailable"
          />
        )}
      </span>
      {(primary !== "idle" || unavailable) && (
        <span
          className="st-agent-compact"
          data-status={unavailable ? "unavailable" : primary}
          aria-hidden="true"
        >
          <Icon
            size={9}
            className={
              !unavailable && primary === "working"
                ? "st-agent-spin"
                : undefined
            }
          />
          {!unavailable && counts && primary !== "idle" && (
            <b>{counts[primary] > 99 ? "99+" : counts[primary]}</b>
          )}
        </span>
      )}
      <span className="st-shortcut-announcement" role="status">
        {agentActivityLabel(counts, unavailable)}
      </span>
    </>
  );
}
