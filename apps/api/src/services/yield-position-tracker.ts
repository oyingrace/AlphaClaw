/**
 * Stacks yield position tracker: sync yield_positions from on-chain Stacks balances.
 * Supports stSTX (Stacking DAO); other opportunities can be added by reading balances.
 */

import { createSupabaseAdmin } from '@alphaclaw/db';
import { getStacksTokenBalance } from '../lib/stacks-trade.js';
import type { YieldOpportunity } from '@alphaclaw/shared';
import { STACKS_CONTRACTS } from '@alphaclaw/shared';
import { getStakingContractStake } from '../lib/stacks-read.js';

const supabaseAdmin = createSupabaseAdmin(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const STSTX_DECIMALS = 6;

function normalizeVaultKey(vaultAddress: string): string {
  return vaultAddress.toLowerCase();
}

/**
 * Upsert yield_positions after a successful Stacks deposit.
 * For stSTX we use the current stSTX balance as lp_shares and add amountUsd to deposit_amount_usd.
 */
export async function upsertYieldPositionAfterDeposit(params: {
  walletAddress: string;
  serverWalletAddress: string;
  vaultAddress: string;
  amountUsd: number;
}): Promise<void> {
  const { walletAddress, serverWalletAddress, vaultAddress, amountUsd } = params;
  const vaultKey = normalizeVaultKey(vaultAddress);

  // Testnet: use AlphaClaw staking contract state instead of stSTX token balance.
  if (STACKS_CONTRACTS.network === 'testnet') {
    const stakingId = STACKS_CONTRACTS.stakingContractId;
    if (!stakingId) {
      console.warn(
        '[yield-position-tracker] STACKS_STAKING_CONTRACT_ID not configured, skipping upsert for testnet',
      );
      return;
    }

    const canonicalVaultKey = normalizeVaultKey(stakingId);
    try {
      const { amount } = await getStakingContractStake(serverWalletAddress);
      const lpShares = Number(amount);

      const { data: existingRow } = await supabaseAdmin
        .from('yield_positions')
        .select('deposit_amount_usd, deposited_at')
        .eq('wallet_address', walletAddress)
        .eq('vault_address', canonicalVaultKey)
        .maybeSingle();

      const existingDepositUsd =
        (existingRow as { deposit_amount_usd?: number } | null)?.deposit_amount_usd ?? 0;
      const totalDepositUsd = existingDepositUsd + amountUsd;
      const depositedAt =
        (existingRow as { deposited_at?: string } | null)?.deposited_at ??
        new Date().toISOString();

      const { error } = await supabaseAdmin.from('yield_positions').upsert(
        {
          wallet_address: walletAddress,
          vault_address: canonicalVaultKey,
          protocol: 'AlphaClaw Staking',
          lp_shares: lpShares,
          deposit_token: 'STX',
          deposit_amount_usd: totalDepositUsd,
          deposited_at: depositedAt,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'wallet_address,vault_address' },
      );

      if (error) {
        console.error('[yield-position-tracker] Failed to upsert testnet yield position:', error);
      }
    } catch (err) {
      console.error(
        '[yield-position-tracker] Error while reading testnet staking position:',
        err,
      );
    }
    return;
  }

  // Mainnet: stSTX liquid staking via Stacking DAO.
  if (!vaultAddress.includes('ststx') && !vaultAddress.includes('stSTX')) {
    console.warn(
      '[yield-position-tracker] Unknown Stacks vault on mainnet, skipping upsert:',
      vaultAddress,
    );
    return;
  }

  const balance = await getStacksTokenBalance(serverWalletAddress, 'stSTX');
  const lpShares = Number(balance);

  const { data: existingRow } = await supabaseAdmin
    .from('yield_positions')
    .select('deposit_amount_usd, deposited_at')
    .eq('wallet_address', walletAddress)
    .eq('vault_address', vaultKey)
    .maybeSingle();

  const existingDepositUsd = (existingRow as { deposit_amount_usd?: number } | null)?.deposit_amount_usd ?? 0;
  const totalDepositUsd = existingDepositUsd + amountUsd;
  const depositedAt = (existingRow as { deposited_at?: string } | null)?.deposited_at ?? new Date().toISOString();

  const { error } = await supabaseAdmin.from('yield_positions').upsert(
    {
      wallet_address: walletAddress,
      vault_address: vaultKey,
      protocol: 'Liquid Staking',
      lp_shares: lpShares,
      deposit_token: 'stSTX',
      deposit_amount_usd: totalDepositUsd,
      deposited_at: depositedAt,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'wallet_address,vault_address' },
  );

  if (error) {
    console.error('[yield-position-tracker] Failed to upsert yield position:', error);
  }
}

/**
 * Clear yield_positions after a successful withdraw.
 */
export async function clearYieldPositionAfterWithdraw(params: {
  walletAddress: string;
  vaultAddress: string;
}): Promise<void> {
  const { walletAddress, vaultAddress } = params;
  const vaultKey = normalizeVaultKey(vaultAddress);

  const { error } = await supabaseAdmin
    .from('yield_positions')
    .update({
      lp_shares: 0,
      deposit_amount_usd: 0,
      updated_at: new Date().toISOString(),
    })
    .eq('wallet_address', walletAddress)
    .eq('vault_address', vaultKey);

  if (error) {
    console.error('[yield-position-tracker] Failed to clear yield position:', error);
  }
}

/**
 * Light sync: verify DB rows against on-chain. Clear any where on-chain shows 0.
 */
export async function syncYieldPositionsFromChain(params: {
  walletAddress: string;
  serverWalletAddress: string;
}): Promise<void> {
  const { walletAddress, serverWalletAddress } = params;

  const { data: positions, error: fetchError } = await supabaseAdmin
    .from('yield_positions')
    .select('vault_address, lp_shares')
    .eq('wallet_address', walletAddress)
    .gt('lp_shares', 0);

  if (fetchError || !positions?.length) return;

  const stakingId = STACKS_CONTRACTS.stakingContractId;
  const stakingKey = stakingId ? normalizeVaultKey(stakingId) : null;

  for (const row of positions) {
    const vaultAddr = (row.vault_address as string) ?? '';

    // Testnet: clear AlphaClaw staking positions when on-chain amount is zero.
    if (STACKS_CONTRACTS.network === 'testnet' && stakingKey && vaultAddr === stakingKey) {
      try {
        const { amount } = await getStakingContractStake(serverWalletAddress);
        if (amount === 0n) {
          await clearYieldPositionAfterWithdraw({
            walletAddress,
            vaultAddress: vaultAddr,
          });
        }
      } catch (err) {
        console.error(
          '[yield-position-tracker] Error while syncing testnet staking position:',
          err,
        );
      }
      continue;
    }

    // Mainnet: stSTX positions cleared when stSTX balance is zero.
    if (vaultAddr.includes('ststx') || vaultAddr.includes('stSTX')) {
      const balance = await getStacksTokenBalance(serverWalletAddress, 'stSTX');
      if (balance === 0n) {
        await clearYieldPositionAfterWithdraw({ walletAddress, vaultAddress: vaultAddr });
      }
    }
    // Other vault types: could add balance checks when we support more
  }
}

/**
 * Full sync: discover on-chain Stacks yield positions and upsert yield_positions.
 */
export async function fullSyncYieldPositionsFromChain(params: {
  walletAddress: string;
  serverWalletAddress: string;
  opportunities: YieldOpportunity[];
}): Promise<{ synced: number; cleared: number }> {
  const { walletAddress, serverWalletAddress, opportunities } = params;
  let synced = 0;
  let cleared = 0;

  const { data: existingRows } = await supabaseAdmin
    .from('yield_positions')
    .select('vault_address, lp_shares')
    .eq('wallet_address', walletAddress);

  for (const row of existingRows ?? []) {
    const vaultAddr = (row.vault_address as string) ?? '';

    // Testnet: clear AlphaClaw staking positions when on-chain amount is zero.
    const stakingId = STACKS_CONTRACTS.stakingContractId;
    const stakingKey = stakingId ? normalizeVaultKey(stakingId) : null;
    if (STACKS_CONTRACTS.network === 'testnet' && stakingKey && vaultAddr === stakingKey) {
      try {
        const { amount } = await getStakingContractStake(serverWalletAddress);
        if (amount === 0n) {
          await clearYieldPositionAfterWithdraw({ walletAddress, vaultAddress: vaultAddr });
          cleared++;
        }
      } catch (err) {
        console.error(
          '[yield-position-tracker] Error while full-syncing testnet staking position:',
          err,
        );
      }
      continue;
    }

    // Mainnet: stSTX positions cleared when stSTX balance is zero.
    if (vaultAddr.includes('ststx') || vaultAddr.includes('stSTX')) {
      const balance = await getStacksTokenBalance(serverWalletAddress, 'stSTX');
      if (balance === 0n) {
        await clearYieldPositionAfterWithdraw({ walletAddress, vaultAddress: vaultAddr });
        cleared++;
      }
    }
  }

  if (STACKS_CONTRACTS.network === 'testnet') {
    // Testnet: derive position from AlphaClaw staking contract state.
    const stakingId = STACKS_CONTRACTS.stakingContractId;
    if (stakingId) {
      try {
        const { amount } = await getStakingContractStake(serverWalletAddress);
        if (amount > 0n) {
          const lpShares = Number(amount);
          const stxPriceUsd = Number(process.env.STX_PRICE_USD ?? '0.25');
          const depositAmountUsd = (Number(amount) / 10 ** STSTX_DECIMALS) * stxPriceUsd;

          const canonicalVaultKey = normalizeVaultKey(stakingId);

          const { data: existingRow } = await supabaseAdmin
            .from('yield_positions')
            .select('deposited_at')
            .eq('wallet_address', walletAddress)
            .eq('vault_address', canonicalVaultKey)
            .maybeSingle();

          const { error } = await supabaseAdmin.from('yield_positions').upsert(
            {
              wallet_address: walletAddress,
              vault_address: canonicalVaultKey,
              protocol: 'AlphaClaw Staking',
              lp_shares: lpShares,
              deposit_token: 'STX',
              deposit_amount_usd: depositAmountUsd,
              deposited_at:
                (existingRow as { deposited_at?: string } | null)?.deposited_at ??
                new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'wallet_address,vault_address' },
          );
          if (!error) synced++;
        }
      } catch (err) {
        console.error(
          '[yield-position-tracker] Error while full-syncing testnet staking position:',
          err,
        );
      }
    }
  } else {
    // Mainnet: stSTX upsert if balance > 0
    const ststxOpp = opportunities.find(
      (o) =>
        o.vaultAddress?.toLowerCase().includes('ststx') || o.id === 'ststx-liquid-staking',
    );
    if (ststxOpp) {
      const balance = await getStacksTokenBalance(serverWalletAddress, 'stSTX');
      if (balance > 0n) {
        const lpShares = Number(balance);
        const ststxPriceUsd = Number(process.env.STX_PRICE_USD ?? '1.5'); // stSTX ~ STX price
        const depositAmountUsd = (Number(balance) / 10 ** STSTX_DECIMALS) * ststxPriceUsd;

        const { data: existingRow } = await supabaseAdmin
          .from('yield_positions')
          .select('deposited_at')
          .eq('wallet_address', walletAddress)
          .eq('vault_address', normalizeVaultKey(ststxOpp.vaultAddress))
          .maybeSingle();

        const { error } = await supabaseAdmin.from('yield_positions').upsert(
          {
            wallet_address: walletAddress,
            vault_address: normalizeVaultKey(ststxOpp.vaultAddress),
            protocol: ststxOpp.protocol ?? 'Liquid Staking',
            lp_shares: lpShares,
            deposit_token: 'stSTX',
            deposit_amount_usd: depositAmountUsd,
            deposited_at:
              (existingRow as { deposited_at?: string } | null)?.deposited_at ??
              new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'wallet_address,vault_address' },
        );
        if (!error) synced++;
      }
    }
  }

  return { synced, cleared };
}
