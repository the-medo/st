import { describe, expect, test } from 'bun:test';
import { medoConversation } from './medo.ts';

describe('Steam Machine history adapter', () => {
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
