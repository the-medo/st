/** Ovis's browser capabilities are scoped to its host; browser globals stay intact. */
export type OvisHost = {
  root: HTMLElement;
  active: boolean;
  navigate: (url: string, replace: boolean, state?: unknown) => void;
  title: (title: string) => void;
};
let host: OvisHost | null = null;
const listeners = new Set<() => void>();
export function setOvisHost(value: OvisHost | null) {
  const changed = host?.active !== value?.active;
  host = value;
  if (changed) listeners.forEach((fn) => fn());
}
export function ovisUrl(input: string | URL) {
  const url = new URL(String(input), globalThis.location.href);
  if (
    url.host === globalThis.location.host &&
    (/^\/api\//.test(url.pathname) || url.pathname === "/ws")
  )
    url.pathname = "/ovis" + url.pathname;
  return url.href;
}
function routeUrl(input: string | URL) {
  const u = new URL(String(input), globalThis.location.href);
  if (
    u.origin === globalThis.location.origin &&
    !/^\/ovis(?:\/|$)/.test(u.pathname)
  )
    u.pathname = "/ovis" + (u.pathname === "/" ? "" : u.pathname);
  return u;
}
export const hostFetch = (input: RequestInfo | URL, init?: RequestInit) =>
  globalThis.fetch(
    input instanceof Request
      ? new Request(ovisUrl(input.url), input)
      : ovisUrl(input),
    init,
  );
export class HostWebSocket extends globalThis.WebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(ovisUrl(url), protocols);
  }
}
export class HostEventSource extends globalThis.EventSource {
  constructor(url: string | URL, options?: EventSourceInit) {
    super(ovisUrl(url), options);
  }
}
const popEvents = new WeakMap<Event, Event>();
function scopedEvent(event: Event) {
  if (event.type !== "popstate") return event;
  let scoped = popEvents.get(event);
  if (!scoped) {
    scoped = new Proxy(event, {
      get(target, key) {
        if (key === "state")
          return (target as PopStateEvent).state?.usr ?? null;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    popEvents.set(event, scoped);
  }
  return scoped;
}
const wrapped = new WeakMap<object, Map<string, EventListener>>();
function listen(
  target: Document | Window,
  type: string,
  listener: EventListenerOrEventListenerObject | null,
  options?: boolean | AddEventListenerOptions,
) {
  if (!listener) return;
  const invoke = (event: Event) => {
    if (host) {
      if (type === "popstate" && !host.active) return;
      if (
        /^(?:key|paste|copy|cut)/.test(type) &&
        (!host.active || !host.root.contains(event.target as Node))
      )
        return;
    }
    if (typeof listener === "function")
      listener.call(target, scopedEvent(event));
    else listener.handleEvent(scopedEvent(event));
  };
  const key =
    (target === globalThis.document ? "doc:" : "win:") +
    type +
    ":" +
    Boolean(typeof options === "boolean" ? options : options?.capture);
  const map = wrapped.get(listener) ?? new Map();
  if (map.has(key)) return;
  map.set(key, invoke);
  wrapped.set(listener, map);
  target.addEventListener(type, invoke, options);
  if (type === "visibilitychange") {
    const signal = () => invoke(new Event("visibilitychange"));
    listeners.add(signal);
    visibilityCallbacks.set(invoke, signal);
  }
}
const visibilityCallbacks = new WeakMap<EventListener, () => void>();
function unlisten(
  target: Document | Window,
  type: string,
  listener: EventListenerOrEventListenerObject | null,
  options?: boolean | EventListenerOptions,
) {
  if (!listener) return;
  const key =
    (target === globalThis.document ? "doc:" : "win:") +
    type +
    ":" +
    Boolean(typeof options === "boolean" ? options : options?.capture);
  const map = wrapped.get(listener);
  const invoke = map?.get(key);
  if (invoke) {
    target.removeEventListener(type, invoke, options);
    const signal = visibilityCallbacks.get(invoke);
    if (signal) listeners.delete(signal);
    map!.delete(key);
  }
}
const docTarget = (key: PropertyKey) =>
  host && (key === "body" || key === "documentElement") ? host.root : undefined;
export const hostDocument = new Proxy({} as Document, {
  get(_target, key) {
    const real = globalThis.document;
    if (!real) return undefined;
    if (key === "hidden") return real.hidden || (!!host && !host.active);
    if (key === "visibilityState")
      return real.hidden || (!!host && !host.active) ? "hidden" : "visible";
    const scoped = docTarget(key);
    if (scoped) return scoped;
    if (key === "getElementById" && host)
      return (id: string) =>
        id === "root"
          ? host!.root
          : host!.root.querySelector(`#${CSS.escape(id)}`);
    if ((key === "querySelector" || key === "querySelectorAll") && host)
      return host.root[key].bind(host.root);
    if (key === "addEventListener")
      return (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: AddEventListenerOptions,
      ) => listen(real, type, listener, options);
    if (key === "removeEventListener")
      return (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: EventListenerOptions,
      ) => unlisten(real, type, listener, options);
    const value = Reflect.get(real, key, real);
    return typeof value === "function" ? value.bind(real) : value;
  },
  set(_target, key, value) {
    if (key === "title" && host) {
      if (host.active) host.title(String(value));
      return true;
    }
    return Reflect.set(globalThis.document, key, value);
  },
});
export const hostLocation = new Proxy({} as Location, {
  get(_target, key) {
    const real = globalThis.location;
    if (key === "assign" || key === "replace")
      return (url: string) => {
        const next = routeUrl(url);
        if (host && next.origin === real.origin)
          host.navigate(
            next.pathname + next.search + next.hash,
            key === "replace",
          );
        else real[key](url);
      };
    const value = Reflect.get(real, key, real);
    return typeof value === "function" ? value.bind(real) : value;
  },
  set(_target, key, value) {
    if (key === "href" && host) {
      const next = routeUrl(String(value));
      if (next.origin === globalThis.location.origin)
        host.navigate(next.pathname + next.search + next.hash, false);
      else globalThis.location.href = String(value);
      return true;
    }
    return Reflect.set(globalThis.location, key, value);
  },
});
const hostHistory = new Proxy({} as History, {
  get(_target, key) {
    const real = globalThis.history;
    if (key === "pushState" || key === "replaceState")
      return (state: unknown, _unused: string, url?: string | URL | null) => {
        if (host) {
          if (host.active && url) {
            const next = routeUrl(url);
            host.navigate(
              next.pathname + next.search + next.hash,
              key === "replaceState",
              state,
            );
          }
        } else real[key](state, "", url);
      };
    if (key === "state" && host) return real.state?.usr ?? null;
    const value = Reflect.get(real, key, real);
    return typeof value === "function" ? value.bind(real) : value;
  },
});
export const hostWindow = new Proxy({} as Window & typeof globalThis, {
  get(_target, key) {
    const real = globalThis.window;
    if (!real) return undefined;
    if (key === "event" && real.event) return scopedEvent(real.event);
    if (key === "document") return hostDocument;
    if (key === "location") return hostLocation;
    if (key === "history") return hostHistory;
    if (key === "innerWidth" && host) return host.root.clientWidth;
    if (key === "innerHeight" && host) return host.root.clientHeight;
    if (key === "fetch") return hostFetch;
    if (key === "open")
      return (url?: string | URL, target?: string, features?: string) =>
        real.open(url ? routeUrl(url) : url, target, features);
    if (key === "addEventListener")
      return (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: AddEventListenerOptions,
      ) => listen(real, type, listener, options);
    if (key === "removeEventListener")
      return (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: EventListenerOptions,
      ) => unlisten(real, type, listener, options);
    const value = Reflect.get(real, key, real);
    return typeof value === "function" && !/^[A-Z]/.test(String(key))
      ? value.bind(real)
      : value;
  },
  set(_target, key, value) {
    return Reflect.set(globalThis.window, key, value);
  },
});
