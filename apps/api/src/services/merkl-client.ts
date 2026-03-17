import type { YieldOpportunity, ClaimableReward } from '@alphaclaw/shared';
import { STACKS_CONTRACTS } from '@alphaclaw/shared';
import { getStakingContractRewards, getStakingContractStake } from '../lib/stacks-read.js';
import { fetchStacksYieldOpportunities } from './stacks-yield-client.js';

const OPPORTUNITIES_CACHE_TTL = 5 * 60 * 1000; // 5 min

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const opportunitiesCache = new Map<string, CacheEntry<YieldOpportunity[]>>();

/**
 * Fetch yield opportunities for Stacks.
 */
export async function fetchYieldOpportunities(): Promise<YieldOpportunity[]> {
  const cacheKey = 'all';
  const cached = opportunitiesCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < OPPORTUNITIES_CACHE_TTL) {
    return cached.data;
  }

  const opportunities = await fetchStacksYieldOpportunities();
  opportunitiesCache.set(cacheKey, { data: opportunities, timestamp: Date.now() });
  return opportunities;
}

/**
 * Claimable rewards API for Stacks-only mode.
 * - Mainnet: currently returns an empty list (no Merkl integration).
 * - Testnet: reads pending rewards from AlphaClaw staking contract + RewardToken.
 */
export async function fetchClaimableRewards(
  walletAddress: string,
): Promise<ClaimableReward[]> {
  // Mainnet path: keep empty until Merkl integration is added.
  if (STACKS_CONTRACTS.network !== 'testnet') {
    return [];
  }

  const stakingId = STACKS_CONTRACTS.stakingContractId;
  const rewardTokenId = STACKS_CONTRACTS.rewardTokenContractId;
  if (!stakingId || !rewardTokenId) {
    return [];
  }

  try {
    const { amount, lastClaim } = await getStakingContractStake(walletAddress);
    if (amount === 0n) return [];

    const rawRewards = await getStakingContractRewards(amount, lastClaim, walletAddress);
    if (rawRewards === 0n) return [];

    // RewardToken demo: assume 6 decimals, valueUsd = 0 (test token).
    const decimals = 6;
    const humanAmount = Number(rawRewards) / 10 ** decimals;
    const humanStr = humanAmount.toString();

    const reward: ClaimableReward = {
      token: {
        address: rewardTokenId,
        symbol: 'RWT',
        decimals,
      },
      amount: humanStr,
      claimed: '0',
      pending: humanStr,
      claimableAmount: humanStr,
      claimableValueUsd: 0,
    };

    return [reward];
  } catch (err) {
    console.error('[merkl-client] Failed to fetch testnet staking rewards:', err);
    return [];
  }
}

/** Clear all caches (for testing) */
export function clearMerklCache(): void {
  opportunitiesCache.clear();
}
