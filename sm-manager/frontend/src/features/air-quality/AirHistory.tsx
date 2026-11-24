import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePoll } from "../../lib/api";
import { AirChart } from "./AirChart";
import {
  airBucketAllowed,
  airBucketLabel,
  airBuckets,
  airGroups,
  airRangeLabel,
  airRanges,
  type AirData,
  type Bucket,
  type Group,
} from "./model";

export function AirHistory({ group }: { group: Group }) {
  const [hours, setHours] = useState(6),
    [bucket, setBucket] = useState<Bucket>("auto");
  const [cursor, setCursor] = useState<number | null>(null);
  const result = usePoll<AirData>(
    `/api/air-quality?hours=${hours}&bucket=${bucket}`,
    30000,
  );
  const [previous, setPrevious] = useState<AirData | null>(null);
  useEffect(() => {
    if (result.data) setPrevious(result.data);
  }, [result.data]);
  const data = result.data ?? previous;
  const definition = airGroups[group];
  const panel = useRef<HTMLElement>(null),
    dialog = useRef<HTMLDialogElement>(null),
    button = useRef<HTMLButtonElement>(null);
  const [nativeFull, setNativeFull] = useState(false),
    [modalFull, setModalFull] = useState(false);
  const expanded = nativeFull || modalFull;
  useEffect(() => {
    const changed = () =>
      setNativeFull(document.fullscreenElement === panel.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  useEffect(() => {
    if (!modalFull) return;
    const element = dialog.current!;
    element.showModal();
    button.current?.focus();
    return () => element.close();
  }, [modalFull]);
  const fullscreen = async () => {
    if (modalFull) {
      dialog.current?.close();
      return;
    }
    if (document.fullscreenElement === panel.current) {
      await document.exitFullscreen();
      return;
    }
    if (document.fullscreenEnabled && panel.current?.requestFullscreen) {
      try {
        await panel.current.requestFullscreen();
        return;
      } catch {
        /* Embedded browsers can deny native fullscreen. */
      }
    }
    setModalFull(true);
  };
  const rangeChanged = (value: number) => {
    setHours(value);
    if (!airBucketAllowed(value, bucket)) setBucket("auto");
    setCursor(null);
  };
  const bucketChanged = (value: Bucket) => {
    if (!airBucketAllowed(hours, value)) return;
    setBucket(value);
    setCursor(null);
  };
  const bucketTitle = (value: Bucket) =>
    airBucketAllowed(hours, value)
      ? value === "auto"
        ? "Choose a bucket to suit the time range"
        : `Average readings in ${airBucketLabel(value)} buckets`
      : Number(value) > hours * 3600
        ? "Choose a longer time range for this bucket"
        : "Choose a shorter time range for this level of detail";
  const loading = !result.data && !result.error;
  const status = loading
    ? `Loading ${airRangeLabel(hours)} history · ${airBucketLabel(bucket)} buckets…`
    : result.error
      ? `Could not load ${airRangeLabel(hours)} history with ${airBucketLabel(bucket)} buckets.${data ? ` Showing previous ${airRangeLabel(data.hours)} history (${airBucketLabel(data.bucket_seconds)} buckets).` : " Retrying shortly…"}`
      : "";
  const content = (
    <article
      ref={panel}
      id={`air-panel-${group}`}
      className={`panel air-history${expanded ? " is-expanded" : ""}`}
      data-air-group={group}
      aria-labelledby={`air-title-${group}`}
    >
      <div className="panel-heading">
        <h2 id={`air-title-${group}`}>{definition.label}</h2>
        <button
          ref={button}
          id={`air-fullscreen-${group}`}
          className="button air-fullscreen-button"
          aria-pressed={expanded}
          aria-label={`${expanded ? "Exit fullscreen for" : "Show fullscreen:"} ${definition.label}`}
          onClick={() => void fullscreen()}
        >
          {expanded ? "Exit fullscreen" : "Fullscreen"}
        </button>
      </div>
      <div className="air-chart-controls">
        <div className="air-control-set">
          <span className="air-control-label">Range</span>
          <div
            id={`air-range-${group}`}
            className="segmented air-range"
            role="group"
            aria-label={`${definition.label} time range`}
          >
            {airRanges.map((value) => (
              <button
                key={value}
                data-air-hours={value}
                aria-pressed={hours === value}
                className={hours === value ? "selected" : ""}
                onClick={() => rangeChanged(value)}
              >
                {value === 168 ? "Week" : value === 720 ? "Month" : `${value}h`}
              </button>
            ))}
          </div>
          <select
            id={`air-range-select-${group}`}
            className="air-compact-select"
            aria-label={`${definition.label} time range`}
            value={hours}
            onChange={(event) => rangeChanged(Number(event.target.value))}
          >
            {airRanges.map((value) => (
              <option key={value} value={value}>
                {value === 168 ? "Week" : value === 720 ? "Month" : `${value}h`}
              </option>
            ))}
          </select>
        </div>
        <div className="air-control-set">
          <span className="air-control-label">Bucket</span>
          <div
            id={`air-bucket-${group}`}
            className="segmented air-bucket"
            role="group"
            aria-label={`${definition.label} bucket size`}
          >
            {airBuckets.map((value) => (
              <button
                key={value}
                data-air-bucket={value}
                disabled={!airBucketAllowed(hours, value)}
                title={bucketTitle(value)}
                aria-pressed={bucket === value}
                className={bucket === value ? "selected" : ""}
                onClick={() => bucketChanged(value)}
              >
                {airBucketLabel(value)}
              </button>
            ))}
          </div>
          <select
            id={`air-bucket-select-${group}`}
            className="air-compact-select"
            aria-label={`${definition.label} bucket size`}
            value={bucket}
            onChange={(event) =>
              bucketChanged(
                event.target.value === "auto"
                  ? "auto"
                  : (Number(event.target.value) as Bucket),
              )
            }
          >
            {airBuckets.map((value) => (
              <option
                key={value}
                value={value}
                disabled={!airBucketAllowed(hours, value)}
                title={bucketTitle(value)}
              >
                {airBucketLabel(value)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p
        id={`air-load-${group}`}
        className="section-note air-load"
        role="status"
        hidden={!status}
      >
        {status}
      </p>
      <AirChart
        group={group}
        data={data}
        cursor={cursor}
        onInspect={setCursor}
      />
    </article>
  );
  return (
    <>
      {modalFull && dialog.current
        ? createPortal(content, dialog.current)
        : content}
      <dialog
        ref={dialog}
        className="air-fullscreen-dialog"
        aria-label={`${definition.label} fullscreen`}
        onClose={() => {
          setModalFull(false);
          requestAnimationFrame(() =>
            button.current?.focus({ preventScroll: true }),
          );
        }}
      />
    </>
  );
}
