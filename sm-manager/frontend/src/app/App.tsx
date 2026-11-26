import { GitPullRequest as GithubIcon } from "lucide-react";
import herdrIcon from "../assets/herdr.svg";
import { RecentConversations } from "../components/RecentConversations";
import { isWorkmode, withWorkmode } from "../lib/workmode";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { NavLink, Route, Routes, useLocation, useNavigate } from "react-router";
import { Home } from "../features/Home";
import { Notice } from "../components/Ui";
import { usePoll } from "../lib/api";
import type { UiConfig } from "../lib/types";
import { useMonitor } from "../features/MonitorContext";
import { Planner } from "../features/Planner";
import { Agents } from "../features/ovis/Agents";
import {
  ShortcutIndicator,
  ShortcutKey,
} from "../components/ShortcutIndicator";
import { useSidebarShortcuts } from "./useSidebarShortcuts";
const Overview = lazy(() =>
  import("../features/Overview").then((m) => ({ default: m.Overview })),
);
const Projects = lazy(() =>
  import("../features/Resources").then((m) => ({ default: m.Projects })),
);
const Containers = lazy(() =>
  import("../features/Resources").then((m) => ({ default: m.Containers })),
);
const GitHub = lazy(() =>
  import("../features/GitHub").then((m) => ({ default: m.GitHub })),
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
const Assistant = lazy(() =>
  import("../features/Assistant").then((m) => ({ default: m.Assistant })),
);
const navigation = [
  ["overview", "Overview", "◫", "O"],
  ["projects", "Projects", "⌘", "P"],
  ["containers", "Containers", "▤", "N"],
  ["github", "GitHub", "github", "G"],
  ["storage", "Storage", "▥", "S"],
  ["zed", "Zed", "/zed.svg", "Z"],
  ["dbs", "DBs", "/db.svg", "D"],
] as const;
const shortcut = (key: string) => ({
  "data-shortcut": key,
  "aria-description": `Keyboard shortcut: press and release Control+Shift, then ${key}.`,
});
export function App() {
  const location = useLocation(),
    navigate = useNavigate();
  const sidebar = useRef<HTMLElement>(null);
  const shortcuts = useSidebarShortcuts(sidebar, location.key);
  const config = usePoll<UiConfig>("/api/ui-config", 60000);
  const { snapshot: monitor, projects } = useMonitor();
  const planner = location.pathname.startsWith("/planner/");
  const agents =
    location.pathname === "/agents" || location.pathname.startsWith("/agents/");
  const [agentsTitle, setAgentsTitle] = useState("Agents");
  const workmode = isWorkmode(location.search);
  const agentsAddress = useRef("/agents");
  if (agents)
    agentsAddress.current = location.pathname + location.search + location.hash;
  const connection = monitor.error
    ? "Reconnecting"
    : !monitor.data
      ? "Connecting"
      : monitor.data.stale
        ? "Stale"
        : "Connected";
  const title = agents
    ? agentsTitle
    : location.pathname === "/"
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
    document.title = agents ? `ST - ${title}` : `ST · ${title}`;
  }, [agents, title]);
  useEffect(() => {
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", workmode ? "#19120e" : "#0d1117");
  }, [workmode]);
  return (
    <div className="st-app" data-workmode={workmode}>
      <aside
        className="st-sidebar sidebar"
        ref={sidebar}
        data-shortcuts-ready={
          shortcuts.step === 2 && shortcuts.scope === "main"
        }
      >
        <NavLink
          {...shortcut("H")}
          className="st-brand brand"
          to={withWorkmode("/", workmode)}
          aria-label="Home"
          title="ST · Home"
        >
          <img src="/st-logo.svg" alt="" width="86" height="48" />
          <img
            className="workmode-logo"
            src="/ydistri.svg"
            alt="Ydistri"
            hidden={!workmode}
          />
          <ShortcutKey letter="H" />
        </NavLink>
        <nav aria-label="Main navigation">
          {config.data?.ovis && (
            <NavLink
              {...shortcut("A")}
              className="nav-link nav-agents"
              title="Agents"
              aria-label="Agents"
              to={withWorkmode(agentsAddress.current, workmode)}
            >
              <img
                className="nav-icon nav-herdr-icon"
                src={herdrIcon}
                alt=""
                width="22"
                height="22"
              />
              Agents
              <ShortcutKey letter="A" />
            </NavLink>
          )}
          {navigation.map(([path, label, icon, key]) => (
            <NavLink
              {...shortcut(key)}
              className="nav-link"
              title={label}
              aria-label={label}
              key={path}
              to={`/${path}${workmode ? "?workmode=1" : ""}`}
            >
              {icon === "github" ? (
                <GithubIcon className="nav-icon" aria-hidden="true" size={17} />
              ) : icon.startsWith("/") ? (
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
              <ShortcutKey letter={key} />
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
        </nav>
        <div className="st-sidebar-bottom sidebar-bottom">
          {config.data?.planner && (
            <nav className="sidebar-planner" aria-label="Planner">
              <h2 className="sidebar-heading">Planner</h2>
              <NavLink
                {...shortcut("T")}
                className="nav-link"
                title="Tasks"
                aria-label="Tasks"
                to={withWorkmode("/planner/tasks", workmode)}
              >
                <span className="nav-icon" aria-hidden="true">
                  ☑
                </span>
                Tasks
                <ShortcutKey letter="T" />
              </NavLink>
              <NavLink
                {...shortcut("C")}
                className="nav-link"
                title="Calendar"
                aria-label="Calendar"
                to={withWorkmode("/planner/calendar", workmode)}
              >
                <span className="nav-icon" aria-hidden="true">
                  ▦
                </span>
                Calendar
                <ShortcutKey letter="C" />
              </NavLink>
            </nav>
          )}
          {!workmode && (
            <nav className="sidebar-devices" aria-label="Devices">
              <h2 className="sidebar-heading">Devices</h2>
              <NavLink
                className="nav-link"
                to="/assistant"
                aria-label="Voice assistant"
              >
                <span className="nav-icon" aria-hidden="true">
                  ◉
                </span>
                Assistant
              </NavLink>
              <NavLink
                {...shortcut("F")}
                className="nav-link"
                title="Faceplate"
                aria-label="Faceplate"
                to="/faceplate"
              >
                <span className="nav-icon" aria-hidden="true">
                  ▣
                </span>
                Faceplate
                <ShortcutKey letter="F" />
              </NavLink>
              {config.data?.printer_url && (
                <a
                  {...shortcut("R")}
                  className="nav-link"
                  title="Prusa Connect"
                  aria-label="Prusa Connect"
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
                  <ShortcutKey letter="R" />
                  <span className="nav-external" aria-hidden="true">
                    ↗
                  </span>
                </a>
              )}
              <NavLink
                {...shortcut("Q")}
                className="nav-link"
                title="Air quality"
                aria-label="Air quality"
                to="/air-quality"
              >
                <span className="nav-icon" aria-hidden="true">
                  ≋
                </span>
                Air quality
                <ShortcutKey letter="Q" />
              </NavLink>
            </nav>
          )}
          <div
            className={`machine st-connection connection ${connection !== "Connected" ? "stale" : ""}`}
            role="status"
            aria-label={`${monitor.data?.system.hostname ?? "Monitor"} · ${connection}`}
            title={connection}
          >
            <span className="status-dot" aria-hidden="true" />
            <strong>{monitor.data?.system.hostname ?? "Connecting…"}</strong>
          </div>
          <button
            {...shortcut("W")}
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
            <ShortcutKey letter="W" />
            <span className="workmode-switch" aria-hidden="true" />
          </button>
          <div className="sidebar-version">
            ST · LOCAL <span>v2 preview</span>
          </div>
        </div>
      </aside>
      <main className="st-main">
        <div
          id="dashboard"
          data-view={location.pathname.slice(1) || "home"}
          className="st-content"
          hidden={planner || agents}
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
                ["github", <GitHub />],
                ["storage", <Storage />],
                ["zed", <Zed />],
                ["dbs", <Dbs />],
                ["air-quality", <AirQuality />],
                ["faceplate", <Faceplate />],
                ["assistant", <Assistant />],
              ].map(([path, element]) => (
                <Route key={String(path)} path={`/${path}`} element={element} />
              ))}
              <Route path="/planner/*" element={null} />
              <Route path="/agents/*" element={null} />
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
        {config.data?.planner && (
          <Planner active={planner} onFrameLoad={shortcuts.connectPlanner} />
        )}
        {config.data?.ovis && (
          <Agents
            active={agents}
            workmode={workmode}
            onTitle={setAgentsTitle}
          />
        )}
        {planner && config.data && !config.data.planner && (
          <Notice>Planner is not configured on this instance.</Notice>
        )}
        {agents && config.data && !config.data.ovis && (
          <Notice>Agents is not configured on this instance.</Notice>
        )}
      </main>
      <ShortcutIndicator step={shortcuts.step} scope={shortcuts.scope} />
      {shortcuts.recent && (
        <RecentConversations
          picker={shortcuts.recent}
          onOpen={shortcuts.openRecent}
          onClose={shortcuts.cancel}
        />
      )}
    </div>
  );
}
