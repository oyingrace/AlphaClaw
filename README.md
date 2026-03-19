<h1 align="center">AlphaClaw</h1>

<p align="center">
  <strong>Autonomous AI agent platform on Stacks</strong> — deploy agents that trade, farm yield, and analyze markets while you sleep.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> •
  <a href="#agents">Agents</a> •
  <a href="#mainnet-vs-testnet">Mainnet vs testnet</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#stack">Stack</a>
</p>

---

## What is AlphaClaw?

AlphaClaw is an **autonomous multi-agent platform** built on the Stacks blockchain. Users connect with a wallet — no KYC, no friction — configure their agents, and let them run.

**Agents available:**

- **FX Trading Agent** — monitors live news, generates AI signals (buy/sell/hold), and executes trades on Stacks. Non-custodial.
- **Yield Agent** — scans Stacks yield opportunities (like stSTX liquid staking), deploys idle stables, and rebalances based on your guardrails.
- **Intelligence Agent (Chat)** — conversational layer with live access to prices, news, and X sentiment. Ask it anything about your portfolio or the market.

Every agent runs under user-defined **guardrails** — trade size limits, APR thresholds, allocation caps, hold periods. Every action is logged on-chain and auditable.

---

## How we use Stacks, USDCx, sBTC

- **Stacks-native execution**: Agents execute trades and yield actions on Stacks, calling into Stacks contracts (e.g. StackingDAO stSTX) from a derived server wallet.
- **USDCx as base stable**: USDCx is the primary stablecoin the FX and yield agents reason about and allocate from when sizing positions.
- **sBTC exposure**: sBTC is treated as a first-class asset in the FX universe, allowing agents to rotate between STX, sBTC, and USDCx based on news-driven signals.
- **Bitcoin-aligned yield**: The yield agent uses Stacks to access Bitcoin-correlated yield (via stSTX and native stacking flows) while keeping UX in a single dashboard.

---

## Quick Start

```bash
# Prerequisites: Node 20, pnpm 9.15.0
nvm use
pnpm install

# Set up environment (see Environment section)
cp apps/api/.env.example apps/api/.env

# Run everything (API :4000, Web :3000)
pnpm dev
```

| Command | Description |
|--------|-------------|
| `pnpm dev` | Run API + Web via Turborepo |
| `pnpm build` | Build all packages |
| `pnpm type-check` | Type-check workspace |
| `pnpm test` | Run all tests |
| `pnpm clean` | Remove build output |

---

## Agents

### FX Trading Agent

Runs on a 60s cron. For each active agent:

1. Fetch current positions and portfolio value
2. Fetch FX news via Parallel AI (cached 1hr per currency set)
3. Generate signals with Gemini 2.5 Flash — buy/sell/hold with confidence 0–100
4. Validate against guardrails (allowed currencies, daily limit, max trade size, max allocation)
5. Execute swap on Stacks (ALEX routing)
6. Log all events to `agent_timeline`, emit real-time progress via WebSocket

**Progress flow:** `fetching_news` → `analyzing` → `checking_signals` → `executing_trades` → `complete` / `error`

**FX Guardrails:** allowed/blocked currencies · daily trade limit · max trade size (USD) · max allocation % (buys only)

### Yield Agent

Continuously scans for yield opportunities on Stacks (starting with stSTX liquid staking).

Deploys idle stablecoins into the best available vaults and rebalances over time. Every deposit, withdraw, and rebalance is logged to the timeline.

**Yield Guardrails:** minimum APR threshold · maximum vault allocation % · minimum hold period

### Intelligence Agent (Chat)

Conversational AI layer with access to live tool groups:

- **CoinGecko** — live token prices and market data
- **Parallel AI** — real-time FX news
- **Grok** — X (Twitter) social sentiment

Ask it why your agent rotated, where yield is highest right now, or what's moving the market.

---

## Mainnet vs testnet

