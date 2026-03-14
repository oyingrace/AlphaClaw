import { createSupabaseAdmin, type Database } from '@alphaclaw/db';
import { STACKS_TOKENS, getTokenDecimals } from '@alphaclaw/shared';
import { logTimeline } from './agent-cron.js';
import { getStacksTokenBalance } from '../lib/stacks-trade.js';

type AgentConfigRow = Database['public']['Tables']['agent_configs']['Row'];

const supabaseAdmin = createSupabaseAdmin(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/** In-memory cache of last known balances per principal per token. */
const lastKnownBalances = new Map<string, bigint>();

function balanceKey(principal: string, symbol: string): string {
  return `${principal}:${symbol}`;
}

/**
 * Check all active agent wallets for new deposits on Stacks.
 * Call this from the agent cron tick (or a dedicated cron).
 */
export async function checkForDeposits(): Promise<void> {
  const { data: configs, error } = await supabaseAdmin
    .from('agent_configs')
    .select('wallet_address, server_wallet_address, server_wallet_id, agent_type')
    .not('server_wallet_address', 'is', null);

  if (error || !configs) return;

  for (const rawConfig of configs) {
    const config = rawConfig as Pick<
      AgentConfigRow,
      'wallet_address' | 'server_wallet_address' | 'server_wallet_id' | 'agent_type'
    >;
    const serverPrincipal = config.server_wallet_address as string;
    if (!serverPrincipal) continue;

    for (const symbol of STACKS_TOKENS) {
      try {
        const balance = await getStacksTokenBalance(serverPrincipal, symbol);

        const key = balanceKey(serverPrincipal, symbol);
        const previous = lastKnownBalances.get(key);

        lastKnownBalances.set(key, balance);

        if (previous === undefined) continue;

        if (balance > previous) {
          const depositAmount = balance - previous;
          const decimals = getTokenDecimals(symbol);
          const depositFormatted = Number(depositAmount) / 10 ** decimals;

          const agentType = config.agent_type === 'yield' ? 'yield' : 'fx';
          await logTimeline(config.wallet_address, 'funding', {
            summary: `Received ${depositFormatted.toFixed(2)} ${symbol}`,
            detail: {
              token: symbol,
              amount: depositFormatted,
              rawAmount: depositAmount.toString(),
            },
          }, undefined, agentType);
        }
      } catch (err) {
        console.error(`Failed to check ${symbol} balance for ${serverPrincipal}:`, err);
      }
    }
  }
}
