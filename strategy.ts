// strategy.ts — paper bot for the pump.fun Sharpe sprint (v4).
//
// Idea, in one paragraph: most pump.fun coins grind down, so entries must
// be selective and exits must have room to breathe. Two entry moments are
// used, both measured on the dev window. (1) A momentum burst: the price
// rises >=6% over three trades on a buy trade — the next few trades keep
// climbing more often than not. (2) A spike-then-dip with a bounce
// confirmation: a coin runs >=20% off its low, pulls back >=8% off its
// peak, then ticks >=2% up off the dip low — the bounce, not the dip
// itself, is the entry. (A stricter variant of both thresholds graded
// worse, and momentum-only graded worse too, so both legs stay at these
// levels.) Entries are small (<=0.08 SOL), capped by the harness's
// 1%-of-real-reserves order limit. Exits are deliberately wide:
// take-profit +4% net, stop-loss -8% net, or a time stop. Tighter stops
// graded far worse: a -3% net stop-loss is roughly a -0.3% gross move
// once the ~2.5% round-trip fees are counted, so noise alone stops the
// position out. Deterministic: decisions use only the replayed events; no
// clock, no environment, no randomness.
//
// Entry and exit prices come from the curve's virtual reserves
// (virtual_quote_reserves / virtual_token_reserves). Fees: ~1.25% of the
// trade on each side plus a 105,000-lamport tx fee per order.
//
// Three harness behaviours shape this design. First, an order fills two
// slots after it is decided and is rejected when the fill is >5% worse
// than the decision-time reserves, so chasing a burst that keeps running
// mostly gets rejected for free instead of filled at the top. Second,
// sells escalate their slippage (20%, then 50%, then 100%) after
// consecutive slippage rejections, because a stop-loss that keeps being
// rejected while the price freefalls is worse than eating the drop to
// exit; buys keep tight (5%) slippage for the same reason in reverse.
// Third, a sell rejected because its fees would eat the whole output (or
// it pays out more than the curve's real reserves hold) is never
// re-sent: the position is unexitable and the harness writes it off at
// the end, so resending only spams rejected orders. Duplicate sells are
// never sent either: until a pending sell resolves, the position is
// still listed, and every extra sell would only be rejected.

import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

// ---- tuned constants (all in lamports / basis points / slots) ----
const TARGET_BUY_LAMPORTS = 80_000_000n; // 0.08 SOL per entry, before caps
const MIN_BUY_LAMPORTS = 12_000_000n; // 0.012 SOL: above the 0.01 SOL round-trip bar
const MAX_POSITIONS = 5;
const BUY_SLIPPAGE_BPS = 500;
const SELL_SLIPPAGE_BPS = 2000;
const FEE_BPS_EACH_SIDE = 125; // protocol 95 + creator 30
const TX_FEE_LAMPORTS = 105_000n; // base 5,000 + priority 100,000

// Momentum burst: price up this much vs three trades ago, on a buy trade.
const MOMENTUM_PCT = 1.06;
const MOMENTUM_LOOKBACK = 3;
// Spike-then-dip: arm after this rise off the running low, dip this far off
// the peak, enter when the price ticks this far back up off the dip low.
const SPIKE_PCT = 1.2;
const DIP_PCT = 0.92;
const BOUNCE_PCT = 1.02;
// Exits, on net proceeds (after sell fees) vs the position's cost.
const TAKE_PROFIT = 0.04;
const STOP_LOSS = -0.08;
const MAX_HOLD_SLOTS = 25_000;
const MAX_HOLD_TRADES = 30;
const REENTRY_COOLDOWN_SLOTS = 1_000;

interface MintTrack {
  prices: number[]; // last few trade prices, oldest first
  runMin: number; // lowest price since the last reset
  runPeak: number; // highest price since the last reset
  spikeArmed: boolean; // runPeak reached SPIKE_PCT * runMin
  dipped: boolean; // price fell to DIP_PCT * runPeak after arming
  dipLow: number; // lowest price since the dip began
  trades: number; // trades seen on this mint
  momentumSignalled: boolean; // momentum condition held at last evaluation
  bounceSignalled: boolean; // bounce condition held at last evaluation
}

interface OpenTrade {
  entrySlot: number;
  entryTrades: number;
}

