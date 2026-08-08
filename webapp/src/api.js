const TOKEN_KEY = 'anrak_token';

export class AuthError extends Error {}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

// Appends the auth token as a query param, for <audio>/<a> elements that
// can't send a custom Authorization header.
export function authedUrl(path) {
  const token = getToken();
  if (!token) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}token=${encodeURIComponent(token)}`;
}

export async function apiFetch(path, opts = {}) {
  const token = getToken();
  const headers = { ...(opts.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    setToken('');
    throw new AuthError('Session expired — please unlock again.');
  }
  return res;
}

export async function apiJson(path, opts = {}) {
  const res = await apiFetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export async function login(passphrase) {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passphrase }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || 'Invalid passphrase');
  setToken(data.token);
  return data.token;
}

export async function logout() {
  try {
    await apiFetch('/api/logout', { method: 'POST' });
  } catch {
    /* token already invalid — nothing to clean up server-side */
  }
  setToken('');
}
