## AlphaClaw Stacks testnet configuration

### 1. Deploy / record contracts on Stacks testnet

- Deploy the `RewardToken` and `alphaclaw` contracts to Stacks testnet using Clarinet or your preferred flow.
- Record the resulting contract IDs:
  - Staking contract: `ST...alphaclaw`
  - Reward token: `ST...RewardToken`

You will plug these IDs into both the backend and web app env files.

### 2. Backend (API + yield agent) env

In your API environment (e.g. `apps/api/.env` or your deployment settings), configure:

- `STACKS_NETWORK=testnet`
- `STACKS_API_URL=https://api.testnet.hiro.so`
- `STACKS_STAKING_CONTRACT_ID=<your testnet alphaclaw contract ID>`
- `STACKS_REWARD_TOKEN_CONTRACT_ID=<your testnet RewardToken contract ID>`

The backend reads these via the shared `STACKS_CONTRACTS` config from `@alphaclaw/shared`, which is then used by:

- `apps/api/src/lib/stacks-trade.ts` (network selection and API base URL)
- `apps/api/src/lib/stacks-server-wallet.ts` (address derivation on mainnet vs testnet)

### 3. Web app env (Next.js)

In `apps/web/.env.local` (or your hosting provider env), set:

- `NEXT_PUBLIC_API_URL` – base URL of the API (e.g. `http://localhost:4000` for local dev).
- `NEXT_PUBLIC_STACKS_NETWORK=testnet`
- `NEXT_PUBLIC_STACKS_API_URL=https://api.testnet.hiro.so`
- `NEXT_PUBLIC_STACKS_STAKING_CONTRACT_ID=<your testnet alphaclaw contract ID>`
- `NEXT_PUBLIC_STACKS_REWARD_TOKEN_CONTRACT_ID=<your testnet RewardToken contract ID>`

The web app uses these via:

- `apps/web/src/lib/stacks-config.ts` (`browserStacksConfig`) for network + contract IDs.
- `apps/web/src/components/network-indicator.tsx` to render the active network label in the UI.

### 4. Running against testnet locally

1. Start Clarinet or your preferred tooling to deploy contracts to testnet and obtain the IDs.
2. Fill in the backend and web env vars as above.
3. Run the API and web app:

```bash
pnpm dev:api   # or your existing API dev command
pnpm dev:web   # or your existing web dev command
```

Open the app, connect a Stacks testnet wallet via the existing connect flow, and use the Yield agent page to:

- Register the yield agent.
- Run an on-demand cycle.
- Observe positions / rewards as they are synced via the Stacks testnet contracts.

