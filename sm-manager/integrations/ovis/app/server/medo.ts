import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { ConversationPart, ConversationTurn } from '../shared/protocol.ts';
import { codexReadSkills, skillInvocationPrompt } from './skill-activity.ts';
import { formatCodexQuestionReply } from '../shared/codex-question-reply.ts';
import { badRequest, jsonResponse, readJsonObject, setRequestRoute } from './http.ts';
import type { MedoProviders } from '../shared/medo.ts';
import { firstMessageFault } from '../shared/launch-rules.ts';
import type { FirstMessages } from './workspace-routes.ts';
import { homeSignIn, systemUsageContext } from './usage.ts';
import { authorizedTranscript } from './transcript-store.ts';
import { readBound } from './conversation-shared.ts';

import { HistoryChanged, type ConversationPage, type RecognizedConversation } from './conversation-shared.ts';

const script = fileURLToPath(new URL('./medo-bridge.py', import.meta.url));
export async function medoCall(payload: Record<string, unknown>, timeoutMs = 75_000): Promise<any> {
  const child = Bun.spawn(['python3', script], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...process.env } });
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

function nativeTurnTime(id: unknown): string | null {
  // Codex can omit startedAt from persisted turns. A native UUIDv7 still carries
  // its creation time (RFC 9562 §5.7); never substitute the time of this read.
  if (typeof id !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(id)) return null;
  return new Date(Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16)).toISOString();
}

