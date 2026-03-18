/**
 * Stacks trade layer: quote and execute swap via ALEX only (server key, full auto).
 */

import { createNetwork } from '@stacks/network';
import { STACKS_CONTRACTS } from '@alphaclaw/shared';
import { getStxBalance, getFtBalance, getStacksBalances } from './stacks-client.js';
import { getTokenAddress, getTokenDecimals } from '@alphaclaw/shared';
import {
  isAlexPair,
  getAlexQuote,
  executeAlexSwap,
} from './alex-swap.js';

const DEFAULT_MAINNET_URL = 'https://api.hiro.so';
const DEFAULT_TESTNET_URL = 'https://api.testnet.hiro.so';

function getApiBase(): string {
  return (
    process.env.STACKS_API_URL ??
    process.env.HIRO_API_URL ??
    (STACKS_CONTRACTS.network === 'testnet' ? DEFAULT_TESTNET_URL : DEFAULT_MAINNET_URL)
  );
}

/** Network config for @stacks/transactions (mainnet or testnet with optional custom URL). */
export function getStacksNetwork(): ReturnType<typeof createNetwork> {
  const isTestnet = STACKS_CONTRACTS.network === 'testnet';
  const baseUrl = getApiBase();
  return createNetwork({
    network: isTestnet ? 'testnet' : 'mainnet',
    client: { baseUrl },
  });
}

/** Network name for display / yield-executor (mainnet or testnet). */
export function getStacksNetworkName(): 'mainnet' | 'testnet' {
  return (process.env.STACKS_NETWORK ?? 'mainnet').toLowerCase() === 'testnet' ? 'testnet' : 'mainnet';
}

export interface StacksQuoteResult {
  amountOut: bigint;
  amountIn: bigint;
  rate: number;
  route: Array<{ tokenIn: string; tokenOut: string }>;
}

/**
 * Get a quote for swapping tokenIn -> tokenOut. ALEX only; both tokens must be in ALEX swappable list.
 */
export async function getStacksQuote(params: {
  tokenInSymbol: string;
  tokenOutSymbol: string;
  amountIn: bigint;
}): Promise<StacksQuoteResult> {
  const { tokenInSymbol, tokenOutSymbol, amountIn } = params;

  const ok = await isAlexPair(tokenInSymbol, tokenOutSymbol);
  if (!ok) {
    throw new Error(
      `Swap only supports ALEX tokens. Both "${tokenInSymbol}" and "${tokenOutSymbol}" must be in the ALEX swappable list. Use GET /api/trade/alex-tokens for the list.`,
    );
  }

  return getAlexQuote({
    tokenInSymbol,
    tokenOutSymbol,
    amountIn,
  });
}

/**
 * Get balance for a token for a given principal.
 * - For core tokens (in shared token list) use precise asset IDs.
 * - For other tokens (e.g. ALEX, aUSD), fall back to scanning all SIP-10 balances by symbol.
 */
export async function getStacksTokenBalance(
  principal: string,
  tokenSymbol: string
): Promise<bigint> {
  const assetId = getTokenAddress(tokenSymbol);
  if (assetId === 'STX') {
    return getStxBalance(principal);
  }

  // For SIP-10 tokens, prefer scanning balances by symbol. This is more robust
  // when contract IDs or symbol casing differ between our config and the
  // underlying Hiro balances map (e.g. USDCx vs USDCX-TOKEN).
  const balances = await getStacksBalances(principal);

  const upper = tokenSymbol.toUpperCase();
  for (const [id, entry] of Object.entries(balances.fungible_tokens)) {
    const parts = id.split('::');
    const rawSymbol = (parts[1] ?? id).toUpperCase();
    // Direct symbol match (e.g. STX, sBTC)
    if (rawSymbol === upper) {
      return BigInt(entry.balance ?? '0');
    }
    // Handle known alias: USDCx vs USDCX-TOKEN on Hiro
    if (upper === 'USDCX' && rawSymbol === 'USDCX-TOKEN') {
      return BigInt(entry.balance ?? '0');
    }
  }
  return 0n;
}

/**
 * Base stable token used as source for "buy" in agent flows. On Stacks we previously used USDCx; ALEX uses aUSD etc.
 */
export const STACKS_BASE_STABLE = 'USDCx';

/**
 * Execute a swap on Stacks via ALEX only. Both tokens must be ALEX swappable.
 */
export async function executeStacksSwap(params: {
  serverWalletId: string;
  serverWalletAddress: string;
  tokenInSymbol: string;
  tokenOutSymbol: string;
  amountIn: bigint;
  amountOutMin: bigint;
}): Promise<{ txId: string }> {
  const {
    serverWalletId,
    serverWalletAddress,
    tokenInSymbol,
    tokenOutSymbol,
    amountIn,
    amountOutMin,
  } = params;

  const balance = await getStacksTokenBalance(serverWalletAddress, tokenInSymbol);
  if (balance < amountIn) {
    throw new Error(
      `Insufficient ${tokenInSymbol} balance: have ${balance}, need ${amountIn}`,
    );
  }

  const ok = await isAlexPair(tokenInSymbol, tokenOutSymbol);
  if (!ok) {
    throw new Error(
      `Swap only supports ALEX tokens. Both "${tokenInSymbol}" and "${tokenOutSymbol}" must be in the ALEX swappable list.`,
    );
  }

  return executeAlexSwap({
    serverWalletId,
    serverWalletAddress,
    tokenInSymbol,
    tokenOutSymbol,
    amountIn,
    amountOutMin,
  });
}