export class SpikeDipStrategy {
  private readonly tracks = new Map<string, MintTrack>();
  private readonly open = new Map<string, OpenTrade>();
  private readonly lastExitSlot = new Map<string, number>();
  // Mints whose position can no longer be sold at all: the harness rejects
  // every sell (the sale's fees eat its whole output, or it pays out more
  // than the curve's real reserves hold). Resending the sell every batch
  // only spams rejected orders.
  private readonly unexitable = new Set<string>();
  private readonly slipRejects = new Map<string, number>();

  /** Decide this batch's orders. Pure function of state + batch. */
  decide(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];

    // Learn from this batch's fills: a sell rejected for a persistent
    // reason means the position is unexitable; repeated slippage
    // rejections mean the price is in freefall and the next sell must go
    // out looser.
    for (const fill of batch.fills) {
      if (fill.side !== 'sell' || fill.status !== 'rejected') continue;
      if (fill.reason === 'zero_amount' || fill.reason === 'max_order_size' ||
          fill.reason === 'token_complete' || fill.reason === 'insufficient_tokens' ||
          fill.reason === 'after_end') {
        this.unexitable.add(fill.mint);
      } else if (fill.reason === 'max_slippage') {
        const n = (this.slipRejects.get(fill.mint) ?? 0) + 1;
        this.slipRejects.set(fill.mint, n);
      }
    }

    // Fold every trade of this batch into the per-mint trackers first, in
    // chain order, so holds and cooldowns never leave the tape stale.
    // A mint joins freshMints only on the rising edge of a signal: the
    // trade where its condition turns true after being false.
    const freshMints = new Set<string>();
    for (const event of batch.events) {
      if (event.event !== 'TradeEvent') continue;
      const price = tradePrice(event);
      if (!(price > 0)) continue;
      const track = this.trackFor(event.mint);
      track.prices.push(price);
      if (track.prices.length > 8) track.prices.shift();
      track.trades += 1;
      if (price < track.runMin) track.runMin = price;
      if (price > track.runPeak) track.runPeak = price;
      if (!track.spikeArmed && track.runPeak >= SPIKE_PCT * track.runMin) {
        track.spikeArmed = true;
      }
      if (track.spikeArmed && !track.dipped && price <= DIP_PCT * track.runPeak) {
        track.dipped = true;
        track.dipLow = price;
      }
      if (track.dipped && price < track.dipLow) track.dipLow = price;
      // A fresh rise far above the old peak starts a new cycle.
      if (track.dipped && price >= track.runPeak) this.resetCycle(track, price);
      const momentum = this.momentumNow(track, event.is_buy);
      const bounce = this.bounceNow(track);
      if ((momentum && !track.momentumSignalled) || (bounce && !track.bounceSignalled)) {
        freshMints.add(event.mint);
      }
      track.momentumSignalled = momentum;
      track.bounceSignalled = bounce;
    }

