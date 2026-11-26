import {
  useEffect,
  useRef,
  useState,
  type RefObject,
  type ReactNode,
} from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import {
  AudioLines,
  CalendarDays,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FolderGit2,
  GitPullRequest,
  HardDrive,
  House,
  LayoutDashboard,
  Monitor,
  MoreHorizontal,
  PanelsTopLeft,
  Wind,
  X,
} from "lucide-react";
import herdrIcon from "../assets/herdr.svg";
import {
  AgentActivity,
  type AgentActivityState,
} from "../components/AgentActivity";
import { agentActivityLabel } from "../features/ovis/activity";
import { useAgentActivity } from "../features/ovis/useAgentActivity";
import { ShortcutKey } from "../components/ShortcutIndicator";
import { isWorkmode, withWorkmode } from "../lib/workmode";
import type { UiConfig } from "../lib/types";

export const navigation = [
  ["overview", "Overview", "overview", "O"],
  ["projects", "Projects", "projects", "P"],
  ["containers", "Containers", "containers", "N"],
  ["github", "GitHub", "github", "G"],
  ["storage", "Storage", "storage", "S"],
  ["zed", "Zed", "/zed.svg", "Z"],
  ["dbs", "DBs", "/db.svg", "D"],
] as const;
const icons = {
  overview: LayoutDashboard,
  projects: FolderGit2,
  containers: PanelsTopLeft,
  github: GitPullRequest,
  storage: HardDrive,
  home: House,
  tasks: CheckSquare,
  calendar: CalendarDays,
  assistant: AudioLines,
  faceplate: Monitor,
  air: Wind,
};
function NavigationIcon({ name }: { name: string }) {
  if (name === "agents" || name.startsWith("/"))
    return (
      <img
        className={`nav-icon ${name === "agents" ? "nav-herdr-icon" : ""}`}
        src={name === "agents" ? herdrIcon : name}
        alt=""
        width={22}
        height={22}
      />
    );
  const Icon = icons[name as keyof typeof icons];
  return <Icon className="nav-icon" aria-hidden="true" size={19} />;
}
const shortcut = (key?: string) =>
  key
    ? {
        "data-shortcut": key,
        "aria-description": `Keyboard shortcut: press and release Control+Shift, then ${key}.`,
      }
    : {};
