import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ConversationMetadata } from '../../shared/protocol.ts';
import { apiFetch } from '../lib/api-request-id.ts';
import { MedoDialog } from './MedoProjects.tsx';

type Model = { model: string; displayName: string; defaultReasoningEffort: string; supportedReasoningEfforts: { reasoningEffort: string }[] };
async function request<T>(action: string, body: object): Promise<T> {
  const response = await apiFetch(`/api/medo/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message || 'Codex did not respond.');
  return value as T;
}
export function MedoModelPicker({ paneId, metadata }: { paneId: string; metadata?: ConversationMetadata | null }) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const show = async () => {
    setOpen(true); setError(''); setBusy(true);
    try {
      const value = await request<{ models: Model[] }>('models', { paneId });
      setModels(value.models); const selected = value.models.find((item) => item.model === metadata?.model) ?? value.models[0];
      setModel(selected?.model ?? ''); setEffort(metadata?.reasoning_effort ?? selected?.defaultReasoningEffort ?? '');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const selected = models.find((item) => item.model === model);
  return <><button type="button" className="medo-model-button" aria-label="Change model and reasoning" title="Change model and reasoning" onClick={() => void show()}>{metadata?.model || 'Model'}{metadata?.reasoning_effort ? ` · ${metadata.reasoning_effort}` : ''}<ChevronDown size={12} /></button>
    {open && <MedoDialog title="Model and reasoning" onClose={() => setOpen(false)}><form onSubmit={(event) => {
      event.preventDefault(); setBusy(true); setError('');
      void request('settings', { paneId, model, effort }).then(() => setOpen(false)).catch((cause: unknown) => setError(String(cause))).finally(() => setBusy(false));
    }}><label>Model<select aria-label="Model" value={model} disabled={busy} onChange={(event) => { setModel(event.target.value); setEffort(models.find((item) => item.model === event.target.value)?.defaultReasoningEffort ?? ''); }}>{models.map((item) => <option key={item.model} value={item.model}>{item.displayName || item.model}</option>)}</select></label>
      <label>Reasoning<select aria-label="Reasoning" value={effort} disabled={busy} onChange={(event) => setEffort(event.target.value)}>{selected?.supportedReasoningEfforts.map((item) => <option key={item.reasoningEffort} value={item.reasoningEffort}>{item.reasoningEffort}</option>)}</select></label>
      {error && <p role="alert" className="medo-error">{error}</p>}<button className="btn" disabled={busy || !model}>{busy ? 'Loading…' : 'Apply to this conversation'}</button>
    </form></MedoDialog>}
  </>;
}
