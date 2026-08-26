import { supabase } from './supabase-client.js';
import { listDriveFiles, listGcsObjects } from './google-apis.js';

export async function loadProjects() {
  const { data, error } = await supabase
    .from('ingestion_projects')
    .select('*')
    .order('display_name', { ascending: true });
  if (error) throw error;
  return data;
}

export async function loadFiles(projectId) {
  const { data, error } = await supabase
    .from('ingestion_files')
    .select('*')
    .eq('project_id', projectId)
    .order('file_name', { ascending: true });
  if (error) throw error;
  return data;
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

export async function updateFileNotes(fileId, notes) {
  const { error } = await supabase.from('ingestion_files').update({ notes }).eq('id', fileId);
  if (error) throw error;
}

// Pulls live Drive + GCS listings for a project and reconciles them into
// ingestion_files. Matches Drive files to GCS objects by filename. Existing
// manual status (ingested_at/tested_at) on a file is left untouched.
export async function syncProject(project, googleAccessToken) {
  const [driveFiles, gcsObjects] = await Promise.all([
    project.drive_folder_id ? listDriveFiles(project.drive_folder_id, googleAccessToken) : Promise.resolve([]),
    project.gcs_bucket_name ? listGcsObjects(project.gcs_bucket_name, googleAccessToken) : Promise.resolve([]),
  ]);

  const now = new Date().toISOString();
  const byName = new Map();

  for (const f of driveFiles) {
    byName.set(f.name, {
      file_name: f.name,
      drive_file_id: f.id,
      drive_modified_time: f.modifiedTime || null,
      drive_last_seen_at: now,
    });
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

  const rows = Array.from(byName.values()).map((r) => ({ ...r, project_id: project.id }));
  if (rows.length === 0) return { driveCount: 0, gcsCount: 0 };

  const { error } = await supabase
    .from('ingestion_files')
    .upsert(rows, { onConflict: 'project_id,file_name' });
  if (error) throw error;

  return { driveCount: driveFiles.length, gcsCount: gcsObjects.length };
}

// Derives the pipeline stage for a file row, for rendering.
export function fileStage(file) {
  const inDrive = !!file.drive_last_seen_at;
  const inGcs = !!file.gcs_last_seen_at;
  const ingested = !!file.ingested_at;
  const tested = !!file.tested_at;
  return { inDrive, inGcs, ingested, tested };
}
