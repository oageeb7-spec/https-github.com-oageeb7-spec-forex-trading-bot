#!/usr/bin/env python3
"""charts.py - render a candlestick chart of a symbol with the bot's own trade
plan drawn on it.

It fetches the same free Yahoo chart bars the trader skills use, then overlays
whatever analysis the bot has already produced:

  - entry / stop / target from trader/plan.json (if the plan is for this symbol)
  - the opening range high/low
  - the scanner's setup label from trader/watchlist.json (if the symbol is on it)

The output is one self-contained .html file you open in any browser. The chart
is drawn by a small inline renderer with no external dependency, so the file
works fully offline - nothing is fetched when you open it.

Standard library only (urllib, json, gzip). No pip install, no API key.

Usage:
  python3 charts.py TSLA                         # 5 days of 15-minute bars
  python3 charts.py EURUSD=X --range 1mo --interval 1h
  python3 charts.py NVDA --range 1d --interval 5m --out trader/nvda.html
  python3 charts.py TSLA --offline TSLA.json     # read a saved chart JSON
  python3 charts.py --plan                        # chart the symbol in trader/plan.json

Data: Yahoo's free, unofficial chart JSON. It can lag and bars are not single
trades. Do not trade off this chart alone - it is a view of the plan your other
tools already made.
"""
import argparse
import gzip
import json
import os
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
TRADER = os.path.join(ROOT, "trader")
YAHOO_HOSTS = ("query2.finance.yahoo.com", "query1.finance.yahoo.com")
UA = "jarvis-charts/1.0 (+local tool)"


class ChartError(Exception):
    pass


def yahoo_sym(sym):
    # Yahoo uses dashes for class shares (BRK.B -> BRK-B); FX/crypto keep their suffix.
    return sym.upper().replace(".", "-") if "=" not in sym else sym.upper()


def fetch_chart(sym, rng, interval):
    """Fetch Yahoo chart JSON, falling back from query2 to query1."""
    path = "/v8/finance/chart/%s?range=%s&interval=%s" % (yahoo_sym(sym), rng, interval)
    last = None
    for host in YAHOO_HOSTS:
        url = "https://%s%s" % (host, path)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=20) as r:
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                return json.loads(raw.decode("utf-8"))
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
            last = e
            continue
    raise ChartError("could not fetch %s from Yahoo (%s)" % (sym, last))


def load_offline(path):
    data = open(path, "rb").read()
    if path.endswith(".gz"):
        data = gzip.decompress(data)
    return json.loads(data.decode("utf-8"))


def bars_from_chart(chart):
    """Turn Yahoo chart JSON into [{time, open, high, low, close}] sorted by time,
    dropping gaps where Yahoo reports a null bar."""
    try:
        res = chart["chart"]["result"][0]
    except (KeyError, IndexError, TypeError):
        err = (chart.get("chart") or {}).get("error") if isinstance(chart, dict) else None
        raise ChartError("no chart data" + (": %s" % err if err else ""))
    ts = res.get("timestamp") or []
    q = (res.get("indicators", {}).get("quote") or [{}])[0]
    o, h, l, c = q.get("open", []), q.get("high", []), q.get("low", []), q.get("close", [])
    v = q.get("volume", [])
    bars = []
    for i, t in enumerate(ts):
        vals = (o[i] if i < len(o) else None, h[i] if i < len(h) else None,
                l[i] if i < len(l) else None, c[i] if i < len(c) else None)
        if any(x is None for x in vals):
            continue
        vol = v[i] if i < len(v) and v[i] is not None else 0
        bars.append({"time": int(t), "open": round(vals[0], 6), "high": round(vals[1], 6),
                     "low": round(vals[2], 6), "close": round(vals[3], 6), "vol": int(vol)})
    bars.sort(key=lambda b: b["time"])
    meta = res.get("meta", {})
    return bars, meta


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def plan_overlays(sym):
    """Return price lines + a caption from trader/plan.json if it's for this symbol."""
    plan = read_json(os.path.join(TRADER, "plan.json"))
    if not plan or str(plan.get("symbol", "")).upper() != sym.upper():
        return [], None
    lines = []
    for key, color, label in (("entry", "#2962ff", "Entry"), ("stop", "#ef5350", "Stop"),
                              ("target", "#26a69a", "Target")):
        if plan.get(key) is not None:
            lines.append({"price": float(plan[key]), "color": color,
                          "title": "%s %s" % (label, plan[key])})
    orr = plan.get("opening_range") or {}
    for key, label in (("high", "OR high"), ("low", "OR low")):
        if orr.get(key) is not None:
            lines.append({"price": float(orr[key]), "color": "#9598a1", "title": label})
    rr = plan.get("reward_risk")
    caption = "%s %s setup - stop %s, target %s%s" % (
        plan.get("setup", "?"), plan.get("side", ""), plan.get("stop"), plan.get("target"),
        (" (%.2fR)" % rr) if isinstance(rr, (int, float)) else "")
    return lines, caption


