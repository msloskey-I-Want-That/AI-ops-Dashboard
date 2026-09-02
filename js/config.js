// Public config — safe to expose client-side.
// The Supabase anon key is not a secret; access is controlled by Row Level Security.
export const SUPABASE_URL = 'https://izgkopvrwhetqaomejns.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_6BPbiblpkNBAl-F5IvBBwA_D8Q_1adT';

// Google OAuth scopes requested at sign-in. Drive stays read-only — this app
// never writes to Drive. Cloud Storage is read-write: Sync can now copy
// Drive-only files into GCS automatically, in addition to just reading.
export const GOOGLE_OAUTH_SCOPES =
  'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/devstorage.read_write';
