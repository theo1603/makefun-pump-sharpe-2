// main.ts — entrypoint for the pump.fun Sharpe sprint paper bot.
//
// One strategy program on Node 22: it reads hello / batch / orders / slot
// lines from the harness on stdin and answers each batch with its orders.
// The wire protocol lives in ./vendor/makefun-bot.ts (the kit's own SDK,
// vendored unchanged); the trading logic lives in ./strategy.ts.

import { runBot } from './vendor/makefun-bot.ts';
import { SpikeDipStrategy } from './strategy.ts';

const strategy = new SpikeDipStrategy();

await runBot({
  onBatch(state, batch) {
    return strategy.decide(state, batch);
  },
});
