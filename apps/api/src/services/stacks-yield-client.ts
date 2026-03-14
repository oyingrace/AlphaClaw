import type { YieldOpportunity } from '@alphaclaw/shared';

/**
 * Approximate daily $ yield for the whole pool from APR and TVL (for display).
 * Actual per-user rewards = (APR/100) * userDeposit / 365.
 */
function dailyRewardsFromApr(apr: number, tvl: number): number {
  return (apr / 100) * tvl / 365;
}

/**
 * Static Stacks yield opportunities for the Stacks-port v1.
 *
 * These are curated examples rather than live on-chain discovery. They are
 * presented in the same shape as Merkl opportunities so the existing
 * overview UI and types continue to work unchanged.
 */
export async function fetchStacksYieldOpportunities(): Promise<YieldOpportunity[]> {
  const opportunities: YieldOpportunity[] = [
    {
      id: 'ststx-liquid-staking',
      name: 'stSTX Liquid Staking',
      vaultAddress: 'SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token',
      protocol: 'Liquid Staking',
      status: 'LIVE',
      apr: 7.5,
      tvl: 2_000_000,
      dailyRewards: dailyRewardsFromApr(7.5, 2_000_000),
      tokens: [
        {
          symbol: 'stSTX',
          address: 'SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token',
          decimals: 6,
        },
      ],
      depositUrl: 'https://explorer.hiro.so/txid',
      type: 'staking',
      merklUrl: undefined,
    },
    {
      id: 'native-stx-stacking',
      name: 'Native STX Stacking',
      vaultAddress: 'STX',
      protocol: 'Stacks Consensus',
      status: 'LIVE',
      apr: 6.0,
      tvl: 50_000_000,
      dailyRewards: dailyRewardsFromApr(6, 50_000_000),
      tokens: [
        {
          symbol: 'STX',
          address: 'STX',
          decimals: 6,
        },
      ],
      depositUrl: 'https://stacks.co/earn/bitcoin',
      type: 'staking',
      merklUrl: undefined,
    },
    {
      id: 'usdcx-sbtc-yield',
      name: 'USDCx/sBTC Yield Pair',
      vaultAddress: 'USDCx-sBTC',
      protocol: 'Stacks DeFi',
      status: 'LIVE',
      apr: 4.0,
      tvl: 1_000_000,
      dailyRewards: dailyRewardsFromApr(4, 1_000_000),
      tokens: [
        {
          symbol: 'USDCx',
          address: 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx',
          decimals: 6,
        },
        {
          symbol: 'sBTC',
          address: 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token',
          decimals: 8,
        },
      ],
      depositUrl: 'https://explorer.hiro.so',
      type: 'lp',
      merklUrl: undefined,
    },
  ];

  // Keep highest APR first, limit to top 5
  return opportunities.sort((a, b) => b.apr - a.apr).slice(0, 5);
}

