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

export type Analysis = { setup: Setup; bars: BarRow[]; clock: Clock; analyzedAt: number; review: DeskReview | null };

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

export type Signal = Setup & {
  id: string; minRR: number; createdAt: number; live: Live | null;
  source?: 'manual' | 'scanner'; outcome?: string; realizedR?: number; closedAt?: number;
  desk: { final: 'take' | 'skip'; confidence: number } | null;
};

export type SizeResult = {
  pair: string; side: string; lots: number; units: number; unitName: string; limit: string;
  byRisk: number; byLeverage: number; pipValue: number; stopPips: number; targetPips: number | null;
  maxLoss: number; lossAtStop: number; gainAtTarget: number | null; margin: number; rewardRisk: number | null;
};

export type Level = { price: number; color: string; title: string };

export type ToolCall = { name: string; args: string };

export type AgentReport = {
  agent: 'analyst' | 'risk' | 'head';
  title: string;
  status: 'done' | 'skipped' | 'failed';
  verdict: string;
  confidence: number | null;
  points: string[];
  concerns: string[];
  tools: ToolCall[];
  ms: number;
};

export type DeskReview = {
  id: string;
  pair: string;
  timeframe: string;
  analyst: AgentReport;
  risk: AgentReport;
  head: AgentReport;
  final: 'take' | 'skip';
  confidence: number;
  summary: string;
  guardrails: string[];
  createdAt: number;
};

export type FeedEvent = {
  at: number;
  agent: 'scanner' | 'analyst' | 'risk' | 'head' | 'tracker' | 'desk';
  text: string;
  pair?: string;
  tf?: string;
  tone?: 'good' | 'bad' | 'info' | 'warn';
};

export type ScannerDoc = {
  lastRun: number; trigger: string; scanned: number; found: number; reviewed: number; closed: number;
  errors: number; note: string; ms: number; setups: string[];
};

export type Meta = {
  pairs: string[]; timeframes: string[]; clock: Clock; scanner: ScannerDoc | null;
  watchlist: string[]; scanTimeframes: string[]; agentBudget: { used: number; cap: number };
};

export type Performance = {
  closed: number; targetHit: number; stopped: number; stoppedAfterTp1: number; missed: number; rSum: number;
  winRate: number | null; avgR: number | null; note: string;
};
