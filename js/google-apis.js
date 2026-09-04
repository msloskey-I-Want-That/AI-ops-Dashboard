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
        fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, createdTime, size)',
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
        createdTime: item.createdTime,
        size: item.size,
        mimeType: item.mimeType,
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

const GOOGLE_NATIVE_MIME_PREFIX = 'application/vnd.google-apps.';

// Downloads a regular (non-Google-native) Drive file's raw content. Google
// Docs/Sheets/Slides have no raw bytes to download this way — callers should
// check mimeType and skip those (or export them, a separate feature) before
// calling this.
export async function downloadDriveFile(fileId, accessToken) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw await googleApiError(res, 'Drive download');
  return res.blob();
}

export function isGoogleNativeFile(mimeType) {
  return typeof mimeType === 'string' && mimeType.startsWith(GOOGLE_NATIVE_MIME_PREFIX);
}

// Uploads a file to GCS, but only if no object already exists at that name
// (ifGenerationMatch=0 makes this atomic and race-condition-safe — the
// upload itself fails with 412 rather than needing a separate existence
// check first). Returns 'uploaded' or 'skipped-exists'.
export async function uploadToGcsIfAbsent(bucketName, objectName, blob, contentType, accessToken) {
  const params = new URLSearchParams({
    uploadType: 'media',
    name: objectName,
    ifGenerationMatch: '0',
  });
  const res = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucketName)}/o?${params}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': contentType || 'application/octet-stream',
    },
    body: blob,
  });
  if (res.status === 412) return 'skipped-exists';
  if (!res.ok) throw await googleApiError(res, 'Cloud Storage upload');
  return 'uploaded';
}

// Downloads a single object's raw bytes from GCS.
export async function downloadFromGcs(bucketName, objectName, accessToken) {
  const res = await fetch(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucketName)}/o/${encodeURIComponent(objectName)}?alt=media`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw await googleApiError(res, 'Cloud Storage download');
  return res.blob();
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
    const err = new Error(`${apiName}: your Google session expired — sign in again to refresh it.`);
    err.isGoogleAuthError = true;
    return err;
  }
  if (res.status === 403) {
    const err = new Error(
      `${apiName}: access denied${detail ? ` (${detail})` : ''}. This can mean you don't have permission on this resource, or — if this just started happening — your Google session predates a permission change and needs to be refreshed. Try Reconnect Google.`
    );
    err.isGoogleAuthError = true;
    return err;
  }
  if (res.status === 404) {
    return new Error(`${apiName}: not found${detail ? ` (${detail})` : ''}. Check the folder ID / bucket name is correct.`);
  }
  return new Error(`${apiName} error (${res.status})${detail ? `: ${detail}` : ''}`);
}
