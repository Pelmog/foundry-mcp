export function foundryUrl(base, path) {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('FOUNDRY_URL must be an HTTP(S) base URL without credentials, query or fragment');
  }
  url.pathname = url.pathname.replace(/\/$/, '') + path;
  return url.href;
}

export async function fetchFoundryStatus(base, { fetchImpl = fetch, signal } = {}) {
  const response = await fetchImpl(foundryUrl(base, '/api/status'), {
    redirect: 'error', signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error(`Foundry status HTTP ${response.status}`);
  const status = await response.json();
  if (!status || typeof status.active !== 'boolean'
      || (status.active && (typeof status.world !== 'string' || !status.world))) {
    throw new Error('Invalid Foundry /api/status response');
  }
  return status;
}
