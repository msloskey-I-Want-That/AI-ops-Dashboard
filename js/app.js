import { supabase } from './supabase-client.js';
import { signInWithGoogle, signOut, getSession, onAuthChange, getCachedGoogleToken, clearGoogleToken } from './auth.js';
import {
  loadProjects,
  loadFiles,
  addProject,
  updateProject,
  setFileStatus,
  bulkSetFileStatus,
  syncProject,
  fileStage,
  loadProgressOverview,
  loadSingleProjectStats,
  verifyIngestion,
} from './ingestion.js';

const el = (id) => document.getElementById(id);

let state = {
  session: null,
  projects: [],
  activeProjectId: null,
  files: [],
  editingProjectId: null, // set when the dialog is open in "edit" mode
  selectedFileIds: new Set(),
  activeFilter: null, // null | 'missingFromGcs' | 'notIngested' | 'notTested'
};

const FILTER_LABELS = {
  missingFromGcs: 'in Drive, missing from GCS',
  notIngested: 'in GCS, not ingested',
  notTested: 'ingested, not tested',
};

function matchesFilter(file, filterKey) {
  if (!filterKey) return true;
  const { inDrive, inGcs, ingested, tested } = fileStage(file);
  if (filterKey === 'missingFromGcs') return inDrive && !inGcs;
  if (filterKey === 'notIngested') return inGcs && !ingested;
  if (filterKey === 'notTested') return ingested && !tested;
  return true;
}

function getVisibleFiles() {
  return state.files.filter((f) => matchesFilter(f, state.activeFilter));
}

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
  await renderOverview();
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
    if (view === 'overview') renderOverview();
    if (view === 'filetypes') initFiletypesView();
  });
});

// ---------------- Overview ----------------

let overviewChart = null;
let overviewSizeChart = null;

el('btn-refresh-overview').addEventListener('click', () => renderOverview());

