/** Decode only complete native answer envelopes; ordinary messages stay intact. */
export function codexQuestionReplies(text: string): { question: string; answer: string }[] | null {
  const match = text.trim().match(/^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/);
  if (!match) return null;
  try {
    const items: unknown = JSON.parse(match[1]!);
    if (!Array.isArray(items) || !items.length || items.some((item) => !item || typeof item.answer !== 'string'
      || !item.answer.trim() || (item.question !== undefined && typeof item.question !== 'string'))) return null;
    return items.map((item) => ({ question: (item.question ?? '').trim(), answer: item.answer.trim() }));
  } catch { return null; }
}

export function formatCodexQuestionReply(text: string): string | null {
  const replies = codexQuestionReplies(text);
  return replies?.map(({ question, answer }) => [question ? question.split('\n').map((line) => `> ${line}`).join('\n') : '', answer]
    .filter(Boolean).join('\n\n')).join('\n\n') ?? null;
}
