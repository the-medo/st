import type { HostShortcuts } from "../lib/hostShortcuts.ts";
import { focusInOtherModal, useFocusTrap } from '../lib/useFocusTrap.ts';
import { usePhoneSheetBack } from '../lib/sheetHistory.ts';
import { createPortal } from 'react-dom';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowDownToLine, ArrowUp, ArrowUpToLine, Check, ChevronDown, ChevronRight, Circle, CircleAlert, Copy, Ellipsis, Folder, GripVertical, Link, LoaderCircle, MessageCircle, Pencil, Plus, RefreshCw, Search, Settings, X } from 'lucide-react';
import type { MedoCatalog, MedoChat, MedoFolder, MedoOpen, MedoProject, MedoStyle } from '../../shared/medo.ts';
import { apiFetch } from '../lib/api-request-id.ts';
import { RowMenu } from './RowMenu.tsx';
import './MedoProjects.css';
import {useResourceUrl} from '../lib/useResourceUrl.ts';
import { useMedoReadState } from '../lib/medoReadState.ts';
import { copyText } from '../lib/clipboard.ts';
import { savedConversationLink } from '../lib/savedConversation.ts';

type SidebarDrag = { kind: 'folder'; projectId: string; id: string } | { kind: 'chat'; projectId: string; id: string; folderId: string | null };
type FolderPosition = NonNullable<MedoFolder['position']>;
const foldersAt = (project: MedoProject, position: FolderPosition) => project.folders.filter((folder) => (folder.position ?? 'end') === position);

