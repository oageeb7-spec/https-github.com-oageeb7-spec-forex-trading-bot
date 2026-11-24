#!/usr/bin/env python3
"""Tests for strategies.py, including OpenTrader's own grid test cases. Run: python3 test_strategies.py"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import strategies as st  # noqa: E402


def bars_from(closes, spread=0.0):
    return [{"date": f"d{i:04}", "open": c, "high": c + spread, "low": c - spread, "close": c}
            for i, c in enumerate(closes)]


class GridTest(unittest.TestCase):
    def test_opentrader_mock(self):
        # packages/tools/src/mocks/grid-bot.ts: lines 10..20 step 2, price 14.5
        lv = st.grid_levels([10, 12, 14, 16, 18, 20], 14.5)
        self.assertEqual([(x["buy"], x["sell"]) for x in lv], [(10, 12), (12, 14), (14, 16), (16, 18), (18, 20)])
        self.assertEqual([x["filled"] for x in lv], [False, False, True, True, True])

    def test_opentrader_eth_case(self):
        lines = st.grid_lines(2500, 2800, 16)
        lv = st.grid_levels(lines, 2610)
        self.assertEqual(len(lv), 15)
        self.assertEqual([round(x["buy"]) for x in lv if not x["filled"]], [2500, 2520, 2540, 2560, 2580, 2600])

    def test_opentrader_near_case(self):
        lv = st.grid_levels(st.grid_lines(7.5, 12, 10), 9.8)
        self.assertEqual([x["buy"] for x in lv if not x["filled"]], [7.5, 8, 8.5, 9, 9.5])

    def test_nearest_line_tie_goes_up(self):
        lv = st.grid_levels([1.0, 1.1, 1.2], 1.15)  # equidistant: the line above is the waiting one
        self.assertEqual([x["filled"] for x in lv], [False, False])

    def test_backtest_round_trip(self):
        lines = [1.0, 1.1, 1.2]
        # start 1.13: level 1.1->1.2 is bought at the start price; bars gap, so fills are at the open
        r = st.grid_backtest("EURUSD", bars_from([1.13, 1.05, 0.99, 1.12, 1.21]), lines, 1)
        self.assertEqual(r["rounds"], 2)
        self.assertAlmostEqual(r["realized"], (1.12 - 0.99) + (1.21 - 1.13))
        self.assertEqual(r["open_now"], 0)

    def test_no_rebuy_in_the_bar_it_sold(self):
        bars = [{"date": "a", "open": 1.0, "high": 1.0, "low": 1.0, "close": 1.0},
                {"date": "b", "open": 1.02, "high": 1.11, "low": 0.95, "close": 1.0}]
        r = st.grid_backtest("EURUSD", bars, [1.0, 1.1], 1)
        self.assertEqual(r["rounds"], 1)
        self.assertEqual(r["open_now"], 0)


class DcaTest(unittest.TestCase):
    def test_ladder_average_and_tp(self):
        rows = st.dca_ladder(100.0, 1, 1, 1.0, 5.0, [(1.0, 1), (2.0, 2)])
        self.assertAlmostEqual(rows[1]["avg"], (100 + 99) / 2)
        self.assertAlmostEqual(rows[2]["avg"], (100 + 99 + 2 * 98) / 4)
        self.assertAlmostEqual(rows[2]["tp"], rows[2]["avg"] * 1.01)

    def test_sell_side_mirrors(self):
        rows = st.dca_ladder(100.0, 1, -1, 1.0, None, [(1.0, 1)])
        self.assertAlmostEqual(rows[1]["price"], 101.0)
        self.assertAlmostEqual(rows[1]["tp"], 100.5 * 0.99)

    def test_stop_must_be_beyond_safety(self):
        with self.assertRaises(st.FxError):
            st.dca_ladder(100.0, 1, 1, 1.0, 1.5, [(2.0, 1)])

    def test_backtest_safety_then_target(self):
        # entry 100, safety at 99 fills, then the TP at avg 99.5 * 1.01 is reached
        r = st.dca_backtest("XAUUSD", bars_from([100, 99, 101, 101]), 1, 1, 1.0, None, [(1.0, 1)], None, 14)
        self.assertEqual(r["trades"][0]["why"], "target")
        self.assertEqual(r["trades"][0]["fills"], 1)

    def test_backtest_stop(self):
        r = st.dca_backtest("XAUUSD", bars_from([100, 94, 94]), 1, 1, 1.0, 5.0, [], None, 14)
        self.assertEqual(r["trades"][0]["why"], "stop")
        self.assertAlmostEqual(r["realized"], -5.0)


class RsiTest(unittest.TestCase):
    def test_persistence_and_single_advice(self):
        closes = [100 - i for i in range(20)] + [80 + 2 * i for i in range(20)]
        sigs = st.rsi_signals(closes, 14, 30, 70, 2)
        self.assertEqual(sigs.count("buy"), 1)
        self.assertEqual(sigs.count("sell"), 1)
        # with persistence 2 the buy comes on the 2nd candle below 30, not the first
        rs = st.rsi_series(closes, 14)
        first_low = next(i for i, r in enumerate(rs) if r is not None and r < 30)
        self.assertEqual(sigs.index("buy"), first_low + 1)

    def test_series_matches_fx_rsi(self):
        closes = [1 + (i % 7) * 0.01 - (i % 3) * 0.004 for i in range(60)]
        self.assertAlmostEqual(st.rsi_series(closes, 14)[-1], st.fx.rsi(closes, 14))

    def test_backtest_modes(self):
        closes = [100 - i for i in range(20)] + [80 + 2 * i for i in range(20)] + [118 - 2 * i for i in range(20)]
        long = st.rsi_backtest("EURUSD", bars_from(closes), 14, 30, 70, 1, "long")
        both = st.rsi_backtest("EURUSD", bars_from(closes), 14, 30, 70, 1, "both")
        self.assertTrue(all(t["side"] == "buy" for t in long["trades"]))
        self.assertGreaterEqual(len(both["trades"]) + (1 if both["open"] else 0), len(long["trades"]))


if __name__ == "__main__":
    unittest.main()
