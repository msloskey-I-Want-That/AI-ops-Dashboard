// Recursively lists every file inside a Drive folder, at any depth. Folders
// found in the tree are walked into (not returned as "files" themselves).
// Each file's name is its path relative to the root folder — e.g.
// "Files/LEVO/02. February/statement.xlsx" — which matches how the
// corresponding GCS objects are already named after a folder-structured
// upload, so Drive and GCS entries line up correctly even when nested.
export async function listDriveFiles(rootFolderId, accessToken) {
  const files = [];

  async function listChildren(folderId) {
    const items = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, size)',
        pageSize: '1000',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      });
      if (pageToken) params.set('pageToken', pageToken);

      const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw await googleApiError(res, 'Drive');
      const data = await res.json();
      items.push(...(data.files || []));
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    return items;
  }

  const FOLDER_MIME = 'application/vnd.google-apps.folder';

  async function walk(folderId, pathPrefix) {
    const children = await listChildren(folderId);
    const folders = children.filter((c) => c.mimeType === FOLDER_MIME);
    const leaves = children.filter((c) => c.mimeType !== FOLDER_MIME);

    for (const item of leaves) {
      files.push({
        id: item.id,
        name: pathPrefix ? `${pathPrefix}/${item.name}` : item.name,
        modifiedTime: item.modifiedTime,
        size: item.size,
      });
    }

    // Traverse subfolders in parallel for speed.
    await Promise.all(
      folders.map((folder) =>
        walk(folder.id, pathPrefix ? `${pathPrefix}/${folder.name}` : folder.name)
      )
    );
  }

  await walk(rootFolderId, '');
  return files;
}

// Lists objects in a GCS bucket (flat listing — no folder delimiter, since
// buckets here are used as flat staging areas per project).
export async function listGcsObjects(bucketName, accessToken) {
  const objects = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      fields: 'nextPageToken, items(name, size, updated)',
      maxResults: '1000',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const res = await fetch(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucketName)}/o?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw await googleApiError(res, 'Cloud Storage');
    const data = await res.json();
    objects.push(...(data.items || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return objects;
}

async function googleApiError(res, apiName) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error?.message || '';
  } catch {
    // ignore parse failure, fall back to status text
  }
  if (res.status === 401) {
    return new Error(`${apiName}: your Google session expired — sign in again to refresh it.`);
  }
  if (res.status === 403) {
    return new Error(`${apiName}: access denied${detail ? ` (${detail})` : ''}. Check you have permission on this resource.`);
  }
  if (res.status === 404) {
    return new Error(`${apiName}: not found${detail ? ` (${detail})` : ''}. Check the folder ID / bucket name is correct.`);
  }
  return new Error(`${apiName} error (${res.status})${detail ? `: ${detail}` : ''}`);
}
