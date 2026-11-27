import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, FolderOpen, LoaderCircle } from 'lucide-react';
import type { MedoNewRequest, MedoOpen, MedoProject, MedoProvider, MedoProviders } from '../../shared/medo.ts';
import { MAX_FIRST_MESSAGE_CHARS } from '../../shared/launch-rules.ts';
import { apiFetch } from '../lib/api-request-id.ts';
import { useMachineSessions } from '../lib/machineSessionContext.tsx';
import { weeklyRemaining } from '../lib/medoProviders.ts';
import { useUsage } from '../lib/usage.ts';
import { AgentMark } from './AgentMark.tsx';
import { DirectoryBrowser } from './DirectoryBrowser.tsx';
import { MedoDialog } from './MedoProjects.tsx';
import './MedoNewConversation.css';

const PROVIDERS = [{ id: 'codex', label: 'Codex' }, { id: 'claude', label: 'Claude' }] as const;
const EFFORT_LABELS: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum', ultra: 'Ultra', minimal: 'Minimal', none: 'None' };
type Choice = { model: string; effort: string };

export function MedoNewConversation({ projects, initialProject, initialFolder, onClose, onStart }: {
  projects: MedoProject[];
  initialProject: string | null;
  initialFolder?: string;
  onClose: () => void;
  onStart: (request: MedoNewRequest) => Promise<MedoOpen>;
}) {
  const sessions = useMachineSessions();
  const [provider, setProvider] = useState<MedoProvider>('codex');
  const [options, setOptions] = useState<MedoProviders | null>(null);
  const [loading, setLoading] = useState(true);
  const [choices, setChoices] = useState<Record<MedoProvider, Choice>>({ codex: { model: '', effort: '' }, claude: { model: '', effort: '' } });
  const [project, setProject] = useState(initialProject ?? projects.find((item) => item.path)?.id ?? '');
  const [folder, setFolder] = useState(initialFolder ?? '');
  const folders = projects.find((item) => item.id === project)?.folders ?? [];
  const [cwd, setCwd] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [optionsError, setOptionsError] = useState('');
  const inFlight = useRef(false);
  const { report, loading: usageLoading, refresh } = useUsage(true);
  const selected = options?.providers.find((item) => item.id === provider);
  const choice = choices[provider];
  const model = selected?.models.find((item) => item.id === choice.model);
  const efforts = model?.efforts ?? (provider === 'claude' ? ['low', 'medium', 'high', 'xhigh', 'max'] : []);

  useEffect(() => {
    const controller = new AbortController();
    void apiFetch('/api/medo/providers', { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error('Could not load the available agents. Reopen this window to try again.');
      const value = await response.json() as MedoProviders;
      if (controller.signal.aborted) return;
      setOptions(value);
      const preset = value.providers.find((item) => item.id === 'codex')?.models.find((item) => item.isDefault);
      if (preset) setChoices((current) => ({ ...current, codex: { model: preset.id, effort: preset.defaultEffort } }));
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setOptionsError(cause instanceof Error ? cause.message : 'Could not load the available agents.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  const change = (next: Partial<Choice>) => setChoices((current) => ({ ...current, [provider]: { ...current[provider], ...next } }));
  const close = () => { if (!inFlight.current) onClose(); };
  const start = async () => {
    if (inFlight.current || loading || !selected?.installed || (!project && !cwd.trim())) return;
    inFlight.current = true; setPending(true); setError('');
    const text = prompt.trim();
    const connection = sessions?.peek('local')?.connection;
    try {
      await onStart({ ...(project ? { projectId: project, ...(folder ? { folderId: folder } : {}) } : { cwd: cwd.trim() }), provider, ...choice,
        ...(text ? { prompt: text } : {}), ...(connection ? { first_message_connection: connection } : {}) });
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The conversation could not start.'); }
    finally { inFlight.current = false; setPending(false); }
  };

  return <MedoDialog title="New conversation" onClose={close} className="medo-new-dialog">
    <form className="medo-new-form" onSubmit={(event) => { event.preventDefault(); void start(); }}>
      <div className="medo-new-destination"><div className="medo-new-project-fields"><label>Project<select aria-label="Project" value={project} disabled={pending} onChange={(event) => { setProject(event.target.value); setFolder(''); }}>
        {projects.filter((item) => item.path).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        <option value="">Other folder…</option>
      </select></label>{folders.length > 0 && <label>Conversation folder<select aria-label="Conversation folder" value={folder} disabled={pending} onChange={(event) => setFolder(event.target.value)}><option value="">Unfiled</option>{folders.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}</div>{!project && <label>Folder<div className="medo-new-folder"><input aria-label="Folder" value={cwd} placeholder="Choose a folder" disabled={pending} onChange={(event) => setCwd(event.target.value)} /><button type="button" className="btn" aria-label="Browse folders" disabled={pending} onClick={() => setBrowsing(true)}><FolderOpen size={18} /></button></div></label>}</div>
      <div className="medo-provider-choices" role="radiogroup" aria-label="Conversation provider" onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || pending) return;
        event.preventDefault();
        const next = provider === 'codex' ? 'claude' : 'codex';
        if (options?.providers.find((item) => item.id === next)?.installed) {
          setProvider(next);
          event.currentTarget.querySelector<HTMLButtonElement>(`[data-provider="${next}"]`)?.focus();
        }
      }}>
        {PROVIDERS.map((item) => {
          const option = options?.providers.find((value) => value.id === item.id);
          const usage = weeklyRemaining(option, report);
          const isSelected = provider === item.id;
          return <button key={item.id} type="button" role="radio" aria-checked={isSelected} aria-label={item.label} aria-describedby={`weekly-${item.id}`} data-provider={item.id}
            tabIndex={isSelected || (!selected?.installed && option?.installed) ? 0 : -1} disabled={pending || (!loading && !option?.installed)} className={`medo-provider-card${isSelected ? ' is-selected' : ''}`}
            onClick={() => setProvider(item.id)}>
            <span id={`weekly-${item.id}`} className={`medo-weekly-badge${usage.percent !== null && usage.percent <= 15 ? ' is-low' : ''}`} title={usage.note}>
              {usage.percent === null ? (usageLoading && !report ? 'Checking usage…' : 'Usage unavailable') : <><strong>{usage.percent}%</strong> left this week</>}
            </span>
            <span className="medo-provider-logo" aria-hidden="true"><AgentMark agent={item.id} size={68} /></span>
            <span className="medo-provider-name">{item.label}</span>
            <span className="medo-provider-selection">{isSelected ? <><Check size={13} /> Selected</> : option && !option.installed ? 'Not installed' : 'Choose agent'}</span>
          </button>;
        })}
      </div>
      <div className="medo-new-models"><label>Model<select aria-label="Model" value={choice.model} disabled={pending || loading} onChange={(event) => {
        const next = selected?.models.find((item) => item.id === event.target.value);
        change({ model: event.target.value, effort: next?.defaultEffort ?? '' });
      }}><option value="">Agent default</option>{selected?.models.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label>Reasoning<select aria-label="Reasoning" value={choice.effort} disabled={pending || loading || !efforts.length} onChange={(event) => change({ effort: event.target.value })}>
          <option value="">Default</option>{efforts.map((effort) => <option key={effort} value={effort}>{EFFORT_LABELS[effort] ?? effort}</option>)}
        </select></label></div>
      {(selected?.error || optionsError) && <p className="medo-new-note" role="status">{optionsError || selected?.error}</p>}
      <label className="medo-new-message">Message<textarea aria-label="Message" placeholder="What would you like to work on?" value={prompt} maxLength={MAX_FIRST_MESSAGE_CHARS} disabled={pending} onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void start(); } }} /></label>
      {error && <p role="alert" className="medo-error">{error}</p>}
      <div className="medo-new-actions"><button type="button" className="medo-usage-refresh" onClick={refresh} disabled={usageLoading || pending}>Refresh usage</button>
        <button className="btn btn-primary medo-new-submit" disabled={loading || pending || !selected?.installed || (!project && !cwd.trim())}>
          {pending ? <LoaderCircle className="medo-spinner" size={17} /> : <ArrowUp size={17} />}{pending ? 'Starting…' : 'Start conversation'}
        </button></div>
    </form>
    {browsing && <MedoDialog title="Choose folder" onClose={() => setBrowsing(false)}><DirectoryBrowser start={cwd} onPick={(path) => { setCwd(path); setBrowsing(false); }} /></MedoDialog>}
  </MedoDialog>;
}
