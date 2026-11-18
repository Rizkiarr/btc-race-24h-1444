# Dip-Filtered BTC Trading Bot

A deterministic bot for the make.fun btc-race-24h competition that uses a dip-filtered strategy to capture BTC price dislocations.

## Strategy

The bot operates with the following rules:

1. **Entry Signal**: Buy full size when:
   - Close price is at least 1.5% below the 6-hour high
   - The price bar is "stabilizing" (current close > close 15 minutes ago)
   - No entry has been made in the current 24h window

2. **Exit Rules**: Sell on the FIRST of:
   - Take-profit: +2.0% from entry price
   - Trailing stop: 1.0% below the peak price after entry
   - Disaster stop: -1.5% from entry price
   - Forced exit: Before the last bar of the window

3. **Position Limits**: Maximum 1 entry per 24h competitive window

## Technical Details

- **Language**: TypeScript (Node 22)
- **Entry Fee**: 4 bps + 2 bps slippage + price impact
- **Max Slippage**: 80 bps (conservative fill limit)
- **Deterministic**: No wall clock, no network, no files beyond the repo

## Dev Results

| Window | Net PnL | Trades | Max Drawdown | Notes |
|--------|---------|--------|--------------|-------|
| btc-race-24h-20261118-1444 (dev) | +$5.58 USDC | 2 | 0.01% | Meets >$5 gate |
| btc-race-24h-20261117-0603 (extra) | +$18.14 USDC | 2 | 0.007% | Beats buy-and-hold (+$1.07) |

At 2x fees (cost sensitivity test): Dev PnL remains positive at +$4.77 USDC.

## Build

```bash
npm install  # if using module bundling
node cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver process
```

## License

MIT License - see LICENSE file for details.