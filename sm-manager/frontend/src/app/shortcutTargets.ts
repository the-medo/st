import { selectAgentsProject } from "../features/ovis/shortcuts";

export type ShortcutScope =
  | "main"
  | "planner"
  | "agents"
  | "project"
  | "conversation"
  | "recent";
export type ShortcutBinding = {
  key: string;
  element: HTMLElement;
  run: () => void;
  next?: ShortcutScope;
};
export const visible = (element: HTMLElement) =>
  element.isConnected &&
  element.getClientRects().length > 0 &&
  !element.closest("[hidden], [inert]") &&
  getComputedStyle(element).visibility !== "hidden";
const usable = (element: HTMLElement) =>
  visible(element) && !element.matches(":disabled");
const elements = (
  root: ParentNode,
  selector: string,
  includeDisabled = false,
) =>
  [...root.querySelectorAll<HTMLElement>(selector)].filter(
    includeDisabled ? visible : usable,
  );

export function mainBindings(sidebar: HTMLElement | null): ShortcutBinding[] {
  if (!sidebar) return [];
  return elements(sidebar, "[data-shortcut]").map((element) => {
    const href = element.getAttribute("href") ?? "";
    return {
      key: element.dataset.shortcut!,
      element,
      run: () => element.click(),
      next: href.startsWith("/ovis")
        ? "agents"
        : href.startsWith("/planner/")
          ? "planner"
          : undefined,
    };
  });
}

const plannerKeys = {
  contacts: "O",
  calendar: "C",
  tasks: "T",
  notes: "N",
  journals: "J",
};
const newLabels: Record<string, string> = {
  contacts: "New",
  tasks: "New task",
  notes: "New note",
  journals: "New journal",
};

export function plannerBindings(
  doc: Document | undefined,
  finish: () => void,
): ShortcutBinding[] {
  if (!doc) return [];
  // DAVe uses a memory router. Its active link is authoritative, not iframe.location.
  const links = elements(doc, "nav a[href]");
  const pathOf = (el: HTMLElement) =>
    new URL(el.getAttribute("href")!, location.origin).pathname
      .split("/")
      .at(-1)!;
  const active = links.find((el) => el.getAttribute("aria-current") === "page");
  const page = active ? pathOf(active) : location.pathname.split("/").at(-1)!;
  const bindings: ShortcutBinding[] = [];
  for (const [path, key] of Object.entries(plannerKeys)) {
    const element = links.find((el) => pathOf(el) === path);
    if (element && page !== path)
      bindings.push({
        key,
        element,
        next: "planner",
        run: () => element.click(),
      });
  }
  if (page === "calendar" && doc.querySelector(".fc")) {
    let button = doc.querySelector<HTMLButtonElement>("[data-st-calendar-new]");
    if (!button) {
      button = doc.createElement("button");
      button.type = "button";
      button.dataset.stCalendarNew = "";
      button.textContent = "+ New";
      button.title = "New event today";
      button.setAttribute("aria-label", "New event today");
      button.onclick = () => {
        finish();
        // Use DAVe's existing New Event command, which chooses today's next half hour.
        // Blur first because DAVe deliberately ignores this command in editable fields.
        (doc.activeElement as HTMLElement | null)?.blur();
        doc.dispatchEvent(
          new KeyboardEvent("keydown", { key: "n", bubbles: true }),
        );
      };
      const today = doc.querySelector(
        ".fc-day-today .fc-daygrid-day-frame, .fc-day-today .fc-scrollgrid-sync-inner, .fc-day-today",
      );
      (today ??
        doc.querySelector(".fc-toolbar") ??
        doc.querySelector(".fc"))!.append(button);
    }
    bindings.push({ key: "Q", element: button, run: () => button!.click() });
  } else {
    const element = elements(doc, "button").find(
      (el) =>
        [...el.childNodes]
          .filter(
            (node) =>
              node.nodeType !== 1 ||
              !(node as Element).classList.contains("st-context-key"),
          )
          .map((node) => node.textContent)
          .join("")
          .trim() === newLabels[page],
    );
    if (element)
      bindings.push({ key: "Q", element, run: () => element.click() });
  }
  return bindings;
}

export function agentsBindings(
  scope: ShortcutScope,
  project: string | null,
  chooseProject: (id: string) => void,
): ShortcutBinding[] {
  const root = document.querySelector(".st-ovis-root");
  if (!root) return [];
  const bindings: ShortcutBinding[] = [];
  const add = (key: string, selector: string, within: ParentNode = root) => {
    const element = elements(within, selector)[0];
    if (element)
      bindings.push({
        key,
        element,
        run: () => {
          element.focus({ preventScroll: true });
          element.click();
        },
      });
  };
  if (scope === "agents" || scope === "conversation") {
    elements(root, ".medo-project")
      .slice(0, 9)
      .forEach((section, i) => {
        const element = section.querySelector<HTMLElement>(
          ".medo-project-toggle",
        )!;
        bindings.push({
          key: String(i + 1),
          element,
          next: "project",
          run: () => {
            const id = section.dataset.stProject!;
            chooseProject(id);
            selectAgentsProject(id);
          },
        });
      });
    // Conversation mode exposes the sidebar and toolbar together. Keep their
    // keys distinct, including while a toolbar control is temporarily unavailable.
    const alphabet =
      scope === "conversation"
        ? "ABCDFGHIJKLMNOPRSTUVWXYZ".replace(/[FOTY]/g, "")
        : "ABCDFGHIJKLMNOPRSTUVWXYZ";
    elements(root, ".medo-chat-open", true)
      .slice(0, alphabet.length)
      .forEach((element, i) => {
        bindings.push({
          key: alphabet[i]!,
          element,
          run: () => element.click(),
        });
      });
    add("Q", '.medo-sidebar-head button[aria-label="New conversation"]');
  } else if (scope === "project") {
    const section = elements(root, ".medo-project").find(
      (el) => el.dataset.stProject === project,
    );
    if (!section) return bindings;
    section.dataset.stShortcutSelected = "true";
    elements(section, ".medo-chat-open", true)
      .slice(0, 9)
      .forEach((element, i) => {
        bindings.push({
          key: String(i + 1),
          element,
          run: () => element.click(),
        });
      });
    add(
      "Q",
      '.medo-project-head button[aria-label^="New conversation in "]',
      section,
    );
    add(
      "O",
      '.medo-project-head button[aria-label^="Actions for project "]',
      section,
    );
  }
  if (scope === "conversation") {
    add("T", ".tab-strip-add");
    add("Y", '.view-switch button[aria-pressed="false"], .lens-toggle');
    add("F", ".header-files-button");
    add("O", ".header-more-button");
  }
  return bindings;
}
