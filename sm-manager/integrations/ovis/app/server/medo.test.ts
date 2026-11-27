import { describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleMedoRequest, medoConversation } from './medo.ts';
import type { FirstMessages } from './workspace-routes.ts';

test('saved Claude history keeps native tools and images after its terminal exits, within the registered store', async () => {
  const previous = process.env.MEDO_PROJECTS;
  process.env.MEDO_PROJECTS = '1';
  const directory = mkdtempSync(join(tmpdir(), 'medo-saved-claude-'));
  const root = join(directory, 'projects');
  mkdirSync(root);
  const path = join(root, 'session.jsonl');
  const uuid = '11111111-2222-4333-8444-555555555555';
  const png = 'iVBORw0KGgoAAAANSUhEUg==';
  const long = 'fixture output\n'.repeat(600);
  writeFileSync(path, [
    { type: 'user', uuid, timestamp: '2026-11-01T12:00:00Z', message: { content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
      { type: 'text', text: 'Inspect this fixture.' },
    ] } },
    { type: 'assistant', message: { model: 'claude-fixture', content: [
      { type: 'thinking', thinking: 'Checking the fixture.' },
      { type: 'tool_use', id: 'toolu_fixture', name: 'Read', input: { file_path: 'fixture.txt' } },
    ] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_fixture', content: long }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Fixture checked.' }], stop_reason: 'end_turn' } },
  ].map(record => JSON.stringify(record)).join('\n') + '\n');
  const call = mock(async () => ({ path, root }));
  const get = async (endpoint: string, ref?: string, readOnly = false) => {
    const url = new URL('http://fixture/api/' + endpoint);
    url.searchParams.set('pane_id', 'medo:claude:' + uuid);
    if (ref) url.searchParams.set('ref', ref);
    return (await handleMedoRequest(new Request(url), url, readOnly, { call }))!;
  };
  try {
    expect((await get('medo/conversation', undefined, true)).status).toBe(403);
    expect(call).not.toHaveBeenCalled();
    const response = await get('medo/conversation');
    expect(response.status).toBe(200);
    const history = await response.json();
    expect(history.source).toBe('claude-transcript');
    expect(call).toHaveBeenCalledWith({ operation: 'claude-history', threadId: 'claude:' + uuid });
    const parts = history.turns.flatMap((turn: { parts: unknown[] }) => turn.parts);
    expect(parts).toContainEqual({ kind: 'image', media_type: 'image/png', ref: uuid + ':0' });
    expect(parts).toContainEqual({ kind: 'thinking', text: 'Checking the fixture.' });
    expect(parts).toContainEqual(expect.objectContaining({ kind: 'tool', output_ref: 'toolu_fixture' }));
    expect(parts).toContainEqual({ kind: 'text', text: 'Fixture checked.', phase: 'final_answer' });
    const image = await get('pane/conversation/image', uuid + ':0');
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await image.arrayBuffer())).toEqual(Buffer.from(png, 'base64'));
    expect((await get('pane/conversation/image', uuid + ':0', true)).status).toBe(403);
    expect(await (await get('pane/conversation/tool-output', 'toolu_fixture')).text()).toBe(long);
    expect((await get('pane/conversation/tool-output', '../private')).status).toBe(404);
    const outside = join(directory, 'outside.jsonl');
    writeFileSync(outside, 'private');
    const escaped = join(root, 'escaped.jsonl');
    symlinkSync(outside, escaped);
    call.mockResolvedValue({ path: escaped, root });
    expect((await get('medo/conversation')).status).toBe(400);
    expect((await get('pane/conversation/image', uuid + ':0')).status).toBe(400);
  } finally {
    if (previous === undefined) delete process.env.MEDO_PROJECTS;
    else process.env.MEDO_PROJECTS = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Steam Machine history adapter', () => {
  test('formats native question replies with their questions and preserves malformed messages', () => {
    const text = '<send_user_message_question_reply>\n' + JSON.stringify([
      { question: 'Which `GET /Files` default?', answer: 'Active only', questionItemId: '["request_user_input_async","call",0]' },
      { question: 'Any notes?\nInclude tests?', answer: 'Keep the tests.\nCheck archived files too.' },
    ]) + '\n</send_user_message_question_reply>';
    const result = medoConversation({ thread: { id: 'fixture' }, turns: [{ id: 'turn', items: [{ id: 'reply', role: 'user', text }] }] });
    expect(result.turns[0]).toMatchObject({ role: 'user', message_id: 'reply', turn_id: 'turn', parts: [{ kind: 'text',
      text: '> Which `GET /Files` default?\n\nActive only\n\n> Any notes?\n> Include tests?\n\nKeep the tests.\nCheck archived files too.' }] });
    for (const body of ['not JSON', '{}', '[]', '[{"answer":7}]', '[{"answer":"yes"},{"answer":null}]']) {
      const invalid = `<send_user_message_question_reply>${body}</send_user_message_question_reply>`;
      expect(medoConversation({ thread: { id: 'fixture' }, turns: [{ id: 'turn', items: [{ role: 'user', text: invalid }] }] }).turns[0]?.parts[0])
        .toEqual({ kind: 'text', text: invalid });
    }
  });
  test('recovers an omitted start time from a native UUIDv7 turn without guessing for other IDs', () => {
    // RFC 9562's UUIDv7 test vector encodes 1645557742000 milliseconds.
    const nativeId = '017f22e2-79b0-7cc3-98c4-dc0c0c07398f';
    const adapt = (id: string, startedAt?: number | null) => medoConversation({ thread: { id: 'fixture' }, turns: [{
      id, startedAt, items: [{ id: 'user', role: 'user', text: 'Inspect the project.' },
        { id: 'tool', kind: 'commandExecution', status: 'inProgress', text: 'git status' }],
    }] });
    for (const missing of [null, undefined]) {
      expect(adapt(nativeId, missing).turns.map(turn => turn.ts)).toEqual([
        '2022-02-22T19:22:22.000Z', '2022-02-22T19:22:22.000Z',
      ]);
    }
    expect(adapt(nativeId, 100).turns.map(turn => turn.ts)).toEqual([
      '1970-01-01T00:01:40.000Z', '1970-01-01T00:01:40.000Z',
    ]);
    for (const id of ['turn', nativeId.replace('-7cc3-', '-4cc3-'), nativeId.replace('-98c4-', '-18c4-')]) {
      expect(adapt(id, null).turns.map(turn => turn.ts)).toEqual([null, null]);
    }
  });
  test('keeps commentary, tools and final answer in one assistant turn and preserves attachments', () => {
    const result = medoConversation({ version: 'v1', thread: { id: 'demo', model: 'model-a', effort: 'high' }, active: false, ovisCursor: 'older', turns: [{ id: 'turn', startedAt: 100, completedAt: 104, items: [
      { id: 'user', role: 'user', text: 'Please inspect', attachments: [{ name: 'test.png', path: '/demo/test.png' }] },
      { id: 'comment', role: 'assistant', text: 'Checking the file.', phase: 'commentary' },
      { id: 'tool', role: 'activity', kind: 'commandExecution', title: 'Command', text: 'file test.png' },
      { id: 'final', role: 'assistant', text: 'It is a PNG.', phase: 'final_answer' },
    ] }] });
    expect(result.turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    expect(result.turns[0]?.parts[0]).toEqual({ kind: 'text', text: 'Please inspect\n\n![test.png](</demo/test.png>)' });
    expect(result.turns[0]).toMatchObject({ message_id: 'user', turn_id: 'turn' });
    expect(result.turns[1]?.parts.map((part) => part.kind)).toEqual(['text', 'tool', 'text']);
    expect(result.turns[1]?.end_ts).toBe('1970-01-01T00:01:44.000Z');
    expect(result).toMatchObject({ history_id: 'medo:demo', cursor: 'older', metadata: { model: 'model-a', reasoning_effort: 'high' }, activity: 'idle' });
  });
  test('changes its cache version for streaming content and model changes', () => {
    const data = { version: 'same-version', thread: { id: 'demo', model: 'model-a' }, turns: [], active: true };
    expect(medoConversation(data).version).not.toBe(medoConversation({ ...data, thread: { id: 'demo', model: 'model-b' } }).version);
    expect(medoConversation(data).activity).toBe('working');
  });
});

