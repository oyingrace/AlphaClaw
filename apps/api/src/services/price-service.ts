/**
 * Stacks price service: fetch token prices for USDCx, sBTC, STX.
 * Uses external API (e.g. Coingecko) or fixed 1.0 for stables. Replace with DEX/oracle when available.
 */

import { STACKS_TOKENS } from '@alphaclaw/shared';

const lastKnownPrices = new Map<string, number>();

/** Fetch current prices for Stacks tokens. USDCx = 1; STX and sBTC from Coingecko. */
export async function fetchAllPrices(): Promise<Map<string, number>> {
  const results = new Map<string, number>();

  // USDCx is the reference stable — $1
  results.set('USDCx', 1);

  // STX, stSTX and sBTC from Coingecko
  let coingeckoOk = true;
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=blockstack,stacking-dao,bitcoin&vs_currencies=usd',
    );
    const data = (await res.json()) as {
      blockstack?: { usd?: number };
      'stacking-dao'?: { usd?: number };
      bitcoin?: { usd?: number };
    };
    if (typeof data.blockstack?.usd === 'number') {
      results.set('STX', data.blockstack.usd);
    }
    if (typeof data['stacking-dao']?.usd === 'number') {
      results.set('stSTX', data['stacking-dao'].usd);
    } else if (typeof data.blockstack?.usd === 'number') {
      // Fallback: if Coingecko doesn't return stSTX yet, approximate with STX.
      results.set('stSTX', data.blockstack.usd);
    }
    if (typeof data.bitcoin?.usd === 'number') results.set('sBTC', data.bitcoin.usd);
  } catch (err) {
    coingeckoOk = false;
    console.warn('Coingecko price fetch failed, using fallbacks/last known:', err);
  }

  // If Coingecko is unavailable and we don't have any cached values yet,
  // populate conservative non-zero defaults so the UI doesn't show $0.00.
  if (!coingeckoOk) {
    if (!results.has('STX') && lastKnownPrices.has('STX')) {
      results.set('STX', lastKnownPrices.get('STX')!);
    } else if (!results.has('STX')) {
      results.set('STX', 1); // fallback heuristic
    }

    if (!results.has('stSTX') && lastKnownPrices.has('stSTX')) {
      results.set('stSTX', lastKnownPrices.get('stSTX')!);
    } else if (!results.has('stSTX')) {
      results.set('stSTX', 1); // approximate STX when unknown
    }

    if (!results.has('sBTC') && lastKnownPrices.has('sBTC')) {
      results.set('sBTC', lastKnownPrices.get('sBTC')!);
    } else if (!results.has('sBTC')) {
      results.set('sBTC', 30000); // rough BTC-denominated fallback
    }
  }

  // Fallback to last known
  for (const symbol of STACKS_TOKENS) {
    if (!results.has(symbol) && lastKnownPrices.has(symbol)) {
      results.set(symbol, lastKnownPrices.get(symbol)!);
    }
    if (results.has(symbol)) {
      lastKnownPrices.set(symbol, results.get(symbol)!);
    }
  }

  return results;
}

/** Get price for a single token (from cache or fetch). */
export async function getTokenPriceUsd(tokenSymbol: string): Promise<number> {
  const prices = await fetchAllPrices();
  return prices.get(tokenSymbol) ?? 0;
}
