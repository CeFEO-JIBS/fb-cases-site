# fb-cases-site

The student interface of the CeFEO case platform, served by GitHub Pages at
`case.cefeo.se`. Static HTML, CSS and JavaScript. Deploy is a push to `main`.

It contains no case content. Everything it shows arrives from the student API
after a team signs in. The API and the runtime live in the private repository
`CeFEO-JIBS/fb-cases`; the contract between the two is `docs/09-api-contract.md`
there.

`config.js` holds three public values: the Supabase URL, the anon key (which only
opens what row-level security allows) and the API base URL. No secret is ever
committed here.

Design follows the platform's design system: Archivo, Newsreader and IBM Plex Mono
on a grey-green paper ground; the platform's purple marks live state and identity
only.

The icon set at the root — `favicon.svg`, three PNGs, `apple-touch-icon.png`, two
manifest icons and `site.webmanifest` — is the platform's mark, a genogram. The same
drawing is inlined in the masthead, strokes `currentColor` and so arrives in a
re-liveried case's own colours. The SVG carries its own `prefers-color-scheme` rule
and turns white in a dark tab; do not add a second `<link media=…>` beside it. The
rules and the source are in `design/` in the platform repository. Every icon link
carries the `?v=` version, like every other asset here: a browser holds a favicon far
longer than the ten minutes GitHub Pages asks for.
