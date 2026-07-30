# ADR-019: Static Asset Serving Contract — Honest 404s and a Revalidated Shell

**Date:** 2026-07-30

## Context

The frontend is a Vite SPA served by Caddy: `index.html` names a set of content-hashed bundles
under `/assets/`, and a deploy replaces both. Caddy answered every unmatched path with
`try_files {path} /index.html` so client-side routes resolve, and `index.html` itself went out with
no `Cache-Control` at all — leaving browsers to infer a lifetime from `Last-Modified`.

Those two facts compose into a failure with no error anywhere. A browser holding a stale
`index.html` requests bundle names the deploy has deleted; the SPA fallback matches those paths too
and answers `200 text/html`. A `<script type="module">` handed HTML fails to parse, React never
runs, and the page renders blank — no failed request in the network tab, no console error
attributable to a cause, nothing for a user to report beyond "it's broken".

React cannot report this: the boundary that would catch it is inside the bundle that never ran.

## Decision

Three separate guarantees, because there are three distinct ways the page can come up empty.

1. **`/assets/*` is handled outside the SPA fallback**, so a missing bundle **404s honestly**
   instead of being handed HTML. Fingerprinted names never change meaning, so they carry
   `max-age=31536000, immutable`.
2. **`index.html` is served `no-cache`**, so it always revalidates. It is the file that names which
   fingerprints are current, and it must never be held stale.
3. **`index.html` ships static markup inside `#root`** saying the script did not load, revealed on
   a CSS delay. React's first commit clears the container, so a successful boot deletes it. It is
   markup and CSS rather than script because the CSP forbids inline JS.

Error responses are `no-store`, so a 404 cannot inherit the year-long lifetime of the `/assets`
path it was requested under and outlive a rollback that restores the file.

Unknown application routes still reach `index.html` and are answered by a client-side 404 page that
names the path, rather than a silent redirect — a truncated reset or invite link is the usual way
someone arrives at one.

## Consequences

- **A broken deploy is visible.** Each of the three failure modes — stale shell, missing bundle,
  script blocked by an extension or network — now produces either an HTTP error or on-screen text.
- **`index.html` costs a revalidation on every load.** A conditional request answered `304` is far
  cheaper than the failure it prevents, and the bundles it points at remain immutable.
- **The boot fallback must stay inside `#root`.** Its removal depends on React clearing the
  container on first commit; moved elsewhere it would persist under a working app.
- **This is verified against a real Caddy container, not asserted.** `header` directives are
  evaluated before `try_files` rewrites, so a matcher written against the rewritten path silently
  never fires — the reason the original `Cache-Control` on `index.html` did nothing. See the
  `live-verify` skill.
- **Cloudflare sits in front.** A static asset not updating after a deploy is a cache purge, not a
  rebuild; these headers govern the origin, not what Cloudflare has already stored.
