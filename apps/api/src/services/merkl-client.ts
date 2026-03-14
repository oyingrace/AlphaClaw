import type { YieldOpportunity, ClaimableReward } from '@alphaclaw/shared';
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
 * Placeholder rewards API for Stacks-only mode.
 * Currently returns an empty list; extend with Stacks-native rewards when available.
 */
export async function fetchClaimableRewards(
  _walletAddress: string,
): Promise<ClaimableReward[]> {
  return [];
}

/** Clear all caches (for testing) */
export function clearMerklCache(): void {
  opportunitiesCache.clear();
}
