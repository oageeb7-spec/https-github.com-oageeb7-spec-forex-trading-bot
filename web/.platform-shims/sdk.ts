// LOCAL ONLY: stands in for the platform's @appdeploy/sdk (router + in-memory db).
type Ctx = { body: unknown; query: Record<string, string>; params: Record<string, string>; event: any };
type Res = { statusCode: number; headers: Record<string, string>; body: string };
type Mw = (ctx: Ctx) => Promise<Res | void> | Res | void;
export const json = (data: unknown, status = 200): Res => ({ statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
export const error = (message: string, status = 400): Res => json({ error: message }, status);
export function router(routes: Record<string, Mw[]>) {
  const table = Object.entries(routes).map(([k, mws]) => {
    const [method, path] = k.split(' ');
    const names: string[] = [];
    const re = new RegExp('^' + path.replace(/:([A-Za-z]+)/g, (_m, n) => { names.push(n); return '([^/]+)'; }) + '$');
    return { method, re, names, mws };
  });
  return async (event: { method: string; path: string; query: Record<string, string>; body: unknown }): Promise<Res> => {
    for (const r of table) {
      const m = r.re.exec(event.path);
      if (r.method !== event.method || !m) continue;
      const params: Record<string, string> = {};
      r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
      for (const mw of r.mws) {
        const out = await mw({ body: event.body, query: event.query, params, event });
        if (out) return out;
      }
    }
    return error('not found', 404);
  };
}
const tables = new Map<string, Map<string, Record<string, unknown>>>();
const t = (name: string) => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name)!; };
let seq = 0;
export const db = {
  tx: {
    async add(table: string, records: Record<string, unknown>[]) {
      return records.map((rec) => {
        const id = (rec.id as string) || `id${++seq}`;
        if (t(table).has(id)) return null;
        const { id: _drop, ...rest } = rec;
        void _drop;
        t(table).set(id, rest);
        return id;
      });
    },
  },
  async list<T = Record<string, any>>(table: string, opts: { limit?: number } = {}): Promise<{ items: Array<Omit<T, 'id'> & { id: string }>; nextToken?: string }> {
    return { items: [...t(table)].slice(0, opts.limit ?? 50).map(([id, rec]) => ({ ...rec, id })) as Array<Omit<T, 'id'> & { id: string }> };
  },
  async delete(table: string, ids: string[]) { return ids.map((id) => t(table).delete(id)); },
};