async function renderOverview() {
  const kpiRow = el('overview-kpi-row');
  const note = el('overview-note');
  note.textContent = '';

  let rows;
  try {
    rows = await loadProgressOverview();
  } catch (err) {
    kpiRow.innerHTML = '';
    note.textContent = `Could not load overview: ${err.message || err}`;
    return;
  }

  const synced = rows.filter((r) => Number(r.total_files) > 0);
  const notSynced = rows.filter((r) => Number(r.total_files) === 0);
  // Projects at MJN's scale (millions of files) would visually swallow
  // every other project on a shared chart — break them out separately so
  // the comparison charts stay meaningful for everything else.
  const chartable = synced.filter((r) => Number(r.total_files) <= LARGE_PROJECT_THRESHOLD);
  const largeScale = synced.filter((r) => Number(r.total_files) > LARGE_PROJECT_THRESHOLD);

  const totals = synced.reduce(
    (acc, r) => {
      acc.total += Number(r.total_files);
      acc.missing += Number(r.missing_from_gcs);
      acc.notIngested += Number(r.not_ingested);
      acc.notTested += Number(r.not_tested);
      acc.tested += Number(r.fully_tested);
      acc.bytes += Number(r.total_bytes);
      return acc;
    },
    { total: 0, missing: 0, notIngested: 0, notTested: 0, tested: 0, bytes: 0 }
  );

  const kpi = (label, value, color) => `
    <div class="kpi-card">
      <p class="kpi-label">${escapeHtml(label)}</p>
      <p class="kpi-num mono"${color ? ` style="color:${color}"` : ''}>${value}</p>
    </div>`;
  kpiRow.innerHTML =
    kpi('Files tracked', totals.total.toLocaleString()) +
    kpi('Total data volume', formatBytes(totals.bytes)) +
    kpi('Fully tested', totals.tested.toLocaleString(), 'var(--stage-tested)') +
    kpi('Queued for ingestion', totals.notIngested.toLocaleString(), 'var(--stage-not-ingested)') +
    kpi('Needs Drive → GCS copy', totals.missing.toLocaleString(), 'var(--stage-missing)');

  note.textContent = notSynced.length
    ? `Not yet synced: ${notSynced.map((r) => r.display_name).join(', ')}.`
    : '';

  const largeSection = el('overview-large-scale');
  if (largeScale.length === 0) {
    largeSection.hidden = true;
  } else {
    largeSection.hidden = false;
    largeSection.innerHTML =
      '<h2 class="section-heading">Large-scale projects (shown separately — too large for the comparison charts)</h2>' +
      '<div class="kpi-row">' +
      largeScale
        .map(
          (r) => `
        <div class="kpi-card large-scale-card">
          <p class="kpi-label">${escapeHtml(r.display_name)}</p>
          <p class="kpi-num mono">${Number(r.total_files).toLocaleString()} files</p>
          <p class="kpi-label">${formatBytes(r.total_bytes)} · ${Number(r.missing_from_gcs).toLocaleString()} need GCS copy · ${Number(r.not_ingested).toLocaleString()} queued</p>
        </div>`
        )
        .join('') +
      '</div>';
  }

  // Sort ascending so the largest project ends up at the top of the
  // horizontal bar (Chart.js renders category index 0 at the bottom).
  const sorted = [...chartable].sort((a, b) => Number(a.total_files) - Number(b.total_files));

  const ctx = document.getElementById('overview-chart');
  const chartData = {
    labels: sorted.map((r) => r.display_name),
    datasets: [
      { label: 'Missing from GCS', data: sorted.map((r) => Number(r.missing_from_gcs)), backgroundColor: '#ff6b6a', stack: 's' },
      { label: 'Not yet ingested', data: sorted.map((r) => Number(r.not_ingested)), backgroundColor: '#ff9552', stack: 's' },
      { label: 'Ingested, not tested', data: sorted.map((r) => Number(r.not_tested)), backgroundColor: '#ffd166', stack: 's' },
      { label: 'Fully tested', data: sorted.map((r) => Number(r.fully_tested)), backgroundColor: '#c3f53a', stack: 's' },
    ],
  };

  if (overviewChart) {
    overviewChart.data = chartData;
    overviewChart.update();
  } else {
    overviewChart = new Chart(ctx, {
      type: 'bar',
      data: chartData,
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { stacked: true, grid: { color: 'rgba(255,255,255,0.08)' }, ticks: { color: '#9a9ca3' } },
          y: { stacked: true, grid: { display: false }, ticks: { color: '#9a9ca3' } },
        },
      },
    });
  }

  // Second chart: data volume by project, sorted independently by size
  // (biggest file count and biggest data volume aren't always the same
  // project — e.g. many small files vs. a few huge ones).
  const sortedBySize = [...chartable].sort((a, b) => Number(a.total_bytes) - Number(b.total_bytes));
  const sizeCtx = document.getElementById('overview-size-chart');
  const sizeData = {
    labels: sortedBySize.map((r) => r.display_name),
    datasets: [
      {
        label: 'Data volume',
        data: sortedBySize.map((r) => Number(r.total_bytes)),
        backgroundColor: '#c3f53a',
      },
    ],
  };

  if (overviewSizeChart) {
    overviewSizeChart.data = sizeData;
    overviewSizeChart.update();
  } else {
    overviewSizeChart = new Chart(sizeCtx, {
      type: 'bar',
      data: sizeData,
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => formatBytes(ctx.parsed.x) } },
        },
        scales: {
          x: {
            grid: { color: 'rgba(255,255,255,0.08)' },
            ticks: { color: '#9a9ca3', callback: (value) => formatBytes(value) },
          },
          y: { grid: { display: false }, ticks: { color: '#9a9ca3' } },
        },
      },
    });
  }
}

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

const LARGE_PROJECT_THRESHOLD = 20000; // files — loading/rendering more than this in the browser risks a crash

