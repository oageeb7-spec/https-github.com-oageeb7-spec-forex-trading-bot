"""Reference outputs from the Python setup.py, for web/backend/parity.test.ts."""
import json, os, sys
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SK = os.path.join(ROOT, ".claude", "skills", "trader-forex")
sys.path.insert(0, SK)
import setup  # noqa: E402

def mirror(bars, m):
    return [{"t": b["t"], "open": m - b["open"], "close": m - b["close"],
             "high": m - b["low"], "low": m - b["high"]} for b in bars]

out = []
for pair, fname, m in (("EURUSD", "EURUSD_15m.json", 2.24), ("XAUUSD", "XAUUSD_15m.json", 8000.0),
                       ("BTCUSD", "BTCUSD_15m.json", 160000.0)):
    with open(os.path.join(SK, "tests", "fixtures", fname)) as f:
        bars = setup.parse_chart(f.read())
    variants = {"real": bars, "mirror": mirror(bars, m), "merged4": setup.merge(bars, 4)}
    for name, bs in variants.items():
        for cut in (0, 40, 120, 200):
            use = bs[:len(bs) - cut] if cut else bs
            for swing in (2, 3, 4):
                for mrr in (1.0, 1.5, 2.0):
                    s = setup.analyze(pair, use, swing, mrr, "15m")
                    s.pop("created", None)
                    t = setup.track(s, bs) if s["decision"] == "trade" else None
                    out.append({"pair": pair, "variant": name, "cut": cut, "swing": swing, "minRR": mrr,
                                "setup": s, "track": t})
json.dump(out, sys.stdout)
