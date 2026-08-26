# AI Ops Dashboard

Personal ops dashboard, built module by module. First module live: **Ingestion Tracker**.

Live: https://msloskey-i-want-that.github.io/AI-ops-Dashboard/

## What it does (Ingestion Tracker)

Tracks the pipeline for each data project: **Drive (shared folder) → GCS bucket → Supabase (ingested + tested)**.

- Drive folder contents and GCS bucket contents are listed **live**, client-side, using your own Google
  sign-in (read-only scopes: `drive.readonly`, `devstorage.read_only`). No service account keys are
  embedded in the app.
- Ingested/tested status is stored in Supabase — these are steps you perform yourself (running the
  ingestion script, testing it), so the app just lets you check them off per file.
- Each file's status is reconciled by filename across all three stages, with clear flags for files
  that are stuck at a stage (e.g. copied to Drive but never made it to GCS).

## Architecture

- Vanilla JS, no build step. `js/app.js` is the entry point.
- **Auth**: Supabase Auth, Google provider. Supabase only returns the Google OAuth access token
  (`provider_token`) once, right after sign-in — it's cached in `sessionStorage` for the tab's
  lifetime (~1hr, matching Google's token expiry). When it expires, sign out and back in to refresh
  it before syncing again. This doesn't affect reading/writing ingested/tested status, only the live
  Drive/GCS sync.
- **Data**: Supabase Postgres, two tables — `ingestion_projects` (Drive folder ↔ GCS bucket mapping)
  and `ingestion_files` (cached last-known Drive/GCS state + manual ingested/tested status). RLS is
  restricted to authenticated users only.
- **Google APIs**: called directly from the browser (`js/google-apis.js`) — Drive API v3 for folder
  listings, Cloud Storage JSON API for bucket listings.

## Known limitations / future improvements

- Sync matches Drive files to GCS objects **by filename**. If a file gets renamed between stages,
  it'll show as two separate rows.
- Sync only looks one level deep in each Drive folder (no subfolder recursion).
- A file that disappears from Drive or GCS between syncs still shows its last-known state — there's
  no "removed" detection yet.
- `Accounts & Budget` and `SOP Compliance` modules are scaffolded in the nav but not yet built.

## Local development

No build step — just serve the folder statically, e.g. `npx serve .`, and open it in a browser.
