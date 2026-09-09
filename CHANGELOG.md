# Changelog

## 0.2.0 — 2026-09-09

Requires Paseo 0.8 or newer.

### Paseo 0.8
- Migrated to the Paseo 0.8 runtime layout: `index.client.tsx` and `index.server.ts` entries, code under `client/`, `server/`, and `shared/`, and `requirements.paseo` set to `>=0.8.0`. SDK dependency is `@getpaseo/plugin` `0.8.0-beta.1`.
- Removed the legacy `index.ts` entry and the local type shim.

### Surface
- Redesigned to match the Hosts and 9Router panels.
- The Servers tab always shows "Add server", "Import", and "Refresh", not only when the list is empty.
- Each HTTP server shows its account sign-in rows inline, with Authorise, Cancel, Sign out, and paste-the-callback-URL completion.
- Health results carry a "checked at" timestamp and a "Check now" button, so configured, reachable, and signed-in are no longer conflated.
- An OAuth sign-in started on the daemon host can be finished from any browser by pasting the callback URL.

## 0.1.0 — 2026-08-29

Initial standalone release.