// Loads a project's files for the table view, unless it's too large to
// safely load and render — in which case it shows accurate aggregate stats
// (a cheap server-side query) instead of ever attempting to pull millions
// of individual rows into the browser. Used both when selecting a project
// and after a sync completes.
async function loadAndRenderProjectFiles(projectId) {
  let stats = null;
  try {
    stats = await loadSingleProjectStats(projectId);
  } catch {
    // fall through — if the stats query fails, just try the normal path
  }

  if (stats && Number(stats.total_files) > LARGE_PROJECT_THRESHOLD) {
    state.files = [];
    state.selectedFileIds = new Set();
    state.activeFilter = null;
    renderLargeProjectStats(stats);
    return;
  }

  state.files = await loadFiles(projectId);
  state.selectedFileIds = new Set();
  state.activeFilter = null;
  renderFileTable();
}

function renderLargeProjectStats(stats) {
  renderStats(
    Number(stats.total_files),
    Number(stats.missing_from_gcs),
    Number(stats.not_ingested),
    Number(stats.not_tested),
    Number(stats.total_bytes)
  );
  el('filter-bar').hidden = true;
  el('bulk-bar').hidden = true;
  el('file-table').hidden = true;
  el('empty-state').hidden = false;
  el('empty-state').innerHTML = `
    <p>${Number(stats.total_files).toLocaleString()} files tracked — too many to list individually here.</p>
    <p class="empty-state-sub">Loading or rendering this many rows would crash the browser tab, so this view shows complete, accurate totals only, computed directly in the database. Sync, Verify ingestion, and auto-copy to GCS all still work normally regardless of scale.</p>
  `;
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

  await loadAndRenderProjectFiles(projectId);
}

// ---------------- Sync progress dialog ----------------

function openProgressDialog(title) {
  el('sync-progress-title').textContent = title;
  el('sync-progress-phase').textContent = 'Starting…';
  el('sync-progress-log').innerHTML = '';
  const bar = el('sync-progress-bar');
  bar.style.width = '0%';
  bar.classList.add('is-indeterminate');
  el('sync-progress-dialog').showModal();
}

function setProgressPhase(text) {
  el('sync-progress-phase').textContent = text;
}

function setProgressBar(pct) {
  const bar = el('sync-progress-bar');
  bar.classList.remove('is-indeterminate');
  bar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
}

function setProgressIndeterminate() {
  el('sync-progress-bar').classList.add('is-indeterminate');
}

