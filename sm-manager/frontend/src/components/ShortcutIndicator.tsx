import type { ShortcutStep } from "../app/useSidebarShortcuts";
import type { ShortcutScope } from "../app/shortcutTargets";
import "./shortcuts.css";

export function ShortcutKey({ letter }: { letter: string }) {
  return (
    <kbd className="st-shortcut-key" aria-hidden="true">
      {letter}
    </kbd>
  );
}

export function ShortcutIndicator({
  step,
  scope = "main",
}: {
  step: ShortcutStep;
  scope?: ShortcutScope;
}) {
  const label = {
    main: "Main sidebar",
    planner: "Planner",
    agents: "Projects & conversations",
    project: "Project conversations",
    conversation: "Agents & conversation actions",
    recent: "Recent conversations",
  }[scope];
  const agents = ["agents", "project", "conversation"].includes(scope);
  return (
    <>
      <span
        className="st-shortcut-announcement"
        role="status"
        aria-live="polite"
      >
        {step === 2
          ? `${label} shortcuts ready. Escape cancels. Shift or Left Arrow opens main sidebar shortcuts.`
          : ""}
      </span>
      <div
        className="st-shortcut-indicator"
        data-step={step}
        data-scope={scope}
        aria-hidden="true"
      >
        <div className="st-shortcut-hint">
          <span>{step === 2 ? label : "One more tap"}</span>
          {step === 2 && agents && (
            <small>
              <kbd>E</kbd> Recent conversations & terminals
            </small>
          )}
          <small>
            {step === 2
              ? `${scope !== "main" ? "⇧ / ← Main sidebar · " : ""}Esc Cancel`
              : "Tap Ctrl again"}
          </small>
        </div>
        <div className="st-shortcut-orb">
          <svg viewBox="0 0 64 64" fill="none">
            <circle className="st-shortcut-track" cx="32" cy="32" r="28" />
            <circle
              className="st-shortcut-progress"
              cx="32"
              cy="32"
              r="28"
              pathLength="100"
            />
          </svg>
          <span>Ctrl</span>
          <span className="st-shortcut-dots">
            <i />
            <i />
          </span>
        </div>
      </div>
    </>
  );
}
