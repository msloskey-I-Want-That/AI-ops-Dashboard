import { supabase } from './supabase-client.js';
import { GOOGLE_OAUTH_SCOPES } from './config.js';

// IMPORTANT: Supabase only hands back the Google OAuth access token
// (`provider_token`) once, on the SIGNED_IN event immediately after the
// OAuth redirect. It is never persisted across page reloads (by design —
// Supabase doesn't store third-party provider tokens). We cache it in
// sessionStorage so a reload within the same tab doesn't force a re-login,
// but it will still expire (~1hr, Google's normal access token lifetime) and
// a fresh sign-in will be needed periodically to sync Drive/GCS again.
const GOOGLE_TOKEN_KEY = 'aiops_google_token';
const GOOGLE_TOKEN_EXPIRY_KEY = 'aiops_google_token_expiry';

export function getCachedGoogleToken() {
  const token = sessionStorage.getItem(GOOGLE_TOKEN_KEY);
  const expiry = Number(sessionStorage.getItem(GOOGLE_TOKEN_EXPIRY_KEY) || 0);
  if (!token || Date.now() > expiry) return null;
  return token;
}

function cacheGoogleToken(token, expiresInSec) {
  if (!token) return;
  sessionStorage.setItem(GOOGLE_TOKEN_KEY, token);
  sessionStorage.setItem(GOOGLE_TOKEN_EXPIRY_KEY, String(Date.now() + (expiresInSec || 3600) * 1000));
}

export function clearGoogleToken() {
  sessionStorage.removeItem(GOOGLE_TOKEN_KEY);
  sessionStorage.removeItem(GOOGLE_TOKEN_EXPIRY_KEY);
}

export async function signInWithGoogle() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      scopes: GOOGLE_OAUTH_SCOPES,
      redirectTo: window.location.origin + window.location.pathname,
      queryParams: { access_type: 'offline', prompt: 'consent' },
    },
  });
  if (error) throw error;
}

export async function signOut() {
  clearGoogleToken();
  await supabase.auth.signOut();
}

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

// Call once at app startup. Listens for the SIGNED_IN event that carries the
// Google provider_token, and for sign-outs, so the rest of the app can react.
export function onAuthChange(callback) {
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN' && session?.provider_token) {
      // Supabase doesn't surface the Google token's actual expiry, so we
      // assume Google's standard 1hr access token lifetime.
      cacheGoogleToken(session.provider_token, 3600);
    }
    if (event === 'SIGNED_OUT') {
      clearGoogleToken();
    }
    callback(event, session);
  });
}
