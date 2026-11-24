import {useEffect, useRef, type ReactNode} from 'react';
import {safeUrl} from '../lib/api';
export function Panel({title, actions, children}: {title?: string; actions?: ReactNode; children: ReactNode}) {return <section className="st-panel">{(title || actions) && <header><h2>{title}</h2>{actions}</header>}{children}</section>;}
export function Notice({children, retry}: {children: ReactNode; retry?: () => void}) {return <div className="st-notice" role="status">{children}{retry && <button onClick={retry}>Retry</button>}</div>;}
export function Empty({children = 'No data available.'}: {children?: ReactNode}) {return <p className="st-empty">{children}</p>;}
export function Metric({label, value, detail}: {label: string; value: ReactNode; detail?: ReactNode}) {return <div className="st-metric"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;}
export function External({url, children, protocols}: {url?: string; children: ReactNode; protocols?: string[]}) {const href = safeUrl(url, protocols); return href ? <a href={href} target="_blank" rel="noopener noreferrer">{children} ↗</a> : <span>{children}</span>;}
export function Modal({title, children, close}: {title: string; children: ReactNode; close: () => void}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {const d = ref.current!; const focus = document.activeElement as HTMLElement | null; d.showModal(); return () => {d.close(); focus?.focus();};}, []);
  return <dialog ref={ref} onCancel={close} className="st-dialog"><header><h2>{title}</h2><button onClick={close} aria-label="Close dialog">✕</button></header>{children}</dialog>;
}