test('completion receipt HTTP contract is owner-only, exact, and not cached', async () => {
  const previous = process.env.MEDO_PROJECTS;
  process.env.MEDO_PROJECTS = '1';
  try {
    const url = new URL('http://fixture/api/medo/read-completion');
    const threadId = '00000000-0000-4000-8000-000000000001';
    const activity = { revision: 4, completionId: 'newer-turn', unread: true, status: 'done' };
    const calls: Record<string, unknown>[] = [];
    const call = async (payload: Record<string, unknown>) => { calls.push(payload); return { threadId, activity }; };
    const request = (body: unknown) => new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await handleMedoRequest(request({ threadId, completionId: 'old-turn' }), url, true, { call }))?.status).toBe(403);
    for (const body of [{}, { threadId, completionId: '' }, { threadId: '../file', completionId: 'turn' }, { threadId, completionId: 42 }])
      expect((await handleMedoRequest(request(body), url, false, { call }))?.status).toBe(400);
    expect(calls).toEqual([]);
    const response = await handleMedoRequest(request({ threadId, completionId: 'old-turn', operation: 'new' }), url, false, { call });
    expect(calls).toEqual([{ operation: 'read-completion', threadId, completionId: 'old-turn' }]);
    expect(response?.headers.get('cache-control')).toBe('no-store');
    expect(await response?.json()).toEqual({ threadId, activity });
    const catalogUrl = new URL('http://fixture/api/medo/catalog');
    const catalogue = await handleMedoRequest(new Request(catalogUrl), catalogUrl, false, { call: async () => ({ chats: [{ id: threadId, activity }] }) });
    expect(await catalogue?.json()).toEqual({ chats: [{ id: threadId, activity }] });
  } finally {
    if (previous === undefined) delete process.env.MEDO_PROJECTS;
    else process.env.MEDO_PROJECTS = previous;
  }
});

