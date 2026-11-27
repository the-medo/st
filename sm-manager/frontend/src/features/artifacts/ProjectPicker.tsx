import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { Check, ChevronDown, Folder, Layers } from "lucide-react";
import type { ArtifactProject } from "./model";

export function projectStyle(project?: ArtifactProject): CSSProperties {
  const appearance = project?.appearance ?? {};
  const color = (value?: string) =>
    value && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value) ? value : undefined;
  return {
    "--artifact-project-title": color(appearance.titleColor) || "var(--text)",
    "--artifact-project-icon":
      color(appearance.iconColor) ||
      color(appearance.titleColor) ||
      "var(--muted)",
    "--artifact-project-border":
      color(appearance.borderColor) ||
      color(appearance.titleColor) ||
      "var(--line)",
    "--artifact-project-background":
      color(appearance.sectionColor) || "transparent",
  } as CSSProperties;
}

export function ProjectBadge({
  project,
  all = false,
}: {
  project?: ArtifactProject;
  all?: boolean;
}) {
  const style = project?.appearance;
  const image =
    style?.image && /^[a-f0-9]{64}\.(png|jpg|webp)$/.test(style.image)
      ? style.image
      : null;
  return (
    <span className="artifact-project-badge" style={projectStyle(project)}>
      <span className="artifact-project-icon" aria-hidden="true">
        {image ? (
          <img
            src={`/agents/api/medo/icon?name=${encodeURIComponent(image)}`}
            alt=""
          />
        ) : (
          style?.iconText || (all ? <Layers size={17} /> : <Folder size={17} />)
        )}
      </span>
      <span>{all ? "All projects" : (project?.name ?? "No project")}</span>
    </span>
  );
}

export function ProjectPicker({
  projects,
  value,
  onChange,
  filter = false,
  disabled = false,
}: {
  projects: ArtifactProject[];
  value: string;
  onChange: (id: string) => void;
  filter?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const options = [
    ...(filter ? [{ id: "__all", project: undefined }] : []),
    { id: "", project: undefined },
    ...projects.map((project) => ({ id: project.id, project })),
  ];
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => {
    if (open)
      root.current
        ?.querySelectorAll<HTMLButtonElement>('[role="option"]')
        [active]?.focus();
  }, [open, active]);
  const choose = (next: string) => {
    onChange(next);
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <div
      className="artifact-project-picker"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (!open) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          setActive((current) =>
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? options.length - 1
                : (current +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    options.length) %
                  options.length,
          );
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-label="Project"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={id}
        disabled={disabled}
        onClick={() => {
          setActive(
            Math.max(
              0,
              options.findIndex((option) => option.id === value),
            ),
          );
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          if (!open && ["ArrowDown", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            setActive(
              Math.max(
                0,
                options.findIndex((option) => option.id === value),
              ),
            );
            setOpen(true);
          }
        }}
      >
        <ProjectBadge
          project={projects.find((project) => project.id === value)}
          all={value === "__all"}
        />
        <ChevronDown size={15} />
      </button>
      {open && (
        <div
          id={id}
          role="listbox"
          aria-label="Projects"
          className="artifact-project-options"
        >
          {options.map((option, index) => (
            <button
              type="button"
              key={option.id}
              role="option"
              aria-selected={option.id === value}
              tabIndex={active === index ? 0 : -1}
              style={projectStyle(option.project)}
              onClick={() => choose(option.id)}
            >
              <ProjectBadge
                project={option.project}
                all={option.id === "__all"}
              />
              {option.id === value && <Check size={16} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
