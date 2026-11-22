/* Actual power state is authoritative; never flip the switch optimistically. */
function createNightMode(button, status, fetcher = fetch) {
  let current = null;
  let busy = false;
  async function update(action) {
    if (busy) return;
    busy = true;
    button.disabled = true;
    if (action) status.textContent = action === "on" ? "Turning the faceplate off…" : "Turning the faceplate on…";
    try {
      const response = await fetcher("/api/night-mode", action ? {
        method: "POST", headers: { "Content-Type": "application/json", "X-SM-Token": current.token },
        body: JSON.stringify({ action }),
      } : { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not change screen power. Refresh and try again.");
      current = data;
      button.setAttribute("aria-checked", String(data.night_mode === true));
      status.textContent = data.error || `${data.night_mode ? "Faceplate off" : "Faceplate on"} · ${data.mode === "gaming" ? "Gaming" : "Desktop"} Mode`;
    } catch (error) {
      current = null;
      status.textContent = error.message || "Screen power is unavailable.";
    } finally {
      busy = false;
      button.disabled = !current?.available;
    }
  }
  button.addEventListener("click", () => {
    if (current?.available && !busy) void update(current.night_mode ? "off" : "on");
  });
  return { refresh: () => update() };
}
