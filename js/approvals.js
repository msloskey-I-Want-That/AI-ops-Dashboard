import { supabase } from './supabase-client.js';

const el = (id) => document.getElementById(id);
const escapeHtml = (s) => (s == null ? '' : String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])));

function formatBytes(bytes) {
  if (bytes == null || isNaN(bytes) || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 1 ? 2 : 0)} ${units[i]}`;
}

function formatRelativeTime(dateStr) {
  if (!dateStr) return '—';
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

// ---------------- Data Fetchers ----------------

export async function loadPendingBatches() {
  const { data, error } = await supabase
    .from('ingest_batches')
    .select(`
      id,
      kind,
      folder_id,
      status,
      file_count,
      total_bytes,
      oldest_file_at,
      sealed_at,
      project_id,
      ingestion_projects (
        id,
        slug,
        display_name,
        ingest_mode
      )
    `)
    .in('status', ['pending_approval', 'held'])
    .order('sealed_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

export async function loadBatchFiles(batchId, page = 0, pageSize = 20) {
  const from = page * pageSize;
  const to = from + pageSize - 1;
  const { data, count, error } = await supabase
    .from('drive_ingest_ledger')
    .select('id, name, size_bytes, mime_type, drive_rel_path, status, first_seen_at', { count: 'exact' })
    .eq('batch_id', batchId)
    .order('name', { ascending: true })
    .range(from, to);

  if (error) throw error;
  return { files: data || [], total: count || 0 };
}

export async function setBatchStatus(batchId, status, userEmail) {
  const payload = {
    status,
    approved_by: status === 'approved' ? userEmail : null,
    approved_at: status === 'approved' ? new Date().toISOString() : null,
  };
  const { data, error } = await supabase
    .from('ingest_batches')
    .update(payload)
    .eq('id', batchId);

  if (error) throw error;
  return data;
}

export async function loadHeldItems() {
  const [unprovRes, unroutedRes] = await Promise.all([
    supabase
      .from('ingest_folder_dispositions')
      .select('*')
      .eq('disposition', 'unprovisioned')
      .order('first_seen_at', { ascending: false }),
    supabase
      .from('drive_ingest_ledger')
      .select('id, name, size_bytes, mime_type, first_seen_at')
      .eq('status', 'held_unrouted')
      .order('first_seen_at', { ascending: false })
      .limit(100),
  ]);

  if (unprovRes.error) throw unprovRes.error;
  if (unroutedRes.error) throw unroutedRes.error;

  return {
    unprovisioned: unprovRes.data || [],
    unrouted: unroutedRes.data || [],
  };
}

export async function mapUnprovisionedFolder(folderId, projectId, userEmail) {
  const { error } = await supabase
    .from('ingest_folder_dispositions')
    .update({
      disposition: 'mapped',
      mapped_project_id: projectId,
      decided_by: userEmail,
      decided_at: new Date().toISOString(),
    })
    .eq('drive_folder_id', folderId);
  if (error) throw error;
}

export async function ignoreUnprovisionedFolder(folderId, userEmail) {
  const { error } = await supabase
    .from('ingest_folder_dispositions')
    .update({
      disposition: 'ignored',
      mapped_project_id: null,
      decided_by: userEmail,
      decided_at: new Date().toISOString(),
    })
    .eq('drive_folder_id', folderId);
  if (error) throw error;
}

export async function loadRecentExecutions() {
  const { data, error } = await supabase
    .from('ingest_batches')
    .select(`
      id,
      kind,
      status,
      file_count,
      total_bytes,
      started_at,
      heartbeat_at,
      finished_at,
      result,
      error,
      ingestion_projects (
        slug,
        display_name
      )
    `)
    .in('status', ['running', 'done', 'failed', 'stalled'])
    .order('started_at', { ascending: false })
    .limit(20);

  if (error) throw error;
  return data || [];
}

// ---------------- UI Rendering ----------------

let currentTargetBatchId = null;
const batchFileCache = new Map(); // batchId -> { page, files, total }

export async function initApprovalsView(projects, userEmail) {
  const urlParams = new URLSearchParams(window.location.hash.includes('?') ? window.location.hash.split('?')[1] : '');
  currentTargetBatchId = urlParams.get('batch');

  await Promise.all([
    renderPendingBatchesUI(userEmail),
    renderHeldItemsUI(projects, userEmail),
    renderRecentExecutionsUI(),
  ]);

  if (currentTargetBatchId) {
    const card = document.getElementById(`batch-card-${currentTargetBatchId}`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth' });
      card.classList.add('is-highlighted');
      const toggle = card.querySelector('.btn-toggle-files');
      if (toggle && !card.classList.contains('is-expanded')) {
        toggle.click();
      }
    }
  }
}

async function renderPendingBatchesUI(userEmail) {
  const container = el('approvals-pending-list');
  if (!container) return;

  container.innerHTML = '<div class="glass-loading">Loading pending batches…</div>';

  try {
    const batches = await loadPendingBatches();
    if (batches.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <p>No batches awaiting approval.</p>
          <span class="empty-state-sub">New files detected in Drive will appear here after sealing.</span>
        </div>
      `;
      return;
    }

    container.innerHTML = batches
      .map((b) => {
        const p = b.ingestion_projects || {};
        const matterName = p.display_name || 'Unmapped Folder';
        const isCopyAndIngest = p.ingest_mode === 'copy_and_ingest';
        const badgeClass = isCopyAndIngest ? 'badge-lime' : 'badge-orange';
        const badgeLabel = isCopyAndIngest ? 'Copy & Ingest' : 'Copy Only';
        const mb = formatBytes(b.total_bytes);
        const age = formatRelativeTime(b.sealed_at || b.oldest_file_at);
        const isHeld = b.status === 'held';

        return `
          <div class="approval-card glass-panel ${isHeld ? 'is-held' : ''}" id="batch-card-${b.id}">
            <div class="approval-card-header">
              <div class="approval-meta">
                <div class="approval-title-row">
                  <h3 class="approval-matter-title">${escapeHtml(matterName)}</h3>
                  <span class="badge ${badgeClass}">${badgeLabel}</span>
                  ${isHeld ? '<span class="badge badge-held">HELD</span>' : ''}
                </div>
                <div class="approval-sub-meta">
                  <span><strong>${b.file_count}</strong> files</span>
                  <span class="meta-sep">·</span>
                  <span>${mb}</span>
                  <span class="meta-sep">·</span>
                  <span>Sealed ${age}</span>
                  <span class="meta-sep">·</span>
                  <span class="mono text-muted" title="${b.id}">ID: ${b.id.slice(0, 8)}…</span>
                </div>
              </div>
              <div class="approval-actions">
                <button class="btn btn-sm btn-ghost btn-toggle-files" data-batch="${b.id}">View files</button>
                ${
                  isHeld
                    ? `<button class="btn btn-sm btn-primary btn-approve" data-batch="${b.id}">Release &amp; Approve</button>`
                    : `
                      <button class="btn btn-sm btn-secondary btn-hold" data-batch="${b.id}">Hold</button>
                      <button class="btn btn-sm btn-primary btn-approve" data-batch="${b.id}">Approve</button>
                    `
                }
              </div>
            </div>
            <div class="approval-files-container" id="files-container-${b.id}" hidden>
              <div class="approval-files-table-wrapper" id="files-table-${b.id}">
                <div class="glass-loading-inline">Loading files…</div>
              </div>
            </div>
          </div>
        `;
      })
      .join('');

    // Attach listeners
    container.querySelectorAll('.btn-approve').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.batch;
        btn.disabled = true;
        btn.textContent = 'Approving…';
        try {
          await setBatchStatus(id, 'approved', userEmail);
          renderPendingBatchesUI(userEmail);
          renderRecentExecutionsUI();
        } catch (err) {
          alert(`Failed to approve batch: ${err.message || err}`);
          btn.disabled = false;
          btn.textContent = 'Approve';
        }
      });
    });

    container.querySelectorAll('.btn-hold').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.batch;
        btn.disabled = true;
        btn.textContent = 'Holding…';
        try {
          await setBatchStatus(id, 'held', userEmail);
          renderPendingBatchesUI(userEmail);
        } catch (err) {
          alert(`Failed to hold batch: ${err.message || err}`);
          btn.disabled = false;
          btn.textContent = 'Hold';
        }
      });
    });

    container.querySelectorAll('.btn-toggle-files').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.batch;
        const panel = el(`files-container-${id}`);
        const card = el(`batch-card-${id}`);
        if (!panel.hidden) {
          panel.hidden = true;
          card.classList.remove('is-expanded');
          btn.textContent = 'View files';
        } else {
          panel.hidden = false;
          card.classList.add('is-expanded');
          btn.textContent = 'Hide files';
          await renderBatchFilesTable(id, 0);
        }
      });
    });
  } catch (err) {
    container.innerHTML = `<div class="error-msg">Failed to load pending batches: ${escapeHtml(err.message || String(err))}</div>`;
  }
}

