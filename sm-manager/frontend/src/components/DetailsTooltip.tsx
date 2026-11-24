import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/** A top-layer tooltip stays outside table overflow while inheriting the ST theme. */
export function DetailsTooltip({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const cancelHide = () => clearTimeout(timer.current);

  const hide = () => tip.current?.hidePopover();
  const leave = (pointerType: string) => {
    if (pointerType === "touch" || document.activeElement === trigger.current)
      return;
    cancelHide();
    timer.current = setTimeout(hide, 120);
  };
  const place = useCallback(() => {
    if (!trigger.current || !tip.current?.matches(":popover-open")) return;
    const anchor = trigger.current.getBoundingClientRect();
    const box = tip.current.getBoundingClientRect();
    if (anchor.bottom < 0 || anchor.top > innerHeight) return hide();
    tip.current.style.left = `${Math.max(12, Math.min(anchor.left, innerWidth - box.width - 12))}px`;
    tip.current.style.top = `${Math.max(12, anchor.bottom + box.height + 8 < innerHeight - 12 ? anchor.bottom + 8 : anchor.top - box.height - 8)}px`;
  }, []);
  const show = () => {
    cancelHide();
    tip.current?.showPopover();
    place();
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (!open) return;

    place();
    const observer = new ResizeObserver(place);
    if (tip.current) observer.observe(tip.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);
  return (
    <div
      className="st-detail-trigger"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) hide();
      }}
    >
      <button
        type="button"
        ref={trigger}
        className="st-branch-tooltip st-ellipsis"
        aria-describedby={id}
        onFocus={show}
        onClick={show}
        onPointerEnter={show}
        onPointerLeave={(event) => leave(event.pointerType)}
      >
        {label}
      </button>
      <div
        ref={tip}
        id={id}
        role="tooltip"
        popover="auto"
        className="st-details-tooltip"
        onToggle={(event) => setOpen(event.newState === "open")}
        onPointerEnter={cancelHide}
        onPointerLeave={(event) => leave(event.pointerType)}
      >
        {children}
      </div>
    </div>
  );
}
