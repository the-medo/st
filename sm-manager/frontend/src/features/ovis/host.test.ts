import { afterAll, expect, mock, test } from "bun:test";

// Exercise the browser adapter without starting React, sockets or agent sessions.
const names = ["EventSource", "window", "location", "history"] as const;
const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const install = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
install("EventSource", class {});
const { hostWindow, setOvisHost } = await import("./host");

afterAll(() => {
  setOvisHost(null);
  for (const name of names) {
    const descriptor = originals.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test("late terminal history cannot undo route exit before the inactive host commits", () => {
  const navigate = mock(() => {});
  const replaceState = mock(() => {});
  install("window", globalThis);
  install("history", { state: null, replaceState });
  install("location", new URL("https://st.test/agents?pane=fixture"));
  setOvisHost({ root: {} as HTMLElement, active: true, navigate, title: () => {} });

  hostWindow.history.replaceState(null, "", "/agents?pane=fixture&view=terminal");
  expect(navigate).toHaveBeenCalledWith("/agents?pane=fixture&view=terminal", true, null);
  navigate.mockClear();

  // React Router has moved the address; the retained Agents view is still active
  // until React commits the next screen. Its final URL write must be ignored.
  install("location", new URL("https://st.test/overview"));
  hostWindow.history.replaceState(null, "", "/overview?pane=fixture&view=terminal");
  expect(navigate).not.toHaveBeenCalled();
  expect(replaceState).not.toHaveBeenCalled();
});
