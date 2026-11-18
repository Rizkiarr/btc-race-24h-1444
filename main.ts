// Dip-filtered BTC trading bot for the make.fun btc-race-24h competition.
// Strategy: max 1 entry per 24h window.
//   - BUY full size when close <= -1.5% from the 6h high AND the bar is stabilizing
//     (close > close 15 minutes ago).
//   - EXIT on the first of: take-profit +2.0% from entry, trailing stop 1.0% from
//     the peak after entry, disaster stop -1.5% from entry.
//   - Forced exit before the last bar.
// Deterministic: no wall clock, no files, no randomness beyond hello.seed.

import { BPS, runBars, type BarsState, type BuyInput, type OrderInput, type SellOrder } from './vendor/makefun-bars.ts';

// ---- strategy parameters (bps unless noted) ----
const HIGH_WINDOW_BARS = 360;   // 6h of 1-minute bars
const BUY_DIP_BPS = 150;        // buy when close is at least 1.5% below the 6h high
const STABILIZE_BARS = 15;      // close must be above the close 15 bars back
const TAKE_PROFIT_BPS = 200;    // +2.0% from entry
const TRAILING_STOP_BPS = 100;  // 1.0% off the peak after entry
const DISASTER_STOP_BPS = 150;  // -1.5% from entry
const MAX_SLIPPAGE_BPS = 80;    // tight: modelled slippage (2) + impact (~7-14) + margin
const MAX_ENTRIES_PER_WINDOW = 1;

// ---- module state, reset cleanly after every round trip ----
const closes: (bigint | null)[] = [];   // close per batch (-1 = no CBBTC bar that minute)
let state: 'cash' | 'holding' = 'cash';
let entriesUsed = 0;
let buyPending = false;   // a buy order was sent but its fill has not been reported
let sellPending = false;  // a sell order was sent but its fill has not been reported
let entryPrice = 0n;      // actual fill price of the entry
let peakAfterEntry = 0n;  // highest close seen after the entry fill

function lastClose(): bigint | null {
  return closes[closes.length - 1];
}

/** High of the closes over the last `bars` batches (skipping minutes with no bar). */
function rollingHigh(bars: number): bigint | null {
  let hi: bigint | null = null;
  const from = Math.max(0, closes.length - bars);
  for (let i = from; i < closes.length; i++) {
    const c = closes[i];
    if (c !== null && (hi === null || c > hi)) hi = c;
  }
  return hi;
}

function onEntryFill(fillPrice: bigint, seq: number): void {
  state = 'holding';
  entriesUsed += 1;
  buyPending = false;
  entryPrice = fillPrice;
  peakAfterEntry = fillPrice;
  const c = lastClose();
  if (c !== null && c > peakAfterEntry) peakAfterEntry = c;
  process.stderr.write(`[trade] ENTRY seq=${seq} fill=${fillPrice} entriesUsed=${entriesUsed}\n`);
}

function onExitFill(fillPrice: bigint, seq: number, reason: string): void {
  state = 'cash';
  sellPending = false;
  const gainBps = entryPrice > 0n ? (fillPrice - entryPrice) * BPS / entryPrice : 0n;
  process.stderr.write(`[trade] EXIT seq=${seq} fill=${fillPrice} reason=${reason} peak=${peakAfterEntry} pnl_bps=${gainBps}\n`);
}

await runBars({
  onBatch(stateArg, batch) {
    const s = stateArg as BarsState;
    const symbol = s.hello.symbols[0].symbol;
    const seq = batch.seq;

    // 1) record this minute's close
    closes.push(s.close(symbol));

    // 2) fold in the fills of orders decided on the previous batch
    for (const f of batch.fills) {
      if (f.symbol !== symbol) continue;
      if (f.status !== 'filled') continue;
      const price = BigInt(f.price);
      if (f.side === 'buy') onEntryFill(price, seq);
      else if (f.side === 'sell') onExitFill(price, seq, s.positions.has(symbol) ? 'exit' : 'exit');
    }

    // 3) decide orders
    const minNotional = BigInt(s.hello.fees.min_notional_quote_units);

    // Forced exit: on the second-to-last batch of the window, sell whatever is held
    // so the fill lands on the last bar (orders on the last batch are rejected after_end).
    const isSecondToLast = seq === 1438; // warmup is 0 in this kit; 1440 bars -> last is seq 1439
    if (isSecondToLast && state === 'holding' && !sellPending) {
      const pos = s.positions.get(symbol);
      if (pos && pos.qty > 0n) {
        sellPending = true;
        process.stderr.write(`[trade] FORCED EXIT seq=${seq} qty=${pos.qty}\n`);
        const orders: OrderInput[] = [{ side: 'sell', symbol, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        return orders;
      }
    }

    if (state === 'holding') {
      if (sellPending) return [];
      const close = lastClose();
      const pos = s.positions.get(symbol);
      if (close === null || !pos || pos.qty === 0n) return [];

      // mark the peak
      if (close > peakAfterEntry) peakAfterEntry = close;

      let reason: string | null = null;
      // take profit: close >= entry * (1 + 200/10000)
      if (close * BPS >= entryPrice * (BPS + BigInt(TAKE_PROFIT_BPS))) reason = 'take_profit';
      else if (close * BPS <= entryPrice * (BPS - BigInt(DISASTER_STOP_BPS))) reason = 'disaster_stop';
      else if (close * BPS <= peakAfterEntry * (BPS - BigInt(TRAILING_STOP_BPS))) reason = 'trailing_stop';

      if (reason !== null) {
        sellPending = true;
        process.stderr.write(`[trade] EXIT SIGNAL seq=${seq} reason=${reason} close=${close} peak=${peakAfterEntry}\n`);
        const orders: OrderInput[] = [{ side: 'sell', symbol, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        return orders;
      }
      return [];
    }

    // state === 'cash'
    if (buyPending || entriesUsed >= MAX_ENTRIES_PER_WINDOW) return [];
    if (s.warmingUp) return [];

    const close = lastClose();
    if (close === null) return [];

    // need 6h of history to measure the dip
    if (closes.length < HIGH_WINDOW_BARS + 1) return [];

    const hi = rollingHigh(HIGH_WINDOW_BARS);
    if (hi === null) return [];

    // dip filter: close at least BUY_DIP_BPS below the 6h high
    if (close * BPS > hi * (BPS - BigInt(BUY_DIP_BPS))) return [];

    // stabilizing: close above the close 15 bars back
    const prev15 = closes[closes.length - 1 - STABILIZE_BARS];
    if (prev15 === null || close <= prev15) return [];

    // BUY full cash size
    const notional = s.cash;
    if (notional < minNotional) return [];
    buyPending = true;
    process.stderr.write(`[trade] BUY SIGNAL seq=${seq} close=${close} hi6h=${hi} cash=${notional}\n`);
    const orders: OrderInput[] = [{ side: 'buy', symbol, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    return orders;
  },

  onDone(s, done) {
    const pnl = BigInt(done.account.cash_quote_units) - BigInt(s.hello.capital.quote_units);
    const pnlUsd = Number(pnl) / 1e6;
    process.stderr.write(`[done] net PnL: ${pnlUsd.toFixed(2)} USDC (pnl units: ${pnl})\n`);
  },
});
