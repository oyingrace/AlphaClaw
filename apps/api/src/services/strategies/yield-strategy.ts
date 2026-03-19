import type { GuardrailCheck } from '@alphaclaw/shared';
import type { YieldOpportunity, YieldSignal, YieldGuardrails } from '@alphaclaw/shared';
import { STACKS_CONTRACTS } from '@alphaclaw/shared';
import { fetchYieldOpportunities, fetchClaimableRewards } from '../merkl-client.js';
import { analyzeYieldOpportunities } from '../yield-analyzer.js';
import { executeYieldDeposit, executeYieldWithdraw } from '../yield-executor.js';
import { checkYieldGuardrails } from '../yield-guardrails.js';
import type {
  AgentStrategy,
  AgentConfigRow,
  StrategyContext,
  StrategyAnalysisResult,
  ExecutionResult,
  WalletContext,
  GuardrailContext,
} from './types.js';

/** Enriched opportunity with metadata for the analyzer */
export interface YieldOpportunityWithSwapMeta extends YieldOpportunity {
  depositTokenSymbol: string;
  routeFromUSDC: boolean;
}

interface YieldData {
  opportunities: YieldOpportunityWithSwapMeta[];
  claimableRewards: Array<{ token: { symbol: string; address: string }; claimableAmount: string }>;
}

/** Add minimal meta for analyzer (Stacks opportunities: stSTX, stacking, USDCx/sBTC) */
function enrichStacksOpportunities(opportunities: YieldOpportunity[]): YieldOpportunityWithSwapMeta[] {
  return opportunities.map((opp) => ({
    ...opp,
    depositTokenSymbol: opp.tokens?.[0]?.symbol ?? 'Unknown',
    routeFromUSDC: true,
  }));
}

function getGuardrails(config: AgentConfigRow): YieldGuardrails {
  const params = ((config as any).strategy_params ?? {}) as Record<string, unknown>;
  return {
    minAprThreshold: (params.minAprThreshold as number) ?? 5,
    maxSingleVaultPct: (params.maxSingleVaultPct as number) ?? 40,
    minHoldPeriodDays: (params.minHoldPeriodDays as number) ?? 3,
    maxIlTolerancePct: (params.maxIlTolerancePct as number) ?? 10,
    minTvlUsd: (params.minTvlUsd as number) ?? 50_000,
    maxVaultCount: (params.maxVaultCount as number) ?? 5,
    rewardClaimFrequencyHrs: (params.rewardClaimFrequencyHrs as number) ?? 168,
    autoCompound: (params.autoCompound as boolean) ?? false,
  };
}

export class YieldStrategy implements AgentStrategy {
  type = 'yield' as const;

  async fetchData(config: AgentConfigRow, _context: StrategyContext): Promise<YieldData> {
    const allOpportunities = await fetchYieldOpportunities();
    const opportunities = enrichStacksOpportunities(allOpportunities);

    const claimableRewards = config.server_wallet_address
      ? await fetchClaimableRewards(config.server_wallet_address)
      : [];

    return { opportunities, claimableRewards };
  }

  async analyze(
    data: unknown,
    config: AgentConfigRow,
    context: StrategyContext,
  ): Promise<StrategyAnalysisResult> {
    const { opportunities } = data as YieldData;
    const guardrails = getGuardrails(config);

    // Short-term: filter opportunities to only the vaults the executor can
    // actually handle.
    //
    // Mainnet: executor supports stSTX liquid staking vaults.
    // Testnet: executor routes all staking deposits/withdrawals to the
    // configured AlphaClaw staking contract, so signals must target that
    // canonical vault address (stakingContractId).
    const filtered = opportunities
      .filter((o) => o.tvl >= guardrails.minTvlUsd)
      .filter((o) => {
        if (STACKS_CONTRACTS.network === 'testnet') {
          if (!STACKS_CONTRACTS.stakingContractId) return false;
          return (
            o.vaultAddress.toLowerCase() ===
            STACKS_CONTRACTS.stakingContractId.toLowerCase()
          );
        }

        return o.depositTokenSymbol === 'stSTX';
      });

    const result = await analyzeYieldOpportunities({
      opportunities: filtered,
      currentPositions: context.positions.map((p: any) => ({
        vaultAddress: p.vault_address ?? p.vaultAddress ?? '',
        depositAmountUsd: Number(p.deposit_amount_usd ?? p.depositAmountUsd ?? 0),
        currentApr: p.current_apr ?? p.currentApr ?? null,
      })),
      portfolioValueUsd: context.portfolioValueUsd,
      guardrails,
      customPrompt: config.custom_prompt,
      walletAddress: config.wallet_address,
      walletBalances: context.walletBalances?.map((b) => ({
        symbol: b.symbol,
        formatted: b.formatted,
        valueUsd: b.valueUsd,
      })),
    });

    return {
      signals: result.signals,
      summary: result.strategySummary,
      sourcesUsed: result.sourcesUsed,
    };
  }

  async executeSignal(
    signal: unknown,
    wallet: WalletContext,
    _config: AgentConfigRow,
  ): Promise<ExecutionResult> {
    const s = signal as YieldSignal;

    if (s.action === 'deposit') {
      const result = await executeYieldDeposit({
        serverWalletId: wallet.serverWalletId,
        serverWalletAddress: wallet.serverWalletAddress,
        vaultAddress: String(s.vaultAddress),
        amountUsd: s.amountUsd,
      });
      return {
        success: result.success,
        txHash: result.txHash,
        amountUsd: s.amountUsd,
        vaultAddress: result.vaultAddress,
        error: result.error,
      };
    }

    if (s.action === 'withdraw') {
      const result = await executeYieldWithdraw({
        serverWalletId: wallet.serverWalletId,
        serverWalletAddress: wallet.serverWalletAddress,
        vaultAddress: String(s.vaultAddress),
      });
      return {
        success: result.success,
        txHash: result.txHash,
        error: result.error,
      };
    }

    return { success: true };
  }

  checkGuardrails(
    signal: unknown,
    config: AgentConfigRow,
    context: GuardrailContext,
  ): GuardrailCheck {
    const s = signal as YieldSignal;
    const guardrails = getGuardrails(config);

    return checkYieldGuardrails({
      signal: s,
      guardrails,
      currentPositions: context.positions.map((p: any) => ({
        vaultAddress: p.vault_address ?? p.vaultAddress ?? '',
        depositAmountUsd: Number(p.deposit_amount_usd ?? p.depositAmountUsd ?? 0),
        depositedAt: p.deposited_at ?? p.depositedAt ?? new Date().toISOString(),
      })),
      portfolioValueUsd: context.portfolioValueUsd,
    });
  }

  getProgressSteps(): string[] {
    return ['scanning_vaults', 'analyzing_yields', 'checking_yield_guardrails', 'executing_yields', 'claiming_rewards'];
  }
}