test('preserves native skill reads, MCP identity and failed status through the HTTP shape', () => {
  const result = medoConversation({ thread: { id: 'fixture' }, turns: [{ id: 'turn', items: [
    { id: 'read', kind: 'commandExecution', status: 'completed', exitCode: 0, commandActions: [{ type: 'read', path: '/skills/review/SKILL.md' }] },
    { id: 'failed-read', kind: 'commandExecution', status: 'failed', exitCode: 1, commandActions: [{ type: 'read', path: '/skills/missing/SKILL.md' }] },
    { id: 'search', kind: 'commandExecution', status: 'completed', exitCode: 0, commandActions: [{ type: 'search', path: '/skills/list/SKILL.md' }] },
    { id: 'mcp', kind: 'mcpToolCall', status: 'failed', mcp: { server: 'docs', tool: 'search', status: 'failed' } },
  ] }] });
  expect(result.turns[0]?.parts.filter(part => part.kind === 'skill').map(part => part.skill.status)).toEqual(['loaded', 'failed']);
  expect(result.turns[0]?.parts.at(-1)).toMatchObject({ kind: 'tool', state: 'error', mcp: { server: 'docs', tool: 'search', status: 'failed' } });
});


test('resource inventory requires owner access and a conversation identity', async () => {
  const previous = process.env.MEDO_PROJECTS;
  process.env.MEDO_PROJECTS = '1';
  try {
    const url = new URL('http://fixture/api/medo/resources?pane_id=medo:00000000-0000-4000-8000-000000000001');
    const denied = await handleMedoRequest(new Request(url), url, true);
    expect(denied?.status).toBe(403);
    url.searchParams.set('pane_id', '/arbitrary/path');
    expect((await handleMedoRequest(new Request(url), url, false))?.status).toBe(400);
  } finally {
    if (previous === undefined) delete process.env.MEDO_PROJECTS;
    else process.env.MEDO_PROJECTS = previous;
  }
});

