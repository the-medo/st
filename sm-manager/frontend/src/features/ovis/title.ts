/** Convert the embedded app's title to ST's label without exposing pane/thread IDs. */
export function agentsPageTitle(value: string): string {
  if (value === "Ovis") return "Agents";
  const title = value.replace(/\s+·\s+Ovis$/, "").trim();
  if (
    !title ||
    /^(?:medo:)?[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
      title,
    ) ||
    /^w[\da-z]+:p[\da-z]+$/i.test(title)
  )
    return "Agents";
  return title;
}