async function renderBatchFilesTable(batchId, page = 0) {
  const wrapper = el(`files-table-${batchId}`);
  if (!wrapper) return;

  try {
    const { files, total } = await loadBatchFiles(batchId, page, 20);
    const totalPages = Math.ceil(total / 20) || 1;

    wrapper.innerHTML = `
      <table class="data-table approvals-table">
        <thead>
          <tr>
            <th>File Name</th>
            <th>Drive Relative Path</th>
            <th>Size</th>
            <th>MIME Type</th>
            <th>Detected</th>
          </tr>
        </thead>
        <tbody>
          ${files
            .map(
              (f) => `
            <tr>
              <td class="cell-filename">${escapeHtml(f.name)}</td>
              <td class="cell-path mono text-muted" title="${escapeHtml(f.drive_rel_path)}">${escapeHtml(f.drive_rel_path)}</td>
              <td class="cell-size">${formatBytes(f.size_bytes)}</td>
              <td class="cell-mime text-muted">${escapeHtml(f.mime_type)}</td>
              <td class="cell-time">${formatRelativeTime(f.first_seen_at)}</td>
            </tr>
          `
            )
            .join('')}
        </tbody>
      </table>
      ${
        totalPages > 1
          ? `
        <div class="pagination-bar">
          <button class="btn btn-xs btn-ghost" ${page === 0 ? 'disabled' : ''} data-prev="${page - 1}">Prev</button>
          <span>Page ${page + 1} of ${totalPages} (${total} total files)</span>
          <button class="btn btn-xs btn-ghost" ${page >= totalPages - 1 ? 'disabled' : ''} data-next="${page + 1}">Next</button>
        </div>
      `
          : ''
      }
    `;

    wrapper.querySelectorAll('button[data-prev], button[data-next]').forEach((b) => {
      b.addEventListener('click', () => {
        const targetPage = Number(b.dataset.prev || b.dataset.next);
        renderBatchFilesTable(batchId, targetPage);
      });
    });
  } catch (err) {
    wrapper.innerHTML = `<div class="error-msg">Failed to load files: ${escapeHtml(err.message || String(err))}</div>`;
  }
}

