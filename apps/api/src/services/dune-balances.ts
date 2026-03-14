import { STACKS_TOKENS, getTokenAddress, getTokenDecimals } from '@alphaclaw/shared';
import { getTokenPriceUsd } from './price-service.js';
import { getStacksBalances } from '../lib/stacks-client.js';

export interface StacksPortfolioBalance {
  chain_id: number;
  address: string;
  amount: string;
  symbol: string;
  name: string;
  decimals: number;
  price_usd: number;
  value_usd: number;
}

/**
 * Fetch token balances for a Stacks wallet using the Stacks API and local price service.
 */
export async function getWalletBalances(walletAddress: string): Promise<StacksPortfolioBalance[]> {
  const results: StacksPortfolioBalance[] = [];

  // Single balances call for STX + all SIP-10 tokens
  const balances = await getStacksBalances(walletAddress);

  // 1) Known core tokens (STACKS_TOKENS) with proper pricing
  const knownAssetIds = new Set<string>();

  for (const symbol of STACKS_TOKENS) {
    const baseAssetId = getTokenAddress(symbol);
    if (!baseAssetId) continue;

    const decimals = getTokenDecimals(symbol);
    let assetIdToUse = baseAssetId;
    let balanceRaw: bigint;

    if (baseAssetId === 'STX') {
      balanceRaw = BigInt(balances.stx);
    } else {
      // Hiro may report SIP-10 tokens with an extended asset ID including ::symbol,
      // e.g. "SP...ststx-token::ststx". Try exact match first, then prefix match.
      const ftMap = balances.fungible_tokens;
      const direct = ftMap[baseAssetId];
      if (direct) {
        balanceRaw = BigInt(direct.balance ?? '0');
      } else {
        const lowerBase = baseAssetId.toLowerCase();
        const fallbackEntry = Object.entries(ftMap).find(([id]) =>
          id.toLowerCase().startsWith(lowerBase + '::'),
        );
        if (fallbackEntry) {
          assetIdToUse = fallbackEntry[0];
          balanceRaw = BigInt(fallbackEntry[1].balance ?? '0');
        } else {
          balanceRaw = 0n;
        }
      }
    }

    if (balanceRaw === 0n) continue;

    knownAssetIds.add(assetIdToUse.toLowerCase());

    const priceUsd = await getTokenPriceUsd(symbol);
    const amount = Number(balanceRaw) / 10 ** decimals;
    const valueUsd = amount * priceUsd;

    results.push({
      chain_id: 1, // Stacks mainnet indicator (not used downstream beyond typing)
      address: assetIdToUse,
      amount: balanceRaw.toString(),
      symbol,
      name: symbol,
      decimals,
      price_usd: priceUsd,
      value_usd: valueUsd,
    });
  }

  // 2) Any other fungible tokens with positive balances (e.g. ALEX, aUSD)
  for (const [assetId, entry] of Object.entries(balances.fungible_tokens)) {
    const balanceRaw = BigInt(entry.balance ?? '0');
    if (balanceRaw === 0n) continue;

    // Skip ones we already added as core tokens
    if (knownAssetIds.has(assetId.toLowerCase())) continue;

    const parts = assetId.split('::');
    const rawSymbol = parts[1] ?? assetId;
    let symbol = rawSymbol.toUpperCase();

    // Normalize known aliases from Hiro to our canonical symbols
    if (symbol === 'USDCX-TOKEN') symbol = 'USDCx';
    const decimals = 6; // best-effort default; we don't know on-chain decimals here
    const amount = Number(balanceRaw) / 10 ** decimals;

    // We don't have pricing for arbitrary ALEX tokens yet; show balance with $0 value.
    const priceUsd = 0;
    const valueUsd = amount * priceUsd;

    results.push({
      chain_id: 1,
      address: assetId,
      amount: balanceRaw.toString(),
      symbol,
      name: symbol,
      decimals,
      price_usd: priceUsd,
      value_usd: valueUsd,
    });
  }

  return results;
}

