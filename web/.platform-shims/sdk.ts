// LOCAL ONLY: stands in for the platform's @appdeploy/sdk so the backend runs here.
// Router, an in-memory database with the same semantics the app relies on (chosen-ID
// adds, conditional patches, increments, all-or-nothing transactions), and a stub
// ai.run that really calls every declared tool before emitting a schema-shaped result.
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

// ---------------- database ----------------
const INC = Symbol('increment');
export type IncrementValue = { [INC]: number };
export const increment = (amount: number): IncrementValue => ({ [INC]: amount });
const isInc = (v: unknown): v is IncrementValue => typeof v === 'object' && v !== null && INC in v;

class DbError extends Error {
  constructor(public code: string, msg: string) { super(msg); }
  statusCode = 409;
  details = {};
}
export function isAppDatabaseError(e: unknown): e is DbError { return e instanceof DbError; }

const tables = new Map<string, Map<string, Record<string, unknown>>>();
const t = (name: string) => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name)!; };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
let seq = 0;

type Plan = { check: () => boolean; apply: () => void };
type Op<T> = PromiseLike<T> & { plans: () => Plan[]; result: () => T };

function op<T>(plans: () => Plan[], result: () => T): Op<T> {
  let done: Promise<T> | null = null;
  const run = () => (done ??= (async () => {
    const ps = plans();
    return ps.map((p) => (p.check() ? (p.apply(), true) : false)) as unknown as T;
  })());
  return { plans, result, then: (a, b) => run().then(a, b) } as Op<T>;
}

function matches(rec: Record<string, unknown> | undefined, cond?: Record<string, unknown>) {
  if (!cond) return true;
  return Object.entries(cond).every(([k, v]) => (v === undefined ? rec?.[k] === undefined : rec?.[k] === v));
}

export const db = {
  tx: {
    add(table: string, records: Record<string, unknown>[]) {
      const ids = records.map((r) => (r.id as string) || `id${++seq}`);
      const o = op<(string | null)[]>(() => records.map((r, i) => ({
        check: () => !t(table).has(ids[i]),
        apply: () => { const { id: _drop, ...rest } = r; void _drop; t(table).set(ids[i], clone(rest)); },
      })), () => ids);
      const then = o.then.bind(o);
      (o as any).then = (a: any, b: any) => then((ok: any) => (ok as boolean[]).map((x, i) => (x ? ids[i] : null)), undefined).then(a, b);
      return o;
    },
    update(table: string, items: Array<{ id: string; record: Record<string, unknown>; if?: Record<string, unknown> }>, options: { patch?: boolean } = {}) {
      return op<boolean[]>(() => items.map((it) => ({
        check: () => {
          const cur = t(table).get(it.id);
          if (options.patch && !cur) return false;
          return matches(cur, it.if);
        },
        apply: () => {
          const cur = t(table).get(it.id) || {};
          const next: Record<string, unknown> = options.patch ? { ...cur } : {};
          for (const [k, v] of Object.entries(it.record)) {
            if (isInc(v)) next[k] = (Number(cur[k]) || 0) + v[INC];
            else if (v === undefined) delete next[k];
            else next[k] = clone(v);
          }
          t(table).set(it.id, next);
        },
      })), () => []);
    },
  },
  async transact(ops: Array<Op<unknown>>) {
    const plans = ops.flatMap((o) => o.plans());
    if (!plans.every((p) => p.check())) throw new DbError('AppDatabaseConditionFailed', 'condition failed');
    plans.forEach((p) => p.apply());
    return ops.map(() => true);
  },
  async get<T = Record<string, any>>(table: string, ids: string[], _opts?: { consistent?: boolean }): Promise<Array<T | null>> {
    return ids.map((id) => (t(table).has(id) ? (clone(t(table).get(id)) as T) : null));
  },
  async list<T = Record<string, any>>(table: string, opts: { limit?: number } = {}): Promise<{ items: Array<Omit<T, 'id'> & { id: string }>; nextToken?: string }> {
    return { items: [...t(table)].slice(0, opts.limit ?? 50).map(([id, rec]) => ({ ...rec, id })) as Array<Omit<T, 'id'> & { id: string }> };
  },
  async delete(table: string, ids: string[]) { return ids.map((id) => t(table).delete(id)); },
};

// ---------------- ai.run stub ----------------
const env = ((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env) || {};
type Tool = { name: string; description?: string; parameters?: Record<string, any> };
export type AiRunOptions = {
  prompt?: string; system?: string; tools?: Tool[]; maxSteps?: number; temperature?: number; thinkingMode?: string;
  onToolCall?: (name: string, args: Record<string, unknown>) => Promise<unknown> | unknown;
};

function fill(schema: any, key = ''): unknown {
  if (!schema) return null;
  if (schema.enum && key === 'verdict' && env.STUB_RISK) return env.STUB_RISK;
  if (schema.enum) return env.STUB_ENUM === 'last' ? schema.enum[schema.enum.length - 1] : schema.enum[0];
  switch (schema.type) {
    case 'object': return Object.fromEntries(Object.entries(schema.properties || {}).map(([k, v]) => [k, fill(v, k)]));
    case 'array': return [`(local stub) ${key} item one`, `(local stub) ${key} item two`];
    case 'boolean': return true;
    case 'integer': return 70;
    case 'number': return key.includes('account') ? 10000 : 1;
    case 'string': return `(local stub) ${key}`;
    default: return null;
  }
}

export const ai = {
  async run(opts: AiRunOptions): Promise<{ text: string; steps: number; data?: unknown }> {
    if (env.STUB_AI_DOWN) throw Object.assign(new Error('rate limited'), { statusCode: 429, responseText: 'busy' });
    let steps = 0;
    for (const tool of opts.tools || []) {
      if (tool.name === 'emit_result') continue;
      const args = fill(tool.parameters) as Record<string, unknown>;
      const out = await opts.onToolCall?.(tool.name, args);
      if (out && typeof out === 'object' && 'error' in (out as object)) throw new Error(`tool ${tool.name} failed: ${JSON.stringify(out)}`);
      steps++;
    }
    const emit = (opts.tools || []).find((x) => x.name === 'emit_result');
    // simulate a model that runs out of steps after using its tools, without reporting
    if (env.STUB_NO_EMIT && steps > 0) return { text: 'ran out of steps', steps: opts.maxSteps ?? steps };
    return { text: 'local stub', steps: steps + 1, data: emit ? fill(emit.parameters) : undefined };
  },
};

// ---------------- secrets ----------------
// STUB_TG=1 pretends a Telegram bot token was stored (the local server answers api.telegram.org).
export const secrets = {
  async listSecretNames() { return env.STUB_TG ? ['TELEGRAM_BOT_TOKEN'] : []; },
  async readSecret(name: string) {
    if (name === 'TELEGRAM_BOT_TOKEN' && env.STUB_TG) return 'LOCAL_TEST_TOKEN';
    throw new Error(`secret ${name} is not set`);
  },
};
