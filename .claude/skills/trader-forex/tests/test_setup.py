"""Tests for setup.py. Standard library only, no network.

Run:  python3 -m unittest discover -s .claude/skills/trader-forex/tests -v

fixtures/EURUSD_15m.json is real Yahoo data (EURUSD=X, 15-minute bars, 5 days)
saved so the results are reproducible.
"""
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import setup  # noqa: E402

FIX = os.path.join(HERE, "fixtures", "EURUSD_15m.json")


def read_fix():
    with open(FIX) as f:
        return f.read()


def real_bars():
    return setup.parse_chart(read_fix())


def mirror(bars):
    """Flip prices around a level: a bearish chart becomes the same chart bullish."""
    m = 2 * 1.12
    return [{"t": b["t"], "open": m - b["open"], "close": m - b["close"],
             "high": m - b["low"], "low": m - b["high"]} for b in bars]


def bar(t, o, h, l, c):
    return {"t": t, "open": o, "high": h, "low": l, "close": c}


class RealDataTest(unittest.TestCase):
    def test_parse_skips_null_bars(self):
        bars = real_bars()
        raw = json.loads(read_fix())["chart"]["result"][0]["timestamp"]
        self.assertLess(len(bars), len(raw))           # Yahoo's weekend nulls are dropped
        self.assertTrue(all(b["low"] <= b["close"] <= b["high"] for b in bars))
        self.assertEqual(bars, sorted(bars, key=lambda b: b["t"]))

    def test_default_minimum_rejects_low_reward(self):
        s = setup.analyze("EURUSD", real_bars(), 3, 2.0, "15m")
        self.assertEqual(s["decision"], "no_trade")
        self.assertEqual(s["side"], "sell")
        self.assertTrue(s["rejected"])
        self.assertAlmostEqual(s["rr"], 1.61, places=2)   # 151 / 94 pips, from the shown prices
        self.assertIn("under the 2 minimum", s["reasons"][-1])

    def test_sell_levels_are_ordered_and_reasoned(self):
        s = setup.analyze("EURUSD", real_bars(), 3, 1.5, "15m")
        self.assertEqual(s["decision"], "trade")
        self.assertEqual(s["side"], "sell")
        self.assertGreater(s["stop"], s["entry"])
        self.assertGreater(s["entry"], s["tp1"])
        self.assertGreater(s["tp1"], s["tp2"])
        self.assertEqual((s["entry"], s["stop"], s["tp1"], s["tp2"]),
                         (1.12334, 1.12428, 1.12271, 1.12183))
        risk = s["stop"] - s["entry"]
        self.assertAlmostEqual(s["rr"], (s["entry"] - s["tp2"]) / risk, places=1)
        self.assertAlmostEqual(s["stop_pips"], risk / 0.0001, places=0)
        text = " ".join(s["reasons"])
        for word in ("Break of structure", "liquidity", "premium", "fair-value gap", "TP1", "TP2"):
            self.assertIn(word, text)

    def test_mirrored_chart_gives_mirrored_buy(self):
        sell = setup.analyze("EURUSD", real_bars(), 3, 1.5, "15m")
        buy = setup.analyze("EURUSD", mirror(real_bars()), 3, 1.5, "15m")
        self.assertEqual(buy["decision"], "trade")
        self.assertEqual(buy["side"], "buy")
        self.assertLess(buy["stop"], buy["entry"])
        self.assertLess(buy["entry"], buy["tp1"])
        self.assertLess(buy["tp1"], buy["tp2"])
        self.assertAlmostEqual(buy["rr"], sell["rr"], places=1)
        self.assertAlmostEqual(buy["stop_pips"], sell["stop_pips"], delta=0.2)
        self.assertIn("discount", " ".join(buy["reasons"]))

    def test_plan_has_what_fx_size_reads(self):
        s = setup.analyze("EURUSD", real_bars(), 3, 1.5, "15m")
        plan = setup.to_plan(s)
        for k in ("pair", "side", "entry", "stop", "target", "stop_pips", "target_pips", "reward_risk"):
            self.assertIn(k, plan)
        self.assertEqual(plan["target"], s["tp2"])
        self.assertEqual(plan["tp1"], s["tp1"])

    def test_real_gold_failed_zone_is_no_trade(self):
        with open(os.path.join(HERE, "fixtures", "XAUUSD_15m.json")) as f:
            bars = setup.parse_chart(f.read())   # real GC=F 15-minute bars
        s = setup.analyze("XAUUSD", bars, 3, 2.0, "15m")
        self.assertEqual(s["decision"], "no_trade")
        self.assertGreater(s["score"]["bear"], s["score"]["bull"])
        self.assertIn("zone has failed", s["reasons"][-1])

    def test_gold_uses_gold_pips(self):
        gold = [{k: (v * 3600 if k != "t" else v) for k, v in b.items()} for b in real_bars()]
        s = setup.analyze("XAUUSD", gold, 3, 1.5, "15m")
        self.assertIn(s["decision"], ("trade", "no_trade"))
        if s.get("stop") is not None:
            self.assertAlmostEqual(s["stop_pips"], abs(s["stop"] - s["entry"]) / 0.1, delta=0.2)
            self.assertGreaterEqual(s["stop_pips"], 20)   # 20-pip ($2) minimum stop on gold


