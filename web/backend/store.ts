// Small bounded documents in the app database, updated with optimistic concurrency
// (a version field `v` checked at commit), so the scanner cron and user requests can
// write at the same time without losing each other's changes.
import { db, increment, isAppDatabaseError } from '@appdeploy/sdk';

export const META = 'meta';
export const SIGNALS = 'signals';
export const REVIEWS = 'reviews';

const INDEX_MAX = 60;
const FEED_MAX = 40;

export async function getDoc<T>(table: string, id: string): Promise<T | null> {
  const [doc] = await db.get<T>(table, [id], { consistent: true });
  return doc;
}

/** Read-modify-write a document; retries when another writer got there first. */
export async function updateDoc<T extends Record<string, unknown>>(
  table: string, id: string, init: T, mutate: (cur: T) => T,
): Promise<T> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const cur = await getDoc<T & { v: number }>(table, id);
    if (!cur) {
      const next = mutate(init);
      const [created] = await db.tx.add(table, [{ ...next, id, v: 1 }]);
      if (created) return next;
      continue;
    }
    const { v, ...rest } = cur;
    const next = mutate(rest as unknown as T);
    const [ok] = await db.tx.update(table, [{ id, record: { ...next, v: v + 1 }, if: { v } }], { patch: true });
    if (ok) return next;
  }
  throw new Error(`The database is busy (${table}/${id}); please try again.`);
}

// ---- signal index: newest first, bounded; dropped records are deleted ----

type Index = { ids: string[] };

export async function indexAdd(id: string): Promise<void> {
  let dropped: string[] = [];
  await updateDoc<Index>(META, 'index', { ids: [] }, (cur) => {
    const ids = [id, ...cur.ids.filter((x) => x !== id)];
    dropped = ids.slice(INDEX_MAX);
    return { ids: ids.slice(0, INDEX_MAX) };
  });
  if (dropped.length) await db.delete(SIGNALS, dropped);
}

export async function indexRemove(id: string): Promise<void> {
  await indexRemoveMany([id]);
}

export async function indexRemoveMany(gone: string[]): Promise<void> {
  const drop = new Set(gone);
  await updateDoc<Index>(META, 'index', { ids: [] }, (cur) => ({ ids: cur.ids.filter((x) => !drop.has(x)) }));
}

export async function indexIds(): Promise<string[]> {
  return (await getDoc<Index>(META, 'index'))?.ids ?? [];
}

// ---- agent activity feed ----

export type FeedEvent = {
  at: number;
  agent: 'scanner' | 'analyst' | 'risk' | 'head' | 'tracker' | 'desk';
  text: string;
  pair?: string;
  tf?: string;
  tone?: 'good' | 'bad' | 'info' | 'warn';
};

type Feed = { items: FeedEvent[] };

export async function feedAdd(events: FeedEvent[]): Promise<void> {
  if (!events.length) return;
  await updateDoc<Feed>(META, 'feed', { items: [] }, (cur) => ({
    items: [...events.slice().reverse(), ...cur.items].slice(0, FEED_MAX),
  }));
}

export async function feedList(): Promise<FeedEvent[]> {
  return (await getDoc<Feed>(META, 'feed'))?.items ?? [];
}

// ---- forward-test stats: only ever incremented, together with closing a signal ----

export type Stats = {
  closed: number; targetHit: number; stopped: number; stoppedAfterTp1: number; missed: number; rSum: number;
};

export const EMPTY_STATS: Stats = { closed: 0, targetHit: 0, stopped: 0, stoppedAfterTp1: 0, missed: 0, rSum: 0 };

/** Close a signal and count it in the stats atomically; a signal can only be closed once. */
export async function closeSignal(id: string, outcome: string, realizedR: number): Promise<boolean> {
  await db.tx.add(META, [{ id: 'stats', ...EMPTY_STATS }]);   // null if it already exists
  const counts: Record<string, ReturnType<typeof increment>> = {};
  if (outcome === 'missed') {
    counts.missed = increment(1);
  } else {
    counts.closed = increment(1);
    counts.rSum = increment(realizedR);
    if (outcome === 'target hit') counts.targetHit = increment(1);
    else if (outcome === 'stopped') counts.stopped = increment(1);
    else counts.stoppedAfterTp1 = increment(1);
  }
  const mark = db.tx.update(SIGNALS, [{
    id, record: { outcome, realizedR, closedAt: Date.now() }, if: { outcome: undefined },
  }], { patch: true });
  const count = db.tx.update(META, [{ id: 'stats', record: counts }], { patch: true });
  try {
    await db.transact([mark, count]);
    return true;
  } catch (e) {
    if (isAppDatabaseError(e) && e.code === 'AppDatabaseConditionFailed') return false;   // already closed
    throw e;
  }
}

export async function stats(): Promise<Stats> {
  const s = await getDoc<Stats>(META, 'stats');
  return { ...EMPTY_STATS, ...(s || {}) };
}

// ---- simple hourly budget for AI agent runs ----

export async function takeAgentBudget(cap: number): Promise<{ ok: boolean; used: number }> {
  const hour = new Date().toISOString().slice(0, 13).replace(/[-T]/g, '');
  const id = `budget_${hour}`;
  await db.tx.add(META, [{ id, used: 0 }]);
  const doc = await getDoc<{ used: number }>(META, id);
  const used = doc?.used ?? 0;
  if (used >= cap) return { ok: false, used };
  await db.tx.update(META, [{ id, record: { used: increment(1) } }], { patch: true });
  return { ok: true, used: used + 1 };
}

export async function budgetUsed(): Promise<number> {
  const hour = new Date().toISOString().slice(0, 13).replace(/[-T]/g, '');
  return (await getDoc<{ used: number }>(META, `budget_${hour}`))?.used ?? 0;
}
