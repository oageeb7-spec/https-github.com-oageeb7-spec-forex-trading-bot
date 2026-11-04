// LOCAL ONLY: stands in for the platform's @appdeploy/client so the app can run here.
async function call(method: string, url: string, data?: unknown) {
  const r = await fetch(url, {
    method,
    headers: data !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: data !== undefined && method !== 'GET' ? JSON.stringify(data) : undefined,
  });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { response: { status: r.status, data: body } });
  return { data: body };
}
export const api = {
  get: (url: string) => call('GET', url),
  post: (url: string, data?: unknown) => call('POST', url, data),
  put: (url: string, data?: unknown) => call('PUT', url, data),
  delete: (url: string) => call('DELETE', url),
};
