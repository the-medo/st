# Agents inside S.T.

This layout follows the existing Ovis conversation UI and the requested persistent
S.T. navigation. `Agents` stays mounted after first use; `Feature` joins the existing
React root. Its original standalone entry is deliberately not loaded.

`ovis-plugin.ts` supplies explicit lexical browser capabilities to imported Ovis
modules. It does not patch the browser's real globals. The host maps API, socket,
and resource URLs beneath `/agents`, keeps navigation in React Router, scopes DOM
queries and portals to the feature root, and suppresses hidden keyboard handlers.
Ovis styles are wrapped in CSS `@scope`; layout containment keeps fixed overlays
inside the feature. Theme mutations target that root rather than the document.
Modern browsers supporting CSS scope are required.

ST owns the service worker, viewport and application lifecycle. The Ovis PWA
entry is omitted. Current chat selection and draft state survive ST navigation;
its query-based links can be refreshed or opened directly at `/agents?...`.
The standalone entry remains buildable for compatibility.

`tests/ovis-browser.ts` bundles Ovis's MIT-licensed demo transport and synthetic
Medo catalog. It exercises the actual production frontend without opening a
real chat or a live terminal. Fixtures under `app/site/demo` are upstream demo
data, not collected history. Review changes to the host transform when importing
new upstream modules with browser-global use. Full native Ovis mobile/desktop,
relay-hosted shell and root-level PWA integration are separate release gates.
