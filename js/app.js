import { supabase } from './supabase-client.js';
import { signInWithGoogle, signOut, getSession, onAuthChange, getCachedGoogleToken } from './auth.js';
import {
  loadProjects,
  loadFiles,
  addProject,
  updateProject,
  setFileStatus,
  bulkSetFileStatus,
  syncProject,
  fileStage,
} from './ingestion.js';

const el = (id) => document.getElementById(id);

let state = {
  session: null,
  projects: [],
  activeProjectId: null,
  files: [],
  editingProjectId: null, // set when the dialog is open in "edit" mode
  selectedFileIds: new Set(),
};

// ---------------- Auth wiring ----------------

el('btn-sign-in').addEventListener('click', async () => {
  el('auth-error').hidden = true;
  try {
    await signInWithGoogle();
  } catch (err) {
    el('auth-error').textContent = err.message || 'Sign-in failed.';
    el('auth-error').hidden = false;
  }
});

el('btn-sign-out').addEventListener('click', async () => {
  await signOut();
  window.location.reload();
});

onAuthChange((_event, session) => {
  state.session = session;
  renderAuthState();
});

async function init() {
  checkForAuthErrorInUrl();
  try {
    state.session = await getSession();
  } catch (err) {
    console.error('getSession failed:', err);
    el('auth-error').textContent = `Session check failed: ${err.message || err}`;
    el('auth-error').hidden = false;
  }
  renderAuthState();
  if (state.session) {
    try {
      await bootApp();
    } catch (err) {
      console.error('bootApp failed:', err);
      el('no-project-state').hidden = false;
      el('no-project-state').innerHTML = `<p style="color:var(--danger)">Failed to load projects: ${escapeHtml(err.message || String(err))}</p><p class="empty-state-sub">Check the browser console for details.</p>`;
    }
  }
}

// Supabase appends ?error=...&error_description=... (or in the hash) to the
// redirect URL when the OAuth exchange fails, instead of throwing in JS.
// Surface it so failures aren't silent.
function checkForAuthErrorInUrl() {
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const queryParams = new URLSearchParams(window.location.search);
  const error = hashParams.get('error') || queryParams.get('error');
  const description =
    hashParams.get('error_description') || queryParams.get('error_description') || '';
  if (error) {
    el('auth-error').textContent = `${error}${description ? `: ${decodeURIComponent(description.replace(/\+/g, ' '))}` : ''}`;
    el('auth-error').hidden = false;
    // Clean the error out of the URL so a refresh doesn't keep showing it.
    window.history.replaceState({}, '', window.location.pathname);
  }
}

function renderAuthState() {
  const signedIn = !!state.session;
  el('auth-screen').hidden = signedIn;
  el('app-shell').hidden = !signedIn;
  if (signedIn) {
    el('user-email').textContent = state.session.user?.email || 'Signed in';
  }
}

async function bootApp() {
  await refreshProjects();
}

// ---------------- Nav ----------------

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    const view = btn.dataset.view;
    document.querySelectorAll('.view').forEach((v) => (v.hidden = true));
    el(`view-${view}`).hidden = false;
  });
});

// ---------------- Ingestion: projects ----------------

async function refreshProjects() {
  state.projects = await loadProjects();
  renderProjectBar();
  if (!state.activeProjectId && state.projects.length > 0) {
    selectProject(state.projects[0].id);
  } else if (state.projects.length === 0) {
    el('project-panel').hidden = true;
    el('no-project-state').hidden = false;
  }
}

function renderProjectBar() {
  const bar = el('project-bar');
  bar.innerHTML = '';
  for (const p of state.projects) {
    const chip = document.createElement('button');
    chip.className = 'project-chip' + (p.id === state.activeProjectId ? ' is-active' : '');
    chip.innerHTML = `${escapeHtml(p.display_name)}`;
    chip.addEventListener('click', () => selectProject(p.id));
    bar.appendChild(chip);
  }
}

async function selectProject(projectId) {
  state.activeProjectId = projectId;
  renderProjectBar();
  const project = state.projects.find((p) => p.id === projectId);
  if (!project) return;

  el('no-project-state').hidden = true;
  el('project-panel').hidden = false;
  el('sync-status').hidden = true;

  el('project-title').textContent = project.display_name;
  el('project-meta').textContent =
    `bucket: ${project.gcs_bucket_name || '—'}` +
    `  ·  drive folder: ${project.drive_folder_id || 'not set'}` +
    (project.gcp_project_id ? `  ·  gcp: ${project.gcp_project_id}` : '');

  state.files = await loadFiles(projectId);
  state.selectedFileIds = new Set();
  renderFileTable();
}

// ---------------- Sync ----------------

