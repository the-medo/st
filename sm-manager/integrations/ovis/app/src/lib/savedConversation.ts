/** Saved histories are normal destinations, independent of a live Herdr pane. */
export function savedConversation(search: string): string | null {
  const id = new URLSearchParams(search).get('saved');
  return id && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id) ? id : null;
}
export function withSavedConversation(search: string, id: string | null): string {
  const params = new URLSearchParams(search);
  if (id) {
    params.set('saved', id);
    for (const key of ['pane', 'ws', 'view', 'file']) params.delete(key);
  } else params.delete('saved');
  const value = params.toString();
  return value ? `?${value}` : '';
}

/** Keep the current app mount, but never share transient pane/settings state. */
export function savedConversationLink(href: string, id: string): string {
  const url = new URL(href);
  url.search = withSavedConversation('', id);
  url.hash = '';
  return url.href;
}