class NoTradeTest(unittest.TestCase):
    def test_short_history(self):
        s = setup.analyze("EURUSD", real_bars()[:20], 3, 2.0, "15m")
        self.assertEqual(s["decision"], "no_trade")
        self.assertIn("not enough history", s["reasons"][0])

    def test_flat_market_has_no_edge(self):
        bars = [bar(1000 + i * 900, 1.1, 1.1002, 1.0998, 1.1) for i in range(120)]
        s = setup.analyze("EURUSD", bars, 3, 2.0, "15m")
        self.assertEqual(s["decision"], "no_trade")
        self.assertIsNone(s["side"])


class MergeTest(unittest.TestCase):
    def test_hourly_to_4h(self):
        base = 4 * 3600 * 100   # on a 4h boundary
        hours = [bar(base + i * 3600, 1 + i, 2 + i, 0.5 + i, 1.5 + i) for i in range(8)]
        m = setup.merge(hours, 4)
        self.assertEqual(len(m), 2)
        self.assertEqual((m[0]["open"], m[0]["high"], m[0]["low"], m[0]["close"]), (1, 5, 0.5, 4.5))
        self.assertEqual((m[1]["open"], m[1]["high"], m[1]["low"], m[1]["close"]), (5, 9, 4.5, 8.5))
        self.assertEqual(m[1]["t"], base + 4 * 3600)


class TrackTest(unittest.TestCase):
    SELL = {"pair": "EURUSD", "side": "sell", "entry_type": "market", "entry": 1.1230,
            "stop": 1.1240, "tp1": 1.1220, "tp2": 1.1210, "last_bar_time": 0}

    def run_track(self, s, path):
        bars = [bar(900 * (i + 1), p, h, l, p) for i, (p, h, l) in enumerate(path)]
        return setup.track(s, bars)

    def test_both_targets(self):
        t = self.run_track(self.SELL, [(1.1228, 1.1231, 1.1225), (1.1219, 1.1226, 1.1218),
                                       (1.1209, 1.1219, 1.1208)])
        self.assertEqual(t["status"], "target hit")
        self.assertEqual(len(t["events"]), 2)   # TP1, then TP2

    def test_stopped(self):
        t = self.run_track(self.SELL, [(1.1236, 1.1241, 1.1229)])
        self.assertEqual(t["status"], "stopped")

    def test_stop_wins_a_bar_that_hits_both(self):
        t = self.run_track(self.SELL, [(1.1230, 1.1241, 1.1209)])
        self.assertEqual(t["status"], "stopped")

    def test_tp1_then_stop(self):
        t = self.run_track(self.SELL, [(1.1219, 1.1229, 1.1219), (1.1239, 1.1241, 1.1222)])
        self.assertEqual(t["status"], "stopped after TP1")

    def test_open_pips(self):
        t = self.run_track(self.SELL, [(1.1225, 1.1229, 1.1224)])
        self.assertEqual(t["status"], "open")
        self.assertAlmostEqual(t["open_pips"], 5.0, places=1)
        self.assertAlmostEqual(t["to_tp1_pips"], 5.0, places=1)
        self.assertAlmostEqual(t["to_stop_pips"], 15.0, places=1)   # distance to the stop is positive

    def test_flat_price_is_zero_not_minus_zero(self):
        t = self.run_track(self.SELL, [(1.1230, 1.1231, 1.1229)])
        self.assertEqual(f"{t['open_pips']:+}", "+0.0")

    def test_buy_distances(self):
        buy = {"pair": "EURUSD", "side": "buy", "entry_type": "market", "entry": 1.1230,
               "stop": 1.1220, "tp1": 1.1240, "tp2": 1.1250, "last_bar_time": 0}
        t = self.run_track(buy, [(1.1235, 1.1236, 1.1231)])
        self.assertEqual(t["status"], "open")
        self.assertAlmostEqual(t["open_pips"], 5.0, places=1)
        self.assertAlmostEqual(t["to_stop_pips"], 15.0, places=1)
        self.assertAlmostEqual(t["to_tp2_pips"], 15.0, places=1)

    def test_reported_pips_match_the_shown_prices(self):
        s = setup.analyze("EURUSD", real_bars(), 3, 1.5, "15m")
        self.assertAlmostEqual(s["stop_pips"], round(abs(s["stop"] - s["entry"]) / 0.0001, 1), places=6)
        self.assertAlmostEqual(s["tp1_pips"], round(abs(s["tp1"] - s["entry"]) / 0.0001, 1), places=6)

    def test_limit_pending_then_missed(self):
        s = dict(self.SELL, entry_type="limit", entry=1.1235, stop=1.1245)
        t = self.run_track(s, [(1.1228, 1.1232, 1.1226)])
        self.assertEqual(t["status"], "pending")
        self.assertNotIn("open_pips", t)
        t = self.run_track(s, [(1.1228, 1.1232, 1.1226), (1.1219, 1.1231, 1.1218)])
        self.assertEqual(t["status"], "missed")

    def test_limit_fills_then_wins(self):
        s = dict(self.SELL, entry_type="limit", entry=1.1235, stop=1.1245)
        t = self.run_track(s, [(1.1234, 1.1236, 1.1231), (1.1209, 1.1233, 1.1208)])
        self.assertEqual(t["status"], "target hit")
        self.assertIn("entry filled", t["events"][0])

    def test_only_bars_after_the_setup_count(self):
        s = dict(self.SELL, last_bar_time=900)
        t = self.run_track(s, [(1.1239, 1.1241, 1.1230), (1.1225, 1.1229, 1.1224)])
        self.assertEqual(t["status"], "open")   # the stop-touching bar 1 was before the setup
        self.assertEqual(t["bars_since"], 1)


