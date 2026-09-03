# AI Ops Dashboard

Personal ops dashboard, built module by module. First module live: **Ingestion Tracker**.

Live: https://msloskey-i-want-that.github.io/AI-ops-Dashboard/

## What it does (Ingestion Tracker)

Tracks the pipeline for each data project: **Drive (shared folder) → GCS bucket → Supabase (ingested + tested)**.

- Drive folder contents and GCS bucket contents are listed **live**, client-side, using your own Google
  sign-in (`drive.readonly`, `devstorage.read_write` scopes). Drive folders are walked **recursively** —
  subfolders are traversed, not treated as files — and each file's tracked name is its path relative to
  the project's root folder (e.g. `Files/LEVO/02. February/statement.xlsx`), matching how the
  corresponding GCS objects are already named after a folder-structured upload.
- **Sync automatically copies any file found in Drive but missing from GCS straight into the bucket** —
  downloaded from Drive and uploaded to GCS entirely client-side, no server involved. Uses
  `ifGenerationMatch=0` so it's a no-op (skipped, not overwritten) if something with that name already
  exists — safe to re-run. Native Google Docs/Sheets/Slides (no raw bytes to copy) are skipped and
  counted separately, since copying those would need export-to-format logic instead, a separate
  feature. This is the one place in the app that writes to your real cloud storage rather than just
  reading it.
- Ingested/tested status is stored in Supabase — these are steps you perform yourself (running the
  ingestion script, testing it), so the app just lets you check them off per file.
- Each file's status is reconciled by relative path across all three stages, with clear flags for files
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

- Each project tracks when it was last synced (`last_synced_at`). Opening a project shows a
  **"new in Drive since [date]"** stat — files whose real Drive upload date is after that
  timestamp — clickable to filter the table down to just those, same as the other flagged stats.
  This baseline is captured once per viewing session (when you open the project), so it stays
  meaningful even across a few syncs in the same sitting rather than resetting to ~0 immediately
  after each one.

## Known limitations / future improvements

- **No proactive alerts yet.** This app is entirely client-side — it can only see Drive/GCS state
  at the moment someone opens it and syncs. A true "email/Slack me the moment staff adds a file"
  notification would need a separate backend piece (a scheduled job running on Google's
  infrastructure, checking periodically) — a genuinely different piece of infrastructure, not an
  extension of the current architecture.

- Sync matches Drive files to GCS objects **by relative path** (folder structure
  included, e.g. `Files/LEVO/02. February/statement.xlsx`). If a file gets
  renamed or moved to a different folder between stages, it'll show as two
  separate rows.
- A file that disappears from Drive or GCS between syncs still shows its last-known state — there's
  no "removed" detection yet.
- `Accounts & Budget` and `SOP Compliance` modules are scaffolded in the nav but not yet built.

## Local development

No build step — just serve the folder statically, e.g. `npx serve .`, and open it in a browser.
