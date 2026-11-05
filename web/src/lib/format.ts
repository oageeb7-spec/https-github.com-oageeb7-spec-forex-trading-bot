export const COLORS = {
  up: '#26a69a',
  down: '#ef5350',
  entry: '#3b82f6',
  tp2: '#0d9488',
  zone: '#8b93a7',
};

export function pairLabel(pair: string): string {
  const name = `${pair.slice(0, 3)}/${pair.slice(3)}`;
  if (pair === 'XAUUSD') return `${name} · Gold`;
  if (pair === 'XAGUSD') return `${name} · Silver`;
  if (pair === 'BTCUSD') return `${name} · Bitcoin`;
  return name;
}

export const isCrypto = (pair: string) => pair.startsWith('BTC');

export function decimals(pair: string): number {
  if (isCrypto(pair)) return 2;
  if (pair.startsWith('XAU')) return 2;
  if (pair.startsWith('XAG')) return 3;
  return pair.endsWith('JPY') ? 3 : 5;
}

export function price(pair: string, x: number | null | undefined): string {
  return x == null ? '-' : x.toFixed(decimals(pair));
}

export function money(x: number | null | undefined): string {
  if (x == null) return '-';
  return x.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function signedPips(x: number | null | undefined, pair = ''): string {
  if (x == null) return '-';
  const sign = x > 0 ? '+' : x < 0 ? '-' : '';
  // on crypto 1 pip = $1, so show dollars - "225 pips" on bitcoin reads wrong
  return isCrypto(pair) ? `${sign}$${Math.abs(x).toFixed(1)}` : `${sign}${Math.abs(x).toFixed(1)} pips`;
}

export function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Pull a readable message out of an API error, whatever shape the client throws. */
export function errorText(e: unknown, fallback: string): string {
  const err = e as { response?: { data?: unknown; status?: number }; message?: string };
  const data = err?.response?.data as { error?: unknown; message?: unknown } | string | undefined;
  if (typeof data === 'string' && data.trim()) return data;
  if (data && typeof data === 'object') {
    if (typeof data.error === 'string') return data.error;
    if (typeof data.message === 'string') return data.message;
  }
  return fallback;
}