export function medoConversation(data: any): RecognizedConversation {
  const turns: ConversationTurn[] = [];
  const time = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value) ? new Date(value * 1000).toISOString() : null;
  for (const turn of data.turns) {
    const started = time(turn.startedAt) ?? nativeTurnTime(turn.id);
    let assistant: ConversationPart[] = [];
    const flush = () => {
      if (assistant.length) turns.push({ role: 'assistant', turn_id: turn.id, ts: started, ...(turn.completedAt ? { end_ts: time(turn.completedAt)! } : {}), parts: assistant });
      assistant = [];
    };
    for (const item of turn.items) {
      if (item.role === 'user') {
        flush();
        const reply = formatCodexQuestionReply(String(item.text));
        if (reply !== null) {
          turns.push({ role: 'user', ts: started, message_id: item.id, turn_id: turn.id, parts: [{ kind: 'text', text: reply }] });
          continue;
        }
        // Ovis uploads images as explicit file mentions; show those files inline in saved history.
        const mentioned = [...String(item.text).matchAll(/@([^\s]+\.(?:png|jpe?g|webp|gif))(?=\s|$)/gi)].filter((match) => match[1]!.startsWith('/')).map((match) => ({ name: match[1]!.split('/').pop(), path: match[1]! }));
        const files = [...(item.attachments || []), ...mentioned];
        const selected = skillInvocationPrompt(String(item.text));
        const userText = mentioned.reduce((text, file) => text.replace(`@${file.path}`, ''), selected?.request ?? String(item.text)).trim();
        const attachments = files.map((f: any) => /\.(png|jpe?g|webp|gif)$/i.test(f.path)
          ? `![${f.name}](<${f.path}>)` : `[${f.name}](<${f.path}>)`).join('\n');
        turns.push({ role: 'user', ts: started, message_id: item.id, turn_id: turn.id,
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
  return { source: 'codex-transcript', history_id: `medo:${data.thread.id}`, turns, cursor: data.ovisCursor ?? null, version: createHash('sha256').update(JSON.stringify([data.version, turns, data.thread.model, data.thread.effort])).digest('hex'),
    metadata: { model: data.thread.model ?? null, reasoning_effort: data.thread.effort ?? null },
    activity: data.active ? 'working' : 'idle' };
}

interface MedoServices {
  firstMessages?: FirstMessages;
  changed?: () => void;
  timeout?: () => void;
  call?: typeof medoCall;
}

export async function handleMedoRequest(request: Request, url: URL, readOnly: boolean, services: MedoServices = {}): Promise<Response | null> {
  if (process.env['MEDO_PROJECTS'] !== '1') return null;
  const own = url.pathname.startsWith('/api/medo/');
  const conversation = url.pathname === '/api/pane/conversation' && request.method === 'GET';
  const savedClaudeMedia = ['/api/pane/conversation/image', '/api/pane/conversation/tool-output'].includes(url.pathname)
    && /^medo:claude:[0-9a-f-]{36}$/.test(url.searchParams.get('pane_id') ?? '');
  if (!own && !conversation && !savedClaudeMedia) return null;
  if (readOnly && (own || savedClaudeMedia)) return jsonResponse({ error: { code: 'read_only', message: 'This device can only watch.' } }, 403);
  try {
    const call = services.call ?? medoCall;
    if (conversation) return null;
    setRequestRoute('/api/medo');
    if (savedClaudeMedia) {
      if (request.method !== 'GET') return badRequest('method_not_allowed', 'Use GET to read saved conversation content.');
      const ref = url.searchParams.get('ref');
      if (!ref) return badRequest('missing_parameter', 'Choose an image or tool output.');
      const authorized = await savedClaudeTranscript(url.searchParams.get('pane_id')!.slice(5), call);
      if (!authorized) return jsonResponse({ error: { code: 'not_found', message: 'Saved content is unavailable.' } }, 404);
      const { transcriptImage, transcriptToolOutput } = await import('./conversation.ts');
      const [dev, ino] = authorized.identity.split(':').map(BigInt);
      const headers = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' };
      if (url.pathname.endsWith('/image')) {
        const image = readBound([[authorized.path, { dev: dev!, ino: ino! }]], () => transcriptImage(authorized.path, ref));
        return image ? new Response(image.bytes, { headers: { ...headers, 'content-type': image.mediaType, 'content-security-policy': "default-src 'none'; sandbox" } })
          : jsonResponse({ error: { code: 'image_not_found', message: 'This image is unavailable.' } }, 404);
      }
      const output = readBound([[authorized.path, { dev: dev!, ino: ino! }]], () => transcriptToolOutput('claude-transcript', authorized.path, ref));
      return output !== null ? new Response(output, { headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' } })
        : jsonResponse({ error: { code: 'output_not_found', message: 'This tool output is unavailable.' } }, 404);
    }
    if (request.method === 'GET' && url.pathname === '/api/medo/providers') {
      const ctx = systemUsageContext();
      const [result, codex, claude] = await Promise.all([
        call({ operation: 'providers' }) as Promise<MedoProviders>,
        homeSignIn(ctx, 'codex', ctx.env['CODEX_HOME'] ? { kind: 'dir', dir: ctx.env['CODEX_HOME'] } : { kind: 'default' }).catch(() => null),
        homeSignIn(ctx, 'claude', ctx.env['CLAUDE_CONFIG_DIR'] ? { kind: 'dir', dir: ctx.env['CLAUDE_CONFIG_DIR'] } : { kind: 'default' }).catch(() => null),
      ]);
      return jsonResponse({ providers: result.providers.map((provider) => {
        const signIn = provider.id === 'codex' ? codex : claude;
        return { ...provider, usageKey: signIn && signIn !== 'unknown' ? signIn.key : null };
      }) }, 200, { 'cache-control': 'no-store' });
    }
    if (request.method === 'GET' && url.pathname === '/api/medo/conversation') {
      const result = await readMedoConversation(url.searchParams.get('pane_id') ?? '', {
        before: url.searchParams.get('before') ?? undefined, from: url.searchParams.get('from') ?? undefined,
        history_id: url.searchParams.get('history_id') ?? undefined,
      }, true, call);
      return result ? jsonResponse({ ...result, server_time: new Date().toISOString() }, 200, { 'cache-control': 'no-store' }) : badRequest('invalid_conversation', 'Choose a saved conversation.');
    }

    if (request.method === 'GET' && url.pathname === '/api/medo/resources') {
      const paneId = url.searchParams.get('pane_id') ?? '';
      if (!/^(t[\da-z]+|medo:[0-9a-f-]{36})$/.test(paneId)) return badRequest('invalid_conversation', 'Choose a conversation.');
      return jsonResponse(await call({ operation: 'resources', paneId }), 200, { 'cache-control': 'no-store' });
    }

    if (request.method === 'GET' && url.pathname === '/api/medo/catalog') return jsonResponse(await call({ operation: 'index' }), 200, { 'cache-control': 'no-store' });
    if (request.method === 'GET' && url.pathname === '/api/medo/assistant') {
      return jsonResponse(await call({ operation: 'assistant_state', threadId: url.searchParams.get('thread') }), 200, { 'cache-control': 'no-store' });
    }
    if (request.method === 'GET' && url.pathname === '/api/medo/icon') {
      const name = url.searchParams.get('name');
      if (!name || !/^[a-f0-9]{64}\.(png|jpg|webp)$/.test(name)) return badRequest('invalid_icon', 'Choose a project image.');
      const value = await call({ operation: 'icon-get', name });
      return new Response(Buffer.from(value.base64, 'base64'), { headers: { 'content-type': name.endsWith('.jpg') ? 'image/jpeg' : `image/${name.split('.').pop()}`, 'cache-control': 'private, max-age=3600' } });
    }
    if (request.method !== 'POST') return badRequest('method_not_allowed', 'Use POST for this action.');
    const payload = await readJsonObject(request);
    if (payload instanceof Response) return payload;
    if (url.pathname === '/api/medo/read-completion') {
      if (typeof payload.threadId !== 'string' || !/^[0-9a-f-]{36}$/.test(payload.threadId)
        || typeof payload.completionId !== 'string' || !payload.completionId || payload.completionId.length > 300)
        return badRequest('invalid_completion', 'Choose the completed turn you read.');
      return jsonResponse(await call({ operation: 'read-completion', threadId: payload.threadId, completionId: payload.completionId }), 200, { 'cache-control': 'no-store' });
    }
    if (url.pathname === '/api/medo/assistant') {
      if (!['send', 'answer', 'stop'].includes(String(payload.action))) return badRequest('unknown_action', 'Choose an assistant action.');
      return jsonResponse(await call({ ...payload, operation: `assistant_${payload.action}` }));
    }
    if (url.pathname === '/api/medo/new') {
      const provider = payload['provider'] ?? 'codex';
      if (provider !== 'codex' && provider !== 'claude') return badRequest('invalid_provider', 'Choose Codex or Claude.');
      if ((payload['model'] !== undefined && typeof payload['model'] !== 'string') || (payload['effort'] !== undefined && typeof payload['effort'] !== 'string')) return badRequest('invalid_model', 'Choose a model and reasoning level.');
      const prompt = payload['prompt'];
      const fault = firstMessageFault(prompt, provider);
      if (fault) return badRequest('invalid_first_message', fault);
      const connection = payload['first_message_connection'] ?? null;
      if (connection !== null && (typeof connection !== 'string' || !connection || connection.length > 128)) return badRequest('invalid_first_message', 'Choose a connected conversation window.');
      if (typeof prompt === 'string' && !services.firstMessages) return badRequest('message_queue_unavailable', 'The message queue is unavailable. Try again shortly.');
      const asked = typeof prompt === 'string' ? services.firstMessages!.ask(connection as string | null) : null;
      services.timeout?.();
      try {
        const { pid, ...result } = await call({ ...payload, provider, operation: 'new' });
        asked?.at(result.address);
        services.changed?.();
        if (asked && typeof prompt === 'string') {
          try {
            const message = await services.firstMessages!.queue(result.address, prompt, provider, asked, typeof pid === 'number' ? pid : null);
            result.first_message = { id: message.id, ...(message.state === 'held' && message.error ? { held: message.error.code } : {}) };
          } catch {
            // Creation succeeded: return its pane so a retry cannot create another conversation.
            result.first_message = { error: { message: 'Conversation created. Your message was saved as a draft; send it from the conversation.' } };
          }
        }
        services.changed?.();
        return jsonResponse(result);
      } finally { asked?.end(); }
    }
    const operations: Record<string, string> = { '/api/medo/models': 'models', '/api/medo/settings': 'settings', '/api/medo/open': 'open', '/api/medo/new': 'new', '/api/medo/rename': 'rename', '/api/medo/organize': 'organize', '/api/medo/style': 'style', '/api/medo/icon': 'icon-put' };
    const operation = operations[url.pathname];
    if (!operation) return badRequest('unknown_action', 'Unknown project action.');
    const { pid: _pid, ...result } = await call({ ...payload, operation });
    return jsonResponse(result);
  } catch (error) {
    if (error instanceof HistoryChanged) return jsonResponse({ error: { code: 'history_changed', message: error.message } }, 409);
    return jsonResponse({ error: { code: 'project_action_failed', message: error instanceof Error ? error.message : 'The project action failed.' } }, 400);
  }
}

/** Resolve only registered native Claude history, then bind reads to that file. */
async function savedClaudeTranscript(threadId: string, call = medoCall) {
  const data = await call({ operation: 'claude-history', threadId });
  if (!data) return null;
  const authorized = authorizedTranscript(data.path, data.root);
  if (!authorized) throw new Error('The saved Claude conversation is unavailable.');
  return authorized;
}

export async function readMedoConversation(paneId: string, page: ConversationPage, saved = false, call = medoCall): Promise<RecognizedConversation | null> {
  if (process.env['MEDO_PROJECTS'] !== '1' || !/^(t[\da-z]+|medo:(?:claude:)?[0-9a-f-]{36})$/.test(paneId)) return null;
  if (paneId.startsWith('medo:') && !saved) return null;
  if (paneId.startsWith('medo:claude:')) {
    const authorized = await savedClaudeTranscript(paneId.slice(5), call);
    if (!authorized) return { source: 'claude-transcript', history_id: paneId, turns: [], version: 'empty', cursor: null, metadata: { model: null, reasoning_effort: null }, activity: 'idle' };
    // The native reader provides paging, tools, thinking, branches and metadata for saved history too.
    const { transcriptPage } = await import('./conversation.ts');
    const [dev, ino] = authorized.identity.split(':').map(BigInt);
    const result = readBound([[authorized.path, { dev: dev!, ino: ino! }]], () => transcriptPage('claude-transcript', authorized.path, page));
    if (page.history_id && page.history_id !== result.history_id) throw new HistoryChanged();
    return result;
  }
  const data = await call({ operation: 'conversation', ...(paneId.startsWith('medo:') ? { threadId: paneId.slice(5) } : { paneId }), before: page.before, from: page.from });
  if (!data) return null;
  if (data.historyChanged) throw new HistoryChanged();
  const result = medoConversation(data);
  if (page.history_id && page.history_id !== result.history_id) throw new HistoryChanged();
  return result;
}