function appendProgressLog(text, cls) {
  const log = el('sync-progress-log');
  const line = document.createElement('div');
  line.className = 'progress-log-line' + (cls ? ` is-${cls}` : '');
  line.textContent = text;
  log.appendChild(line);
  while (log.children.length > 300) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

el('btn-close-sync-progress').addEventListener('click', () => el('sync-progress-dialog').close());

// Shared handler for syncProject's progress events — used by both the
// single-project Sync button and Sync all. `prefix` lets Sync all tag log
// lines with which project they belong to.
function handleSyncProgressEvent(event, prefix = '') {
  if (event.phase === 'listing') {
    setProgressPhase(`${prefix}Listing Drive and Cloud Storage…`);
    setProgressIndeterminate();
  } else if (event.phase === 'listed') {
    appendProgressLog(`${prefix}Found ${event.driveCount} file(s) in Drive, ${event.gcsCount} object(s) in GCS.`);
  } else if (event.phase === 'copy-start') {
    setProgressPhase(`${prefix}Copying ${event.total} missing file(s) to GCS…`);
  } else if (event.phase === 'copy') {
    setProgressPhase(`${prefix}Copying to GCS — ${event.index}/${event.total}`);
    setProgressBar((event.index / event.total) * 100);
    if (event.outcome === 'copied') appendProgressLog(`${prefix}Copied: ${event.name}`, 'copied');
    else if (event.outcome === 'skipped-exists') appendProgressLog(`${prefix}Already existed: ${event.name}`, 'skipped');
    else if (event.outcome === 'skipped-native') appendProgressLog(`${prefix}Skipped (native Google Doc): ${event.name}`, 'skipped');
    else if (event.outcome === 'failed') appendProgressLog(`${prefix}Failed: ${event.name} — ${event.message}`, 'failed');
  } else if (event.phase === 'save-start') {
    setProgressPhase(`${prefix}Saving ${event.total} file record(s)…`);
    setProgressIndeterminate();
  } else if (event.phase === 'save') {
    setProgressPhase(`${prefix}Saving file records — ${event.done}/${event.total}`);
    setProgressBar((event.done / event.total) * 100);
  }
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
    showSyncStatusWithAction(
      'Your Google session for Drive/Cloud Storage has expired. ',
      'Reconnect Google',
      () => signInWithGoogle()
    );
    return;
  }

  const btn = el('btn-sync');
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  showSyncStatus('Syncing… see progress window.', false);
  openProgressDialog(`Syncing ${project.display_name}`);

  try {
    const result = await syncProject(project, token, (event) => handleSyncProgressEvent(event));
    await loadAndRenderProjectFiles(project.id);

    const copyParts = [];
    if (result.copied) copyParts.push(`${result.copied} copied to GCS`);
    if (result.skippedExists) copyParts.push(`${result.skippedExists} already existed`);
    if (result.skippedNative) copyParts.push(`${result.skippedNative} skipped (native Google Docs)`);
    if (result.failed && result.failed.length) copyParts.push(`${result.failed.length} failed`);
    const copySummary = copyParts.length ? ` — ${copyParts.join(', ')}.` : '';

    setProgressPhase('Done.');
    setProgressBar(100);
    appendProgressLog(`Finished — ${result.driveCount} in Drive, ${result.gcsCount} in GCS.${copySummary}`, 'copied');

    showSyncStatus(
      `Synced — ${result.driveCount} file(s) in Drive, ${result.gcsCount} object(s) in GCS.${copySummary}`,
      result.failed && result.failed.length > 0,
      !(result.failed && result.failed.length > 0)
    );
  } catch (err) {
    if (err.isGoogleAuthError) {
      clearGoogleToken();
      showSyncStatusWithAction(err.message + ' ', 'Reconnect Google', () => signInWithGoogle());
      setProgressPhase('Stopped — Google session expired.');
      appendProgressLog(err.message || 'Google session expired.', 'failed');
    } else {
      showSyncStatus(err.message || 'Sync failed.', true);
      setProgressPhase('Failed.');
      appendProgressLog(err.message || 'Sync failed.', 'failed');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync now';
  }
});

el('btn-verify').addEventListener('click', async () => {
  const project = state.projects.find((p) => p.id === state.activeProjectId);
  if (!project) return;

  if (!project.verify_supabase_url) {
    showSyncStatus('No verification database configured for this project yet.', true);
    return;
  }

  const btn = el('btn-verify');
  btn.disabled = true;
  btn.textContent = 'Verifying…';
  showSyncStatus('Checking against the case database…', false);

  try {
    const result = await verifyIngestion(project, (count) => {
      showSyncStatus(`Checking against the case database — ${count} record(s) read so far…`, false);
    });
    await loadAndRenderProjectFiles(project.id);
    const statusSummary = Object.entries(result.statusCounts)
      .map(([status, count]) => `${status}: ${count}`)
      .join(', ');
    showSyncStatus(
      `Verified against ${result.externalRecords} case-database record(s) (${statusSummary}) — ${result.newlyVerified} newly confirmed here.`,
      false,
      true
    );
  } catch (err) {
    showSyncStatus(err.message || 'Verification failed.', true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Verify ingestion';
  }
});

function showSyncStatus(message, isError, isSuccess) {
  const box = el('sync-status');
  box.innerHTML = '';
  box.textContent = message;
  box.hidden = false;
  box.classList.toggle('is-error', !!isError);
  box.classList.toggle('is-success', !!isSuccess);
}

function showSyncStatusWithAction(message, actionLabel, onAction) {
  const box = el('sync-status');
  box.innerHTML = '';
  box.hidden = false;
  box.classList.add('is-error');
  box.classList.remove('is-success');

  const span = document.createElement('span');
  span.textContent = message;
  const btn = document.createElement('button');
  btn.className = 'btn btn-secondary btn-sm';
  btn.textContent = actionLabel;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Reconnecting…';
    try {
      await onAction();
    } catch (err) {
      showSyncStatus(err.message || 'Reconnect failed.', true);
    }
  });
  box.appendChild(span);
  box.appendChild(btn);
}

