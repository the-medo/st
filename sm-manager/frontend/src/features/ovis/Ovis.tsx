import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { useNavigate } from "react-router";
import { setOvisHost } from "./host";
import { Notice } from "../../components/Ui";
export function Ovis({ active }: { active: boolean }) {
  const root = useRef<HTMLDivElement>(null),
    navigate = useNavigate();
  const [Feature, setFeature] = useState<ComponentType | null>(null),
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
        document.title = `ST · ${title}`;
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
  }, [active, navigate]);
  useEffect(() => () => setOvisHost(null), []);
  useEffect(() => {
    if (!active || Feature || started.current) return;
    started.current = true;
    setError("");
    void import("./Feature")
      .then((m) => setFeature(() => m.default))
      .catch((e) => {
        setError(e instanceof Error ? e.message : "Ovis could not load");
        started.current = false;
      });
  }, [active, Feature, retry]);
  return (
    <section hidden={!active} className="st-ovis-section" aria-label="Ovis">
      <div className="st-ovis-root" ref={root} inert={!active}>
        {Feature ? (
          <Feature />
        ) : error ? (
          <Notice retry={() => setRetry((v) => v + 1)}>{error}</Notice>
        ) : (
          <Notice>Opening Ovis…</Notice>
        )}
      </div>
    </section>
  );
}