| | **Mainnet** | **Testnet** |
|---|-------------|-------------|
| **Chain** | Real STX, USDCx, sBTC, stSTX on Stacks mainnet | Faucet-funded test assets (e.g. `ST2…` addresses) |
| **API** | Hiro mainnet (`api.hiro.so` by default) | Hiro testnet (`api.testnet.hiro.so` by default) |
| **FX agent — trades** | Full set of supported assets; swaps route through **ALEX** (buy *and* sell vs USDCx). | **Demo path only:** **buy STX with USDCx** via AlphaClaw’s small **Clarity swap** contract. **Sells are disabled.** sBTC / multi-asset rotation is not executed on-chain here. |
| **Yield agent** | Curated opportunities (stSTX, native stacking, USDCx/sBTC pair, etc.); positions follow **live token balances** (e.g. stSTX) where applicable. | Same list for the UI, **plus** an **AlphaClaw staking** opportunity when `STACKS_STAKING_CONTRACT_ID` is set — deposits go to your **testnet stake contract**; positions sync from **contract state**, not mainnet stSTX. |
| **Contracts** | Point env vars at your **mainnet** contract IDs when you use custom AlphaClaw contracts. | Use **testnet** principals (e.g. `alpha-claw-swap`, `alpha-claw-stake` on testnet). |

**Summary:** Mainnet is the full product (ALEX routing, broader FX, real liquidity). Testnet is for **safe demos and judging** — wallet connect and agents run on testnet, but FX execution is intentionally narrow (USDCx → STX buys only) and yield focuses on the deployable AlphaClaw stake flow.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  FX Agent Cron (every 60s)                                           │
├──────────────────────────────────────────────────────────────────────┤
│  1. Fetch positions & portfolio value                                │
│  2. Fetch FX news (Parallel AI, cached 1hr)                         │
│  3. Generate signals (Gemini 2.5 Flash)                             │
│  4. Validate vs guardrails → Execute swap (Stacks / ALEX)           │
│  5. Log to agent_timeline, emit progress events                     │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│  Yield Agent                                                         │
├──────────────────────────────────────────────────────────────────────┤
│  Scan Stacks yield → Deploy stables → Rebalance                      │
│  Guardrails: min APR · max allocation · min hold period             │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│  Intelligence Agent (Chat)                                           │
├──────────────────────────────────────────────────────────────────────┤
│  CoinGecko prices · Parallel AI news · Grok sentiment               │
└──────────────────────────────────────────────────────────────────────┘
```

**Real-time progress:** Node.js EventEmitter → WebSocket at `/api/ws`. Frontend `useAgentProgress()` hook streams live updates to the dashboard.

**Trade execution:** On **mainnet**, swaps use **ALEX** (default slippage 0.5%). On **testnet**, FX buys use the **alpha-claw-swap** contract (USDCx → STX) only — see [Mainnet vs testnet](#mainnet-vs-testnet).

**TEE (Trusted Execution Environment):** Agent execution runs inside a TEE powered by [Phala Network](https://phala.network). Every agent run produces a cryptographic attestation — a signed proof that the agent logic executed in a secure, tamper-proof enclave. Attestations are generated per run, linked to timeline events and on-chain transactions, and are independently verifiable. This ensures that no one — not even AutoClaw operators — can tamper with agent decisions or trade execution after the fact.

---

## Stack

| Layer | Tech |
|-------|------|
| **API** | Fastify v5, WebSocket, Supabase |
| **Web** | Next.js 15, React 19, Tailwind v4, shadcn/ui, TanStack Query, Motion |
| **Auth** | Stacks wallet signature + JWT — no KYC |
| **FX AI** | Parallel AI (news), Gemini 2.5 Flash (signals) |
| **Yield** | Stacks yield opportunities (stSTX) |
| **Chat AI** | CoinGecko (prices), Parallel AI (news), Grok (sentiment) |
| **TEE** | Phala Network — secure enclave execution with per-run cryptographic attestations |

---


## Monorepo Structure

```
├── apps/
│   ├── api/          # Fastify backend (API, crons, WebSocket)
│   └── web/          # Next.js frontend (App Router, dashboard)
├── packages/
│   ├── shared/       # Types (agent config, risk, tokens, progress)
│   ├── db/           # Supabase client + generated types
│   └── typescript-config/
├── supabase/         # Migrations
```

---

## Token Universe

**Stacks:** STX, sBTC, USDCx, stSTX

---

## License

Private — see repository settings.
