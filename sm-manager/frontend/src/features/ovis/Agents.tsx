import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { useNavigate } from "react-router";
import { agentsPageTitle } from "./title";
import { setOvisHost } from "./host";
import { Notice } from "../../components/Ui";
export function Agents({
  active,
  workmode,
  onTitle,
}: {
  active: boolean;
  workmode: boolean;
  onTitle: (title: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null),
    navigate = useNavigate();
  const [Feature, setFeature] = useState<ComponentType<{
      workmode: boolean;
    }> | null>(null),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  const started = useRef(false);
  useLayoutEffect(() => {
    if (!root.current) return;
    setOvisHost({
      root: root.current,
      active,
      navigate: (url, replace, state) => navigate(url, { replace, state }),
      title: (title) => {
        onTitle(agentsPageTitle(title));
      },
    });
    const observer = new ResizeObserver(() => {
      root.current?.style.setProperty(
        "--app-height",
        `${root.current.clientHeight}px`,
      );
    });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, [active, navigate, onTitle]);
  useEffect(() => () => setOvisHost(null), []);
  useEffect(() => {
    if (!active || Feature || started.current) return;
    started.current = true;
    setError("");
    void import("./Feature")
      .then((m) => setFeature(() => m.default))
      .catch((e) => {
        setError(e instanceof Error ? e.message : "Agents could not load");
        started.current = false;
      });
  }, [active, Feature, retry]);
  return (
    <section hidden={!active} className="st-ovis-section" aria-label="Agents">
      <div
        className="st-ovis-root"
        data-st-host-theme={workmode ? "workmode" : "console"}
        ref={root}
        inert={!active}
      >
        {Feature ? (
          <Feature workmode={workmode} />
        ) : error ? (
          <Notice retry={() => setRetry((v) => v + 1)}>{error}</Notice>
        ) : (
          <Notice>Loading Agents…</Notice>
        )}
      </div>
    </section>
  );
}
