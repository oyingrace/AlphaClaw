# Plan: Testnet staked STX in Active Positions & Claimable Rewards

## Goal

When the yield agent runs on **testnet** (AlphaClaw `alphaclaw-stake-v2` + RewardToken), make:

1. **Active positions** show the staked amount (from contract state) in the yield dashboard.
2. **Claimable rewards** show pending RewardToken from the staking contract in the "Claimable Rewards" card.

---

## Current behavior (why testnet is missing)

- **Positions**: The position tracker only knows **stSTX** (mainnet). It uses `getStacksTokenBalance(serverWalletAddress, 'stSTX')` to get `lp_shares` and upserts/syncs from that. On testnet there is no stSTX token—the “position” lives only in the staking contract state (`get-stake(principal)` → `{ amount, last-claim }`), so nothing is written to `yield_positions` and the UI shows 0 positions.
- **Rewards**: `fetchClaimableRewards` in `merkl-client.ts` is a stub that always returns `[]`. There is no integration with the AlphaClaw staking contract’s `calculate-rewards(amount, last-claim)` or RewardToken.

---

## Implementation plan

### 1. Stacks read-only contract calls (shared layer)

Add a small module (e.g. `apps/api/src/lib/stacks-read.ts`) that calls Clarity read-only functions via the Hiro API.

- **Option A**: Use `@stacks/transactions` `callReadOnlyFunction` + `cvToHex` / `principalCV` and parse the response (e.g. `cvToValue` or manual parsing of the API JSON).
- **Option B**: Use the REST endpoint `POST /v2/contracts/call-read/<contract>/<function>` with principal and encoded args; parse the `result` hex back to values.

Implement at least:

- `getStakingContractStake(principal: string): Promise<{ amount: bigint; lastClaim: bigint }>`
  - Calls `get-stake(principal)` on `STACKS_CONTRACTS.stakingContractId`.
  - Decode the map response to `{ amount, last-claim }` (both `uint` → bigint).
- `getStakingContractRewards(amount: bigint, lastClaim: bigint): Promise<bigint>`
  - Calls `calculate-rewards(amount, last-claim)` on the same contract.
  - Returns the reward amount (same scaling as in contract; RewardToken decimals from contract or config).

Use `STACKS_CONTRACTS.apiUrl` and only run these when `STACKS_CONTRACTS.network === 'testnet'` and `stakingContractId` is set.

---

### 2. Position tracker: testnet = staking contract state

**File**: `apps/api/src/services/yield-position-tracker.ts`

- **Vault key for testnet**: Use a canonical testnet vault key so DB and sync are consistent. Prefer `STACKS_CONTRACTS.stakingContractId` (e.g. `ST1...alphaclaw-stake-v2`) as `vault_address` for the AlphaClaw position. That way “active positions” and “withdraw” both refer to the same vault.

**`upsertYieldPositionAfterDeposit`**

- If `STACKS_CONTRACTS.network === 'testnet'` and we have a staking contract ID:
  - Treat the incoming `vaultAddress` as the “logical” vault (e.g. still the opportunity’s ststx-token from the analyzer). For the **stored** row use `vault_address = stakingContractId` (normalized).
  - Call `getStakingContractStake(serverWalletAddress)` to get current `amount`.
  - Upsert `yield_positions` with:
    - `vault_address`: normalized staking contract ID
    - `lp_shares`: stake `amount` (micro-STX)
    - `deposit_amount_usd`: use the `amountUsd` from the deposit (already passed in)
    - `deposit_token`: `'STX'`
    - `protocol`: e.g. `'AlphaClaw Staking'`
- Else (mainnet): keep existing logic (stSTX balance, ststx vault key).

**`syncYieldPositionsFromChain`**

- For each DB row with `vault_address` equal to the testnet staking contract ID:
  - Call `getStakingContractStake(serverWalletAddress)`.
  - If `amount === 0n`, call `clearYieldPositionAfterWithdraw` for that vault.
- Keep existing stSTX logic for mainnet.

**`fullSyncYieldPositionsFromChain`**

- When on testnet and staking contract is configured:
  - Call `getStakingContractStake(serverWalletAddress)`.
  - If `amount > 0n`: upsert one row with `vault_address` = staking contract ID, `lp_shares` = amount, `deposit_amount_usd` = (amount / 10^6) * STX price, `deposit_token` = 'STX', `protocol` = 'AlphaClaw Staking'.
- Keep existing stSTX discovery for mainnet.

**Agent cron (call site)**