test('new conversations bind the selected provider and first message to the requesting page', async () => {
  const previous = process.env.MEDO_PROJECTS;
  process.env.MEDO_PROJECTS = '1';
  try {
    const url = new URL('http://fixture/api/medo/new');
    const asked = { at: mock(() => {}), end: mock(() => {}) };
    const ask = mock(() => asked);
    const queue = mock(async () => ({ id: 'pending-1', state: 'held', error: { code: 'first_message_unattended' } }));
    const call = mock(async () => ({ address: 't1', pid: 123, reused: false }));
    const firstMessages = { ask, queue } as unknown as FirstMessages;
    const payload = { projectId: 'fixture', provider: 'claude', model: 'opus', effort: 'high', prompt: 'update', first_message_connection: 'page-1' };
    const request = () => new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    expect((await handleMedoRequest(request(), url, true, { call, firstMessages }))?.status).toBe(403);
    expect(call).not.toHaveBeenCalled();
    const result = await handleMedoRequest(request(), url, false, { call, firstMessages });
    expect(result?.status).toBe(200);
    expect(await result!.json()).toEqual({ address: 't1', reused: false, first_message: { id: 'pending-1', held: 'first_message_unattended' } });
    expect(ask).toHaveBeenCalledWith('page-1');
    expect(call).toHaveBeenCalledWith({ ...payload, operation: 'new' });
    expect(asked.at).toHaveBeenCalledWith('t1');
    expect(queue).toHaveBeenCalledWith('t1', 'update', 'claude', asked, 123);
    expect(asked.end).toHaveBeenCalled();
    // A queue failure returns the created pane; a second launch is never needed to recover the draft.
    queue.mockRejectedValue(new Error('queue unavailable'));
    const failed = await handleMedoRequest(request(), url, false, { call, firstMessages });
    expect(failed?.status).toBe(200);
    expect(await failed!.json()).toMatchObject({ address: 't1', first_message: { error: { message: expect.stringContaining('draft') } } });
  } finally {
    if (previous === undefined) delete process.env.MEDO_PROJECTS;
    else process.env.MEDO_PROJECTS = previous;
  }
});

test('invalid provider and first message requests fail before starting a terminal', async () => {
  const previous = process.env.MEDO_PROJECTS;
  process.env.MEDO_PROJECTS = '1';
  try {
    const url = new URL('http://fixture/api/medo/new');
    const call = mock(async () => ({}));
    for (const payload of [{ provider: 'gemini' }, { provider: 'claude', model: ['opus'] }, { provider: 'codex', prompt: '\u001b[1m' }, { provider: 'claude', prompt: 'hello' }, { provider: 'codex', first_message_connection: {} }]) {
      const request = new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      expect((await handleMedoRequest(request, url, false, { call }))?.status).toBe(400);
    }
    expect(call).not.toHaveBeenCalled();
  } finally {
    if (previous === undefined) delete process.env.MEDO_PROJECTS;
    else process.env.MEDO_PROJECTS = previous;
  }
});


test('default resolution carries project and model context and is never cached by HTTP', async () => {
  const previous = process.env.MEDO_PROJECTS;
  process.env.MEDO_PROJECTS = '1';
  try {
    const url = new URL('http://fixture/api/medo/defaults?provider=claude&projectId=garden&model=claude-opus-4-6');
    const call = mock(async () => ({ model: 'claude-opus-4-6', effort: 'high', efforts: ['low', 'medium', 'high'] }));
    const result = (await handleMedoRequest(new Request(url), url, false, { call }))!;
    expect(call).toHaveBeenCalledWith({ operation: 'defaults', provider: 'claude', projectId: 'garden', cwd: undefined, model: 'claude-opus-4-6' });
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect((await result.json()).effort).toBe('high');
  } finally {
    if (previous === undefined) delete process.env.MEDO_PROJECTS;
    else process.env.MEDO_PROJECTS = previous;
  }
});
