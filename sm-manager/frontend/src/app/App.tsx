import { isWorkmode } from "../lib/workmode";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { NavLink, Route, Routes, useLocation, useNavigate } from "react-router";
import {
  Activity,
  FolderGit2,
  Boxes,
  HardDrive,
  Terminal,
  CalendarDays,
  ListTodo,
  Monitor,
  Wind,
  Database,
  Code,
  Menu,
  Home as HomeIcon,
} from "lucide-react";
import { Home } from "../features/Home";
import { Notice } from "../components/Ui";
import { usePoll } from "../lib/api";
import type { UiConfig } from "../lib/types";
import { useMonitor } from "../features/MonitorContext";
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
  ["overview", "Overview", Activity],
  ["projects", "Projects", FolderGit2],
  ["containers", "Containers", Boxes],
  ["codex", "Codex", Terminal],
  ["storage", "Storage", HardDrive],
  ["zed", "Zed", Code],
  ["dbs", "DBs", Database],
] as const;
export function App() {
  const location = useLocation(),
    navigate = useNavigate();
  const [drawer, setDrawer] = useState(false);
  const config = usePoll<UiConfig>("/api/ui-config", 60000);
  const { snapshot: monitor } = useMonitor();
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
          ?.replaceAll("-", " ") ??
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
    setDrawer(false);
  }, [title]);
  return (
    <div className="st-app" data-workmode={workmode}>
      <aside className={`st-sidebar ${drawer ? "open" : ""}`}>
        <NavLink className="st-brand" to="/">
          <img src="/st-logo.svg" alt="S.T." />
          <span>SYSTEM CONSOLE</span>
        </NavLink>
        <nav aria-label="Main navigation">
          <NavLink to="/" end>
            <HomeIcon size={18} />
            Home
          </NavLink>
          {navigation.map(([path, label, Icon]) => (
            <NavLink key={path} to={`/${path}${workmode ? "?workmode=1" : ""}`}>
              <Icon size={18} />
              {label}
            </NavLink>
          ))}
          {config.data?.ovis && (
            <NavLink to={ovisAddress.current}>
              <Terminal size={18} />
              Ovis
            </NavLink>
          )}
        </nav>
        <div className="st-sidebar-bottom">
          {config.data?.planner && (
            <nav aria-label="Planner">
              <span className="st-nav-label">Planner</span>
              <NavLink to="/planner/tasks">
                <ListTodo size={18} />
                Tasks
              </NavLink>
              <NavLink to="/planner/calendar">
                <CalendarDays size={18} />
                Calendar
              </NavLink>
            </nav>
          )}
          {!workmode && (
            <nav aria-label="Devices">
              <span className="st-nav-label">Devices</span>
              <NavLink to="/faceplate">
                <Monitor size={18} />
                Faceplate
              </NavLink>
              <NavLink to="/air-quality">
                <Wind size={18} />
                Air quality
              </NavLink>
              {config.data?.printer_url && (
                <a
                  href={config.data.printer_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <img src="/prusa-connect.svg" alt="" width="18" />
                  Prusa Connect ↗
                </a>
              )}
            </nav>
          )}
          <button
            role="switch"
            aria-checked={workmode}
            onClick={() => {
              const p = new URLSearchParams(location.search);
              if (workmode) p.delete("workmode");
              else p.set("workmode", "1");
              navigate({ pathname: location.pathname, search: p.toString() });
            }}
          >
            Workmode <span>{workmode ? "On" : "Off"}</span>
          </button>
          <small>
            {monitor.data?.system.hostname ?? "Connecting…"}
            <br />
            ST · v2 preview
          </small>
        </div>
      </aside>
      <main className="st-main">
        <header className="st-topbar">
          <button
            className="st-menu"
            aria-label="Toggle S.T. navigation"
            aria-expanded={drawer}
            onClick={() => setDrawer(!drawer)}
          >
            <Menu />
          </button>
          <h1>
            <span>ST /</span> {title}
          </h1>
          <span className={`st-connection ${monitor.error ? "offline" : ""}`}>
            {monitor.error
              ? "Reconnecting"
              : !monitor.data
                ? "Connecting"
                : monitor.data.stale
                  ? "Stale"
                  : "Connected"}
          </span>
        </header>
        <div className="st-content" hidden={planner || ovis}>
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
