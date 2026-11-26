import { RecentConversations } from "../components/RecentConversations";
import { isWorkmode } from "../lib/workmode";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Route, Routes, useLocation, useNavigate } from "react-router";
import { Home } from "../features/Home";
import { Notice } from "../components/Ui";
import { usePoll } from "../lib/api";
import type { UiConfig } from "../lib/types";
import { useMonitor } from "../features/MonitorContext";
import { Planner } from "../features/Planner";
import { Agents } from "../features/ovis/Agents";
import { ShortcutIndicator } from "../components/ShortcutIndicator";
import { useSidebarShortcuts } from "./useSidebarShortcuts";
import { MainNavigation, navigation } from "./MainNavigation";
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
export function App() {
  const location = useLocation(),
    navigate = useNavigate();
  const sidebar = useRef<HTMLDivElement>(null);
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
      <MainNavigation
        navigationRef={sidebar}
        shortcutsReady={shortcuts.step === 2 && shortcuts.scope === "main"}
        config={config.data}
        agentsAddress={agentsAddress.current}
        connection={connection}
        hostname={monitor.data?.system.hostname}
        projectCount={monitor.data ? projects.length : undefined}
        containerCount={
          monitor.data
            ? projects.reduce(
                (count, project) => count + project.container_count,
                0,
              ) + monitor.data.unassigned_containers.length
            : undefined
        }
      />
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
