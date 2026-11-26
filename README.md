# makefun-pump-sharpe-2

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/theo1603/makefun-pump-sharpe-2/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/theo1603/makefun-pump-sharpe-2/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for make.fun's "Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins" bounty ($2 in USDC). It trades a 6-hour pump.fun replay for the highest hourly Sharpe ratio: steady, controlled gains, not one lucky moonshot. It buys only two moments — a momentum burst (price up 6% over three trades on a buy) and a spike-then-dip with a bounce confirmation (a 20% run, an 8% pullback, then a 2% tick back up) — stakes at most 0.08 SOL per coin, and exits every position on a wide take-profit (+4% net), stop-loss (-8% net) or time stop, so no position rides a coin to zero. Paper trading only; no real funds move.

## Run it

```sh
node main.ts
```

Node 22.18 or later, no dependencies to install (the harness runs `node main.ts` and speaks the agent-fun/replay/v2 protocol over stdin/stdout). `strategy.ts` holds the trading logic; `vendor/makefun-bot.ts` is the kit's bot SDK, vendored unchanged.

---

<sub>Entered on [make.fun](https://make.fun/?ref=rheoteho16&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