def watchlist_setup(sym):
    wl = read_json(os.path.join(TRADER, "watchlist.json"))
    if not isinstance(wl, dict):
        return None
    for hit in (wl.get("hits") or wl.get("symbols") or []):
        if isinstance(hit, dict) and str(hit.get("symbol", "")).upper() == sym.upper():
            return hit.get("setup") or hit.get("reason")
    return None


def render_html(sym, interval, rng, bars, price_lines, caption, source_note, ma_period=20):
    has_vol = any(b.get("vol") for b in bars)
    payload = json.dumps({"bars": bars, "lines": price_lines, "ma": int(ma_period),
                          "hasVol": has_vol}, separators=(",", ":"))
    sub = caption or "no trade plan for this symbol yet"
    return """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>%(sym)s chart</title>
<style>
  :root { --bg:#ffffff; --fg:#131722; --muted:#787b86; --panel:#f3f3f6; --grid:#e0e3eb; }
  @media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){ --bg:#131722; --fg:#d1d4dc; --muted:#787b86; --panel:#1c2030; --grid:#2a2e39; } }
  :root[data-theme="dark"]{ --bg:#131722; --fg:#d1d4dc; --muted:#787b86; --panel:#1c2030; --grid:#2a2e39; }
  html,body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.4 -apple-system,Segoe UI,Roboto,sans-serif}
  .wrap{max-width:1100px;margin:0 auto;padding:16px}
  h1{font-size:20px;margin:0 0 2px}
  .sub{color:var(--muted);margin:0 0 12px}
  #chart{width:100%%;height:68vh;min-height:360px;background:var(--panel);border-radius:10px;display:block}
  .note{color:var(--muted);font-size:12px;margin-top:10px}
</style></head>
<body><div class="wrap">
  <h1>%(sym)s &middot; %(interval)s &middot; %(rng)s</h1>
  <p class="sub">%(sub)s</p>
  <canvas id="chart"></canvas>
  <p class="note">%(note)s</p>
</div>
<script>
const DATA = %(payload)s;
const cv = document.getElementById('chart');
const css = getComputedStyle(document.documentElement);
const C = {
  up:'#26a69a', down:'#ef5350', ma:'#f5a623',
  grid: css.getPropertyValue('--grid').trim() || '#e0e3eb',
  fg: css.getPropertyValue('--fg').trim() || '#131722',
  muted: css.getPropertyValue('--muted').trim() || '#787b86',
};
const ML=8, MR=66, MT=12, MB=26;   // margins (price labels on the right)

function fmt(v){ const a=Math.abs(v); const d = a>=1?2 : 4; return v.toFixed(d); }
function vfmt(v){ if(v>=1e9)return (v/1e9).toFixed(1)+'B'; if(v>=1e6)return (v/1e6).toFixed(1)+'M';
  if(v>=1e3)return (v/1e3).toFixed(1)+'K'; return ''+v; }
function tlabel(sec){ const d=new Date(sec*1000);
  return d.toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); }

function sma(bars, n){ const out=new Array(bars.length).fill(null); if(n<=1) return out;
  let sum=0; for(let i=0;i<bars.length;i++){ sum+=bars[i].close;
    if(i>=n) sum-=bars[i-n].close; if(i>=n-1) out[i]=sum/n; } return out; }

function draw(){
  const bars = DATA.bars; if(!bars.length) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W*dpr; cv.height = H*dpr;
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,W,H);
  ctx.font='11px -apple-system,Segoe UI,Roboto,sans-serif';

  const showVol = DATA.hasVol;
  const volH = showVol ? Math.round((H-MT-MB)*0.18) : 0;   // volume panel height
  const gap = showVol ? 8 : 0;
  const cw=W-ML-MR, ch=H-MT-MB-volH-gap;                   // price pane height
  const volTop = MT+ch+gap;

  let lo=Infinity, hi=-Infinity;
  for(const b of bars){ if(b.low<lo)lo=b.low; if(b.high>hi)hi=b.high; }
  for(const ln of DATA.lines){ if(ln.price<lo)lo=ln.price; if(ln.price>hi)hi=ln.price; }
  const pad=(hi-lo)*0.06 || 1; lo-=pad; hi+=pad;
  const x=i=> ML + (bars.length===1? cw/2 : i*(cw/(bars.length-1)));
  const y=p=> MT + (hi-p)/(hi-lo)*ch;

  // horizontal grid + price axis
  ctx.textBaseline='middle';
  for(let s=0;s<=4;s++){ const p=lo+(hi-lo)*s/4, yy=y(p);
    ctx.strokeStyle=C.grid; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(ML,yy); ctx.lineTo(W-MR,yy); ctx.stroke();
    ctx.fillStyle=C.muted; ctx.textAlign='left'; ctx.fillText(fmt(p), W-MR+6, yy);
  }
  // time labels (up to 5)
  ctx.textAlign='center'; ctx.textBaseline='top';
  const step=Math.max(1,Math.floor(bars.length/5));
  for(let i=0;i<bars.length;i+=step){ ctx.fillStyle=C.muted; ctx.fillText(tlabel(bars[i].time), x(i), H-MB+6); }

  // volume panel
  if(showVol){ let vmax=0; for(const b of bars) if(b.vol>vmax) vmax=b.vol;
    const vy=v=> volTop+volH-(vmax?v/vmax:0)*volH;
    const bw2=Math.max(1,(cw/bars.length)*0.7);
    bars.forEach((b,i)=>{ ctx.fillStyle=(b.close>=b.open?C.up:C.down)+'66';
      const h2=volTop+volH-vy(b.vol); ctx.fillRect(x(i)-bw2/2, vy(b.vol), bw2, Math.max(1,h2)); });
    ctx.fillStyle=C.muted; ctx.textAlign='left'; ctx.textBaseline='middle';
    ctx.fillText('Vol '+vfmt(vmax), W-MR+6, volTop+7);
  }

  // candles
  const bw=Math.max(1, Math.min(14, (cw/bars.length)*0.7));
  bars.forEach((b,i)=>{ const up=b.close>=b.open, col=up?C.up:C.down, px=x(i);
    ctx.strokeStyle=col; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(px, y(b.high)); ctx.lineTo(px, y(b.low)); ctx.stroke();
    const yo=y(b.open), yc=y(b.close); ctx.fillStyle=col;
    ctx.fillRect(px-bw/2, Math.min(yo,yc), bw, Math.max(1,Math.abs(yc-yo)));
  });

  // moving average line
  if(DATA.ma>1){ const m=sma(bars, DATA.ma); ctx.strokeStyle=C.ma; ctx.lineWidth=1.5;
    ctx.beginPath(); let started=false;
    for(let i=0;i<bars.length;i++){ if(m[i]==null){started=false;continue;}
      const px=x(i),py=y(m[i]); if(!started){ctx.moveTo(px,py);started=true;} else ctx.lineTo(px,py); }
    ctx.stroke();
    ctx.fillStyle=C.ma; ctx.textAlign='left'; ctx.textBaseline='top';
    ctx.fillText('MA'+DATA.ma, ML+4, MT+4);
  }

  // overlay price lines (entry / stop / target / OR)
  ctx.textBaseline='middle';
  for(const ln of DATA.lines){ const yy=y(ln.price);
    ctx.setLineDash([5,4]); ctx.strokeStyle=ln.color; ctx.lineWidth=1.5;
    ctx.beginPath(); ctx.moveTo(ML,yy); ctx.lineTo(W-MR,yy); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle=ln.color; ctx.fillRect(W-MR, yy-8, MR, 16);
    ctx.fillStyle='#fff'; ctx.textAlign='left';
    ctx.fillText(ln.title.replace(/[^ -~]/g,''), W-MR+4, yy);
  }

  // last-price marker
  const last=bars[bars.length-1], yl=y(last.close), up=last.close>=last.open;
  ctx.setLineDash([2,3]); ctx.strokeStyle=C.muted; ctx.lineWidth=1;
  ctx.beginPath(); ctx.moveTo(ML,yl); ctx.lineTo(W-MR,yl); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle=up?C.up:C.down; ctx.fillRect(W-MR, yl-8, MR, 16);
  ctx.fillStyle='#fff'; ctx.textAlign='left'; ctx.fillText(fmt(last.close), W-MR+4, yl);
}
draw(); addEventListener('resize', draw);
</script>
</body></html>""" % {
        "sym": sym.upper(), "interval": interval, "rng": rng, "sub": sub,
        "note": source_note, "payload": payload,
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description="Candlestick chart with the bot's trade plan overlaid.")
    ap.add_argument("symbol", nargs="?", help="ticker, e.g. TSLA or EURUSD=X")
    ap.add_argument("--range", default="5d", help="Yahoo range: 1d,5d,1mo,3mo,6mo,1y (default 5d)")
    ap.add_argument("--interval", default="15m", help="bar size: 1m,5m,15m,1h,1d (default 15m)")
    ap.add_argument("--offline", help="read a saved Yahoo chart JSON (.json or .json.gz)")
    ap.add_argument("--out", help="output HTML path (default trader/<symbol>_chart.html)")
    ap.add_argument("--ma", type=int, default=20, help="moving-average period to overlay, 0 to disable (default 20)")
    ap.add_argument("--plan", action="store_true", help="chart the symbol in trader/plan.json")
    a = ap.parse_args(argv)

    sym = a.symbol
    if a.plan or not sym:
        plan = read_json(os.path.join(TRADER, "plan.json"))
        if not plan or not plan.get("symbol"):
            ap.error("no symbol given and no trader/plan.json to read one from")
        sym = plan["symbol"]
        if plan.get("interval") and not any(x in (argv or sys.argv) for x in ("--interval",)):
            a.interval = plan["interval"]

    try:
        chart = load_offline(a.offline) if a.offline else fetch_chart(sym, a.range, a.interval)
        bars, meta = bars_from_chart(chart)
    except (ChartError, OSError) as e:
        print("error: %s" % e, file=sys.stderr)
        return 1
    if not bars:
        print("error: no bars for %s (market closed, or range/interval unsupported)" % sym, file=sys.stderr)
        return 1

    lines, caption = plan_overlays(sym)
    setup = watchlist_setup(sym)
    if setup and not caption:
        caption = "scanner setup: %s" % setup
    src = "Data: Yahoo chart (%s bars, %s). Unofficial and delayed - a view of your plan, not a trade signal." % (
        a.interval, "offline file" if a.offline else "live fetch")

    html = render_html(sym, a.interval, a.range, bars, lines, caption, src, ma_period=max(0, a.ma))
    out = a.out or os.path.join(TRADER, "%s_chart.html" % yahoo_sym(sym).replace("=", ""))
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w") as f:
        f.write(html)
    print("wrote %s (%d bars%s)" % (out, len(bars), ", %d overlay lines" % len(lines) if lines else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