function projectColors(style: MedoStyle): CSSProperties {
  const tinted = Boolean(style.sectionColor || style.borderColor);
  const base = style.sectionColor || 'var(--bg-panel)';
  const tint = style.borderColor || 'var(--text)';
  return {
    '--medo-section': style.sectionColor || 'transparent',
    '--medo-border': style.borderColor || 'transparent',
    '--medo-title': style.titleColor || 'var(--text-strong)',
    '--medo-icon': style.iconColor || 'var(--text-dim)',
    '--medo-activity': style.iconColor || style.titleColor || 'var(--accent)',
    '--medo-hover': tinted ? `color-mix(in srgb, ${tint} 12%, ${base})` : 'var(--bg-hover)',
    '--medo-selected': tinted ? `color-mix(in srgb, ${tint} 22%, ${base})` : 'var(--bg-hover)',
  } as CSSProperties;
}

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
export function MedoProjects({ selectedPaneId, onOpen, onNew, onSettings, headerActions, hostShortcuts, selectedThreadId, onRead, onCatalog }: {
  selectedThreadId: string | null; onRead: (chat: MedoChat) => void; onCatalog: (catalog: MedoCatalog) => void;
  hostShortcuts?: HostShortcuts;
  headerActions?: ReactNode;
  selectedPaneId: string | null; onOpen: (paneId: string, isCurrent: () => boolean) => Promise<void>; onNew: (project?: MedoProject) => void; onSettings: () => void;
}) {
  const [catalog, setCatalog] = useState<MedoCatalog | null>(null);
  const [error, setError] = useState('');
  const [catalogError, setCatalogError] = useState('');
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [showDone, setShowDone] = useState(false);
  const [savingDone, setSavingDone] = useState<Set<string>>(new Set());
  const donePending = useRef(new Set<string>());
  const [notice, setNotice] = useState('');
  const [newProject, setNewProject] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [move, setMove] = useState<MedoChat | null>(null);
  const [edit, setEdit] = useState<MedoProject | null>(null);
  const [chatMenu, setChatMenu] = useState<{ chat: MedoChat; anchor: HTMLElement } | null>(null);
  const [projectMenu, setProjectMenu] = useState<{ project: MedoProject; anchor: HTMLElement } | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ projectId: string; folderId: string; anchor: HTMLElement } | null>(null);
  const [dragging, setDragging] = useState<SidebarDrag | null>(null);
  const dragRef = useRef<SidebarDrag | null>(null);
  const [dropTarget, setDropTarget] = useState<{ key: string; direction: 'up' | 'down' | 'inside' } | null>(null);
  const [organizing, setOrganizing] = useState(false);
  const organizePending = useRef(false);
  const [reordering, setReordering] = useState(false);
  const reorderPending = useRef(false);
  const [rename, setRename] = useState<MedoChat | null>(null);
  const readState = useMedoReadState(catalog?.chats, selectedThreadId ? null : selectedPaneId, Boolean(newProject || move || edit || rename || chatMenu || projectMenu || folderMenu), selectedThreadId ?? undefined);
  const pending = useRef<Promise<void> | null>(null);
  const revision = useRef(0);
  const mounted = useRef(false);
  const creatingRef = useRef(false);
  const openingRef = useRef<string | null>(null);
  const selectionTicket = useRef(0);
  const refresh = useCallback(function refreshCatalog(changed = false): Promise<void> {
    if (!mounted.current) return Promise.resolve();
    if (changed) revision.current++;
    if (pending.current) return pending.current;
    let seen = revision.current;
    pending.current = (async () => {
      do {
        seen = revision.current;
        try {
          const next = await call<MedoCatalog>('catalog');
          if (mounted.current && seen === revision.current) { setCatalog(next); setCatalogError(''); }
        } catch (cause) {
          if (mounted.current && seen === revision.current) setCatalogError(cause instanceof Error ? cause.message : 'Could not load projects.');
        }
        // A mutation during a poll requires a fresh read; the old response may
        // describe the terminal before it opened or the folder before it moved.
      } while (mounted.current && seen !== revision.current);
    })().finally(() => {
      pending.current = null;
      // A mutation's promise may settle between the final read and this cleanup.
      if (mounted.current && seen !== revision.current) return refreshCatalog();
    });
    return pending.current;
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 8000);
    const focus = () => void refresh(); window.addEventListener('focus', focus);
    return () => { mounted.current = false; revision.current++; clearInterval(timer); window.removeEventListener('focus', focus); selectionTicket.current++; };
  }, [refresh]);
  const action = async (run: () => Promise<unknown>) => {
    try { await run(); setError(''); await refresh(true); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The change could not be saved.'); return false; }
  };
  const organize = (change: Record<string, unknown>) => call('organize', { change });
  const saveOrganization = async (change: Record<string, unknown>) => {
    if (organizePending.current) return false;
    organizePending.current = true; setOrganizing(true);
    try { return await action(() => organize(change)); }
    finally { organizePending.current = false; if (mounted.current) setOrganizing(false); }
  };
  const clearDrag = () => { dragRef.current = null; setDragging(null); setDropTarget(null); };
  const startDrag = (event: DragEvent<HTMLElement>, source: SidebarDrag) => {
    if (organizePending.current) { event.preventDefault(); return; }
    event.stopPropagation();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-st-sidebar', JSON.stringify(source));
    dragRef.current = source; setDragging(source);
  };
  const dropProps = (projectId: string, folder?: MedoFolder, position?: FolderPosition) => {
    const key = `${projectId}/${position ?? folder?.id ?? ''}`;
    const destination = (event: DragEvent<HTMLElement>) => {
      const source = dragRef.current;
      if (!source || source.projectId !== projectId || organizePending.current) return null;
      if (source.kind === 'chat') {
        if (position || source.folderId === (folder?.id ?? null)) return null;
        return { operation: 'move', projectId, threadId: source.id, folderId: folder?.id ?? null };
      }
      if (folder) {
        if (source.id === folder.id) return null;
        const bounds = event.currentTarget.getBoundingClientRect();
        return { operation: 'move-folder', projectId, folderId: source.id, relativeTo: folder.id, direction: event.clientY < bounds.top + bounds.height / 2 ? 'up' as const : 'down' as const };
      }
      return position ? { operation: 'move-folder', projectId, folderId: source.id, position } : null;
    };
    return {
      'data-drop': dropTarget?.key === key ? dropTarget.direction : undefined,
      onDragOver: (event: DragEvent<HTMLElement>) => {
        const change = destination(event);
        if (!change) return;
        event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
        setDropTarget({ key, direction: change.direction ?? 'inside' });
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget((current) => current?.key === key ? null : current);
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        const change = destination(event);
        if (!change) return;
        event.preventDefault(); event.stopPropagation(); clearDrag();
        void saveOrganization(change).then((ok) => {
          if (ok && mounted.current && change.operation === 'move' && folder) setClosed((current) => { const next = new Set(current); next.delete(`${projectId}/${folder.id}`); return next; });
        });
      },
    };
  };
  const markDone = async (chat: MedoChat) => {
    if (donePending.current.has(chat.id)) return;
    donePending.current.add(chat.id); setSavingDone(new Set(donePending.current));
    try { await action(() => organize({ operation: 'set-done', projectId: chat.project, threadId: chat.id, done: !chat.done })); }
    finally { donePending.current.delete(chat.id); if (mounted.current) setSavingDone(new Set(donePending.current)); }
  };
  const copyConversation = async (chat: MedoChat, link: boolean) => {
    const copied = await copyText(link ? savedConversationLink(window.location.href, chat.id) : chat.id);
    if (!mounted.current) return;
    setNotice(copied ? `Conversation ${link ? 'link' : 'ID'} copied` : '');
    setError(copied ? '' : 'Could not copy to the clipboard. Please try again.');
  };
  const toggle = (key: string) => setClosed((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const read = (chat: MedoChat) => {
    selectionTicket.current++; openingRef.current = null; setOpening(null); setError(''); onRead(chat);
  };
  const open = async (chat: MedoChat) => {
    if (openingRef.current === chat.id) return;
    const ticket = ++selectionTicket.current;
    openingRef.current = chat.id;
    setError('');
    if (chat.assistant || chat.archived || chat.unavailable) { setOpening(null); openingRef.current = null; read(chat); return; }
    setOpening(chat.id);
    try {
      const result = await call<MedoOpen>('open', { threadId: chat.id });
      void refresh(true);
      if (ticket === selectionTicket.current) {
        setCatalog((current) => current && { ...current, chats: current.chats.map((row) => row.id === chat.id ? { ...row, paneId: result.address } : row) });
        await onOpen(result.address, () => ticket === selectionTicket.current);
      }
    } catch (cause) { if (ticket === selectionTicket.current) setError(cause instanceof Error ? cause.message : 'The conversation could not open.'); }
    finally { if (ticket === selectionTicket.current) { setOpening(null); openingRef.current = null; } }
  };
  const openDraft = async (address: string) => {
    const ticket = ++selectionTicket.current;
    openingRef.current = null; setOpening(null); setError('');
    try { await onOpen(address, () => ticket === selectionTicket.current); }
    catch (cause) { if (ticket === selectionTicket.current) setError(cause instanceof Error ? cause.message : 'The conversation could not open.'); }
  };
  useEffect(() => { if (catalog) onCatalog(catalog); }, [catalog, onCatalog]);
  useEffect(() => {
    if (catalog) hostShortcuts?.catalog(catalog, (id, saved) => {
      const chat = catalog.chats.find((item) => item.id === id);
      if (chat) { if (saved) read(chat); else void open(chat); }
    });
  });
  const start = async (project: MedoProject, folder?: MedoFolder) => {
    if (creatingRef.current) return;
    creatingRef.current = true; setCreating(true);
    const ticket = ++selectionTicket.current;
    openingRef.current = null; setOpening(null); setError('');
    setNewProject(false);
    try {
      const result = await call<MedoOpen>('new', { projectId: project.id, ...(folder ? { folderId: folder.id } : {}) });
      void refresh(true);
      if (ticket === selectionTicket.current) {
        setArchived(false); setQuery('');
        setClosed((current) => { const next = new Set(current); next.delete(project.id); if (folder) next.delete(`${project.id}/${folder.id}`); return next; });
        await onOpen(result.address, () => ticket === selectionTicket.current);
      }
    } catch (cause) { if (ticket === selectionTicket.current) setError(cause instanceof Error ? cause.message : 'The conversation could not open.'); }
    finally { creatingRef.current = false; if (mounted.current) setCreating(false); }
  };
  const chats = catalog?.chats.filter((chat) => chat.archived === archived && (showDone || !chat.done) && (!query || chat.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()))) ?? [];
  const drafts = archived ? [] : catalog?.drafts?.filter((draft) => !query || draft.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? [];
  const projects = catalog?.projects.filter((project) => !query || chats.some((chat) => chat.project === project.id) || drafts.some((draft) => draft.project === project.id)) ?? [];
  const projectPosition = projectMenu ? projects.findIndex((project) => project.id === projectMenu.project.id) : -1;
  const moveProject = async (direction: 'up' | 'down') => {
    const relative = projects[projectPosition + (direction === 'up' ? -1 : 1)];
    if (!projectMenu || !relative || reorderPending.current) return;
    reorderPending.current = true; setReordering(true);
    try { await action(() => organize({ operation: 'move-project', projectId: projectMenu.project.id, relativeTo: relative.id, direction })); }
    finally { reorderPending.current = false; if (mounted.current) setReordering(false); }
  };
  useEffect(() => {
    hostShortcuts?.projects((id) => {
      const project = catalog?.projects.find((item) => item.id === id);
      if (!project) return;
      const order = [...foldersAt(project, 'start').map((folder) => folder.id), null, ...foldersAt(project, 'end').map((folder) => folder.id)];
      const first = order.flatMap((folder): (MedoChat | NonNullable<MedoCatalog['drafts']>[number])[] => [
        ...drafts.filter((item) => item.project === id && (item.folder ?? null) === folder),
        ...chats.filter((chat) => chat.project === id && chat.folder === folder).sort((a, b) => b.updated - a.updated),
      ])[0];
      setClosed((current) => {
        const next = new Set(current); next.delete(id);
        if (first && 'folder' in first && first.folder) next.delete(`${id}/${first.folder}`);
        return next;
      });
      if (first) { if ('address' in first) void openDraft(first.address); else void open(first); }
    });
  });
  useEffect(() => () => hostShortcuts?.projects(null), [hostShortcuts]);
  const rows = (project: MedoProject, folder: string | null) => {
    const key = `${project.id}/${folder ?? ''}`;
    const group = chats.filter((chat) => chat.project === project.id && chat.folder === folder).sort((a, b) => b.updated - a.updated);
    const limit = limits[key] ?? 5;
    const renderChat = (chat: MedoChat) => {
      const needsAttention = chat.status === 'blocked';
      const working = chat.status === 'working' || opening === chat.id;
      const finished = !chat.status || chat.status === 'idle' || chat.status === 'done';
      const unread = !working && finished && readState.get(chat.id)?.unread;
      const status = needsAttention ? 'Needs attention' : opening === chat.id ? 'Opening conversation' : working ? 'Working' : unread ? 'Unread conversation' : chat.paneId ? 'Open session' : 'Saved conversation';
      return <div key={chat.id} className={`medo-chat${chat.id === selectedThreadId || (!selectedThreadId && chat.paneId && chat.paneId === selectedPaneId) ? ' is-selected' : ''}${unread ? ' is-unread' : ''}${chat.done ? ' is-done' : ''}`}>
      <button className="medo-chat-open" draggable={!organizing && opening !== chat.id} onDragStart={(event) => startDrag(event, { kind: 'chat', projectId: chat.project, id: chat.id, folderId: chat.folder })} onDragEnd={clearDrag} disabled={opening === chat.id} onClick={() => void open(chat)} title={chat.title} aria-label={chat.title || 'Untitled conversation'} aria-description={status} aria-busy={opening === chat.id}>
        <span className={`medo-indicator${needsAttention ? ' needs-attention' : working ? ' is-working' : ''}`} title={status} role="img" aria-label={status}>{needsAttention ? <CircleAlert size={14} /> : working ? <LoaderCircle className="medo-spinner" size={14} strokeWidth={2} /> : <Circle size={7} fill={unread || chat.paneId ? 'currentColor' : 'none'} />}</span>
        <span className="medo-chat-text"><span className="medo-chat-title">{chat.title || 'Untitled conversation'}</span>{needsAttention && <span className="medo-chat-attention">Needs attention</span>}</span>
      </button><button className="medo-row-action medo-done-action" disabled={savingDone.has(chat.id)} aria-label={`${chat.done ? 'Mark as active' : 'Mark as done'}: ${chat.title}`} title={chat.done ? 'Mark as active' : 'Mark as done'} aria-pressed={Boolean(chat.done)} onClick={() => void markDone(chat)}>{savingDone.has(chat.id) ? <LoaderCircle className="medo-spinner" size={15} /> : <Check size={15} />}</button><button className="medo-row-action" aria-label={`Actions for ${chat.title}`} aria-haspopup="menu" aria-expanded={chatMenu?.chat.id === chat.id} onClick={(event) => setChatMenu(chatMenu?.chat.id === chat.id ? null : { chat, anchor: event.currentTarget })}><Ellipsis size={15} /></button>
    </div>;
    };
    return <>{drafts.filter((draft) => draft.project === project.id && (draft.folder ?? null) === folder).map((draft) => <div key={draft.address} className={`medo-chat${!selectedThreadId && draft.address === selectedPaneId ? ' is-selected' : ''}`}><button className="medo-chat-open" onClick={() => void openDraft(draft.address)}><span className="medo-indicator"><Circle size={7} /></span><span>{draft.title}</span></button></div>)}{group.slice(0, limit).map(renderChat)}{group.length > limit && <div className="medo-list-controls"><button className="medo-more" onClick={() => setLimits((value) => ({ ...value, [key]: limit + 5 }))}>Show more ({group.length - limit})</button></div>}</>;
  };
  const renderFolders = (project: MedoProject, position: FolderPosition) => {
    const zone = dragging?.kind === 'folder' && dragging.projectId === project.id && <div className="medo-folder-drop-zone" data-folder-position={position} {...dropProps(project.id, undefined, position)}>Folders {position === 'start' ? 'before' : 'after'} conversations</div>;
    return <>{position === 'start' && zone}{foldersAt(project, position).map((folder) => {
      const key = `${project.id}/${folder.id}`;
      const folded = !query && closed.has(key);
      return <div className="medo-folder" key={folder.id} data-folder-id={folder.id} data-folder-position={position}>
        <div className="medo-folder-row" draggable={!organizing} onDragStart={(event) => startDrag(event, { kind: 'folder', projectId: project.id, id: folder.id })} onDragEnd={clearDrag} {...dropProps(project.id, folder)}>
          <GripVertical className="medo-folder-grip" size={12} aria-hidden="true" />
          <button className="medo-folder-head" aria-expanded={!folded} onClick={() => toggle(key)} title="Drag to reorder folder">{folded ? <ChevronRight size={12} /> : <ChevronDown size={12} />}<Folder size={13} /><span>{folder.name}</span></button>
          {project.path && <button className="medo-row-action" disabled={creating} aria-label={`New conversation in folder ${folder.name}`} title="New conversation in this folder" onClick={() => void start(project, folder)}><Plus size={15} /></button>}
          <button className="medo-row-action" aria-label={`Actions for folder ${folder.name}`} aria-haspopup="menu" aria-expanded={folderMenu?.projectId === project.id && folderMenu.folderId === folder.id} onClick={(event) => setFolderMenu({ projectId: project.id, folderId: folder.id, anchor: event.currentTarget })}><Ellipsis size={15} /></button>
        </div>{!folded && rows(project, folder.id)}
      </div>;
    })}{position === 'end' && zone}</>;
  };
  const menuProject = folderMenu && catalog?.projects.find((project) => project.id === folderMenu.projectId);
  const menuFolder = menuProject?.folders.find((folder) => folder.id === folderMenu?.folderId);
  const menuSiblings = menuProject && menuFolder ? foldersAt(menuProject, menuFolder.position ?? 'end') : [];
  const folderIndex = menuSiblings.findIndex((folder) => folder.id === menuFolder?.id);
  const moveFolder = (change: Record<string, unknown>) => {
    if (folderMenu) void saveOrganization({ operation: 'move-folder', projectId: folderMenu.projectId, folderId: folderMenu.folderId, ...change });
  };
  const currentEdit = edit && (catalog?.projects.find((project) => project.id === edit.id) ?? edit);
  return <div className="medo-projects" data-dragging={dragging?.kind}>
    <div className="medo-sidebar-head"><strong>Conversations</strong><div className="medo-sidebar-actions">{headerActions}<button aria-label="New conversation" title="New conversation" onClick={() => setNewProject(true)}><Plus size={18} /></button></div></div>
    <label className="medo-search"><Search size={15} /><input aria-label="Search conversations" placeholder="Search conversations" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    {(error || catalogError) && <div className="medo-error" role="alert">{error || catalogError}<button onClick={() => { setError(''); void refresh(true); }}>Retry</button></div>}
    {notice && <div className="medo-copy-notice" role="status">{notice}<button aria-label="Dismiss copy notification" onClick={() => setNotice('')}><X size={13} /></button></div>}
    <div className="medo-project-scroll">{!catalog && !catalogError && <p className="medo-muted">Loading projects…</p>}
      {projects.map((project) => {
        const style = project.appearance ?? {};
        const hidden = !query && closed.has(project.id);
        const projectDrafts = drafts.filter((draft) => draft.project === project.id);
        const matching = chats.filter((chat) => chat.project === project.id).length + projectDrafts.length;
        if (query && !matching) return null;
        return <section key={project.id} className="medo-project" data-st-project={project.id} style={projectColors(style)}>
          <div className="medo-project-head" {...dropProps(project.id)} title={dragging?.kind === 'chat' && dragging.projectId === project.id && dragging.folderId ? 'Drop to move out of the folder' : undefined}><button className="medo-project-toggle" onClick={() => toggle(project.id)} aria-expanded={!hidden}>
            {hidden ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
            <ProjectIcon style={style} />
            <span>{project.name}</span></button>
            {project.path && <button className="medo-row-action" disabled={creating} aria-label={`New conversation in ${project.name}`} onClick={() => void start(project)}><Plus size={15} /></button>}
            <button className="medo-row-action" aria-label={`Actions for project ${project.name}`} aria-haspopup="menu" aria-expanded={projectMenu?.project.id === project.id} onClick={(event) => setProjectMenu(projectMenu?.project.id === project.id ? null : { project, anchor: event.currentTarget })}><Ellipsis size={15} /></button>
          </div>{!hidden && <div className="medo-project-chats">{renderFolders(project, 'start')}<div className="medo-unfiled">{rows(project, null)}</div>{renderFolders(project, 'end')}{!matching && !project.folders.length && <span className="medo-empty">No {archived ? 'archived ' : ''}conversations</span>}</div>}
        </section>;
      })}
    </div>
    <footer><button onClick={() => setArchived(!archived)} aria-pressed={archived}><MessageCircle size={15} />{archived ? 'Archived' : 'Active chats'}</button><button className="medo-show-done" onClick={() => setShowDone(!showDone)} aria-pressed={showDone}><Check size={14} />{showDone ? 'Hide done' : 'Show done'}</button><button aria-label="Refresh projects" onClick={() => void refresh()}><RefreshCw size={15} /></button><button aria-label="Settings" onClick={onSettings}><Settings size={16} /></button></footer>
    {folderMenu && menuFolder && <RowMenu anchor={folderMenu.anchor} title="Folder actions" subtitle={menuFolder.name} onClose={() => setFolderMenu(null)} items={[
      { id: 'start', label: 'Place before conversations', icon: ArrowUpToLine, disabled: organizing, checked: menuFolder.position === 'start', run: () => moveFolder({ position: 'start' }) },
      { id: 'end', label: 'Place after conversations', icon: ArrowDownToLine, disabled: organizing, checked: menuFolder.position !== 'start', run: () => moveFolder({ position: 'end' }) },
      { id: 'up', label: 'Move up', icon: ArrowUp, divider: true, disabled: organizing || folderIndex <= 0, run: () => moveFolder({ relativeTo: menuSiblings[folderIndex - 1]?.id, direction: 'up' }) },
      { id: 'down', label: 'Move down', icon: ArrowDown, disabled: organizing || folderIndex < 0 || folderIndex >= menuSiblings.length - 1, run: () => moveFolder({ relativeTo: menuSiblings[folderIndex + 1]?.id, direction: 'down' }) },
    ]} />}
    {projectMenu && <RowMenu anchor={projectMenu.anchor} title="Project actions" subtitle={projectMenu.project.name} onClose={() => setProjectMenu(null)} items={[
      { id: 'customize', label: 'Customize project', icon: Settings, run: () => setEdit(projectMenu.project) },
      { id: 'up', label: 'Move up', icon: ArrowUp, divider: true, disabled: reordering || projectPosition <= 0, run: () => void moveProject('up') },
      { id: 'down', label: 'Move down', icon: ArrowDown, disabled: reordering || projectPosition < 0 || projectPosition >= projects.length - 1, run: () => void moveProject('down') },
    ]} />}
    {chatMenu && <RowMenu anchor={chatMenu.anchor} title="Conversation actions" subtitle={chatMenu.chat.title} onClose={() => setChatMenu(null)} items={[
      { id: 'rename', label: 'Rename', icon: Pencil, disabled: chatMenu.chat.archived, ...(chatMenu.chat.archived ? { hint: 'Unarchive in Codex to rename' } : {}), run: () => setRename({ ...chatMenu.chat }) },
      { id: 'move', label: 'Move to folder', icon: Folder, run: () => setMove(chatMenu.chat) },
      { id: 'read', label: 'Read saved conversation', icon: MessageCircle, run: () => read(chatMenu.chat) },
      { id: 'copy-link', label: 'Copy conversation link', icon: Link, divider: true, run: () => void copyConversation(chatMenu.chat, true) },
      { id: 'copy-id', label: 'Copy conversation ID', icon: Copy, run: () => void copyConversation(chatMenu.chat, false) },
    ]} />}
    {rename && <RenameChat key={rename.id} chat={rename} onClose={() => setRename((current) => current === rename ? null : current)} onSave={async (name) => {
      const result = await call<{ title: string }>('rename', { threadId: rename.id, name });
      void refresh(true);
      setCatalog((current) => current && ({ ...current, chats: current.chats.map((chat) => chat.id === rename.id ? { ...chat, title: result.title } : chat) }));
    }} />}
    {newProject && <MedoDialog title="New conversation" onClose={() => setNewProject(false)}><div className="medo-folder-choices">{catalog?.projects.filter((project) => project.path).map((project) => <button className="btn medo-project-choice" key={project.id} aria-label={project.name} style={projectColors(project.appearance ?? {})} onClick={() => void start(project)}><ProjectIcon style={project.appearance ?? {}} /><span>{project.name}</span></button>)}<button className="btn" onClick={() => { setNewProject(false); onNew(); }}>Other folder or agent…</button></div></MedoDialog>}
    {move && <MedoDialog title="Move to folder" onClose={() => setMove(null)}><p className="medo-muted">{move.title}</p><div className="medo-folder-choices">{[{ id: '', name: 'No folder' }, ...(catalog?.projects.find((project) => project.id === move.project)?.folders ?? [])].map((folder) => <button key={folder.id} className="btn" onClick={() => void action(() => organize({ operation: 'move', projectId: move.project, threadId: move.id, folderId: folder.id || null })).then((ok) => { if (ok) setMove(null); })}><Folder size={15} />{folder.name}</button>)}</div><button className="btn" onClick={() => { read(move); setMove(null); }}>Read saved conversation</button></MedoDialog>}
    {currentEdit && <ProjectEditor key={currentEdit.id} project={currentEdit} onClose={() => setEdit(null)} onSave={(style) => action(() => call('style', { projectId: currentEdit.id, style }))} onFolder={(change) => action(() => organize({ ...change, projectId: currentEdit.id }))} />}
  </div>;
}
function RenameChat({ chat, onClose, onSave }: { chat: MedoChat; onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState(chat.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const saving = useRef(false);
  return <MedoDialog title="Rename conversation" onClose={onClose}><form onSubmit={(event) => {
    event.preventDefault();
    if (saving.current || !name.trim()) return;
    if (name.trim() === chat.title) { onClose(); return; }
    saving.current = true; setBusy(true); setError('');
    void onSave(name.trim()).then(onClose).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'The conversation could not be renamed.')).finally(() => { saving.current = false; setBusy(false); });
  }}>
    <label>Conversation name<input autoFocus value={name} maxLength={140} required disabled={busy} onFocus={(event) => event.currentTarget.select()} onChange={(event) => setName(event.target.value)} /></label>
    {error && <p className="medo-error" role="alert">{error}</p>}
    <div className="medo-dialog-actions"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save name'}</button></div>
  </form></MedoDialog>;
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
    <div className="medo-colors">{([['titleColor', 'Title'], ['sectionColor', 'Background'], ['borderColor', 'Border'], ['iconColor', 'Icon']] as const).map(([key, title]) => <div className="medo-color" key={key}><label>{title}<input aria-label={`${title} color`} type="color" value={style[key]?.slice(0, 7) || (key === 'sectionColor' ? '#181613' : '#d8d0c3')} onChange={(event) => setStyle({ ...style, [key]: event.target.value })} /></label><button type="button" aria-label={`Reset ${title.toLowerCase()} color`} onClick={() => setStyle({ ...style, [key]: '' })}>Reset</button></div>)}</div>
    <p className="medo-muted">Hover and selected rows follow your background and border colors.</p>
    <div className="medo-appearance-preview" style={projectColors(style)} aria-label="Appearance preview"><div className="medo-preview-heading"><ProjectIcon style={style} />{project.name}<span>Preview</span></div><div className="medo-preview-row"><span className="medo-indicator is-working"><LoaderCircle className="medo-spinner" size={14} /></span>Working conversation</div><div className="medo-preview-row is-unread"><span className="medo-indicator"><Circle size={7} fill="currentColor" /></span>Finished, unread</div><div className="medo-preview-row is-selected"><span className="medo-indicator"><Circle size={7} /></span>Selected conversation</div></div>
    {error && <p role="alert" className="medo-error">{error}</p>}<button className="btn" disabled={busy}>Save appearance</button>
  </form><h3>Folders</h3>{project.folders.map((folder) => <div className="medo-folder-edit" key={folder.id}><input aria-label={`Rename ${folder.name}`} defaultValue={folder.name} key={folder.name} onBlur={(event) => { if (event.target.value !== folder.name) void onFolder({ operation: 'rename', folderId: folder.id, name: event.target.value }); }} /><button title="Remove folder; keep its conversations" aria-label={`Remove folder ${folder.name}`} onClick={() => void onFolder({ operation: 'delete', folderId: folder.id })}><X size={16} /></button></div>)}
    <form className="medo-folder-edit" onSubmit={(event) => { event.preventDefault(); void onFolder({ operation: 'create', name }).then((ok) => { if (ok) setName(''); }); }}><input aria-label="New folder name" placeholder="New folder" maxLength={60} value={name} onChange={(event) => setName(event.target.value)} /><button className="btn" disabled={!name.trim()}><Plus size={16} />Add</button></form><p className="medo-muted">Folders and appearance sync across your PCs. Removing a folder keeps its conversations.</p></MedoDialog>;
}

function ProjectIcon({ style }: { style: MedoStyle }) {
  return <span className="medo-project-icon" aria-hidden="true">{style.image ? <ProjectImage name={style.image} /> : style.iconText || <Folder size={16} />}</span>;
}
function ProjectImage({name}:{name:string}) { const url=useResourceUrl(`/api/medo/icon?name=${encodeURIComponent(name)}`);return url?<img src={url} alt=""/>:null; }
