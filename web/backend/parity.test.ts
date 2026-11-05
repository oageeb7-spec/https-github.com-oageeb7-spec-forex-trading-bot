// Parity check: the TypeScript analyzer must give exactly the same answer as the
// Python setup.py on the saved real bars.
//
//   python3 web/backend/parity_ref.py > ref.json
//   npx tsx web/backend/parity.test.ts ref.json
import { readFileSync } from 'node:fs';
import { analyze, track } from './analyze';
import { Bar, merge, parseChart } from './market';

const FIX = new URL('../../.claude/skills/trader-forex/tests/fixtures/', import.meta.url);
type Ref = { pair: string; variant: string; cut: number; swing: number; minRR: number; setup: any; track: any };
const refs: Ref[] = JSON.parse(readFileSync(process.argv[2], 'utf8'));

const mirror = (bars: Bar[], m: number): Bar[] =>
  bars.map((b) => ({ t: b.t, vol: b.vol, open: m - b.open, close: m - b.close, high: m - b.low, low: m - b.high }));

const data: Record<string, Record<string, Bar[]>> = {};
for (const [pair, file, m] of [['EURUSD', 'EURUSD_15m.json', 2.24], ['XAUUSD', 'XAUUSD_15m.json', 8000], ['BTCUSD', 'BTCUSD_15m.json', 160000]] as const) {
  const bars = parseChart(JSON.parse(readFileSync(new URL(file, FIX), 'utf8')));
  data[pair] = { real: bars, mirror: mirror(bars, m), merged4: merge(bars, 4) };
}

// python snake_case -> typescript camelCase
const SETUP_KEYS: Array<[string, string]> = [
  ['decision', 'decision'], ['side', 'side'], ['reasons', 'reasons'], ['price', 'price'],
  ['last_bar_time', 'lastBarTime'], ['score', 'score'], ['entry_type', 'entryType'], ['entry', 'entry'],
  ['stop', 'stop'], ['tp1', 'tp1'], ['tp2', 'tp2'], ['zone', 'zone'], ['stop_pips', 'stopPips'],
  ['tp1_pips', 'tp1Pips'], ['tp2_pips', 'tp2Pips'], ['rr_tp1', 'rrTp1'], ['rr', 'rr'], ['atr_pips', 'atrPips'],
  ['rejected', 'rejected'],
];
const TRACK_KEYS: Array<[string, string]> = [
  ['status', 'status'], ['price', 'price'], ['events', 'events'], ['bars_since', 'barsSince'],
  ['to_stop_pips', 'toStopPips'], ['to_tp1_pips', 'toTp1Pips'], ['to_tp2_pips', 'toTp2Pips'], ['open_pips', 'openPips'],
];

const same = (a: unknown, b: unknown): boolean => {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
};

let failures = 0;
let trades = 0;
for (const ref of refs) {
  const all = data[ref.pair][ref.variant];
  const bars = ref.cut ? all.slice(0, all.length - ref.cut) : all;
  const s = analyze(ref.pair, bars, ref.swing, ref.minRR, '15m') as unknown as Record<string, unknown>;
  const label = `${ref.pair} ${ref.variant} cut=${ref.cut} swing=${ref.swing} minRR=${ref.minRR}`;
  for (const [py, ts] of SETUP_KEYS) {
    if (!same(ref.setup[py], s[ts])) {
      failures++;
      console.log(`DIFF ${label} ${py}: py=${JSON.stringify(ref.setup[py])} ts=${JSON.stringify(s[ts])}`);
    }
  }
  if (ref.track) {
    trades++;
    const t = track(s as never, all) as unknown as Record<string, unknown>;
    for (const [py, ts] of TRACK_KEYS) {
      if (!same(ref.track[py], t[ts])) {
        failures++;
        console.log(`DIFF ${label} track.${py}: py=${JSON.stringify(ref.track[py])} ts=${JSON.stringify(t[ts])}`);
      }
    }
  }
}
console.log(`${refs.length} cases, ${trades} tracked trades, ${failures} differences`);
process.exit(failures ? 1 : 0);