- After a successful testnet deposit, the cron currently passes `result.vaultAddress` (still the opportunity’s mainnet-style vault, e.g. ststx-token). The position tracker can either:
  - Map that to the testnet staking contract ID inside `upsertYieldPositionAfterDeposit` when on testnet, or
  - Have the executor or strategy pass the “effective” vault (staking contract ID) for testnet so the tracker doesn’t have to guess. Prefer the tracker mapping so the executor stays network-agnostic.

---

### 3. Claimable rewards: testnet = AlphaClaw pending rewards

**File**: `apps/api/src/services/merkl-client.ts` (or a dedicated `stacks-rewards.ts` used by it)

**`fetchClaimableRewards(serverWalletAddress)`**

- If `STACKS_CONTRACTS.network !== 'testnet'` or missing `stakingContractId` / `rewardTokenContractId`: keep current behavior (e.g. return `[]` for now).
- If testnet and both IDs are set:
  1. Call `getStakingContractStake(serverWalletAddress)` → `{ amount, lastClaim }`.
  2. If `amount === 0n`, return `[]`.
  3. Call `getStakingContractRewards(amount, lastClaim)` → reward amount (raw units; contract uses `SCALE` so you may need to divide by 1e6 for RewardToken display decimals if the token uses 6).
  4. Build one `ClaimableReward`:
     - `token`: { address: `rewardTokenContractId`, symbol: `'RewardToken'` (or from config), decimals: 6 (or from RewardToken contract) }
     - `claimableAmount`: string of reward amount (in token units used by the UI).
     - `claimableValueUsd`: 0 unless you add a price for the test token; optional.
     - Fill other `MerklReward` fields (e.g. `amount`, `claimed`, `pending`) as needed so the UI doesn’t break.
  5. Return `[reward]`.

**Note**: The demo contract’s `(now)` returns `u0`, so `calculate-rewards` will return 0 until the contract uses block height or a real time source. The wiring should still be correct so that when `now` is fixed, claimable rewards appear without further front-end changes.

---

### 4. GET /api/yield-agent/positions (enrichment)

**File**: `apps/api/src/routes/yield-agent.ts`

- Enrichment already uses `getWalletBalances(serverWalletAddress)` for `currentValueUsd`. On testnet, the “position” is not a token balance but contract state.
- For rows where `vault_address` equals the testnet staking contract ID:
  - Either use `deposit_amount_usd` as a proxy for `currentValueUsd`, or
  - Call `getStakingContractStake(serverWalletAddress)` and set `currentValueUsd = (amount / 10^6) * stxPriceUsd` so the card shows up-to-date value. Prefer the read-only call so the card reflects current stake even if DB is slightly stale.

---

### 5. Optional: testnet opportunity and vault naming

**File**: `apps/api/src/services/stacks-yield-client.ts`

- When `STACKS_CONTRACTS.network === 'testnet'` and staking contract ID is set, add a dedicated opportunity, e.g. “AlphaClaw Staking (testnet)”, with `vaultAddress: stakingContractId`, so the UI and analyzer can show a human-readable name and the positions section can match the opportunity by `vault_address`. This avoids relying on the mainnet stSTX opportunity for testnet.

---

## Summary checklist

| # | Task | Where |
|---|------|--------|
| 1 | Add Stacks read-only helper: `get-stake`, `calculate-rewards` | New `stacks-read.ts` (or under `lib/`) |
| 2 | In position tracker: testnet branch in `upsertYieldPositionAfterDeposit` using staking contract ID and `getStakingContractStake` | `yield-position-tracker.ts` |
| 3 | In position tracker: testnet branch in `syncYieldPositionsFromChain` and `fullSyncYieldPositionsFromChain` | `yield-position-tracker.ts` |
| 4 | Implement testnet path in `fetchClaimableRewards`: get-stake → calculate-rewards → one ClaimableReward (RewardToken) | `merkl-client.ts` or `stacks-rewards.ts` |
| 5 | Enrich testnet positions in GET /api/yield-agent/positions with current value from get-stake + STX price | `yield-agent.ts` |
| 6 | (Optional) Add testnet-only opportunity with `vaultAddress = stakingContractId` | `stacks-yield-client.ts` |

---

## Contract details (alphaclaw-stake-v2)

- **Read-only**: `(get-stake (user principal))` → `{ amount: uint, last-claim: uint }`
- **Read-only**: `(calculate-rewards (amount uint) (last-claim uint))` → `uint` (reward in scaled units; contract uses `SCALE u1000000`)
- RewardToken is separate; rewards are minted/transferred on `claim-rewards` or `unstake`. The “claimable” amount we show is the result of `calculate-rewards` before any claim.

Once this is implemented, the active positions card will show the testnet staked STX as one position (vault = AlphaClaw staking), and the claimable rewards card will show pending RewardToken for that stake (non-zero once the contract’s `now` returns real time).
