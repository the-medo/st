import { describe, expect, test } from 'bun:test';
import { handleMedoRequest, medoConversation } from './medo.ts';

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