// ---------------- File Types ----------------

let filetypesState = { activeProjectId: null, files: [], activeType: null };

function getFileExtension(fileName) {
  const base = fileName.split('/').pop() || fileName;
  const idx = base.lastIndexOf('.');
  if (idx <= 0) return 'no extension';
  return base.slice(idx + 1).toLowerCase();
}

async function initFiletypesView() {
  renderFiletypesProjectBar();
  el('filetypes-empty').hidden = true;
  el('filetypes-panel').hidden = true;

  if (state.projects.length === 0) {
    el('filetypes-empty').hidden = false;
    el('filetypes-empty').innerHTML = '<p>No projects yet.</p><p class="empty-state-sub">Add a project in Ingestion Tracker first.</p>';
    return;
  }

  try {
    if (filetypesState.activeProjectId) {
      await selectFiletypesProject(filetypesState.activeProjectId);
    } else {
      await selectFiletypesProject(state.projects[0].id);
    }
  } catch (err) {
    console.error('initFiletypesView failed:', err);
    el('filetypes-empty').hidden = false;
    el('filetypes-panel').hidden = true;
    el('filetypes-empty').innerHTML = `<p style="color:var(--danger)">Failed to load: ${escapeHtml(err.message || String(err))}</p><p class="empty-state-sub">Check the browser console for details.</p>`;
  }
}

function renderFiletypesProjectBar() {
  const bar = el('filetypes-project-bar');
  bar.innerHTML = '';
  for (const p of state.projects) {
    const chip = document.createElement('button');
    chip.className = 'project-chip' + (p.id === filetypesState.activeProjectId ? ' is-active' : '');
    chip.textContent = p.display_name;
    chip.addEventListener('click', () => selectFiletypesProject(p.id));
    bar.appendChild(chip);
  }
}

async function selectFiletypesProject(projectId) {
  filetypesState.activeProjectId = projectId;
  filetypesState.activeType = null;
  renderFiletypesProjectBar();
  el('filetypes-empty').hidden = true;
  el('filetypes-panel').hidden = false;

  let stats = null;
  try {
    stats = await loadSingleProjectStats(projectId);
  } catch {
    // fall through — if the stats query fails, just try the normal path
  }
  if (stats && Number(stats.total_files) > LARGE_PROJECT_THRESHOLD) {
    filetypesState.files = [];
    el('filetypes-panel').hidden = true;
    el('filetypes-empty').hidden = false;
    el('filetypes-empty').innerHTML = `<p>${Number(stats.total_files).toLocaleString()} files tracked — too many to break down by type here.</p><p class="empty-state-sub">Loading this many rows would crash the browser tab. Use the Ingestion Tracker's stats for this project instead.</p>`;
    return;
  }

  try {
    filetypesState.files = await loadFiles(projectId);
  } catch (err) {
    console.error('selectFiletypesProject failed:', err);
    el('filetypes-panel').hidden = true;
    el('filetypes-empty').hidden = false;
    el('filetypes-empty').innerHTML = `<p style="color:var(--danger)">Failed to load files: ${escapeHtml(err.message || String(err))}</p>`;
    return;
  }
  renderFiletypesTypeChips();
  renderFiletypesTable();
}