    // Exits first: free slots and cash before considering new entries.
    for (const [mint, holding] of state.positions) {
      if (this.unexitable.has(mint)) continue;
      if (hasPendingSell(state, mint)) continue;
      const trade = this.open.get(mint);
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const price = curvePrice(curve);
      if (!(price > 0)) continue;
      const gross = Number(holding.token_amount) * price;
      const net = gross * (1 - FEE_BPS_EACH_SIDE / 10_000) - Number(TX_FEE_LAMPORTS);
      const pnl = net / Number(holding.cost_lamports) - 1;
      const track = this.tracks.get(mint);
      const ageSlots = trade === undefined ? 0 : batch.slot - trade.entrySlot;
      const ageTrades = trade === undefined || track === undefined ? 0 : track.trades - trade.entryTrades;
      const timedOut = ageSlots > MAX_HOLD_SLOTS || ageTrades > MAX_HOLD_TRADES;
      if (pnl >= TAKE_PROFIT || pnl <= STOP_LOSS || timedOut) {
        // Sell slippage escalates after consecutive slippage rejections:
        // a stop-loss that keeps being rejected while the price freefalls
        // is worse than eating the drop to exit at all.
        const slips = this.slipRejects.get(mint) ?? 0;
        const slippage = slips === 0 ? SELL_SLIPPAGE_BPS : slips === 1 ? 5000 : 10000;
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: slippage,
        });
        this.open.delete(mint);
        this.lastExitSlot.set(mint, batch.slot);
      }
    }

    // Entries: one fresh signal per mint, rising edge only, from the fold
    // pass above.
    for (const mint of freshMints) {
      const track = this.tracks.get(mint);
      if (track === undefined) continue;
      if (state.positions.has(mint)) continue;
      if (state.committedPositionCount() + countBuys(orders) >= MAX_POSITIONS) break;
      if (hasPendingBuy(state, mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const lastExit = this.lastExitSlot.get(mint);
      if (lastExit !== undefined && batch.slot - lastExit < REENTRY_COOLDOWN_SLOTS) continue;

      // Size: target, capped at 90% of the harness's per-batch order limit,
      // and only when the fill would clear the round-trip minimum.
      const cap = state.maxBuyLamports(mint);
      let size = TARGET_BUY_LAMPORTS;
      const capped = (cap * 9n) / 10n;
      if (capped < size) size = capped;
      if (size < MIN_BUY_LAMPORTS) continue;
      if (state.freeCashLamports() - spentBy(orders) < size + TX_FEE_LAMPORTS) continue;

      orders.push({
        side: 'buy',
        mint,
        quote_lamports: size,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
      this.open.set(mint, { entrySlot: batch.slot, entryTrades: track.trades });
    }

    // Forget positions the harness closed on its own (complete / flatten).
    for (const mint of [...this.open.keys()]) {
      if (!state.positions.has(mint) && !hasPendingBuy(state, mint)) this.open.delete(mint);
    }
    return orders;
  }

  private trackFor(mint: string): MintTrack {
    let track = this.tracks.get(mint);
    if (track === undefined) {
      track = {
        prices: [],
        runMin: Number.POSITIVE_INFINITY,
        runPeak: 0,
        spikeArmed: false,
        dipped: false,
        dipLow: 0,
        trades: 0,
        momentumSignalled: false,
        bounceSignalled: false,
      };
      this.tracks.set(mint, track);
    }
    return track;
  }

  private resetCycle(track: MintTrack, price: number): void {
    track.runMin = price;
    track.runPeak = price;
    track.spikeArmed = false;
    track.dipped = false;
    track.dipLow = 0;
    track.momentumSignalled = false;
    track.bounceSignalled = false;
  }

  private momentumNow(track: MintTrack, lastTradeIsBuy: boolean): boolean {
    if (!lastTradeIsBuy) return false;
    if (track.prices.length <= MOMENTUM_LOOKBACK) return false;
    const now = track.prices[track.prices.length - 1];
    const then = track.prices[track.prices.length - 1 - MOMENTUM_LOOKBACK];
    return now >= MOMENTUM_PCT * then;
  }

  private bounceNow(track: MintTrack): boolean {
    if (!track.dipped) return false;
    const now = track.prices[track.prices.length - 1];
    return now >= BOUNCE_PCT * track.dipLow;
  }
}

function tradePrice(event: { virtual_quote_reserves: string; virtual_token_reserves: string }): number {
  const token = Number(BigInt(event.virtual_token_reserves));
  if (token <= 0) return 0;
  return Number(BigInt(event.virtual_quote_reserves)) / token;
}

function curvePrice(curve: {
  virtual_quote_reserves: bigint;
  virtual_token_reserves: bigint;
}): number {
  const token = Number(curve.virtual_token_reserves);
  if (token <= 0) return 0;
  return Number(curve.virtual_quote_reserves) / token;
}

function hasPendingBuy(state: BotState, mint: string): boolean {
  for (const pending of state.pending.values()) {
    if (pending.order.side === 'buy' && pending.order.mint === mint) return true;
  }
  return false;
}

function hasPendingSell(state: BotState, mint: string): boolean {
  for (const pending of state.pending.values()) {
    if (pending.order.side === 'sell' && pending.order.mint === mint) return true;
  }
  return false;
}

function countBuys(orders: OrderInput[]): number {
  let n = 0;
  for (const order of orders) if (order.side === 'buy') n += 1;
  return n;
}

function spentBy(orders: OrderInput[]): bigint {
  let total = 0n;
  for (const order of orders) {
    total += TX_FEE_LAMPORTS;
    if (order.side === 'buy') total += BigInt(order.quote_lamports);
  }
  return total;
}
