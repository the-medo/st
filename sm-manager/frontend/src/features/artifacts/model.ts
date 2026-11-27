export type Artifact = {
  id: string;
  title: string;
  project: string;
  folder: string;
  created: number;
  updated: number;
  revision: number;
  published_revision: number | null;
  publication_pending: boolean;
  share_url: string | null;
  entrypoint: string;
  mime: string;
  preview_base?: string;
};
export type ArtifactFile = {
  path: string;
  role: "source" | "output";
  mime: string;
  size: number;
  sha256: string;
};
export type ArtifactDetail = Artifact & {
  selected_revision: number;
  manifest: { entrypoint: string; files: ArtifactFile[] };
  history: { number: number; created: number; note: string }[];
};
export type Checkout = {
  id: string;
  title: string;
  revision: number;
  directory: string;
  cli: string;
};
export function fileUrl(id: string, revision: number, path: string) {
  return `/api/artifacts/${id}/revisions/${revision}/files/${path.split("/").map(encodeURIComponent).join("/")}`;
}
export function improvePrompt(checkout: Checkout, change: string) {
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  return `${change.trim()}\n\nUpdate the existing Herdr artifact ${checkout.id} (${checkout.title}), starting from revision ${checkout.revision}. Its editable files are in ${JSON.stringify(checkout.directory)}. Read .artifact.json there, modify the existing files, then run ${quote(checkout.cli)} save ${quote(checkout.directory)} --note 'Updated artifact'. Preserve its identity; save a new revision of this artifact. Keep the published version unchanged unless I ask to publish.\n`;
}
