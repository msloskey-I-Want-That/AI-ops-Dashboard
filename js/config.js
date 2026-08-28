// Public config — safe to expose client-side.
// The Supabase anon key is not a secret; access is controlled by Row Level Security.
export const SUPABASE_URL = 'https://izgkopvrwhetqaomejns.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_6BPbiblpkNBAl-F5IvBBwA_D8Q_1adT';

// Google OAuth scopes requested at sign-in. Read-only by design — this app never
// writes to Drive or GCS, it only lists files to compare against Supabase state.
export const GOOGLE_OAUTH_SCOPES =
  'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/devstorage.read_only';
