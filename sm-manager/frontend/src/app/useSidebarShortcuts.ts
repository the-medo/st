import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  agentsSelection,
  recentConversations,
  recentDetails,
  type RecentConversation,
} from "../features/ovis/shortcuts";
import {
  agentsBindings,
  mainBindings,
  plannerBindings,
  type ShortcutScope,
} from "./shortcutTargets";
import hintStyles from "../components/shortcut-keycaps.css?inline";
import "../components/shortcut-keycaps.css";

export type ShortcutStep = 0 | 1 | 2;
export const CTRL_TAP_WINDOW = 700;
export const SHORTCUT_WINDOW = 8000;
export type RecentPicker = { items: RecentConversation[]; index: number };
type ShortcutState = {
  step: ShortcutStep;
  scope: ShortcutScope;
  recent: RecentPicker | null;
};
const idle: ShortcutState = { step: 0, scope: "main", recent: null };

/** Released Ctrl taps opt in. Ordinary modifier chords and typing pass through. */
export function useSidebarShortcuts(
  sidebar: RefObject<HTMLElement | null>,
  route: string,
) {
  const [state, setState] = useState<ShortcutState>(idle);
  const plannerFrame = useRef<Window | null>(null);
  const registerFrame = useRef<(frame: Window | null) => void>(() => {});
  const routeChanged = useRef(() => {});
  const commands = useRef({
    cancel: () => {},
    openRecent: (_index: number) => {},
    showRecent: () => {},
  });
  const connectPlanner = useCallback((frame: Window | null) => {
    plannerFrame.current = frame;
    registerFrame.current(frame);
  }, []);
  useLayoutEffect(() => routeChanged.current(), [route]);

  useEffect(() => {
    let current = idle;
    let project: string | null = null;
    let ctrlDown: number | null = null;
    let shiftAlone = false;
    let chord = false;
    let waitingForPlanner = false;
    const consumed = new Set<string>();
    let sequenceUrl = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let animationFrame = 0;
    let marked: HTMLElement[] = [];
    let selected: HTMLElement | null = null;
    const publish = (next: ShortcutState) => {
      current = next;
      setState(next);
    };
    const clearHints = () => {
      for (const el of marked) {
        delete el.dataset.stShortcut;
        el.querySelector(":scope > .st-context-key")?.remove();
      }
      marked = [];
      if (selected) delete selected.dataset.stShortcutSelected;
      selected = null;
    };
    const removeCalendarButton = () =>
      plannerFrame.current?.document
        .querySelector("[data-st-calendar-new]")
        ?.remove();
    const bindings = () => {
      if (current.scope === "main") return mainBindings(sidebar.current);
      if (current.scope === "planner")
        return plannerBindings(plannerFrame.current?.document, reset);
      return agentsBindings(current.scope, project, (id) => {
        project = id;
      });
    };
    const refresh = () => {
      animationFrame = 0;
      if (current.step !== 2 || current.scope !== "planner")
        removeCalendarButton();
      if (
        current.step !== 2 ||
        current.scope === "main" ||
        current.scope === "recent"
      ) {
        clearHints();
        return;
      }
      if (
        selected &&
        (current.scope !== "project" || selected.dataset.stProject !== project)
      ) {
        delete selected.dataset.stShortcutSelected;
      }
      // Keep unchanged caps mounted: live terminal/status updates must not restart
      // their entrance animation or make the sidebar flicker.
      const next = bindings();
      if (current.scope === "planner") {
        // A cold Planner page can take longer than the shortcut window to load.
        // Give the user the full window once its Quick Add control is available.
        if (!next.some((binding) => binding.key === "Q")) {
          clearTimeout(timer);
          waitingForPlanner = true;
        } else if (waitingForPlanner) {
          waitingForPlanner = false;
          timeout();
        }
      }
      const keep = new Set(next.map((binding) => binding.element));
      for (const el of marked)
        if (!keep.has(el)) {
          delete el.dataset.stShortcut;
          el.querySelector(":scope > .st-context-key")?.remove();
        }
      for (const binding of next) {
        if (binding.element.dataset.stShortcut !== binding.key)
          binding.element.dataset.stShortcut = binding.key;
        let cap = binding.element.querySelector<HTMLElement>(
          ":scope > .st-context-key",
        );
        if (!cap) {
          cap = binding.element.ownerDocument.createElement("kbd");
          cap.className = "st-context-key";
          cap.setAttribute("aria-hidden", "true");
          binding.element.append(cap);
        }
        if (cap.textContent !== binding.key) cap.textContent = binding.key;
      }
      marked = [...keep];
      selected = document.querySelector<HTMLElement>(
        "[data-st-shortcut-selected]",
      );
    };
    const scheduleRefresh = () => {
      if (current.step === 2 && !animationFrame)
        animationFrame = requestAnimationFrame(refresh);
    };
    const reset = () => {
      clearTimeout(timer);
      ctrlDown = null;
      shiftAlone = false;
      chord = false;
      waitingForPlanner = false;
      project = null;
      sequenceUrl = "";
      publish(idle);
      clearHints();
      removeCalendarButton();
    };
    const timeout = () => {
      clearTimeout(timer);
      if (current.scope !== "recent")
        timer = setTimeout(
          reset,
          current.step === 1 ? CTRL_TAP_WINDOW : SHORTCUT_WINDOW,
        );
    };
    const activate = (scope: ShortcutScope) => {
      sequenceUrl = location.href;
      publish({ step: 2, scope, recent: null });
      timeout();
      // Make the numbered project list available even if the user collapsed it.
      if (scope === "agents" || scope === "conversation") {
        const root = document.querySelector(".st-ovis-root");
        root
          ?.querySelector<HTMLElement>('.sidebar-toggle[aria-pressed="false"]')
          ?.click();
        const drawer = root?.querySelector<HTMLElement>(
          '#drawer-toggle[aria-expanded="false"]',
        );
        if (drawer && getComputedStyle(drawer).display !== "none")
          drawer.click();
      }
      refresh();
    };
    const pageScope = (): ShortcutScope => {
      if (location.pathname.startsWith("/planner/")) return "planner";
      if (location.pathname.startsWith("/ovis"))
        return agentsSelection() ? "conversation" : "agents";
      return "main";
    };
    const openRecent = (index: number) => {
      const item = current.recent?.items[index];
      if (!item || !recentDetails(item).available) return;
      reset();
      recentDetails(item).open();
    };
    const showRecent = () => {
      clearTimeout(timer);
      const items = recentConversations().slice();
      const currentId = agentsSelection()?.id;
      const index = items.length > 1 && items[0]?.id === currentId ? 1 : 0;
      publish({ step: 2, scope: "recent", recent: { items, index } });
      refresh();
    };
    const take = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      consumed.add(event.code);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.repeat && consumed.has(event.code)) {
        take(event);
        return;
      }
      if (
        event.isComposing ||
        event.key === "Dead" ||
        event.key === "Process"
      ) {
        reset();
        return;
      }
      if (event.key === "Escape" && current.step !== 0) {
        take(event);
        reset();
        return;
      }
      // Ctrl+Shift is a deliberate alternate entry chord, in either press order.
      // Activate on release so Ctrl+Shift+C/P/etc keep their native behavior.
      if (
        (event.key === "Shift" && event.ctrlKey) ||
        (event.key === "Control" && event.shiftKey)
      ) {
        if (!event.altKey && !event.metaKey && !event.repeat) {
          chord = true;
          ctrlDown = null;
          shiftAlone = false;
        }
        return;
      }
      if (event.key === "Control") {
        if (event.altKey || event.metaKey) reset();
        else if (!event.repeat && ctrlDown === null) {
          ctrlDown = Date.now();
          sequenceUrl = location.href;
        }
        return;
      }
      if (
        event.key === "Shift" &&
        current.step === 2 &&
        !event.altKey &&
        !event.metaKey
      ) {
        shiftAlone = true;
        return;
      }
      shiftAlone = false;
      if (event.ctrlKey || event.altKey || event.metaKey) {
        reset();
        return;
      }
      if (current.step !== 2) {
        reset();
        return;
      }
      if (event.key === "ArrowLeft" && !event.shiftKey) {
        take(event);
        activate("main");
        return;
      }
      if (current.scope === "recent") {
        const key = event.key.toUpperCase();
        if (["E", "ARROWDOWN", "ARROWUP", "ENTER"].includes(key)) {
          take(event);
          if (key === "ENTER") {
            openRecent(current.recent!.index);
            return;
          }
          const { items, index } = current.recent!;
          const direction =
            key === "ARROWUP" || (key === "E" && event.shiftKey) ? -1 : 1;
          publish({
            ...current,
            recent: {
              items,
              index: items.length
                ? (index + direction + items.length) % items.length
                : 0,
            },
          });
        }
        return;
      }
      if (
        event.key.toUpperCase() === "E" &&
        ["agents", "project", "conversation"].includes(current.scope) &&
        !event.shiftKey
      ) {
        take(event);
        showRecent();
        return;
      }
      const binding =
        !event.shiftKey && !event.repeat
          ? bindings().find((item) => item.key === event.key.toUpperCase())
          : undefined;
      if (!binding) {
        reset();
        return;
      }
      take(event);
      if (binding.element.matches(":disabled")) {
        timeout();
        return;
      }
      if (binding.next) {
        // Keep the controller ready across lazy routes and asynchronous session opens.
        // Project identity is supplied by the action before the new bindings are drawn.
        publish({ step: 2, scope: binding.next, recent: null });
        timeout();
        binding.run();
        sequenceUrl = location.href;
        if (binding.next === "agents") activate("agents");
        else scheduleRefresh();
      } else {
        // Removing an injected calendar button must wait until its click is delivered.
        clearTimeout(timer);
        publish(idle);
        clearHints();
        binding.run();
        reset();
      }
    };
    const keyup = (event: KeyboardEvent) => {
      if (consumed.delete(event.code)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      if (chord && (event.key === "Control" || event.key === "Shift")) {
        chord = false;
        ctrlDown = null;
        shiftAlone = false;
        activate("main");
        return;
      }
      if (event.key === "Shift") {
        if (shiftAlone && current.step === 2) activate("main");
        shiftAlone = false;
        return;
      }
      if (event.key !== "Control") return;
      const started = ctrlDown;
      ctrlDown = null;
      if (started === null) return;
      if (
        Date.now() - started > CTRL_TAP_WINDOW ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        event.shiftKey ||
        current.step === 2
      ) {
        reset();
        return;
      }
      if (current.step === 1) activate(pageScope());
      else {
        publish({ step: 1, scope: pageScope(), recent: null });
        timeout();
      }
    };
    const blur = () => {
      consumed.clear();
      reset();
    };
    const pointer = (event: PointerEvent) => {
      if (
        (event.target as Element | null)?.closest?.(
          ".st-recent-overlay, [data-st-calendar-new]",
        )
      )
        return;
      reset();
    };
    const listen = (target: Window) => {
      const doc = target.document;
      target.addEventListener("keydown", keydown, true);
      target.addEventListener("keyup", keyup, true);
      target.addEventListener("blur", blur);
      target.addEventListener("pointerdown", pointer, true);
      target.addEventListener("compositionstart", reset, true);
      doc.addEventListener("visibilitychange", reset);
      const observer = new MutationObserver(scheduleRefresh);
      observer.observe(doc.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          "class",
          "hidden",
          "disabled",
          "aria-current",
          "aria-pressed",
        ],
      });
      return () => {
        target.removeEventListener("keydown", keydown, true);
        target.removeEventListener("keyup", keyup, true);
        target.removeEventListener("blur", blur);
        target.removeEventListener("pointerdown", pointer, true);
        target.removeEventListener("compositionstart", reset, true);
        doc.removeEventListener("visibilitychange", reset);
        observer.disconnect();
      };
    };
    const disconnectMain = listen(window);
    window.addEventListener("popstate", reset);
    let disconnectFrame = () => {};
    registerFrame.current = (frame) => {
      disconnectFrame();
      if (frame) {
        const style = frame.document.createElement("style");
        style.textContent = hintStyles;
        frame.document.head.append(style);
        const disconnect = listen(frame);
        disconnectFrame = () => {
          disconnect();
          style.remove();
        };
      } else disconnectFrame = () => {};
      scheduleRefresh();
    };
    registerFrame.current(plannerFrame.current);
    routeChanged.current = () => {
      if (sequenceUrl === location.href) return;
      if (
        current.step !== 0 &&
        ((current.scope === "planner" &&
          location.pathname.startsWith("/planner/")) ||
          (["agents", "project", "conversation", "recent"].includes(
            current.scope,
          ) &&
            location.pathname.startsWith("/ovis")))
      ) {
        sequenceUrl = location.href;
        scheduleRefresh();
      } else reset();
    };
    commands.current = { cancel: reset, openRecent, showRecent };
    return () => {
      reset();
      disconnectMain();
      disconnectFrame();
      window.removeEventListener("popstate", reset);
      cancelAnimationFrame(animationFrame);
      registerFrame.current = () => {};
      routeChanged.current = () => {};
    };
  }, [sidebar]);

  return {
    ...state,
    connectPlanner,
    cancel: () => commands.current.cancel(),
    openRecent: (index: number) => commands.current.openRecent(index),
    showRecent: () => commands.current.showRecent(),
  };
}
