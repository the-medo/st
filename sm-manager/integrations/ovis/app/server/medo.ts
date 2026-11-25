import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { ConversationPart, ConversationTurn } from '../shared/protocol.ts';
import { codexReadSkills, skillInvocationPrompt } from './skill-activity.ts';
import { badRequest, jsonResponse, readJsonObject, setRequestRoute } from './http.ts';

import { HistoryChanged, type ConversationPage, type RecognizedConversation } from './conversation-shared.ts';

const script = fileURLToPath(new URL('./medo-bridge.py', import.meta.url));
export async function medoCall(payload: Record<string, unknown>, timeoutMs = 75_000): Promise<any> {
  const child = Bun.spawn(['python3', script], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  child.stdin.write(JSON.stringify(payload));
  child.stdin.end();
  const timeout = setTimeout(() => child.kill(), timeoutMs);
  try {
    const [output, , status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (!output) throw new Error('The project bridge did not respond.');
    const value = JSON.parse(output);
    if (status !== 0 || value.error) throw new Error(value.error || 'The project bridge could not complete this request.');
    return value.result;
  } finally { clearTimeout(timeout); }
}

export function medoConversation(data: any): RecognizedConversation {
  const turns: ConversationTurn[] = [];
  const time = (value: number | undefined) => value ? new Date(value * 1000).toISOString() : null;
  for (const turn of data.turns) {
    let assistant: ConversationPart[] = [];
    const flush = () => {
      if (assistant.length) turns.push({ role: 'assistant', ts: time(turn.startedAt), ...(turn.completedAt ? { end_ts: time(turn.completedAt)! } : {}), parts: assistant });
      assistant = [];
    };
    for (const item of turn.items) {
      if (item.role === 'user') {
        flush();
        // Ovis uploads images as explicit file mentions; show those files inline in saved history.
        const mentioned = [...String(item.text).matchAll(/@([^\s]+\.(?:png|jpe?g|webp|gif))(?=\s|$)/gi)].filter((match) => match[1]!.startsWith('/')).map((match) => ({ name: match[1]!.split('/').pop(), path: match[1]! }));
        const files = [...(item.attachments || []), ...mentioned];
        const selected = skillInvocationPrompt(String(item.text));
        const userText = mentioned.reduce((text, file) => text.replace(`@${file.path}`, ''), selected?.request ?? String(item.text)).trim();
        const attachments = files.map((f: any) => /\.(png|jpe?g|webp|gif)$/i.test(f.path)
          ? `![${f.name}](<${f.path}>)` : `[${f.name}](<${f.path}>)`).join('\n');
        turns.push({ role: 'user', ts: time(turn.startedAt), message_id: item.id, turn_id: turn.id,
          parts: [{ kind: 'text', text: [userText, attachments].filter(Boolean).join('\n\n') }] });
        for (const skill of selected?.skills ?? []) assistant.push({ kind: 'skill', skill });
      } else if (item.role === 'assistant') {
        assistant.push({ kind: 'text', text: item.text, ...(item.phase === 'commentary' || item.phase === 'final_answer' ? { phase: item.phase } : {}) });
      } else if (item.kind === 'reasoning') assistant.push({ kind: 'thinking', text: item.text });
      else {
        for (const skill of codexReadSkills({ type: 'CommandExecution', status: item.status, exit_code: item.exitCode, parsed_cmd: item.commandActions })) assistant.push({ kind: 'skill', skill });
        assistant.push({ kind: 'tool', name: item.title || item.kind, summary: item.title || item.kind, input: '', output: item.text || '', call_id: item.id,
        ...(item.mcp ? { mcp: item.mcp } : {}),
        ...(item.status === 'inProgress' ? { state: 'pending' as const } : item.status === 'failed' ? { state: 'error' as const, error: true } : {}) });
      }
    }
    if (turn.error) assistant.push({ kind: 'text', text: `Error: ${typeof turn.error === 'string' ? turn.error : turn.error.message || JSON.stringify(turn.error)}`, failed: true });
    flush();
  }
  return { source: 'codex-transcript', history_id: `medo:${data.thread.id}`, turns, cursor: data.ovisCursor ?? null, version: createHash('sha256').update(JSON.stringify([data.version, data.turns, data.thread.model, data.thread.effort])).digest('hex'),
    metadata: { model: data.thread.model ?? null, reasoning_effort: data.thread.effort ?? null },
    activity: data.active ? 'working' : 'idle' };
}

export async function handleMedoRequest(request: Request, url: URL, readOnly: boolean): Promise<Response | null> {
  if (process.env['MEDO_PROJECTS'] !== '1') return null;
  const own = url.pathname.startsWith('/api/medo/');
  const conversation = url.pathname === '/api/pane/conversation' && request.method === 'GET';
  if (!own && !conversation) return null;
  if (readOnly && own) return jsonResponse({ error: { code: 'read_only', message: 'This device can only watch.' } }, 403);
  try {
    if (conversation) return null;
    setRequestRoute('/api/medo');
    if (request.method === 'GET' && url.pathname === '/api/medo/conversation') {
      const result = await readMedoConversation(url.searchParams.get('pane_id') ?? '', {
        before: url.searchParams.get('before') ?? undefined, from: url.searchParams.get('from') ?? undefined,
        history_id: url.searchParams.get('history_id') ?? undefined,
      }, true);
      return result ? jsonResponse({ ...result, server_time: new Date().toISOString() }, 200, { 'cache-control': 'no-store' }) : badRequest('invalid_conversation', 'Choose a saved conversation.');
    }

    if (request.method === 'GET' && ['/api/medo/resources', '/api/medo/skillshare'].includes(url.pathname)) {
      const paneId = url.searchParams.get('pane_id') ?? '';
      if (!/^(t[\da-z]+|medo:[0-9a-f-]{36})$/.test(paneId)) return badRequest('invalid_conversation', 'Choose a conversation.');
      return jsonResponse(await medoCall({ operation: url.pathname.endsWith('/skillshare') ? 'skillshare' : 'resources', paneId, check: url.searchParams.get('check') === '1' }), 200, { 'cache-control': 'no-store' });
    }

    if (request.method === 'GET' && url.pathname === '/api/medo/catalog') return jsonResponse(await medoCall({ operation: 'index' }), 200, { 'cache-control': 'no-store' });
    if (request.method === 'GET' && url.pathname === '/api/medo/icon') {
      const name = url.searchParams.get('name');
      if (!name || !/^[a-f0-9]{64}\.(png|jpg|webp)$/.test(name)) return badRequest('invalid_icon', 'Choose a project image.');
      const value = await medoCall({ operation: 'icon-get', name });
      return new Response(Buffer.from(value.base64, 'base64'), { headers: { 'content-type': name.endsWith('.jpg') ? 'image/jpeg' : `image/${name.split('.').pop()}`, 'cache-control': 'private, max-age=3600' } });
    }
    if (request.method !== 'POST') return badRequest('method_not_allowed', 'Use POST for this action.');
    const payload = await readJsonObject(request);
    if (payload instanceof Response) return payload;
    const operations: Record<string, string> = { '/api/medo/models': 'models', '/api/medo/settings': 'settings', '/api/medo/open': 'open', '/api/medo/new': 'new', '/api/medo/rename': 'rename', '/api/medo/organize': 'organize', '/api/medo/style': 'style', '/api/medo/icon': 'icon-put' };
    const operation = operations[url.pathname];
    if (!operation) return badRequest('unknown_action', 'Unknown project action.');
    return jsonResponse(await medoCall({ ...payload, operation }));
  } catch (error) {
    if (error instanceof HistoryChanged) return jsonResponse({ error: { code: 'history_changed', message: error.message } }, 409);
    return jsonResponse({ error: { code: 'project_action_failed', message: error instanceof Error ? error.message : 'The project action failed.' } }, 400);
  }
}

/** All Ovis readers (HTTP, watches and search) use the same managed-daemon history. */
export async function readMedoConversation(paneId: string, page: ConversationPage, saved = false): Promise<RecognizedConversation | null> {
  if (process.env['MEDO_PROJECTS'] !== '1' || !/^(t[\da-z]+|medo:[0-9a-f-]{36})$/.test(paneId)) return null;
  if (paneId.startsWith('medo:') && !saved) return null;
  const data = await medoCall({ operation: 'conversation', ...(paneId.startsWith('medo:') ? { threadId: paneId.slice(5) } : { paneId }), before: page.before, from: page.from });
  if (!data) return null;
  if (data.historyChanged) throw new HistoryChanged();
  const result = medoConversation(data);
  if (page.history_id && page.history_id !== result.history_id) throw new HistoryChanged();
  return result;
}
