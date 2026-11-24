/* Runs only in the S.T. proxy document. Never writes DAVe's saved preferences. */
(() => {
  const root = document.documentElement;
  const apply = (name) => {
    if (name !== "console" && name !== "workmode") return;
    root.dataset.stTheme = name;
    root.classList.add("dark");
  };
  const workmode = new URL(location.href).searchParams.get("workmode");
  apply(
    workmode !== null &&
      ["", "1", "true", "on"].includes(workmode.toLowerCase())
      ? "workmode"
      : "console",
  );
  new MutationObserver(() => {
    if (!root.classList.contains("dark")) root.classList.add("dark");
  }).observe(root, { attributes: true, attributeFilter: ["class"] });
  window.addEventListener("message", (event) => {
    if (
      window.parent === window ||
      event.source !== window.parent ||
      event.origin !== location.origin
    )
      return;
    if (event.data?.type === "st:theme") apply(event.data.theme);
  });
  // DAVe's current settings row has no ID. Identify the complete semantic group,
  // leave its saved preference intact, and explain the host's appearance policy.
  const explain = (node) => {
    if (!(node instanceof Element)) return;
    for (const label of node.querySelectorAll("span.block.font-medium")) {
      if (label.textContent !== "Theme") continue;
      const row = label.parentElement;
      if (!row || row.dataset.stThemeControls !== undefined) continue;
      const buttons = [...row.querySelectorAll("button")].map((button) =>
        button.textContent?.trim(),
      );
      if (!["Light", "System", "Dark"].every((name) => buttons.includes(name)))
        continue;
      row.dataset.stThemeControls = "";
      const controls = row.querySelector("div");
      if (controls) controls.inert = true;
      const note = document.createElement("p");
      note.className = "st-theme-note";
      note.textContent = "Colors follow the S.T. console.";
      row.append(note);
    }
  };
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      explain(document.body);
      new MutationObserver((records) => {
        for (const record of records)
          for (const node of record.addedNodes) explain(node);
      }).observe(document.body, { childList: true, subtree: true });
    },
    { once: true },
  );
})();