class BitcoinTest(unittest.TestCase):
    """BTCUSD on real Yahoo BTC-USD 15-minute bars (fixtures/BTCUSD_15m.json)."""

    def bars(self):
        with open(os.path.join(HERE, "fixtures", "BTCUSD_15m.json")) as f:
            return setup.parse_chart(f.read())

    def test_pair_names_and_pip_maths(self):
        from fx import FxError, contract, decimals, norm_pair, pip_size
        for raw in ("BTCUSD", "btc/usd", "bitcoin", "BTC", "XBTUSD"):
            self.assertEqual(norm_pair(raw), "BTCUSD")
        with self.assertRaises(FxError):
            norm_pair("BTCEUR")                     # crypto is USD-quoted only
        self.assertEqual((pip_size("BTCUSD"), decimals("BTCUSD"), contract("BTCUSD")), (1.0, 2, 1))
        self.assertEqual(setup.yahoo_symbol("BTCUSD"), "BTC-USD")

    def test_real_btc_sell_limit(self):
        s = setup.analyze("BTCUSD", self.bars(), 3, 2.0, "15m")
        self.assertEqual((s["decision"], s["side"], s["entry_type"]), ("trade", "sell", "limit"))
        self.assertGreater(s["stop"], s["entry"])
        self.assertGreater(s["entry"], s["price"])  # a sell limit waits above price
        self.assertGreater(s["entry"], s["tp1"])
        self.assertGreater(s["tp1"], s["tp2"])
        self.assertEqual((s["entry"], s["stop"], s["tp1"], s["tp2"]), (80431.29, 80656.9, 80146.98, 79856.55))
        self.assertAlmostEqual(s["stop_pips"], s["stop"] - s["entry"], places=1)   # 1 pip = $1
        self.assertAlmostEqual(s["rr"], 2.55, places=2)

    def test_exact_halves_round_away_from_zero_like_the_web_app(self):
        # 295.25 is exact in binary; Python's round() would give 295.2, JavaScript 295.3
        self.assertEqual(setup.rnd(295.25, 1), 295.3)
        self.assertEqual(setup.rnd(-295.25, 1), -295.3)
        self.assertEqual(setup.rnd(0.15, 1), 0.1)      # 0.15 is really 0.1499..., so no tie
        self.assertEqual(setup.rnd(1.123345, 5), round(1.123345, 5))

    def test_crypto_minimum_stop_scales_with_price(self):
        self.assertAlmostEqual(setup.min_stop_distance("BTCUSD", 80000.0), 80.0)       # 0.1%
        self.assertAlmostEqual(setup.min_stop_distance("BTCUSD", 80001.0), 81.0)       # rounded up to a whole pip
        self.assertAlmostEqual(setup.min_stop_distance("EURUSD", 1.1), 0.0005)
        self.assertAlmostEqual(setup.min_stop_distance("XAUUSD", 4000.0), 2.0)


if __name__ == "__main__":
    unittest.main()
