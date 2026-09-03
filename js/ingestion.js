import { supabase } from './supabase-client.js';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { listDriveFiles, listGcsObjects, downloadDriveFile, uploadToGcsIfAbsent, isGoogleNativeFile } from './google-apis.js';

export async function loadProjects() {
  const { data, error } = await supabase
    .from('ingestion_projects')
    .select('*')
    .order('display_name', { ascending: true });
  if (error) throw error;
  return data;
}

// Supabase caps a single response at ~1000 rows (same limit that required
// batching the sync upsert), so reading back a project with more files than
// that needs pagination too, or only the first 1000 (alphabetically) ever
// show up regardless of how many actually got synced.
const SELECT_PAGE_SIZE = 1000;

export async function loadFiles(projectId) {
  const allRows = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('ingestion_files')
      .select('*')
      .eq('project_id', projectId)
      .order('file_name', { ascending: true })
      .range(from, from + SELECT_PAGE_SIZE - 1);
    if (error) throw error;
    allRows.push(...data);
    if (data.length < SELECT_PAGE_SIZE) break;
    from += SELECT_PAGE_SIZE;
  }
  return allRows;
}

export async function addProject({ slug, display_name, drive_folder_id, gcs_bucket_name, gcp_project_id, notes }) {
  const { data, error } = await supabase
    .from('ingestion_projects')
    .insert({ slug, display_name, drive_folder_id, gcs_bucket_name, gcp_project_id, notes })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateProject(id, fields) {
  const { data, error } = await supabase
    .from('ingestion_projects')
    .update(fields)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function setFileStatus(fileId, stage, on, userEmail) {
  // stage is 'ingested' or 'tested'
  const fields =
    stage === 'ingested'
      ? { ingested_at: on ? new Date().toISOString() : null, ingested_by: on ? userEmail : null }
      : { tested_at: on ? new Date().toISOString() : null, tested_by: on ? userEmail : null };
  const { data, error } = await supabase.from('ingestion_files').update(fields).eq('id', fileId).select().single();
  if (error) throw error;
  return data;
}

// Bulk version — for clearing a historical backlog (e.g. 1000 pre-existing
// files) instead of toggling one at a time. Chunked because a single request
// with many UUIDs in the `.in()` filter builds a URL long enough to hit
// server-side URL length limits and get rejected with a 400.
const BULK_CHUNK_SIZE = 40;

export async function bulkSetFileStatus(fileIds, stage, on, userEmail, onProgress) {
  if (fileIds.length === 0) return [];
  const fields =
    stage === 'ingested'
      ? { ingested_at: on ? new Date().toISOString() : null, ingested_by: on ? userEmail : null }
      : { tested_at: on ? new Date().toISOString() : null, tested_by: on ? userEmail : null };

  const results = [];
  for (let i = 0; i < fileIds.length; i += BULK_CHUNK_SIZE) {
    const chunk = fileIds.slice(i, i + BULK_CHUNK_SIZE);
    const { data, error } = await supabase.from('ingestion_files').update(fields).in('id', chunk).select();
    if (error) {
      console.error('bulkSetFileStatus chunk failed:', { chunkStart: i, chunkSize: chunk.length, error });
      const detail = [error.message, error.details, error.hint].filter(Boolean).join(' — ');
      throw new Error(detail || `Update failed on batch starting at file ${i + 1} of ${fileIds.length}.`);
    }
    results.push(...data);
    if (onProgress) onProgress(Math.min(i + BULK_CHUNK_SIZE, fileIds.length), fileIds.length);
  }
  return results;
}

export async function updateFileNotes(fileId, notes) {
  const { error } = await supabase.from('ingestion_files').update({ notes }).eq('id', fileId);
  if (error) throw error;
}

// Pulls live Drive + GCS listings for a project and reconciles them into
// ingestion_files. Matches Drive files to GCS objects by filename. Existing
// manual status (ingested_at/tested_at) on a file is left untouched.
export async function syncProject(project, googleAccessToken, onProgress) {
  const emit = (event) => { if (onProgress) onProgress(event); };

  emit({ phase: 'listing' });
  const [driveFiles, gcsObjects] = await Promise.all([
    project.drive_folder_id ? listDriveFiles(project.drive_folder_id, googleAccessToken) : Promise.resolve([]),
    project.gcs_bucket_name ? listGcsObjects(project.gcs_bucket_name, googleAccessToken) : Promise.resolve([]),
  ]);
  emit({ phase: 'listed', driveCount: driveFiles.length, gcsCount: gcsObjects.length });

  const now = new Date().toISOString();
  const byName = new Map();
  const driveMeta = new Map(); // name -> {id, mimeType} for the copy step below

  for (const f of driveFiles) {
    byName.set(f.name, {
      file_name: f.name,
      drive_file_id: f.id,
      drive_modified_time: f.modifiedTime || null,
      drive_created_time: f.createdTime || null,
      drive_last_seen_at: now,
    });
    driveMeta.set(f.name, { id: f.id, mimeType: f.mimeType });
  }
  for (const o of gcsObjects) {
    const existing = byName.get(o.name) || { file_name: o.name };
    byName.set(o.name, {
      ...existing,
      gcs_object_name: o.name,
      gcs_size_bytes: o.size ? Number(o.size) : null,
      gcs_last_seen_at: now,
    });
  }

  // Copy step: any file seen in Drive but not in GCS gets uploaded
  // automatically, straight from Drive's bytes into the project's bucket.
  const copyResult = { copied: 0, skippedExists: 0, skippedNative: 0, failed: [] };
  if (project.gcs_bucket_name) {
    const toCopy = Array.from(byName.entries()).filter(([, row]) => row.drive_last_seen_at && !row.gcs_last_seen_at);
    if (toCopy.length > 0) emit({ phase: 'copy-start', total: toCopy.length });
    const COPY_CONCURRENCY = 4;
    let cursor = 0;
    async function copyWorker() {
      while (cursor < toCopy.length) {
        const idx = cursor++;
        const [name, row] = toCopy[idx];
        const meta = driveMeta.get(name);
        if (!meta) continue;
        if (isGoogleNativeFile(meta.mimeType)) {
          copyResult.skippedNative++;
          emit({ phase: 'copy', index: idx + 1, total: toCopy.length, name, outcome: 'skipped-native' });
          continue;
        }
        try {
          const blob = await downloadDriveFile(meta.id, googleAccessToken);
          const outcome = await uploadToGcsIfAbsent(project.gcs_bucket_name, name, blob, meta.mimeType, googleAccessToken);
          if (outcome === 'uploaded') {
            copyResult.copied++;
            byName.set(name, { ...row, gcs_object_name: name, gcs_size_bytes: blob.size, gcs_last_seen_at: now });
            emit({ phase: 'copy', index: idx + 1, total: toCopy.length, name, outcome: 'copied' });
          } else {
            copyResult.skippedExists++;
            byName.set(name, { ...row, gcs_object_name: name, gcs_last_seen_at: now });
            emit({ phase: 'copy', index: idx + 1, total: toCopy.length, name, outcome: 'skipped-exists' });
          }
        } catch (err) {
          copyResult.failed.push({ name, message: err.message || String(err) });
          emit({ phase: 'copy', index: idx + 1, total: toCopy.length, name, outcome: 'failed', message: err.message });
          if (err.isGoogleAuthError) throw err; // stop everything, session's gone
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(COPY_CONCURRENCY, toCopy.length) }, copyWorker));
  }

  const rows = Array.from(byName.values()).map((r) => ({ ...r, project_id: project.id }));
  if (rows.length === 0) {
    await supabase.from('ingestion_projects').update({ last_synced_at: now }).eq('id', project.id);
    return { driveCount: 0, gcsCount: 0, syncedAt: now, ...copyResult };
  }

  // Supabase caps a single write at ~1000 rows and silently truncates rather
  // than erroring, so large projects (thousands of GCS objects) need batching.
  const SYNC_CHUNK_SIZE = 500;
  emit({ phase: 'save-start', total: rows.length });
  for (let i = 0; i < rows.length; i += SYNC_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + SYNC_CHUNK_SIZE);
    const { error } = await supabase
      .from('ingestion_files')
      .upsert(chunk, { onConflict: 'project_id,file_name' });
    if (error) throw error;
    emit({ phase: 'save', done: Math.min(i + SYNC_CHUNK_SIZE, rows.length), total: rows.length });
  }

  // Stamp when this sync completed, so next time (this session or a future
  // one) we can show what's arrived in Drive since this exact point.
  await supabase.from('ingestion_projects').update({ last_synced_at: now }).eq('id', project.id);

  return { driveCount: driveFiles.length, gcsCount: gcsObjects.length, syncedAt: now, ...copyResult };
}

// Derives the pipeline stage for a file row, for rendering.
export function fileStage(file) {
  const inDrive = !!file.drive_last_seen_at;
  const inGcs = !!file.gcs_last_seen_at;
  const ingested = !!file.ingested_at;
  const tested = !!file.tested_at;
  return { inDrive, inGcs, ingested, tested };
}

// Cross-project progress stats, computed server-side (see the
// get_ingestion_progress Postgres function) so it stays fast regardless of
// how many files are tracked overall.
export async function loadProgressOverview() {
  const { data, error } = await supabase.rpc('get_ingestion_progress');
  if (error) throw error;
  return data;
}

// Same aggregate, scoped to one project — used so huge projects (millions
// of rows) can show accurate stats without ever loading the full file list
// into the browser just to count/sum it client-side.
export async function loadSingleProjectStats(projectId) {
  const all = await loadProgressOverview();
  return all.find((r) => r.project_id === projectId) || null;
}

// Verifies ingestion against the project's own external case database
// (its real ingestion pipeline's Supabase project), rather than relying on
// the manual ingested_at/ingested_by self-report. Matches by GCS path —
// this project's own gcs_object_name against the external table's path
// column, with that table's bucket-name prefix stripped off first, since
// our tracked names don't include the bucket name.
export async function verifyIngestion(project, onProgress) {
  if (!project.verify_supabase_url || !project.verify_supabase_anon_key) {
    throw new Error('No verification database configured for this project.');
  }

  const externalClient = createClient(project.verify_supabase_url, project.verify_supabase_anon_key);
  const table = project.verify_table || 'documents';
  const pathCol = project.verify_path_column || 'gcs_archive_path';
  const statusCol = project.verify_status_column || 'ingestion_status';
  const successValue = project.verify_success_value || 'indexed';
  const prefix = project.verify_path_prefix ?? `${project.gcs_bucket_name}/`;

  // Pull every row's path + status from the external table, paginated the
  // same way our own reads are (same underlying Supabase row cap applies).
  const PAGE_SIZE = 1000;
  const externalRows = [];
  let from = 0;
  while (true) {
    const { data, error } = await externalClient
      .from(table)
      .select(`${pathCol}, ${statusCol}`)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`External database error: ${error.message}`);
    externalRows.push(...data);
    if (onProgress) onProgress(externalRows.length);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  const verifiedPaths = new Set(
    externalRows
      .filter((r) => r[statusCol] === successValue)
      .map((r) => (r[pathCol] || '').startsWith(prefix) ? r[pathCol].slice(prefix.length) : r[pathCol])
  );

  const statusCounts = {};
  for (const r of externalRows) {
    const s = r[statusCol] ?? '(null)';
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  }

  const files = await loadFiles(project.id);
  const now = new Date().toISOString();
  const toVerify = files.filter((f) => verifiedPaths.has(f.file_name) && !f.verified_ingested_at);

  const UPDATE_CHUNK = 40;
  for (let i = 0; i < toVerify.length; i += UPDATE_CHUNK) {
    const chunk = toVerify.slice(i, i + UPDATE_CHUNK);
    const { error } = await supabase
      .from('ingestion_files')
      .update({ verified_ingested_at: now })
      .in('id', chunk.map((f) => f.id));
    if (error) throw error;
  }

  return {
    externalRecords: externalRows.length,
    externalVerified: verifiedPaths.size,
    newlyVerified: toVerify.length,
    statusCounts,
  };
}
