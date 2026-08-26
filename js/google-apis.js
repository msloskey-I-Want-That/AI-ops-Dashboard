// Lists files directly inside a Drive folder (non-recursive — one level deep,
// matching the "one shared folder per project" pattern).
export async function listDriveFiles(folderId, accessToken) {
  const files = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, modifiedTime, size)',
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
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);

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
