"""
Fetch recent futures 1-minute data via yfinance and save it as JSON
that REPLAYDESK can import (Setup -> IMPORT FILE).

Usage:
    pip install yfinance
    python fetch_nq.py            # NQ=F, last 7 days of 1m bars
    python fetch_nq.py ES=F       # any yahoo ticker
    python fetch_nq.py NQ=F 5m 55 # 5m bars, last 55 days (yahoo allows more history on 5m)

Notes:
  - Yahoo only serves 1m data for the last ~7 days, 5m for ~60 days.
  - The app expects 1-minute bars for smoothest fills; 5m works but
    intrabar fills get coarser.
"""
import json
import sys

try:
    import yfinance as yf
except ImportError:
    sys.exit("yfinance not installed -> run: pip install yfinance")

ticker = sys.argv[1] if len(sys.argv) > 1 else "NQ=F"
interval = sys.argv[2] if len(sys.argv) > 2 else "1m"
days = int(sys.argv[3]) if len(sys.argv) > 3 else (7 if interval == "1m" else 55)

print(f"Fetching {ticker} {interval} bars, last {days} days...")
df = yf.download(ticker, period=f"{days}d", interval=interval, progress=False, auto_adjust=False)
if df.empty:
    sys.exit("No data returned - check the ticker or try fewer days.")

# yfinance sometimes returns MultiIndex columns
if hasattr(df.columns, "levels"):
    df.columns = [c[0] for c in df.columns]

bars = []
for ts, row in df.iterrows():
    t = int(ts.timestamp())
    o, h, l, c = float(row["Open"]), float(row["High"]), float(row["Low"]), float(row["Close"])
    v = float(row.get("Volume", 0) or 0)
    if any(x != x for x in (o, h, l, c)):  # skip NaN rows
        continue
    bars.append([t, o, h, l, c, v])

out = ticker.replace("=", "").replace("^", "").lower() + f"_{interval}.json"
with open(out, "w") as f:
    json.dump(bars, f)

print(f"Saved {len(bars):,} bars -> {out}")
print("Import this file in REPLAYDESK: Setup -> 02 / IMPORT FILE")
