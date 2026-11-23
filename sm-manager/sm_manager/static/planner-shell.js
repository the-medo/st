/* Keep the buildless console and lazily loaded planner alive in one tab.
 * The same-origin frame isolates DAVe's styles and portals. Its memory router
 * delegates history here so Back/Forward have exactly one entry per action. */
(() => {
  const consoleView = document.getElementById("st-console");
  const plannerView = document.getElementById("st-planner");
  const loading = document.getElementById("planner-loading");
  const message = document.getElementById("planner-loading-message");
  const retry = document.getElementById("planner-retry");
  const pages = new Set(["tasks", "calendar", "contacts", "notes", "journals"]);
  let frame;
  let ready = false;
  let framePath;
  let requestedPath;
  let loadTimer;
  let consoleScroll = 0;
  let returnFocus;

  function plannerPath(value) {
    if (typeof value !== "string" || !value.startsWith("/planner/")) return null;
    const url = new URL(value, location.origin);
    if (url.origin !== location.origin || !pages.has(url.pathname.slice(9))) return null;
    url.searchParams.delete("st-embedded");
    return url.pathname + url.search + url.hash;
  }
  function send(type, data = {}) {
    frame?.contentWindow?.postMessage({ type, ...data }, location.origin);
  }
  function activity() {
    if (ready) send("st:active", { active: !plannerView.hidden && !document.hidden });
  }
  function startFrame(path) {
    ready = false;
    loading.hidden = false;
    retry.hidden = true;
    message.textContent = "Opening planner…";
    if (!frame) {
      frame = document.createElement("iframe");
      frame.id = "planner-frame";
      frame.title = "ST Planner";
      plannerView.append(frame);
    }
    const url = new URL(path, location.origin);
    url.searchParams.set("st-embedded", "1");
    frame.src = url.pathname + url.search + url.hash;
    clearTimeout(loadTimer);
    loadTimer = setTimeout(() => {
      message.textContent = "Planner is taking longer to connect. You can retry or return to ST.";
      retry.hidden = false;
    }, 15000);
  }
  function render() {
    const path = plannerPath(location.pathname + location.search + location.hash);
    const wasPlanner = document.body.dataset.stView === "planner";
    if (path) {
      if (!wasPlanner) {
        consoleScroll = scrollY;
        returnFocus = document.activeElement;
        // Modal dialogs live in the top layer even when their parent is hidden.
        consoleView.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
      }
      document.body.dataset.stView = "planner";
      consoleView.inert = true;
      plannerView.hidden = false;
      requestedPath = path;
      const name = new URL(path, location.origin).pathname.slice(9);
      document.title = `ST · ${name[0].toUpperCase()}${name.slice(1)}`;
      if (!frame) startFrame(path);
      else if (ready && framePath !== path) send("st:navigate", { path });
      if (ready && !wasPlanner) frame.focus();
    } else {
      document.body.dataset.stView = "console";
      consoleView.inert = false;
      plannerView.hidden = true;
      if (wasPlanner) {
        window.dispatchEvent(new Event("st:console"));
        scrollTo(0, consoleScroll);
        returnFocus?.focus({ preventScroll: true });
      }
    }
    activity();
  }
  function navigate(path, replace = false) {
    const current = location.pathname + location.search + location.hash;
    if (path !== current) history[replace ? "replaceState" : "pushState"](null, "", path);
    render();
  }
  function goHome() {
    consoleScroll = 0;
    returnFocus = consoleView.querySelector(".brand");
    navigate("/");
  }
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest("a[href]");
    if (!link || link.target || link.hasAttribute("download")) return;
    const url = new URL(link.href);
    if (url.origin !== location.origin) return;
    const path = plannerPath(url.pathname + url.search + url.hash);
    if (path) {
      event.preventDefault();
      navigate(path);
    } else if (link.closest("#st-planner") && url.pathname === "/") {
      event.preventDefault();
      goHome();
    }
  });
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.source !== frame?.contentWindow) return;
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "st:home") return goHome();
    const path = plannerPath(data.path);
    if (!path) return;
    if (data.type === "st:ready") {
      ready = true;
      framePath = path;
      loading.hidden = true;
      clearTimeout(loadTimer);
      if (requestedPath !== path) send("st:navigate", { path: requestedPath });
      activity();
      if (!plannerView.hidden) frame.focus();
    } else if (data.type === "st:route") {
      framePath = path;
      if (!plannerView.hidden) navigate(path, data.replace === true);
    } else if (data.type === "st:navigated") {
      framePath = path;
    }
  });
  retry.addEventListener("click", () => startFrame(requestedPath));
  window.addEventListener("popstate", render);
  window.addEventListener("hashchange", render);
  document.addEventListener("visibilitychange", activity);
  render();
})();
