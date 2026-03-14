export const STACKS_TOKENS = [ 'sBTC', 'STX', 'stSTX','USDCx'] as const;

export type StacksToken = (typeof STACKS_TOKENS)[number];

export type SupportedToken = StacksToken;

export interface TokenInfo {
  symbol: SupportedToken;
  name: string;
  priceUsd: number;
  change24hPct: number;
  sparkline7d: number[];
  flag?: string;
  decimals?: number;
}

export interface MarketTokensResponse {
  tokens: TokenInfo[];
  updatedAt: string;
}


//Mainnet addresses
export const STACKS_TOKEN_ADDRESSES: Record<StacksToken, string> = {
  USDCx: 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx',
  sBTC: 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token',
  stSTX: 'SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token',
  STX: 'STX', // native asset
}; 

export const ALL_TOKEN_ADDRESSES: Record<string, string> = {
  ...STACKS_TOKEN_ADDRESSES,
};

export const TOKEN_METADATA: Record<
  string,
  { name: string; decimals: number; logo?: string; flag?: string }
> = {
  USDCx: { name: 'USDC on Stacks', decimals: 6 },
  sBTC: { name: 'sBTC on Stacks', decimals: 8 },
  stSTX: { name: 'stSTX on Stacks', decimals: 6 },
  STX: { name: 'Stacks', decimals: 6 },
};

export function getTokenDecimals(symbol: string): number {
  return TOKEN_METADATA[symbol]?.decimals ?? 6;
}

export function getTokenAddress(symbol: string): string | undefined {
  return ALL_TOKEN_ADDRESSES[symbol];
}

export const TARGET_TOKENS = [...STACKS_TOKENS] as const;
export type TargetToken = (typeof TARGET_TOKENS)[number];
