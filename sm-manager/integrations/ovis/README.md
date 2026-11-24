# Ovis source baseline

This directory preserves the working customized Ovis client before integration.
`upstream.json` records its upstream base. `source-manifest.json` records the
SHA-256 of every imported source file, including the uncommitted customization
and the external Python bridge. Subsequent integration commits intentionally
change these files; the manifest remains a record of the original import.

`app/` contains the web frontend, Bun server, shared protocols, patches, build
scripts and tests. Native mobile applications, marketing sites, release/CI
workflows, recordings, private deployment notes and runtime data are excluded.
Upstream MIT and third-party notices are retained. `bridge/` contains the custom
sidebar/chat service source; its live project catalogs and account data are not
part of the repository.

This first import is a preservation step. The bridge still needs explicit data
paths, and the Ovis source still assumes its standalone layout. Follow
`../../ST_V2_IMPLEMENTATION.md` for the integration sequence. Never start tests
against the owner's Herdr session or Codex database. Existing production Ovis
and the shared chat bridge remain independently managed.