const preferenceKey = "st-sidebar-collapsed";
function useMedia(query: string) {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

type Destination = {
  path: string;
  label: string;
  icon: string;
  key?: string;
  count?: number | string;
  activity?: AgentActivityState;
};
function DestinationLink({
  item,
  workmode,
  onClick,
  className = "",
}: {
  item: Destination;
  workmode: boolean;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <NavLink
      {...shortcut(item.key)}
      className={`nav-link ${className}`}
      title={
        item.activity
          ? `${item.label} · ${agentActivityLabel(item.activity.counts, item.activity.unavailable)}`
          : item.label
      }
      aria-description={
        item.activity
          ? agentActivityLabel(item.activity.counts, item.activity.unavailable)
          : shortcut(item.key)["aria-description"]
      }
      aria-label={item.label}
      to={withWorkmode(item.path, workmode)}
      onClick={onClick}
      end={item.path === "/"}
    >
      <NavigationIcon name={item.icon} />
      <span className="nav-label">{item.label}</span>
      {item.key && <ShortcutKey letter={item.key} />}
      {item.activity && <AgentActivity {...item.activity} />}
      {item.count !== undefined && (
        <span className="nav-count" aria-hidden="true">
          {item.count}
        </span>
      )}
    </NavLink>
  );
}

export function MainNavigation({
  navigationRef,
  shortcutsReady,
  config,
  agentsAddress,
  connection,
  hostname,
  projectCount,
  containerCount,
}: {
  navigationRef: RefObject<HTMLDivElement | null>;
  shortcutsReady: boolean;
  config?: UiConfig | null;
  agentsAddress: string;
  connection: string;
  hostname?: string;
  projectCount?: number;
  containerCount?: number;
}) {
  const location = useLocation(),
    navigate = useNavigate();
  const workmode = isWorkmode(location.search);
  const agentsActive =
    location.pathname === "/agents" || location.pathname.startsWith("/agents/");
  const activity = useAgentActivity(!!config?.ovis, agentsActive);
  const compact = useMedia("(max-width: 1000px)");
  const mobile = useMedia("(max-width: 700px)");
  const [preference, setPreference] = useState<boolean | null>(() => {
    try {
      const saved = localStorage.getItem(preferenceKey);
      return saved === "true" ? true : saved === "false" ? false : null;
    } catch {
      return null;
    }
  });
  const collapsed = preference ?? compact;
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => setMoreOpen(false), [location.key, mobile]);
  const toggleCollapsed = () => {
    const next = !collapsed;
    setPreference(next);
    try {
      localStorage.setItem(preferenceKey, String(next));
    } catch {
      /* Session preference still works. */
    }
  };
  const toggleWorkmode = () =>
    navigate(
      withWorkmode(
        location.pathname + location.search + location.hash,
        !workmode,
      ),
    );
  const system: Destination[] = navigation.map(([path, label, icon, key]) => ({
    path: `/${path}`,
    label,
    icon,
    key,
    count:
      path === "projects"
        ? (projectCount ?? "—")
        : path === "containers"
          ? (containerCount ?? "—")
          : undefined,
  }));
  const home: Destination = {
    path: "/",
    label: "Home",
    icon: "home",
    key: "H",
  };
  const agents: Destination = {
    path: agentsAddress,
    label: "Agents",
    icon: "agents",
    key: "A",
    activity: config?.ovis ? activity : undefined,
  };
  const calendar: Destination = {
    path: "/planner/calendar",
    label: "Calendar",
    icon: "calendar",
    key: "C",
  };
  const tasks: Destination = {
    path: "/planner/tasks",
    label: "Tasks",
    icon: "tasks",
    key: "T",
  };
  const assistant: Destination = {
    path: "/assistant",
    label: "Assistant",
    icon: "assistant",
  };
  const devices: Destination[] = [
    { path: "/faceplate", label: "Faceplate", icon: "faceplate", key: "F" },
    { path: "/air-quality", label: "Air quality", icon: "air", key: "Q" },
  ];
  const pinned = [system[0]!, calendar, agents, assistant];
  const moreActive = !pinned.some(
    (item) =>
      location.pathname === item.path.split(/[?#]/)[0] ||
      (item === agents && location.pathname.startsWith("/agents/")),
  );
  const printer = (close?: () => void) =>
    config?.printer_url && (
      <a
        {...shortcut("R")}
        className="nav-link"
        title="Prusa Connect"
        aria-label="Prusa Connect"
        href={config.printer_url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={close}
      >
        <NavigationIcon name="/prusa-connect.svg" />
        <span className="nav-label">Prusa Connect</span>
        <ShortcutKey letter="R" />
        <ExternalLink className="nav-external" size={13} aria-hidden="true" />
      </a>
    );
  const workmodeSwitch = (
    <button
      {...shortcut("W")}
      className="workmode-toggle"
      role="switch"
      aria-label="Workmode"
      aria-checked={workmode}
      onClick={toggleWorkmode}
    >
      <span className="workmode-label">Workmode</span>
      <ShortcutKey letter="W" />
      <span className="workmode-switch" aria-hidden="true" />
    </button>
  );
  const closeMore = () => setMoreOpen(false);
  return (
    <div
      className="st-navigation"
      ref={navigationRef}
      data-shortcuts-ready={shortcutsReady}
    >
      <aside
        className="st-sidebar sidebar"
        data-collapsed={collapsed}
        data-shortcuts-ready={shortcutsReady}
        aria-label="Main sidebar"
      >
        <div className="st-sidebar-scroll" id="st-sidebar-options">
          <NavLink
            {...shortcut("H")}
            className="st-brand brand"
            to={withWorkmode("/", workmode)}
            aria-label="Home"
            title="ST · Home"
          >
            <img src="/st-logo-dark.svg?v=st-seam-1" alt="" width="48" height="48" />
            <img
              className="workmode-logo"
              src="/ydistri.svg"
              alt="Ydistri"
              hidden={!workmode}
            />
            <ShortcutKey letter="H" />
          </NavLink>
          <nav aria-label="Main navigation">
            {config?.ovis && (
              <DestinationLink
                item={agents}
                workmode={workmode}
                className="nav-agents"
              />
            )}
            {system.map((item) => (
              <DestinationLink
                key={item.path}
                item={item}
                workmode={workmode}
              />
            ))}
          </nav>
          <div className="st-sidebar-bottom sidebar-bottom">
            {config?.planner && (
              <nav className="sidebar-planner" aria-label="Planner">
                <h2 className="sidebar-heading">Planner</h2>
                {[tasks, calendar].map((item) => (
                  <DestinationLink
                    key={item.path}
                    item={item}
                    workmode={workmode}
                  />
                ))}
              </nav>
            )}
            {!workmode && (
              <nav className="sidebar-devices" aria-label="Devices">
                <h2 className="sidebar-heading">Devices</h2>
                <DestinationLink item={assistant} workmode={workmode} />
                <DestinationLink item={devices[0]!} workmode={workmode} />
                {printer()}
                <DestinationLink item={devices[1]!} workmode={workmode} />
              </nav>
            )}
            <div className="st-sidebar-footer" hidden={collapsed}>
              <div
                className={`machine st-connection connection ${connection !== "Connected" ? "stale" : ""}`}
                role="status"
                aria-label={`${hostname ?? "Monitor"} · ${connection}`}
                title={connection}
              >
                <span className="status-dot" aria-hidden="true" />
                <strong>{hostname ?? "Connecting…"}</strong>
              </div>
              {workmodeSwitch}
              <div className="sidebar-version">
                ST · LOCAL <span>v2 preview</span>
              </div>
            </div>
          </div>
        </div>
        <button
          className="st-sidebar-toggle"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          aria-controls="st-sidebar-options"
          onClick={toggleCollapsed}
        >
          <span>
            {collapsed ? <ChevronRight size={13} /> : <ChevronLeft size={13} />}
          </span>
        </button>
      </aside>
      <nav
        className="st-mobile-nav"
        aria-label="Mobile navigation"
        inert={moreOpen}
      >
        {pinned.map((item) => (
          <DestinationLink
            key={item.label}
            item={item}
            workmode={workmode}
            className={item === agents ? "st-mobile-agents" : ""}
          />
        ))}
        <button
          className="st-mobile-more"
          data-active={moreActive || moreOpen}
          aria-label="More"
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          aria-controls="st-mobile-menu"
          onClick={() => setMoreOpen(true)}
        >
          <MoreHorizontal size={22} aria-hidden="true" />
          <span>More</span>
        </button>
      </nav>
      {mobile && moreOpen && (
        <MobileMenu onClose={closeMore}>
          <nav aria-label="More navigation">
            <section>
              <h3>Workspace</h3>
              <div className="st-mobile-menu-grid">
                {[home, ...system.slice(1)].map((item) => (
                  <DestinationLink
                    key={item.path}
                    item={item}
                    workmode={workmode}
                    onClick={closeMore}
                  />
                ))}
              </div>
            </section>
            {config?.planner && (
              <section>
                <h3>Planner</h3>
                <div className="st-mobile-menu-grid">
                  <DestinationLink
                    item={tasks}
                    workmode={workmode}
                    onClick={closeMore}
                  />
                </div>
              </section>
            )}
            {!workmode && (
              <section>
                <h3>Devices</h3>
                <div className="st-mobile-menu-grid">
                  {devices.map((item) => (
                    <DestinationLink
                      key={item.path}
                      item={item}
                      workmode={workmode}
                      onClick={closeMore}
                    />
                  ))}
                  {printer(closeMore)}
                </div>
              </section>
            )}
          </nav>
          <footer>
            {workmodeSwitch}
            <span className="st-mobile-connection">
              <i
                className={`status-dot ${connection !== "Connected" ? "stale" : ""}`}
              />
              {connection}
            </span>
          </footer>
        </MobileMenu>
      )}
    </div>
  );
}

function MobileMenu({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    return () => {
      dialog.close();
      document.body.style.overflow = overflow;
      previous?.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      id="st-mobile-menu"
      className="st-mobile-menu"
      aria-labelledby="st-mobile-menu-title"
      onCancel={onClose}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            "a[href], button:not(:disabled)",
          ),
        ];
        const first = controls[0],
          last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          onClose();
      }}
    >
      <header>
        <div>
          <span>ST · YOUR SPACE</span>
          <h2 id="st-mobile-menu-title">More to explore</h2>
        </div>
        <button aria-label="Close menu" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
