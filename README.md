# Kiyoshi

**An autonomous FX agent on Celo.** Kiyoshi watches every local-currency corridor on Celo, compares Textile FX's RFQ market with Uniswap v3 pools at several trade sizes, and trades the gap whenever it beats costs. The same engine powers **Kiyoshi Convert**, a non-custodial best-rate converter for people moving between dollars and reais, pesos or naira.

Built for Celo's **Agents on Open Rails** hackathon.

| | |
|---|---|
| **Live dashboard** | https://agentkiyoshi.lovable.app |
| **Convert** | https://agentkiyoshi.lovable.app/convert |
| **Agent API** | https://kiyoshi-oz4x.onrender.com/status |
| **ERC-8004 identity** | Agent #9991 on the Celo Identity Registry |
| **Agent wallet** | [`0x497F12830607015Ed5ec9736afe43aaF8496512f`](https://celoscan.io/address/0x497F12830607015Ed5ec9736afe43aaF8496512f) |
| **Attribution tag (ERC-8021)** | `celo_f6214d29d540` |

---

## Results

First evening live (Oct 25, 2026), starting from a $35 bankroll:

- **52 round trips, 100% profitable**, every one verifiable on Celoscan
- **+$5.27 realized profit** (about +15% on capital)
- **$1,210 of volume filled on Textile FX**
- The wBRL gap between Uniswap and Textile went from about 0.6% to 0.002% as Kiyoshi traded it closed

Live, up-to-date numbers are on the dashboard and at `/status`.

---

## How it works

### The trader

Every 60 seconds Kiyoshi:

1. **Scans** each Celo corridor (wBRL, wARS, cNGN against USDT) in both directions: buy on Uniswap and sell on Textile, or the reverse. Uniswap is quoted through QuoterV2 across all fee tiers, Textile through its v2 RFQ preview.
2. **Sizes** each route at 100%, 50% and 25% of its maximum trade, because bigger trades move the pool and the best dollar profit is not always at full size.
3. **Executes** the best route if its net edge clears the minimum: leg 1 on the cheaper venue, leg 2 on the other with a **firm Textile quote that must break even** or a Uniswap swap with a minimum-output limit.
4. **Tags every transaction** with the ERC-8021 attribution suffix, through one wallet function that is the only path to the chain.
5. **Records** every cycle and its P&L, and reports equity read at a single block that includes its latest transaction.

### Safety

- **Loss guard:** if leg 2 can't complete, the leftover inventory is held rather than sold at more than a 0.5% loss, for up to 30 minutes, after which it is sold to cap currency risk. No new trades open while inventory is held.
- **Slippage cap:** 0.3% on every Uniswap leg.
- **Verified counterparties:** Kiyoshi refuses to send to any reactor that is not in Textile's published address book, and checks Uniswap's router against the official factory before trading.
- **Textile reservations:** after selling on Textile, Kiyoshi waits for the RFQ reservation to clear instead of colliding with it.
- **Clean deploys:** on shutdown it finishes the current cycle before exiting, and a new instance waits 60 seconds before trading, so two copies never trade at once.

### Kiyoshi Convert

A best-rate converter for people, using the same quoting logic.

1. Enter an amount (e.g. 10 USDT to wBRL). Kiyoshi quotes it on Uniswap and Textile and shows which is better and by how much.
2. Kiyoshi builds the transactions; **the user signs them in their own wallet**. Kiyoshi never holds user funds.
3. Approvals are for the exact amount, never unlimited. Uniswap swaps carry a 0.5% slippage limit; Textile quotes are firm for up to 60 seconds.
4. MiniPay users without CELO pay gas in USDT via Celo's fee-currency adapter.
5. Every transaction Convert builds carries Kiyoshi's attribution tag.

Kiyoshi's trading also keeps Celo's two venues priced consistently, so anyone converting on Celo gets a fairer rate. **Kiyoshi arbitrages so users don't have to.**

---

## Research: naira on Celo

Kiyoshi scans the cNGN corridor every cycle but has no executable route. On Oct 25, 2026 we measured three naira prices on Celo at once:

| Asset | Venue | NGN per USD | Status |
|---|---|---|---|
| NGNm | Uniswap v3 | ~1,335 | Mento NGN oracle offline (`no valid median`) |
| cNGN | Uniswap v3 (0.01% pool) | ~1,368 | Tradable both ways, deep and concentrated |
| cNGN | Textile FX RFQ | ~1,382 | Bid only, sell side empty |

That is a spread of about 3.5% that nobody can close from an ordinary wallet: Mento's naira oracle was offline, there is no NGNm/cNGN pool, the Busha on-ramp (via Textile) delivers cNGN to BNB Chain and Base only, and the issuer bridge requires a registered business. Kiyoshi will route through any path that opens.

---

## Architecture

```
src/
  config.ts      Addresses (Textile, Uniswap v3, tokens), attribution tag, corridors
  wallet.ts      viem clients; sendTagged() is the ONLY way the agent sends a transaction
  textile.ts     Textile v2 RFQ client: rates, preview, firm quotes, proof of control
  swap.ts        Tagged Textile RFQ execution with break-even guard and allowance handling
  uniswap.ts     Uniswap v3 quotes across fee tiers and tagged swaps; output read from receipts
  desk.ts        The agent: scan, size, execute, loss guard, equity, ledger, HTTP API
  convert.ts     Kiyoshi Convert: /convert/quote and /convert/build (non-custodial, tagged)
  register.ts    ERC-8004 registration
  rename.ts      Updates the ERC-8004 registration file
  backfill.ts    Rebuilds trade history from Celo mainnet into the ledger
  verify.ts      Checks the attribution tag on any transaction
  check.ts, probe.ts, arb-check.ts, capacity.ts, scan.ts, scan-ngn.ts
                 Read-only research scripts used to find and size the opportunity
```

### API

| Endpoint | Description |
|---|---|
| `GET /health` | Liveness |
| `GET /status` | Equity, P&L, realized P&L, Textile volume and fills, last scan, config, errors |
| `GET /trades?limit=N` | Executed cycles and leftover sales, newest first, with transaction hashes |
| `GET /convert/quote?from=USDT&to=wBRL&amount=10` | Both venues' output for that amount and the better one |
| `POST /convert/build` | Ready-to-sign, tagged transactions for the user's own wallet |

---

## Run it

Requires Node 22+.

```bash
npm install
npm run new-wallet            # prints a fresh agent address and key
cp .env.example .env          # put the key in AGENT_PRIVATE_KEY
npm run check                 # read-only: balances, rates, a preview quote
npm run desk                  # DRY RUN: scans and reports, sends nothing
LIVE=1 npm run desk           # trades real money
```

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_PRIVATE_KEY` | | Agent wallet key (never commit it) |
| `CELO_RPC` | `https://forno.celo.org` | Celo mainnet RPC |
| `LIVE` | `0` | `1` to trade |
| `MAX_TRADE_USD` | `20` | Max size per cycle (never more than 90% of USDT held) |
| `MIN_EDGE_USD` | `0.01` | Minimum expected profit to trade |
| `INTERVAL_SEC` | `60` | Scan interval |
| `MAX_FLATTEN_LOSS_BPS` | `50` | Loss guard on leftover inventory |
| `MAX_HOLD_MIN` | `30` | Max time to hold leftover inventory |
| `PORT` | | Serve the HTTP API |
| `DATA_DIR` | `.` | Where the ledger is stored (a persistent disk in production) |
| `BASELINE_EQUITY`, `BASELINE_SINCE` | | Starting equity and date for P&L |
| `MAX_CONVERT_USD` | `500` | Max USDT per Convert request |

### Verify it yourself

```bash
npx tsx src/verify.ts <txHash>   # shows sender, contract and attribution tag
npx tsx src/backfill.ts          # rebuilds every trade from the chain
```

---

## Contracts (Celo mainnet)

| Contract | Address |
|---|---|
| Textile FX LimitOrderReactor | `0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3` |
| Uniswap v3 SwapRouter02 | `0x5615CDAb10dc425a742d643d949a7F474C01abc4` |
| Uniswap v3 QuoterV2 | `0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8` |
| ERC-8004 Identity Registry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| USDT | `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e` |
| wBRL (Ripio) | `0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0` |
| wARS (Ripio) | `0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D` |
| cNGN | `0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f` |

---

## Limitations

- Kiyoshi is a taker on Textile: it fills makers' quotes but does not publish its own.
- Profit depends on gaps that other traders open; long quiet periods are normal once a gap closes.
- The naira corridor is monitored but not tradable until a route onto Celo opens.
- The code is new and has not been externally audited. Only trading capital should sit in the agent wallet.

---

Built by **Mel Okoye** ([@0xJedi](https://github.com/MELcodes99)) for Celo's Agents on Open Rails hackathon.

## How to run

Requires Node 20+.

```bash
git clone https://github.com/MELcodes99/kiyoshi && cd kiyoshi
npm ci
npm test                 # unit + safety tests, no wallet or network needed
npm run typecheck
```

### Run the agent without funds (watch mode)

```bash
cp .env.example .env
npm run new-wallet       # prints a fresh throwaway key, paste it into AGENT_PRIVATE_KEY
npm run desk             # LIVE=0: scans Textile vs Uniswap every 60s, sends nothing
```

An unfunded wallet runs in watch mode: Kiyoshi quotes every corridor at full size and logs the edges it would trade. Open http://localhost:3000/status to see the live scan, /trades for the ledger, /health for liveness.

### Run live

Fund the wallet with USDT on Celo (gas is paid in USDT through the fee-currency adapter, so no CELO needed), set `LIVE=1`, and run `npm run desk`. Only run one live instance per wallet.

### Verify onchain activity

```bash
npx tsx scripts/verify.ts <tx hash or celoscan link>   # checks the ERC-8021 attribution tag
npx tsx scripts/wallet-stats.ts                        # trades, volume and tag coverage
```