async function renderHeldItemsUI(projects, userEmail) {
  const unprovContainer = el('held-unprovisioned-list');
  const unroutedContainer = el('held-unrouted-list');

  try {
    const { unprovisioned: allUnprovisioned, unrouted } = await loadHeldItems();

    // Self-resolve: if the watcher already auto-created (or an admin already
    // provisioned) an ingestion_projects row carrying this exact drive_folder_id,
    // this "unprovisioned" disposition row is stale bookkeeping, not something
    // that needs a manual pick - there is nothing else it could correctly map
    // to. The "Map to Matter" dropdown below deliberately excludes any project
    // that already has a drive_folder_id (so you can't accidentally steal a
    // folder away from another matter), which means a self-match is otherwise
    // impossible to select and the row is a dead end forever. Reconcile it
    // automatically instead.
    const projectByFolderId = new Map(projects.filter((p) => p.drive_folder_id).map((p) => [p.drive_folder_id, p]));
    const autoResolved = allUnprovisioned.filter((f) => projectByFolderId.has(f.drive_folder_id));
    const unprovisioned = allUnprovisioned.filter((f) => !projectByFolderId.has(f.drive_folder_id));

    if (autoResolved.length > 0) {
      await Promise.all(
        autoResolved.map((f) =>
          mapUnprovisionedFolder(f.drive_folder_id, projectByFolderId.get(f.drive_folder_id).id, userEmail || 'system (auto-resolved)').catch(
            (err) => console.warn(`Auto-resolve failed for folder ${f.drive_folder_id}:`, err)
          )
        )
      );
    }

    // Render Unprovisioned Folders
    if (unprovisioned.length === 0) {
      unprovContainer.innerHTML = '<p class="empty-state-sub">No unprovisioned folders.</p>';
    } else {
      const projectOptions = projects
        .filter((p) => !p.drive_folder_id)
        .map((p) => `<option value="${p.id}">${escapeHtml(p.display_name)} (${p.slug})</option>`)
        .join('');

      unprovContainer.innerHTML = `
        <table class="data-table">
          <thead>
            <tr>
              <th>Folder Title</th>
              <th>Drive Folder ID</th>
              <th>First Seen</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            ${unprovisioned
              .map(
                (f) => `
              <tr id="unprov-row-${f.drive_folder_id}">
                <td><strong>${escapeHtml(f.title)}</strong></td>
                <td class="mono text-muted">${escapeHtml(f.drive_folder_id)}</td>
                <td>${formatRelativeTime(f.first_seen_at)}</td>
                <td class="actions-cell">
                  <div class="map-action-row">
                    <select class="select-project-map" id="map-select-${f.drive_folder_id}">
                      <option value="">-- Map to Matter --</option>
                      ${projectOptions}
                    </select>
                    <button class="btn btn-xs btn-secondary btn-do-map" data-folder="${f.drive_folder_id}">Map</button>
                    <button class="btn btn-xs btn-ghost btn-do-ignore" data-folder="${f.drive_folder_id}">Ignore</button>
                  </div>
                </td>
              </tr>
            `
              )
              .join('')}
          </tbody>
        </table>
      `;

      unprovContainer.querySelectorAll('.btn-do-map').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const folderId = btn.dataset.folder;
          const select = el(`map-select-${folderId}`);
          const projectId = select.value;
          if (!projectId) {
            alert('Please select a matter project to map this folder to.');
            return;
          }
          btn.disabled = true;
          try {
            await mapUnprovisionedFolder(folderId, projectId, userEmail);
            renderHeldItemsUI(projects, userEmail);
            renderPendingBatchesUI(userEmail);
          } catch (err) {
            alert(`Mapping failed: ${err.message || err}`);
            btn.disabled = false;
          }
        });
      });

      unprovContainer.querySelectorAll('.btn-do-ignore').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const folderId = btn.dataset.folder;
          if (!confirm('Mark this folder as ignored? Files inside will not be ingested.')) return;
          btn.disabled = true;
          try {
            await ignoreUnprovisionedFolder(folderId, userEmail);
            renderHeldItemsUI(projects, userEmail);
          } catch (err) {
            alert(`Ignore failed: ${err.message || err}`);
            btn.disabled = false;
          }
        });
      });
    }

    // Render Unrouted Loose Files
    if (unrouted.length === 0) {
      unroutedContainer.innerHTML = '<p class="empty-state-sub">No unrouted loose root files.</p>';
    } else {
      unroutedContainer.innerHTML = `
        <table class="data-table">
          <thead>
            <tr>
              <th>File Name</th>
              <th>Size</th>
              <th>MIME Type</th>
              <th>First Seen</th>
            </tr>
          </thead>
          <tbody>
            ${unrouted
              .map(
                (f) => `
              <tr>
                <td class="cell-filename">${escapeHtml(f.name)}</td>
                <td class="cell-size">${formatBytes(f.size_bytes)}</td>
                <td class="cell-mime text-muted">${escapeHtml(f.mime_type)}</td>
                <td class="cell-time">${formatRelativeTime(f.first_seen_at)}</td>
              </tr>
            `
              )
              .join('')}
          </tbody>
        </table>
      `;
    }
  } catch (err) {
    unprovContainer.innerHTML = `<div class="error-msg">Failed to load held items: ${escapeHtml(err.message || String(err))}</div>`;
  }
}

