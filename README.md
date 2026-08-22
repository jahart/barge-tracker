# Ohio River Barge Tracker

Live AIS vessel tracker for the Ohio River between OVRC Launch (Parkersburg WV) and Neal Island. Built to check for barge traffic before rowing.

Live at **https://jahart.github.io/barge-tracker/**

## How it works

- `index.html` (repo root) is a static page served via GitHub Pages — no build step, no server to run.
- It connects over WebSocket to a Cloudflare Worker (`worker/`), which holds the AISStream.io API key server-side and proxies live vessel positions through to the browser.
- River stage data (`river.json`) is refreshed every 30 minutes by a GitHub Actions workflow (`scripts/update-river-conditions.mjs`) and polled by the page.

For anything operational — deploying the Worker, rotating the AISStream API key, debugging AIS connectivity, the river-conditions workflow — see **[MAINTENANCE.md](MAINTENANCE.md)**. That's the source of truth for day-to-day work on this repo.

## Danger zone

A radius circle is drawn around OVRC Launch. When any vessel enters that zone, a red alert banner fires with the vessel name, direction, speed, and estimated minutes to the launch site.

## AIS coverage note

Not all vessels broadcast AIS. Large commercial barges and towboats are required to carry AIS — smaller recreational craft are not. Coverage on the Ohio River is generally good for commercial traffic.

## Local development

The Worker (`worker/`) can be run locally via `wrangler dev` — see MAINTENANCE.md for setup.

`server.js` and `public/` are an earlier local-Express-server version of this tracker, superseded by the GitHub Pages + Cloudflare Worker setup above. They're kept around for now (see "Known pending work" in MAINTENANCE.md) but aren't how the live site runs.
