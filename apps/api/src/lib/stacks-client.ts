/**
 * Stacks chain read client: balances (STX + SIP-10) via Hiro Stacks Blockchain API.
 * Used by trade executor, price service, and funding monitor for Stacks port.
 */

const DEFAULT_API_URL = 'https://api.hiro.so';

function getApiBase(): string {
  return process.env.STACKS_API_URL ?? process.env.HIRO_API_URL ?? DEFAULT_API_URL;
}

export interface StacksAddressBalances {
  stx: string; // balance in minimal units (6 decimals for STX)
  fungible_tokens: Record<string, { balance: string }>;
}

/**
 * Fetch STX and fungible token balances for a principal.
 * Principal format: ST1... or SP1... (standard) or contract principal.
 */
export async function getStacksBalances(principal: string): Promise<StacksAddressBalances> {
  const base = getApiBase().replace(/\/$/, '');
  const url = `${base}/extended/v1/address/${encodeURIComponent(principal)}/balances`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Stacks API balances failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as {
    stx?: { balance: string };
    fungible_tokens?: Record<string, { balance: string }>;
  };
  return {
    stx: data.stx?.balance ?? '0',
    fungible_tokens: data.fungible_tokens ?? {},
  };
}

/**
 * Get STX balance for a principal (in minimal units, 6 decimals).
 */
export async function getStxBalance(principal: string): Promise<bigint> {
  const balances = await getStacksBalances(principal);
  return BigInt(balances.stx);
}

/**
 * Get SIP-10 / fungible token balance for a principal.
 * assetId format: "contract_address.contract_name::asset_name" e.g. "SP...usdcx::usdcx"
 */
export async function getFtBalance(principal: string, assetId: string): Promise<bigint> {
  const balances = await getStacksBalances(principal);
  const entry = balances.fungible_tokens[assetId];
  if (!entry) return 0n;
  return BigInt(entry.balance);
}

/**
 * Get balance for a token symbol by resolving to Stacks asset ID and optional principal.
 * For native STX, assetId is "STX"; for SIP-10 use the full asset identifier from shared.
 */
export async function getTokenBalanceStacks(
  principal: string,
  tokenSymbol: string,
  assetId: string
): Promise<bigint> {
  if (assetId === 'STX') {
    return getStxBalance(principal);
  }
  return getFtBalance(principal, assetId);
}
