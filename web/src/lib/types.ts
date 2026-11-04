export type Setup = {
  pair: string;
  timeframe: string;
  decision: 'trade' | 'no_trade';
  side: 'buy' | 'sell' | null;
  reasons: string[];
  price: number | null;
  lastBarTime: number | null;
  score?: { bull: number; bear: number };
  entryType?: 'market' | 'limit';
  entry?: number;
  stop?: number;
  tp1?: number;
  tp2?: number | null;
  zone?: { kind: string; low: number; high: number };
  stopPips?: number;
  tp1Pips?: number;
  tp2Pips?: number | null;
  rrTp1?: number;
  rr?: number;
  rejected?: boolean;
};

export type Clock = { open: boolean; sessions: string[]; overlap: boolean; newYork: string };

/** [time, open, high, low, close, volume] */
export type BarRow = [number, number, number, number, number, number];

export type Analysis = { setup: Setup; bars: BarRow[]; clock: Clock; analyzedAt: number };

export type Live = {
  status: string;
  price: number;
  events: string[];
  barsSince: number;
  toStopPips: number;
  toTp1Pips: number;
  toTp2Pips?: number;
  openPips?: number;
};

export type Signal = Setup & { id: string; minRR: number; createdAt: number; live: Live | null };

export type SizeResult = {
  pair: string; side: string; lots: number; units: number; unitName: string; limit: string;
  byRisk: number; byLeverage: number; pipValue: number; stopPips: number; targetPips: number | null;
  maxLoss: number; lossAtStop: number; gainAtTarget: number | null; margin: number; rewardRisk: number | null;
};

export type Level = { price: number; color: string; title: string };
