import { isWorkmode } from "../lib/workmode";
import { lazy, Suspense, useEffect, useRef } from "react";
import { NavLink, Route, Routes, useLocation, useNavigate } from "react-router";
import { Home } from "../features/Home";
import { Notice } from "../components/Ui";
import { usePoll } from "../lib/api";
import type { UiConfig } from "../lib/types";
import { CopyReport, useMonitor } from "../features/MonitorContext";
import { Planner } from "../features/Planner";
import { Ovis } from "../features/ovis/Ovis";
const Overview = lazy(() =>
  import("../features/Overview").then((m) => ({ default: m.Overview })),
);
const Projects = lazy(() =>
  import("../features/Resources").then((m) => ({ default: m.Projects })),
);
const Containers = lazy(() =>
  import("../features/Resources").then((m) => ({ default: m.Containers })),
);
const Codex = lazy(() =>
  import("../features/Resources").then((m) => ({ default: m.Codex })),
);
const Storage = lazy(() =>
  import("../features/Catalogs").then((m) => ({ default: m.Storage })),
);
const Zed = lazy(() =>
  import("../features/Catalogs").then((m) => ({ default: m.Zed })),
);
const Dbs = lazy(() =>
  import("../features/Catalogs").then((m) => ({ default: m.Dbs })),
);
const AirQuality = lazy(() =>
  import("../features/AirQuality").then((m) => ({ default: m.AirQuality })),
);
const Faceplate = lazy(() =>
  import("../features/Faceplate").then((m) => ({ default: m.Faceplate })),
);
const navigation = [
  ["overview", "Overview", "◫"],
  ["projects", "Projects", "⌘"],
  ["containers", "Containers", "▤"],
  ["codex", "Codex", "✳"],
  ["storage", "Storage", "▥"],
  ["zed", "Zed", "/zed.svg"],
  ["dbs", "DBs", "/db.svg"],
] as const;
export function App() {
  const location = useLocation(),
    navigate = useNavigate();
  const config = usePoll<UiConfig>("/api/ui-config", 60000);
  const { snapshot: monitor, projects } = useMonitor();
  const planner = location.pathname.startsWith("/planner/");
  const ovis = location.pathname.startsWith("/ovis");
  const workmode = isWorkmode(location.search);
  const ovisAddress = useRef("/ovis");
  if (ovis)
    ovisAddress.current = location.pathname + location.search + location.hash;
  const title =
    location.pathname === "/"
      ? "Home"
      : (navigation.find((n) => `/${n[0]}` === location.pathname)?.[1] ??
        location.pathname
          .split("/")
          .filter(Boolean)
          .at(-1)
          ?.replaceAll("-", " ")
          .replace(/^./, (letter) => letter.toUpperCase()) ??
        "Home");
  useEffect(() => {
    if (location.pathname === "/" && location.hash) {
      const hash = location.hash.slice(1);
      const path =
        hash === "home" ? "/" : hash === "system" ? "/overview" : `/${hash}`;
      navigate(path + location.search, { replace: true });
    }
  }, [location.hash, location.pathname, location.search, navigate]);
  useEffect(() => {
    document.title = `ST · ${title}`;
  }, [title]);
  useEffect(() => {
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", workmode ? "#19120e" : "#0d1117");
  }, [workmode]);
  return (
    <div className="st-app" data-workmode={workmode}>
      <aside className="st-sidebar sidebar">
        <NavLink
          className="st-brand brand"
          to="/"
          aria-label="Home"
          title="ST · System console"
        >
          <img src="/st-logo.svg" alt="" width="86" height="48" />
          <span className="brand-caption">SYSTEM CONSOLE</span>
          <img
            className="workmode-logo"
            src="/ydistri.svg"
            alt="Ydistri"
            hidden={!workmode}
          />
        </NavLink>
        <nav aria-label="Main navigation">
          {navigation.map(([path, label, icon]) => (
            <NavLink
              className="nav-link"
              title={label}
              aria-label={label}
              key={path}
              to={`/${path}${workmode ? "?workmode=1" : ""}`}
            >
              {icon.startsWith("/") ? (
                <img
                  className="nav-icon"
                  src={icon}
                  alt=""
                  width="17"
                  height="17"
                />
              ) : (
                <span className="nav-icon" aria-hidden="true">
                  {icon}
                </span>
              )}
              {label}
              {path === "projects" && (
                <span className="nav-count" aria-hidden="true">
                  {monitor.data ? projects.length : "—"}
                </span>
              )}
              {path === "containers" && (
                <span className="nav-count" aria-hidden="true">
                  {monitor.data
                    ? projects.reduce(
                        (count, project) => count + project.container_count,
                        0,
                      ) + monitor.data.unassigned_containers.length
                    : "—"}
                </span>
              )}
            </NavLink>
          ))}
          {config.data?.ovis && (
            <NavLink className="nav-link" title="Ovis" to={ovisAddress.current}>
              <span className="nav-icon" aria-hidden="true">
                ◌
              </span>
              Ovis
            </NavLink>
          )}
        </nav>
        <div className="st-sidebar-bottom sidebar-bottom">
          {config.data?.planner && (
            <nav className="sidebar-planner" aria-label="Planner">
              <h2 className="sidebar-heading">Planner</h2>
              <NavLink className="nav-link" title="Tasks" to="/planner/tasks">
                <span className="nav-icon" aria-hidden="true">
                  ☑
                </span>
                Tasks
              </NavLink>
              <NavLink
                className="nav-link"
                title="Calendar"
                to="/planner/calendar"
              >
                <span className="nav-icon" aria-hidden="true">
                  ▦
                </span>
                Calendar
              </NavLink>
            </nav>
          )}
          {!workmode && (
            <nav className="sidebar-devices" aria-label="Devices">
              <h2 className="sidebar-heading">Devices</h2>
              <NavLink className="nav-link" title="Faceplate" to="/faceplate">
                <span className="nav-icon" aria-hidden="true">
                  ▣
                </span>
                Faceplate
              </NavLink>
              {config.data?.printer_url && (
                <a
                  className="nav-link"
                  title="Prusa Connect"
                  href={config.data.printer_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <img
                    className="nav-icon"
                    src="/prusa-connect.svg"
                    alt=""
                    width="17"
                    height="17"
                  />
                  Prusa Connect
                  <span className="nav-external" aria-hidden="true">
                    ↗
                  </span>
                </a>
              )}
              <NavLink
                className="nav-link"
                title="Air quality"
                to="/air-quality"
              >
                <span className="nav-icon" aria-hidden="true">
                  ≋
                </span>
                Air quality
              </NavLink>
            </nav>
          )}
          <div className="machine">
            <span className="status-dot" />
            <div>
              <strong>{monitor.data?.system.hostname ?? "Connecting…"}</strong>
              <span>Linux · local monitor</span>
            </div>
          </div>
          <button
            className="workmode-toggle"
            role="switch"
            aria-label="Workmode"
            aria-checked={workmode}
            onClick={() => {
              const p = new URLSearchParams(location.search);
              if (workmode) p.delete("workmode");
              else p.set("workmode", "1");
              navigate({ pathname: location.pathname, search: p.toString() });
            }}
          >
            <span className="workmode-label">Workmode</span>
            <span className="workmode-switch" aria-hidden="true" />
          </button>
          <div className="sidebar-version">
            ST · LOCAL <span>v2 preview</span>
          </div>
        </div>
      </aside>
      <main className="st-main">
        <header className="st-topbar topbar">
          <h1>
            <span className="breadcrumb">ST</span>
            <span className="slash">/</span>
            {title}
          </h1>
          <div className="topbar-actions">
            <span
              className={`st-connection connection ${monitor.error || monitor.data?.stale ? "stale" : ""}`}
              role="status"
            >
              <span className="status-dot" />
              {monitor.error
                ? "Reconnecting"
                : !monitor.data
                  ? "Connecting"
                  : monitor.data.stale
                    ? "Stale"
                    : "Connected"}
            </span>
            {location.pathname === "/overview" && <CopyReport />}
          </div>
        </header>
        <div
          id="dashboard"
          data-view={location.pathname.slice(1) || "home"}
          className="st-content"
          hidden={planner || ovis}
        >
          {config.error && (
            <Notice retry={config.refresh}>{config.error}</Notice>
          )}
          <Suspense fallback={<Notice>Loading page…</Notice>}>
            {monitor.error && location.pathname !== "/" && (
              <Notice retry={monitor.refresh}>
                {monitor.error}. Showing any last known readings.
              </Notice>
            )}
            {monitor.data?.stale && <Notice>Monitor samples are stale.</Notice>}
            {location.pathname !== "/" &&
              monitor.data?.warnings.map((w) => <Notice key={w}>{w}</Notice>)}
            <Routes>
              <Route
                path="/"
                element={
                  <Home
                    snapshot={monitor.data}
                    config={config.data}
                    error={monitor.error}
                  />
                }
              />
              {[
                ["overview", <Overview />],
                ["projects", <Projects />],
                ["containers", <Containers />],
                ["codex", <Codex />],
                ["storage", <Storage />],
                ["zed", <Zed />],
                ["dbs", <Dbs />],
                ["air-quality", <AirQuality />],
                ["faceplate", <Faceplate />],
              ].map(([path, element]) => (
                <Route key={String(path)} path={`/${path}`} element={element} />
              ))}
              <Route path="/planner/*" element={null} />
              <Route path="/ovis/*" element={null} />
              <Route
                path="*"
                element={
                  <Notice>
                    Page not found. Choose a destination in the sidebar.
                  </Notice>
                }
              />
            </Routes>
          </Suspense>
        </div>
        {config.data?.planner && <Planner active={planner} />}
        {config.data?.ovis && <Ovis active={ovis} />}
        {planner && config.data && !config.data.planner && (
          <Notice>Planner is not configured on this instance.</Notice>
        )}
        {ovis && config.data && !config.data.ovis && (
          <Notice>Ovis is not configured on this instance.</Notice>
        )}
      </main>
    </div>
  );
}
