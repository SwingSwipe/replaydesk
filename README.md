# REPLAYDESK — prop evaluation simulator

**Live: https://swingswipe.github.io/replaydesk/**

FX Replay-style bar replay + a Topstep/Lucid-style prop rules engine, in one static web app.
You replay historical 1-minute data candle by candle, take trades like it's live, and the desk
enforces real evaluation rules against you: trailing max drawdown, daily loss limit, profit
target, contract caps, commissions.

## Run it

No build, no server needed:

```
# option A: just open index.html in a browser (double-click)
# option B (recommended, avoids any file:// quirks):
cd prop-sim
python -m http.server 8123
# then open http://localhost:8123
```

## Data sources

| Source | What you get |
|---|---|
| **Demo** | Synthetic NQ-style 1m data, 10 trading days. Instant, works offline. |
| **Binance** | Real BTC/ETH 1m candles, any recent window up to 30 days. No API key. |
| **Import file** | Your own 1m bars — TradingView CSV export, or run `fetch_nq.py` for real NQ/ES data. |

```
pip install yfinance
python fetch_nq.py           # grabs last 7 days of NQ=F 1m -> nqf_1m.json
```
Then Setup → IMPORT FILE → pick the json.

## How the replay works

- Base data is 1-minute bars. Each bar plays back in 13 interpolated sub-steps along its
  open → low/high → high/low → close path, so limit/stop/SL/TP fills trigger *inside*
  the bar the way they would live — not just on bar close.
- Missing minutes in thin feeds (binance.us omits zero-trade minutes) are gap-filled
  with flat candles so the stream is continuous; real session breaks stay as gaps.
- Chart timeframe (1m/5m/15m/1h) is aggregated from the base 1m stream; the current
  candle builds in front of you.
- SPACE = play/pause · → = step one bar · speeds up to 30 bars/sec.
- Times shown in New York time; the trading day rolls at 5pm NY like CME.

## View toggles (chart toolbar)

- **VOL** — volume histogram.
- **FLOW** — order flow: per-bar delta histogram + cumulative delta (CVD) line on the
  chart, plus a sidebar panel with a depth ladder and time & sales tape.
- **MAP** — bookmap-style liquidity heatmap: amber bands where resting size sits.
- **LVLS** — prior day high/low + midnight-open price lines (killzone context).

**Honesty note on FLOW/MAP:** delta and CVD are derived from each bar's real volume and
close-location (standard approximation). The book/ladder/tape are *simulated* — walls
are seeded deterministically at trailing swing highs/lows and round numbers, decay over
time, and sometimes pull as price approaches. Nothing peeks at future data, so the
patterns correlate with structure the way real liquidity tends to — use it to train the
*read* (absorption, pulls, delta divergence), never to trust a specific level.

## Order ticket

- SL/TP in **ticks, points, or absolute price** (UNIT selector).
- **AUTO QTY** sizes the position from a $ risk budget and your stop distance,
  capped at the account's max contracts.
- **Click the chart** to drop that price into the resting-order box, then BUY/SEL LMT/STP.
- Optional **trade window** (e.g. 09:30–11:00 NY): entries blocked outside it and,
  if enabled, open positions auto-flatten when the window closes.
- With a position on, a red **⚠ LIQ** line shows the exact price where your equity
  would hit the trailing liquidation level, and the position card shows open P&L in R.
- Hotkeys: SPACE play/pause · → step · **B** buy · **S** sell · **C** close · **F** flatten.
- **SKIP ▶▶** jumps to the next session open (09:30 NY, or your window start) — working
  orders, drawdown, and day rollovers still process on the way, so you can hold overnight.

## Realism knobs

- **Slippage (ticks)** — market and stop fills get worse by N ticks; limit fills don't.
- **Min trading days** and **consistency max %** — hitting the profit target alone doesn't
  pass you; the pass banner waits until every gate is met (like a real combine).
- Fill sounds (SND toggle): entry blip, higher for TP, lower for SL.

## Exports

- **EXPORT CSV** — raw trade log.
- **EXPORT FOR LEDGER →** — JSON in the exact schema of the Ledger journal app
  (`Projects/trading-journal`), including planned risk per trade. Careful: Ledger's
  Import *replaces* its trade list.

## Rules engine

- **Trailing max drawdown** — intraday trail (Topstep-style: counts unrealized highs),
  EOD trail (Lucid-style), or static. Optional lock at starting balance.
- **Daily loss limit** — fails the account or just locks the day, your choice.
- **Profit target** — pass banner when realized balance clears it (flat).
- Max contracts, per-side commissions, attempt counter with full trade history.

## Honest-sim caveats

- Fills are frictionless: market orders fill at the replay price, no slippage or queue.
  Real fills are worse. Treat results as an upper bound — same philosophy as the ICT backtester.
- The 4-point intrabar path is a heuristic; if price hit both your SL and TP inside one
  minute, the path decides which was "first" and can be wrong.
- Demo data is synthetic — good for learning the desk, useless for judging edge.

## Files

- `index.html` / `style.css` / `app.js` — the whole app
- `fetch_nq.py` — yfinance downloader for real futures data
