import { focusInOtherModal, useFocusTrap } from '../lib/useFocusTrap.ts';
import { usePhoneSheetBack } from '../lib/sheetHistory.ts';
import { createPortal } from 'react-dom';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Circle, Ellipsis, Folder, MessageCircle, Plus, RefreshCw, Search, Settings, X } from 'lucide-react';
import type { MedoCatalog, MedoChat, MedoOpen, MedoProject, MedoStyle } from '../../shared/medo.ts';
import { apiFetch } from '../lib/api-request-id.ts';
import { ChatView } from './ChatView.tsx';
import './MedoProjects.css';

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await apiFetch(`/api/medo/${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message || 'The Steam Machine did not respond.');
  return value as T;
}
export function MedoDialog({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  usePhoneSheetBack(onClose);
  const ref = useFocusTrap<HTMLDivElement>(true);
  return createPortal(<div className="medo-overlay" onClick={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}><div ref={ref} role="dialog" aria-modal="true" aria-label={title} onSubmit={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape' && !focusInOtherModal(ref.current)) { event.stopPropagation(); onClose(); } }} className={`medo-dialog${wide ? ' medo-reader' : ''}`}>

    <header><h2>{title}</h2><button aria-label="Close" onClick={onClose}><X size={18} /></button></header>{children}
  </div></div>, document.body);
}
export function MedoProjects({ selectedPaneId, onOpen, onNew, onSettings }: {
  selectedPaneId: string | null; onOpen: (paneId: string) => Promise<void>; onNew: (project?: MedoProject) => void; onSettings: () => void;
}) {
  const [catalog, setCatalog] = useState<MedoCatalog | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [newProject, setNewProject] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [move, setMove] = useState<MedoChat | null>(null);
  const [edit, setEdit] = useState<MedoProject | null>(null);
  const [reader, setReader] = useState<MedoChat | null>(null);
  const pending = useRef(false);
  const selectionTicket = useRef(0);
  const refresh = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    try { setCatalog(await call<MedoCatalog>('catalog')); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load projects.'); }
    finally { pending.current = false; }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 8000);
    const focus = () => void refresh(); window.addEventListener('focus', focus);
    return () => { clearInterval(timer); window.removeEventListener('focus', focus); selectionTicket.current++; };
  }, [refresh]);
  const action = async (run: () => Promise<unknown>) => {
    try { await run(); await refresh(); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The change could not be saved.'); return false; }
  };
  const organize = (change: Record<string, unknown>) => call('organize', { change });
  const toggle = (key: string) => setClosed((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const open = async (chat: MedoChat) => {
    const ticket = ++selectionTicket.current;
    if (chat.archived || chat.unavailable) { setReader(chat); return; }
    setOpening(chat.id); setError('');
    try {
      const result = await call<MedoOpen>('open', { threadId: chat.id });
      if (ticket === selectionTicket.current) await onOpen(result.address);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The conversation could not open.'); }
    finally { if (ticket === selectionTicket.current) setOpening(null); }
  };
  const start = async (project: MedoProject) => {
    setNewProject(false);
    await action(async () => { const result = await call<MedoOpen>('new', { projectId: project.id }); await onOpen(result.address); });
  };
  const chats = catalog?.chats.filter((chat) => chat.archived === archived && (!query || chat.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()))) ?? [];
  const rows = (project: MedoProject, folder: string | null) => {
    const key = `${project.id}/${folder ?? ''}`;
    const group = chats.filter((chat) => chat.project === project.id && chat.folder === folder).sort((a, b) => b.updated - a.updated);
    const limit = limits[key] ?? 5;
    return <>{group.slice(0, limit).map((chat) => <div key={chat.id} className={`medo-chat${chat.paneId && chat.paneId === selectedPaneId ? ' is-selected' : ''}`}>
      <button className="medo-chat-open" disabled={opening === chat.id} onClick={() => void open(chat)} title={chat.title} aria-busy={opening === chat.id}>
        <span className={`medo-indicator${chat.status === 'working' || opening === chat.id ? ' is-working' : ''}`} title={chat.paneId ? 'Open session' : 'Saved conversation'}><Circle size={7} fill={chat.paneId ? 'currentColor' : 'none'} /></span>
        <span>{opening === chat.id ? 'Opening…' : chat.title || 'Untitled conversation'}</span>
      </button><button className="medo-row-action" aria-label={`Move ${chat.title} to folder`} onClick={() => setMove(chat)}><Ellipsis size={15} /></button>
    </div>)}{group.length > limit && <button className="medo-more" onClick={() => setLimits((value) => ({ ...value, [key]: limit + 5 }))}>Show more ({group.length - limit})</button>}</>;
  };
  const currentEdit = edit && (catalog?.projects.find((project) => project.id === edit.id) ?? edit);
  return <div className="medo-projects">
    <div className="medo-sidebar-head"><strong>Conversations</strong><button aria-label="New conversation" title="New conversation" onClick={() => setNewProject(true)}><Plus size={18} /></button></div>
    <label className="medo-search"><Search size={15} /><input aria-label="Search conversations" placeholder="Search conversations" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    {error && <div className="medo-error" role="alert">{error}<button onClick={() => void refresh()}>Retry</button></div>}
    <div className="medo-project-scroll">{!catalog && !error && <p className="medo-muted">Loading projects…</p>}
      {catalog?.projects.map((project) => {
        const style = project.appearance ?? {};
        const hidden = !query && closed.has(project.id);
        const matching = chats.filter((chat) => chat.project === project.id).length;
        if (query && !matching) return null;
        return <section key={project.id} className="medo-project" style={{ '--medo-section': style.sectionColor || 'transparent', '--medo-title': style.titleColor || 'var(--text-strong)', '--medo-icon': style.iconColor || 'var(--text-dim)' } as CSSProperties}>
          <div className="medo-project-head"><button className="medo-project-toggle" onClick={() => toggle(project.id)} aria-expanded={!hidden}>
            {hidden ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
            <span className="medo-project-icon">{style.image ? <img src={`/api/medo/icon?name=${encodeURIComponent(style.image)}`} alt="" /> : style.iconText || <Folder size={16} />}</span>
            <span>{project.name}</span></button>
            {project.path && <button className="medo-row-action" aria-label={`New conversation in ${project.name}`} onClick={() => void start(project)}><Plus size={15} /></button>}
            <button className="medo-row-action" aria-label={`Customize ${project.name}`} onClick={() => setEdit(project)}><Ellipsis size={15} /></button>
          </div>{!hidden && <div className="medo-project-chats">{catalog.drafts?.filter((draft) => draft.project === project.id).map((draft) => <button key={draft.address} className="medo-chat-open" onClick={() => void onOpen(draft.address)}><span className="medo-indicator"><Circle size={7} /></span><span>{draft.title}</span></button>)}{rows(project, null)}{project.folders.map((folder) => {
            const key = `${project.id}/${folder.id}`;
            const folded = !query && closed.has(key);
            return <div className="medo-folder" key={folder.id}><button className="medo-folder-head" aria-expanded={!folded} onClick={() => toggle(key)}>{folded ? <ChevronRight size={12} /> : <ChevronDown size={12} />}<Folder size={13} /><span>{folder.name}</span></button>{!folded && rows(project, folder.id)}</div>;
          })}{!matching && !project.folders.length && <span className="medo-empty">No {archived ? 'archived ' : ''}conversations</span>}</div>}
        </section>;
      })}
    </div>
    <footer><button onClick={() => setArchived(!archived)} aria-pressed={archived}><MessageCircle size={15} />{archived ? 'Archived' : 'Active chats'}</button><button aria-label="Refresh projects" onClick={() => void refresh()}><RefreshCw size={15} /></button><button aria-label="Settings" onClick={onSettings}><Settings size={16} /></button></footer>
    {newProject && <MedoDialog title="New conversation" onClose={() => setNewProject(false)}><div className="medo-folder-choices">{catalog?.projects.filter((project) => project.path).map((project) => <button className="btn" key={project.id} onClick={() => void start(project)}><Folder size={15} />{project.name}</button>)}<button className="btn" onClick={() => { setNewProject(false); onNew(); }}>Other folder or agent…</button></div></MedoDialog>}
    {move && <MedoDialog title="Move to folder" onClose={() => setMove(null)}><p className="medo-muted">{move.title}</p><div className="medo-folder-choices">{[{ id: '', name: 'No folder' }, ...(catalog?.projects.find((project) => project.id === move.project)?.folders ?? [])].map((folder) => <button key={folder.id} className="btn" onClick={() => void action(() => organize({ operation: 'move', projectId: move.project, threadId: move.id, folderId: folder.id || null })).then((ok) => { if (ok) setMove(null); })}><Folder size={15} />{folder.name}</button>)}</div><button className="btn" onClick={() => { setReader(move); setMove(null); }}>Read saved conversation</button></MedoDialog>}
    {currentEdit && <ProjectEditor key={currentEdit.id} project={currentEdit} onClose={() => setEdit(null)} onSave={(style) => action(() => call('style', { projectId: currentEdit.id, style }))} onFolder={(change) => action(() => organize({ ...change, projectId: currentEdit.id }))} />}
    {reader && <MedoDialog title={reader.title} wide onClose={() => setReader(null)}><p className="medo-muted">{reader.unavailable || (reader.archived ? 'Archived conversation — unarchive it in Codex to continue.' : 'Read-only preview of saved history.')}</p><div className="medo-reader-body"><ChatView paneId={`medo:${reader.id}`} refreshKey={0} connected ended agent="codex" watching cwd={reader.cwd} /></div></MedoDialog>}
  </div>;
}
function ProjectEditor({ project, onClose, onSave, onFolder }: { project: MedoProject; onClose: () => void; onSave: (style: MedoStyle) => Promise<boolean>; onFolder: (change: Record<string, unknown>) => Promise<boolean> }) {
  const [style, setStyle] = useState<MedoStyle>(project.appearance ?? {});
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return <MedoDialog title={project.name} onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); setBusy(true); void onSave(style).then((ok) => { if (ok) onClose(); else setError('Could not save. Close this dialog to see the connection error.'); }).finally(() => setBusy(false)); }}>
    <h3>Appearance</h3><label>Icon or emoji<input maxLength={8} value={style.iconText ?? ''} onChange={(event) => setStyle({ ...style, iconText: event.target.value })} placeholder="📁" /></label>
    <label>Project image<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => {
      const file = event.target.files?.[0]; if (!file) return;
      if (file.size > 512 * 1024) { setError('Choose an image smaller than 512 KB.'); return; }
      setBusy(true); setError(''); const reader = new FileReader();
      reader.onerror = () => { setError('The image could not be read.'); setBusy(false); };
      reader.onload = () => { void call<{ image: string }>('icon', { base64: String(reader.result).split(',')[1] }).then((value) => setStyle((current) => ({ ...current, image: value.image }))).catch((cause: unknown) => setError(String(cause))).finally(() => setBusy(false)); }; reader.readAsDataURL(file);
    }} /></label>{style.image && <button type="button" className="btn" onClick={() => setStyle({ ...style, image: '' })}>Remove image</button>}
    <div className="medo-colors">{([['titleColor', 'Title'], ['sectionColor', 'Section'], ['iconColor', 'Icon']] as const).map(([key, title]) => <label key={key}>{title}<input type="color" value={style[key] || (key === 'sectionColor' ? '#181613' : '#d8d0c3')} onChange={(event) => setStyle({ ...style, [key]: event.target.value })} /><button type="button" onClick={() => setStyle({ ...style, [key]: '' })}>Reset</button></label>)}</div>
    {error && <p role="alert" className="medo-error">{error}</p>}<button className="btn" disabled={busy}>Save appearance</button>
  </form><h3>Folders</h3>{project.folders.map((folder) => <div className="medo-folder-edit" key={folder.id}><input aria-label={`Rename ${folder.name}`} defaultValue={folder.name} key={folder.name} onBlur={(event) => { if (event.target.value !== folder.name) void onFolder({ operation: 'rename', folderId: folder.id, name: event.target.value }); }} /><button title="Remove folder; keep its conversations" aria-label={`Remove folder ${folder.name}`} onClick={() => void onFolder({ operation: 'delete', folderId: folder.id })}><X size={16} /></button></div>)}
    <form className="medo-folder-edit" onSubmit={(event) => { event.preventDefault(); void onFolder({ operation: 'create', name }).then((ok) => { if (ok) setName(''); }); }}><input aria-label="New folder name" placeholder="New folder" maxLength={60} value={name} onChange={(event) => setName(event.target.value)} /><button className="btn" disabled={!name.trim()}><Plus size={16} />Add</button></form><p className="medo-muted">Folders and appearance sync across your PCs. Removing a folder keeps its conversations.</p></MedoDialog>;
}