function renderFiletypesTypeChips() {
  const counts = new Map();
  for (const f of filetypesState.files) {
    const ext = getFileExtension(f.file_name);
    counts.set(ext, (counts.get(ext) || 0) + 1);
  }
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);

  const row = el('type-chip-row');
  row.innerHTML = '';
  const allChip = document.createElement('button');
  allChip.className = 'project-chip' + (filetypesState.activeType === null ? ' is-active' : '');
  allChip.textContent = `All (${filetypesState.files.length})`;
  allChip.addEventListener('click', () => {
    filetypesState.activeType = null;
    renderFiletypesTypeChips();
    renderFiletypesTable();
  });
  row.appendChild(allChip);

  for (const [ext, count] of sorted) {
    const chip = document.createElement('button');
    chip.className = 'project-chip' + (filetypesState.activeType === ext ? ' is-active' : '');
    chip.textContent = `.${ext} (${count})`;
    chip.addEventListener('click', () => {
      filetypesState.activeType = filetypesState.activeType === ext ? null : ext;
      renderFiletypesTypeChips();
      renderFiletypesTable();
    });
    row.appendChild(chip);
  }
}

function renderFiletypesTable() {
  const tbody = el('filetypes-table-body');
  tbody.innerHTML = '';
  const visible =
    filetypesState.activeType === null
      ? filetypesState.files
      : filetypesState.files.filter((f) => getFileExtension(f.file_name) === filetypesState.activeType);

  for (const file of visible) {
    const { inDrive, inGcs, ingested, tested } = fileStage(file);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="file-name">${escapeHtml(file.file_name)}</td>
      <td class="mono">${escapeHtml(getFileExtension(file.file_name))}</td>
      <td class="mono">${formatBytes(file.gcs_size_bytes)}</td>
      <td>${pillHtml(inDrive, inDrive ? 'seen' : 'missing')}</td>
      <td>${pillHtml(inGcs, inGcs ? 'seen' : 'missing')}</td>
      <td>${pillHtml(ingested, ingested ? 'yes' : 'no')}</td>
      <td>${pillHtml(tested, tested ? 'yes' : 'no')}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderFileTable() {
  const tbody = el('file-table-body');
  tbody.innerHTML = '';

  const visible = getVisibleFiles();
  el('empty-state').hidden = visible.length > 0;
  el('file-table').hidden = visible.length === 0;

  let missingFromGcs = 0;
  let notIngested = 0;
  let notTested = 0;
  let totalBytes = 0;

  // Stats always reflect the whole project, regardless of the active filter.
  for (const file of state.files) {
    const { inDrive, inGcs, ingested, tested } = fileStage(file);
    if (inDrive && !inGcs) missingFromGcs++;
    if (inGcs && !ingested) notIngested++;
    if (ingested && !tested) notTested++;
    totalBytes += Number(file.gcs_size_bytes) || 0;
  }

  for (const file of visible) {
    const { inDrive, inGcs, ingested, tested } = fileStage(file);

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
    if (file.verified_ingested_at) {
      const badge = document.createElement('span');
      badge.className = 'verified-badge';
      badge.title = `Confirmed in the case database as of ${new Date(file.verified_ingested_at).toLocaleString()}`;
      badge.textContent = '✓ verified';
      ingestedCell.appendChild(badge);
    }
    testedCell.appendChild(toggleButton(tested, 'Tested', () => toggleStatus(file, 'tested', !tested), !ingested));
    tbody.appendChild(tr);
  }

  renderStats(state.files.length, missingFromGcs, notIngested, notTested, totalBytes);
  renderFilterBar();
  renderBulkBar();
  syncCheckAllState();
}

function renderFilterBar() {
  const bar = el('filter-bar');
  if (!state.activeFilter) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const count = getVisibleFiles().length;
  el('filter-label').textContent = `${count} file(s) — ${FILTER_LABELS[state.activeFilter]}`;
}

el('btn-clear-filter').addEventListener('click', () => {
  state.activeFilter = null;
  state.selectedFileIds = new Set();
  renderFileTable();
});

el('btn-copy-filtered').addEventListener('click', async () => {
  const names = getVisibleFiles().map((f) => f.file_name);
  const text = names.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    showSyncStatus(`Copied ${names.length} file name(s) to clipboard.`, false, true);
  } catch {
    showSyncStatus('Could not copy automatically — select and copy the list below.', true);
    // Fallback: show it in a prompt so it can still be copied manually.
    window.prompt('Copy this list:', text);
  }
});

function syncCheckAllState() {
  const checkAll = el('check-all');
  const visible = getVisibleFiles();
  const total = visible.length;
  const selected = visible.filter((f) => state.selectedFileIds.has(f.id)).length;
  checkAll.checked = total > 0 && selected === total;
  checkAll.indeterminate = selected > 0 && selected < total;
}

function renderBulkBar() {
  const count = state.selectedFileIds.size;
  el('bulk-bar').hidden = count === 0;
  el('bulk-count').textContent = `${count} selected`;
}

el('check-all').addEventListener('change', (e) => {
  const visibleIds = getVisibleFiles().map((f) => f.id);
  if (e.target.checked) {
    visibleIds.forEach((id) => state.selectedFileIds.add(id));
  } else {
    visibleIds.forEach((id) => state.selectedFileIds.delete(id));
  }
  renderFileTable();
});

el('btn-bulk-clear').addEventListener('click', () => {
  state.selectedFileIds = new Set();
  renderFileTable();
});

el('btn-bulk-ingested').addEventListener('click', () => bulkApply('ingested'));
el('btn-bulk-tested').addEventListener('click', () => bulkApply('tested'));

const BULK_PROGRESS_THRESHOLD = 40;

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

function renderStats(total, missingFromGcs, notIngested, notTested, totalBytes) {
  const row = el('stat-row');
  row.innerHTML = '';

  const makeStat = (num, label, flagged, filterKey, displayValue) => {
    const btn = document.createElement('button');
    btn.className = 'stat' + (flagged && num > 0 ? ' is-flagged' : '') + (state.activeFilter === filterKey ? ' is-selected' : '');
    btn.innerHTML = `<div class="stat-num mono">${displayValue ?? num}</div><div class="stat-label">${label}</div>`;
    btn.addEventListener('click', () => {
      if (!filterKey || num === 0) return;
      state.activeFilter = state.activeFilter === filterKey ? null : filterKey;
      state.selectedFileIds = new Set();
      renderFileTable();
    });
    if (!filterKey || num === 0) btn.style.cursor = 'default';
    return btn;
  };

  row.appendChild(makeStat(total, 'files tracked', false, null));
  row.appendChild(makeStat(0, 'total size', false, null, formatBytes(totalBytes)));
  row.appendChild(makeStat(missingFromGcs, 'in Drive, missing from GCS', true, 'missingFromGcs'));
  row.appendChild(makeStat(notIngested, 'in GCS, not ingested', true, 'notIngested'));
  row.appendChild(makeStat(notTested, 'ingested, not tested', true, 'notTested'));
}

// ---------------- Add / edit project dialog ----------------

el('btn-sync-all').addEventListener('click', syncAllProjects);

async function syncAllProjects() {
  const eligible = state.projects.filter((p) => p.drive_folder_id && p.gcs_bucket_name);
  const skipped = state.projects.filter((p) => !p.drive_folder_id || !p.gcs_bucket_name);
  const statusBox = el('sync-all-status');
  const btn = el('btn-sync-all');

  if (eligible.length === 0) {
    statusBox.hidden = false;
    statusBox.classList.add('is-error');
    statusBox.textContent = 'No projects have both a Drive folder and GCS bucket set yet — nothing to sync.';
    return;
  }

  let token = getCachedGoogleToken();
  if (!token) {
    statusBox.hidden = false;
    statusBox.innerHTML = '';
    statusBox.classList.add('is-error');
    const span = document.createElement('span');
    span.textContent = 'Your Google session for Drive/Cloud Storage has expired. ';
    const reconnectBtn = document.createElement('button');
    reconnectBtn.className = 'btn btn-secondary btn-sm';
    reconnectBtn.textContent = 'Reconnect Google';
    reconnectBtn.addEventListener('click', () => signInWithGoogle());
    statusBox.appendChild(span);
    statusBox.appendChild(reconnectBtn);
    return;
  }

  btn.disabled = true;
  statusBox.hidden = false;
  statusBox.classList.remove('is-error', 'is-success');
  openProgressDialog(`Syncing ${eligible.length} project(s)`);

  const failures = [];
  const copyNotes = [];
  for (let i = 0; i < eligible.length; i++) {
    const project = eligible[i];
    statusBox.textContent = `Syncing ${i + 1}/${eligible.length}: ${project.display_name}…`;
    const prefix = `[${i + 1}/${eligible.length}] ${project.display_name}: `;
    try {
      const result = await syncProject(project, token, (event) => handleSyncProgressEvent(event, prefix));
      if (result.copied) copyNotes.push(`${project.display_name}: ${result.copied} copied to GCS`);
      if (result.failed && result.failed.length) {
        failures.push({ name: project.display_name, message: `${result.failed.length} file copy failure(s)` });
      }
      // Keep the on-screen table current if this project happens to be the
      // one currently selected.
      if (project.id === state.activeProjectId) {
        await loadAndRenderProjectFiles(project.id);
      }
    } catch (err) {
      if (err.isGoogleAuthError) {
        clearGoogleToken();
        statusBox.innerHTML = '';
        const span = document.createElement('span');
        span.textContent = `Google session expired partway through (stopped at ${project.display_name}). `;
        const reconnectBtn = document.createElement('button');
        reconnectBtn.className = 'btn btn-secondary btn-sm';
        reconnectBtn.textContent = 'Reconnect Google';
        reconnectBtn.addEventListener('click', () => signInWithGoogle());
        statusBox.appendChild(span);
        statusBox.appendChild(reconnectBtn);
        statusBox.classList.add('is-error');
        btn.disabled = false;
        setProgressPhase(`Stopped — Google session expired at ${project.display_name}.`);
        appendProgressLog(err.message || 'Google session expired.', 'failed');
        return;
      }
      appendProgressLog(`${prefix}${err.message || String(err)}`, 'failed');
      failures.push({ name: project.display_name, message: err.message || String(err) });
    }
  }

  btn.disabled = false;
  const skippedNote = skipped.length ? ` (${skipped.length} skipped — no Drive folder/bucket set: ${skipped.map((p) => p.display_name).join(', ')})` : '';
  const copyNote = copyNotes.length ? ` ${copyNotes.join('; ')}.` : '';
  setProgressPhase('Done.');
  setProgressBar(100);
  if (failures.length === 0) {
    statusBox.classList.remove('is-error');
    statusBox.classList.add('is-success');
    statusBox.textContent = `Synced ${eligible.length} project(s).${copyNote}${skippedNote}`;
    appendProgressLog(`All done — ${eligible.length} project(s) synced.${copyNote}`, 'copied');
  } else {
    statusBox.classList.add('is-error');
    statusBox.classList.remove('is-success');
    statusBox.textContent = `Synced ${eligible.length - failures.length}/${eligible.length} project(s). Failed: ${failures.map((f) => `${f.name} (${f.message})`).join('; ')}${copyNote}${skippedNote}`;
    appendProgressLog(`Finished with ${failures.length} failure(s).`, 'failed');
  }
}
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

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const value = n / Math.pow(1024, i);
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

init();