async function renderRecentExecutionsUI() {
  const container = el('approvals-executions-list');
  if (!container) return;

  try {
    const batches = await loadRecentExecutions();
    if (batches.length === 0) {
      container.innerHTML = '<p class="empty-state-sub">No recent runner executions.</p>';
      return;
    }

    container.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>Batch ID</th>
            <th>Matter</th>
            <th>Status</th>
            <th>Files</th>
            <th>Started</th>
            <th>Heartbeat / Finished</th>
            <th>Result Summary</th>
          </tr>
        </thead>
        <tbody>
          ${batches
            .map((b) => {
              const p = b.ingestion_projects || {};
              const name = p.display_name || b.kind;
              let isStalled = false;
              let heartbeatInfo = '—';

              if (b.status === 'running') {
                if (b.heartbeat_at) {
                  const ms = Date.now() - new Date(b.heartbeat_at).getTime();
                  if (ms > 30 * 60 * 1000) {
                    isStalled = true;
                  }
                  heartbeatInfo = `Heartbeat: ${formatRelativeTime(b.heartbeat_at)}`;
                } else {
                  heartbeatInfo = 'Running…';
                }
              } else if (b.finished_at) {
                heartbeatInfo = `Finished: ${formatRelativeTime(b.finished_at)}`;
              }

              const statusBadge = isStalled
                ? '<span class="badge badge-danger">STALLED (&gt;30m)</span>'
                : b.status === 'done'
                ? '<span class="badge badge-lime">DONE</span>'
                : b.status === 'failed'
                ? '<span class="badge badge-danger">FAILED</span>'
                : `<span class="badge badge-orange">${b.status.toUpperCase()}</span>`;

              const res = b.result || {};
              const summary = b.error
                ? `<span class="text-danger">${escapeHtml(b.error)}</span>`
                : res.copied_files_count != null
                ? `${res.copied_files_count} copied, ${res.ingested_files_count || 0} ingested`
                : '—';

              return `
                <tr>
                  <td class="mono" title="${b.id}">${b.id.slice(0, 8)}…</td>
                  <td><strong>${escapeHtml(name)}</strong></td>
                  <td>${statusBadge}</td>
                  <td>${b.file_count} (${formatBytes(b.total_bytes)})</td>
                  <td>${formatRelativeTime(b.started_at)}</td>
                  <td>${heartbeatInfo}</td>
                  <td>${summary}</td>
                </tr>
              `;
            })
            .join('')}
        </tbody>
      </table>
    `;
  } catch (err) {
    container.innerHTML = `<div class="error-msg">Failed to load recent executions: ${escapeHtml(err.message || String(err))}</div>`;
  }
}
