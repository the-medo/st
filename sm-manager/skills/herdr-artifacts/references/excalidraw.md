# Editable diagrams

Use Excalidraw for diagrams the user wants to edit visually. The CLI renders
through the installed official SDK, with local fonts and an on-demand browser.
No MCP or external rendering service is needed.

Create a new diagram from compact JSON (no top-level `type`) or native
`.excalidraw` JSON (`type: "excalidraw"`). Compact elements use the SDK's skeleton
format: labels become bound text, and arrow endpoints can reference shape IDs.

```json
{
  "elements": [
    {"id":"input","type":"rectangle","x":0,"y":0,"width":180,"height":90,"label":{"text":"Input"},"backgroundColor":"#d3f9d8"},
    {"id":"result","type":"rectangle","x":320,"y":0,"width":180,"height":90,"label":{"text":"Result"},"backgroundColor":"#d0ebff"},
    {"id":"flow","type":"arrow","x":180,"y":45,"width":140,"height":0,"start":{"id":"input"},"end":{"id":"result"}}
  ],
  "appState":{"viewBackgroundColor":"#ffffff"}
}
```

```sh
~/.local/bin/herdr-artifacts diagram /path/to/scene.json --title 'Data flow'
```

The returned artifact has a private `source/diagram.excalidraw` original,
`diagram.svg` as its entrypoint, and a PNG download. Inspect the PNG/SVG before
delivery, correcting layout or text overlap when needed. The owner can also
create, import and edit drawings from the Artifacts page.

For changes, `checkout ARTIFACT_ID`, edit the native source named in
`.artifact.json`'s `editor.source`, then `save DIRECTORY --note 'What changed'`.
Preserve native element IDs, seeds and bindings, and keep `type: "excalidraw"`;
native scenes are not compact skeletons. To add elements to a native scene,
use the existing elements as schema examples, preserving required fields.
Do not edit generated SVG/PNG: saving regenerates them from the source. A stale
checkout fails without replacing the stored revision; reconcile with a fresh
checkout. Saves never publish automatically.

Images must be embedded in the scene's `files` map as data URLs. Webpage embeds
and remote image references are unsupported. The source plus exports must fit
the library's 32 MiB revision limit. Public sharing includes output files only;
the native scene is not embedded in SVG/PNG exports.
