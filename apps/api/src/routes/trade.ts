import type { FastifyInstance } from 'fastify';
import { parseUnits, formatUnits } from 'viem';
import { authMiddleware } from '../middleware/auth.js';
import { createSupabaseAdmin, type Database } from '@alphaclaw/db';
import {
  STACKS_TOKENS,
  getTokenDecimals,
  getTokenAddress,
  TOKEN_METADATA,
  type SupportedToken,
} from '@alphaclaw/shared';
import { executeSwap, sendTokens } from '../services/trade-executor.js';
import { getStacksTokenBalance } from '../lib/stacks-trade.js';
import { getAlexSwappableSymbols, getAlexTokenDecimals } from '../lib/alex-swap.js';
import { deriveStacksServerWallet } from '../lib/stacks-server-wallet.js';

const supabaseAdmin = createSupabaseAdmin(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const STACKS_BASE = 'USDCx';
const SEND_TOKENS = new Set<string>([...STACKS_TOKENS]);

function isValidTxHash(hash: string): boolean {
  return /^(0x)?[a-fA-F0-9]{64}$/.test(hash);
}

export async function tradeRoutes(app: FastifyInstance) {
  // GET /api/trade/alex-tokens — list of token symbols supported by ALEX for swaps
  app.get(
    '/api/trade/alex-tokens',
    { preHandler: authMiddleware },
    async (_request, reply) => {
      try {
        const tokens = await getAlexSwappableSymbols();
        return { tokens };
      } catch (err) {
        console.error('ALEX tokens error:', err);
        const message =
          err instanceof Error ? err.message : 'Failed to fetch ALEX tokens';
        return reply.status(500).send({ error: message });
      }
    },
  );

  // POST /api/trade/quote — ALEX only; from/to must be in ALEX swappable list
  app.post(
    '/api/trade/quote',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const body = request.body as {
        from?: string;
        to?: string;
        amount?: string;
        slippage?: number;
      };

      const { from, to, amount, slippage = 0.5 } = body;

      if (!from || !to) {
        return reply.status(400).send({
          error: "Missing 'from' or 'to' token",
        });
      }

      if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
        return reply
          .status(400)
          .send({ error: "'amount' must be a positive number" });
      }

      if (slippage < 0.01 || slippage > 50) {
        return reply
          .status(400)
          .send({ error: "'slippage' must be between 0.01 and 50" });
      }

      try {
        const alexTokens = await getAlexSwappableSymbols();
        const alexSet = new Set(alexTokens.map((t) => t.toUpperCase()));
        if (!alexSet.has(from.toUpperCase()) || !alexSet.has(to.toUpperCase())) {
          return reply.status(400).send({
            error: `Both 'from' and 'to' must be ALEX swappable tokens. Available: ${alexTokens.join(', ')}`,
          });
        }

        const fromDecimals = await getAlexTokenDecimals(from);
        const toDecimals = await getAlexTokenDecimals(to);
        const amountIn = parseUnits(amount, fromDecimals);

        const { getStacksQuote } = await import('../lib/stacks-trade.js');
        const quote = await getStacksQuote({
          tokenInSymbol: from,
          tokenOutSymbol: to,
          amountIn,
        });

        const amountOutMin =
          (quote.amountOut * BigInt(Math.floor((100 - slippage) * 100))) / 10000n;

        return {
          estimatedAmountOut: formatUnits(quote.amountOut, toDecimals),
          estimatedAmountOutRaw: quote.amountOut.toString(),
          minimumAmountOut: formatUnits(amountOutMin, toDecimals),
          minimumAmountOutRaw: amountOutMin.toString(),
          exchangeRate: quote.rate.toFixed(6),
          priceImpact: 0,
          fromToken: from,
          toToken: to,
          amountIn: amount,
        };
      } catch (err) {
        console.error('Quote error:', err);
        const message =
          err instanceof Error ? err.message : 'Failed to get quote';
        return reply.status(500).send({ error: message });
      }
    },
  );

  // POST /api/trade/execute — record a completed swap
  app.post(
    '/api/trade/execute',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const walletAddress = request.user!.walletAddress;
      const body = request.body as {
        txHash?: string;
        from?: string;
        to?: string;
        amountIn?: string;
        amountOut?: string;
        exchangeRate?: string;
      };

      const { txHash, from, to, amountIn, amountOut, exchangeRate } = body;

      if (!txHash || !isValidTxHash(txHash)) {
        return reply.status(400).send({ error: 'Invalid transaction hash' });
      }

      if (!from || !to || !amountIn || !amountOut) {
        return reply
          .status(400)
          .send({ error: 'Missing required fields: from, to, amountIn, amountOut' });
      }

      try {
        // Look up user
        const { data: user, error: userError } = await supabaseAdmin
          .from('user_profiles')
          .select('id')
          .eq('wallet_address', walletAddress)
          .single();

        if (userError || !user) {
          return reply.status(404).send({ error: 'User profile not found' });
        }

        // Insert transaction record
        const { data, error } = await supabaseAdmin
          .from('transactions')
          .insert({
            user_id: user.id,
            type: 'swap' as const,
            source_token: from,
            target_token: to,
            source_amount: parseFloat(amountIn),
            target_amount: parseFloat(amountOut),
            exchange_rate: exchangeRate ? parseFloat(exchangeRate) : null,
            tx_hash: txHash,
            status: 'confirmed' as const,
          })
          .select('id')
          .single();

        if (error) {
          console.error('Failed to record transaction:', error);
          return reply
            .status(500)
            .send({ error: 'Failed to record transaction' });
        }

        return { id: data.id, status: 'confirmed' };
      } catch (err) {
        console.error('Execute error:', err);
        return reply
          .status(500)
          .send({ error: 'Failed to record transaction' });
      }
    },
  );

  // GET /api/trade/history
  app.get(
    '/api/trade/history',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const walletAddress = request.user!.walletAddress;
      const query = request.query as {
        page?: string;
        limit?: string;
        token?: string;
        status?: string;
      };

      const page = Math.max(1, parseInt(query.page || '1', 10));
      const limit = Math.min(100, Math.max(1, parseInt(query.limit || '50', 10)));
      const offset = (page - 1) * limit;

      try {
        // Look up user
        const { data: user, error: userError } = await supabaseAdmin
          .from('user_profiles')
          .select('id')
          .eq('wallet_address', walletAddress)
          .single();

        if (userError || !user) {
          return reply.status(404).send({ error: 'User profile not found' });
        }

        // Build query
        let dbQuery = supabaseAdmin
          .from('transactions')
          .select('*', { count: 'exact' })
          .eq('user_id', user.id)
          .eq('type', 'swap')
          .order('created_at', { ascending: false })
          .range(offset, offset + limit - 1);

        if (query.token) {
          const token = String(query.token).trim();
          if (!/^[A-Za-z0-9]{1,20}$/.test(token)) {
            return reply.status(400).send({ error: `Invalid token filter` });
          }
          dbQuery = dbQuery.or(
            `source_token.eq.${token},target_token.eq.${token}`,
          );
        }

        if (query.status != null && query.status !== '') {
          const status = query.status as string;
          dbQuery = dbQuery.eq('status', status);
        }

        const { data, error, count } = await dbQuery;

        if (error) {
          console.error('Failed to fetch trade history:', error);
          return reply
            .status(500)
            .send({ error: 'Failed to fetch trade history' });
        }

        const total = count ?? 0;

        type TransactionRow = Database['public']['Tables']['transactions']['Row'];
        return {
          transactions: ((data ?? []) as TransactionRow[]).map((tx) => ({
            id: tx.id,
            type: tx.type,
            sourceToken: tx.source_token,
            targetToken: tx.target_token,
            sourceAmount: String(tx.source_amount),
            targetAmount: String(tx.target_amount),
            exchangeRate: tx.exchange_rate ? String(tx.exchange_rate) : null,
            txHash: tx.tx_hash,
            status: tx.status,
            createdAt: tx.created_at,
          })),
          pagination: {
            page,
            limit,
            total,
            hasMore: offset + limit < total,
          },
        };
      } catch (err) {
        console.error('History error:', err);
        return reply
          .status(500)
          .send({ error: 'Failed to fetch trade history' });
      }
    },
  );

  // POST /api/trade/swap — execute a swap via the agent's server wallet
  app.post(
    '/api/trade/swap',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const walletAddress = request.user!.walletAddress;
      const body = request.body as {
        from?: string;
        to?: string;
        amount?: string;
        slippage?: number;
        agent_type?: 'fx' | 'yield';
      };

      const { from, to, amount, slippage = 0.5, agent_type: requestedAgentType = 'fx' } = body;

      if (!from || !to) {
        return reply.status(400).send({ error: "Missing 'from' or 'to' token" });
      }
      if (from === to) {
        return reply.status(400).send({ error: 'Cannot swap a token to itself' });
      }
      if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
        return reply.status(400).send({ error: "'amount' must be a positive number" });
      }

      try {
        const alexTokens = await getAlexSwappableSymbols();
        const alexSet = new Set(alexTokens.map((t) => t.toUpperCase()));
        if (!alexSet.has(from.toUpperCase()) || !alexSet.has(to.toUpperCase())) {
          return reply.status(400).send({
            error: `Both 'from' and 'to' must be ALEX swappable tokens. Available: ${alexTokens.join(', ')}`,
          });
        }
      } catch (err) {
        console.error('ALEX tokens check error:', err);
        return reply.status(500).send({ error: 'Failed to validate tokens' });
      }

      const agentType = requestedAgentType === 'yield' ? 'yield' : 'fx';

      try {
        const { data: agent, error: agentError } = await supabaseAdmin
          .from('agent_configs')
          .select('server_wallet_id, server_wallet_address')
          .eq('wallet_address', walletAddress)
          .eq('agent_type', agentType)
          .maybeSingle();

        if (agentError || !agent?.server_wallet_id || !agent?.server_wallet_address) {
          return reply.status(400).send({
            error: `${agentType === 'yield' ? 'Yield' : 'FX'} agent wallet not configured. Complete onboarding first.`,
          });
        }

        const result = await executeSwap({
          serverWalletId: agent.server_wallet_id,
          serverWalletAddress: agent.server_wallet_address,
          from,
          to,
          amount,
          slippagePct: slippage,
        });

        console.info(
          `[Trade] Swap executed: ${from} → ${to} amount=${amount} txHash=${result.txHash}`,
        );

        const direction = from === 'STX' ? 'sell' : 'buy';
        const currency = direction === 'buy' ? to : from;
        const timelineTable = agentType === 'yield' ? 'yield_agent_timeline' : 'fx_agent_timeline';
        await supabaseAdmin.from(timelineTable).insert({
          wallet_address: walletAddress,
          event_type: 'trade',
          summary: `Manual swap: ${amount} ${from} → ${to}`,
          detail: {
            source: 'manual_swap',
            from,
            to,
            amountIn: result.amountIn.toString(),
            amountOut: result.amountOut.toString(),
            rate: result.rate,
          },
          currency,
          amount_usd: parseFloat(amount),
          direction,
          tx_hash: result.txHash,
        });

        return {
          txHash: result.txHash,
          amountIn: result.amountIn.toString(),
          amountOut: result.amountOut.toString(),
          exchangeRate: result.rate.toFixed(6),
        };
      } catch (err) {
        console.error('Swap error:', err);
        const message = err instanceof Error ? err.message : 'Swap failed';
        return reply.status(500).send({ error: message });
      }
    },
  );

  // GET /api/trade/balance — real-time on-chain balance for send flow (avoids stale Dune data)
  app.get(
    '/api/trade/balance',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const walletAddress = request.user!.walletAddress;
      const query = request.query as { token?: string; agent_type?: string };
      const token = query.token;
      const agentType = query.agent_type === 'yield' ? 'yield' : 'fx';

      if (!token || !SEND_TOKENS.has(token)) {
        return reply.status(400).send({
          error: `Invalid token. Must be one of: ${[...SEND_TOKENS].join(', ')}`,
        });
      }

      const { data: agent, error: agentError } = await supabaseAdmin
        .from('agent_configs')
        .select('server_wallet_address')
        .eq('wallet_address', walletAddress)
        .eq('agent_type', agentType)
        .maybeSingle();

      if (agentError || !agent?.server_wallet_address) {
        return reply.status(404).send({
          error: `${agentType === 'yield' ? 'Yield' : 'FX'} agent wallet not configured.`,
        });
      }

      if (!getTokenAddress(token)) {
        return reply.status(400).send({ error: `Unknown token: ${token}` });
      }

      const decimals = getTokenDecimals(token);
      const balance = await getStacksTokenBalance(agent.server_wallet_address, token);
      const balanceHuman = Number(formatUnits(balance, decimals));
      return { balance: balanceHuman };
    },
  );

  // POST /api/trade/send — send tokens from agent wallet to recipient
  app.post(
    '/api/trade/send',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const walletAddress = request.user!.walletAddress;
      const body = request.body as {
        token?: string;
        amount?: number;
        recipient?: string;
        agent_type?: 'fx' | 'yield';
      };

      const { token, amount, recipient, agent_type: requestedAgentType = 'fx' } = body;

      if (!token || !SEND_TOKENS.has(token)) {
        return reply.status(400).send({
          error: `Invalid token. Must be one of: ${[...SEND_TOKENS].join(', ')}`,
        });
      }
      if (amount == null || isNaN(amount) || amount <= 0) {
        return reply.status(400).send({ error: "'amount' must be a positive number" });
      }
      if (!recipient || !/^[SP][0-9ABCDEFGHJKMNPQRSTVWXYZabcdefghjkmnpqrstuvwxyz]{38,49}$/.test(recipient)) {
        return reply.status(400).send({ error: 'Invalid recipient address (Stacks SP/ST...)' });
      }

      const agentType = requestedAgentType === 'yield' ? 'yield' : 'fx';

      try {
        const { data: agent, error: agentError } = await supabaseAdmin
          .from('agent_configs')
          .select('id, server_wallet_id, server_wallet_address')
          .eq('wallet_address', walletAddress)
          .eq('agent_type', agentType)
          .maybeSingle();

        if (agentError || !agent?.server_wallet_id || !agent?.server_wallet_address) {
          return reply.status(400).send({
            error: `${agentType === 'yield' ? 'Yield' : 'FX'} agent wallet not configured. Complete onboarding first.`,
          });
        }

        // Ensure the configured server_wallet_address matches the derived address
        // from server_wallet_id, so we always show and fund the address the agent
        // can actually sign for.
        const derived = deriveStacksServerWallet(agent.server_wallet_id);
        let serverWalletAddressToUse = agent.server_wallet_address as string;

        if (derived.address !== agent.server_wallet_address) {
          console.warn('[trade/send] Server wallet mismatch detected; updating config', {
            walletAddress,
            agentType,
            configServerWalletAddress: agent.server_wallet_address,
            derivedAddress: derived.address,
          });

          serverWalletAddressToUse = derived.address;

          // Best-effort config repair; ignore errors so send path can continue.
          try {
            await supabaseAdmin
              .from('agent_configs')
              .update({
                server_wallet_address: derived.address,
                updated_at: new Date().toISOString(),
              })
              .eq('id', agent.id);
          } catch (e) {
            console.error('[trade/send] Failed to update server_wallet_address:', e);
          }
        }

        const result = await sendTokens({
          serverWalletId: agent.server_wallet_id,
          serverWalletAddress: serverWalletAddressToUse,
          token,
          amount: String(amount),
          recipient,
        });

        return { txHash: result.txHash };
      } catch (err) {
        console.error('Send error:', err);
        const message = err instanceof Error ? err.message : 'Send failed';
        return reply.status(500).send({ error: message });
      }
    },
  );
}