el('btn-sync').addEventListener('click', async () => {
  const project = state.projects.find((p) => p.id === state.activeProjectId);
  if (!project) return;

  if (!project.drive_folder_id || !project.gcs_bucket_name) {
    showSyncStatus('Set a Drive folder ID and GCS bucket name for this project first (Edit).', true);
    return;
  }

  const token = getCachedGoogleToken();
  if (!token) {
    showSyncStatus('Your Google session for Drive/Cloud Storage has expired. Sign out and back in to refresh it.', true);
    return;
  }

  const btn = el('btn-sync');
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  showSyncStatus('Pulling current state from Drive and Cloud Storage…', false);

  try {
    const result = await syncProject(project, token);
    state.files = await loadFiles(project.id);
    state.selectedFileIds = new Set();
    renderFileTable();
    showSyncStatus(`Synced — ${result.driveCount} file(s) in Drive, ${result.gcsCount} object(s) in GCS.`, false, true);
  } catch (err) {
    showSyncStatus(err.message || 'Sync failed.', true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync now';
  }
});

function showSyncStatus(message, isError, isSuccess) {
  const box = el('sync-status');
  box.textContent = message;
  box.hidden = false;
  box.classList.toggle('is-error', !!isError);
  box.classList.toggle('is-success', !!isSuccess);
}

// ---------------- File table ----------------

function renderFileTable() {
  const tbody = el('file-table-body');
  tbody.innerHTML = '';
  el('empty-state').hidden = state.files.length > 0;
  el('file-table').hidden = state.files.length === 0;

  let missingFromGcs = 0;
  let notIngested = 0;
  let notTested = 0;

  for (const file of state.files) {
    const { inDrive, inGcs, ingested, tested } = fileStage(file);
    if (inDrive && !inGcs) missingFromGcs++;
    if (inGcs && !ingested) notIngested++;
    if (ingested && !tested) notTested++;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td></td>
      <td class="file-name">${escapeHtml(file.file_name)}</td>
      <td>${pipelineHtml(inDrive, inGcs, ingested, tested)}</td>
      <td>${pillHtml(inDrive, inDrive ? 'seen' : 'missing')}</td>
      <td>${pillHtml(inGcs, inGcs ? 'seen' : 'missing')}</td>
      <td></td>
      <td></td>
    `;
    const checkCell = tr.children[0];
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'row-check';
    checkbox.checked = state.selectedFileIds.has(file.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selectedFileIds.add(file.id);
      else state.selectedFileIds.delete(file.id);
      renderBulkBar();
      syncCheckAllState();
    });
    checkCell.appendChild(checkbox);

    const ingestedCell = tr.children[5];
    const testedCell = tr.children[6];
    ingestedCell.appendChild(toggleButton(ingested, 'Ingested', () => toggleStatus(file, 'ingested', !ingested)));
    testedCell.appendChild(toggleButton(tested, 'Tested', () => toggleStatus(file, 'tested', !tested), !ingested));
    tbody.appendChild(tr);
  }

  renderStats(state.files.length, missingFromGcs, notIngested, notTested);
  renderBulkBar();
  syncCheckAllState();
}

function syncCheckAllState() {
  const checkAll = el('check-all');
  const total = state.files.length;
  const selected = state.selectedFileIds.size;
  checkAll.checked = total > 0 && selected === total;
  checkAll.indeterminate = selected > 0 && selected < total;
}

function renderBulkBar() {
  const count = state.selectedFileIds.size;
  el('bulk-bar').hidden = count === 0;
  el('bulk-count').textContent = `${count} selected`;
}

el('check-all').addEventListener('change', (e) => {
  if (e.target.checked) {
    state.selectedFileIds = new Set(state.files.map((f) => f.id));
  } else {
    state.selectedFileIds = new Set();
  }
  renderFileTable();
});

el('btn-bulk-clear').addEventListener('click', () => {
  state.selectedFileIds = new Set();
  renderFileTable();
});

el('btn-bulk-ingested').addEventListener('click', () => bulkApply('ingested'));
el('btn-bulk-tested').addEventListener('click', () => bulkApply('tested'));

const BULK_PROGRESS_THRESHOLD = 150;

async function bulkApply(stage) {
  const ids = Array.from(state.selectedFileIds);
  if (ids.length === 0) return;
  const email = state.session?.user?.email || null;
  const btn = stage === 'ingested' ? el('btn-bulk-ingested') : el('btn-bulk-tested');
  const originalText = btn.textContent;
  btn.disabled = true;
  const onProgress = (done, total) => {
    btn.textContent = total > BULK_PROGRESS_THRESHOLD ? `Applying ${done}/${total}…` : 'Applying…';
  };
  onProgress(0, ids.length);
  try {
    let updated;
    if (stage === 'tested') {
      // Tested implies ingested — stamp both so the pipeline stays consistent,
      // same rule the individual per-row toggle enforces.
      await bulkSetFileStatus(ids, 'ingested', true, email, onProgress);
      updated = await bulkSetFileStatus(ids, 'tested', true, email, onProgress);
    } else {
      updated = await bulkSetFileStatus(ids, 'ingested', true, email, onProgress);
    }
    const byId = new Map(updated.map((f) => [f.id, f]));
    state.files = state.files.map((f) => byId.get(f.id) || f);
    state.selectedFileIds = new Set();
    renderFileTable();
    showSyncStatus(`Marked ${ids.length} file(s) as ${stage}.`, false, true);
  } catch (err) {
    showSyncStatus(err.message || `Could not mark files as ${stage}.`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

function pipelineHtml(inDrive, inGcs, ingested, tested) {
  const seg = (on, isGapCandidate) => {
    const cls = on ? 'is-on' : isGapCandidate ? 'is-gap' : '';
    return `<span class="pipe-seg ${cls}"></span>`;
  };
  return `<span class="pipeline">
    ${seg(inDrive, false)}
    ${seg(inGcs, inDrive && !inGcs)}
    ${seg(ingested, inGcs && !ingested)}
    ${seg(tested, ingested && !tested)}
  </span>`;
}

function pillHtml(on, label) {
  return `<span class="status-pill ${on ? 'is-on' : ''}"><span class="status-dot"></span>${label}</span>`;
}

function toggleButton(on, label, onClick, disabled) {
  const btn = document.createElement('button');
  btn.className = 'status-toggle' + (on ? ' is-on' : '');
  btn.innerHTML = `<span class="status-toggle-check"></span>${label}`;
  btn.disabled = !!disabled;
  btn.title = disabled ? 'Mark ingested first' : '';
  btn.addEventListener('click', onClick);
  return btn;
}

async function toggleStatus(file, stage, on) {
  const email = state.session?.user?.email || null;
  try {
    const updated = await setFileStatus(file.id, stage, on, email);
    const idx = state.files.findIndex((f) => f.id === file.id);
    if (idx !== -1) state.files[idx] = updated;
    renderFileTable();
  } catch (err) {
    showSyncStatus(err.message || 'Could not update status.', true);
  }
}

function renderStats(total, missingFromGcs, notIngested, notTested) {
  const row = el('stat-row');
  const stat = (num, label, flagged) => `
    <div class="stat${flagged && num > 0 ? ' is-flagged' : ''}">
      <div class="stat-num mono">${num}</div>
      <div class="stat-label">${label}</div>
    </div>`;
  row.innerHTML =
    stat(total, 'files tracked', false) +
    stat(missingFromGcs, 'in Drive, missing from GCS', true) +
    stat(notIngested, 'in GCS, not ingested', true) +
    stat(notTested, 'ingested, not tested', true);
}

// ---------------- Add / edit project dialog ----------------

el('btn-add-project').addEventListener('click', () => openProjectDialog(null));
el('btn-edit-project').addEventListener('click', () => {
  const project = state.projects.find((p) => p.id === state.activeProjectId);
  if (project) openProjectDialog(project);
});
el('btn-cancel-dialog').addEventListener('click', () => el('project-dialog').close());

function openProjectDialog(project) {
  state.editingProjectId = project?.id || null;
  el('dialog-title').textContent = project ? 'Edit project' : 'Add project';
  el('f-display-name').value = project?.display_name || '';
  el('f-slug').value = project?.slug || '';
  el('f-drive-folder').value = project?.drive_folder_id || '';
  el('f-gcs-bucket').value = project?.gcs_bucket_name || '';
  el('f-gcp-project').value = project?.gcp_project_id || '';
  el('f-notes').value = project?.notes || '';
  el('project-dialog').showModal();
}

el('project-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fields = {
    slug: el('f-slug').value.trim(),
    display_name: el('f-display-name').value.trim(),
    drive_folder_id: el('f-drive-folder').value.trim() || null,
    gcs_bucket_name: el('f-gcs-bucket').value.trim(),
    gcp_project_id: el('f-gcp-project').value.trim() || null,
    notes: el('f-notes').value.trim() || null,
  };

  try {
    if (state.editingProjectId) {
      await updateProject(state.editingProjectId, fields);
    } else {
      await addProject(fields);
    }
    el('project-dialog').close();
    const keepId = state.editingProjectId || null;
    await refreshProjects();
    if (keepId) selectProject(keepId);
  } catch (err) {
    alert(err.message || 'Could not save project.');
  }
});

// ---------------- Utils ----------------

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

init();
