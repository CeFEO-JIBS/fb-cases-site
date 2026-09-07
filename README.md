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
on a grey-green paper ground; CeFEO purple marks live state only.
