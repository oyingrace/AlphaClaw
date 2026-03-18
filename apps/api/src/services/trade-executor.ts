/**
 * Trade executor for Stacks: quote, balance checks, and swap via server key (full auto).
 * Uses stacks-client and stacks-trade;
 */

import { parseUnits, formatUnits } from 'viem';
import { getTokenAddress, getTokenDecimals, STACKS_CONTRACTS } from '@alphaclaw/shared';
import {
  getStacksQuote,
  getStacksTokenBalance,
  executeStacksSwap,
  STACKS_BASE_STABLE,
  getStacksNetwork,
} from '../lib/stacks-trade.js';
import { getAlexTokenDecimals } from '../lib/alex-swap.js';
import {
  makeSTXTokenTransfer,
  broadcastTransaction,
  AnchorMode,
  PostConditionMode,
  makeContractCall,
  uintCV,
  noneCV,
  standardPrincipalCV,
} from '@stacks/transactions';
import { deriveStacksServerWalletKey } from '../lib/stacks-server-wallet.js';
import { getTokenPriceUsd } from './price-service.js';

const DEFAULT_SLIPPAGE_PCT = 0.5;

const DEFAULT_TEST_SWAP_CONTRACT_ID =
  'ST1HGXPGWSHPHW3PNC66FWQ5VG1PFNYKBCSCQ7WMJ.alpha-claw-swap';

function parseContractPrincipal(principal: string): { address: string; name: string } {
  const [address, name] = principal.split('.');
  if (!address || !name) {
    throw new Error(`Invalid contract principal: ${principal}`);
  }
  return { address, name };
}

function getTestSwapContractId(): string {
  return process.env.STACKS_TEST_SWAP_CONTRACT_ID ?? DEFAULT_TEST_SWAP_CONTRACT_ID;
}

// #region agent log
function _dbg(id: string, msg: string, data: Record<string, unknown>) {
  fetch('http://127.0.0.1:7242/ingest/7d2e188d-ef20-4305-8eeb-fbcbfd7a4be1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      location: 'trade-executor.ts',
      message: msg,
      data,
      timestamp: Date.now(),
      hypothesisId: id,
    }),
  }).catch(() => {});
}
// #endregion

export interface TradeResult {
  txHash: string;
  amountIn: bigint;
  amountOut: bigint;
  rate: number;
}

function applySlippage(amountOut: bigint, slippagePct: number): bigint {
  return (amountOut * BigInt(Math.floor((100 - slippagePct) * 100))) / 10000n;
}

function parseStacksError(err: unknown, context: string): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('Insufficient') || msg.includes('insufficient STX') || msg.includes('Agent wallet')) {
    return new Error(`${context}: ${msg}`);
  }
  if (msg.includes('not configured') || msg.includes('not yet implemented')) {
    return new Error(`${context}: ${msg}`);
  }
  return new Error(`${context}: ${msg}`);
}

/**
 * Execute a trade on Stacks (buy or sell target currency vs base stable USDCx).
 * Server wallet must be a Stacks principal (ST1.../SP1...). No user intervention.
 */
export async function executeTrade(params: {
  serverWalletId: string;
  serverWalletAddress: string;
  currency: string;
  direction: 'buy' | 'sell';
  amountUsd: number;
}): Promise<TradeResult> {
  const { serverWalletId, serverWalletAddress, currency, direction, amountUsd } = params;

  if (amountUsd == null || typeof amountUsd !== 'number' || amountUsd <= 0) {
    throw new Error(
      `Invalid trade amount for ${currency}: amountUsd must be a positive number (got ${String(amountUsd)})`,
    );
  }

  if (!getTokenAddress(currency)) {
    throw new Error(`Unknown token for currency: ${currency}`);
  }

  let tokenInSymbol: string;
  let tokenOutSymbol: string;
  let amountIn: bigint;

  if (direction === 'sell') {
    tokenInSymbol = currency;
    tokenOutSymbol = STACKS_BASE_STABLE;
    const decimals = getTokenDecimals(currency);
    // amountUsd is USD value for sells; convert using token price.
    const priceUsd = await getTokenPriceUsd(currency);
    if (!priceUsd || !Number.isFinite(priceUsd) || priceUsd <= 0) {
      throw new Error(`Invalid price for ${currency}: ${String(priceUsd)}`);
    }
    const amountInHuman = amountUsd / priceUsd;
    amountIn = parseUnits(amountInHuman.toString(), decimals);
    const balance = await getStacksTokenBalance(serverWalletAddress, currency);
    if (balance < amountIn) {
      throw new Error(
        `Insufficient ${currency} balance: have ${formatUnits(balance, decimals)}, need ~${amountUsd}`,
      );
    }
  } else {
    tokenInSymbol = STACKS_BASE_STABLE;
    tokenOutSymbol = currency;
    const decimals = getTokenDecimals(STACKS_BASE_STABLE);
    amountIn = parseUnits(amountUsd.toString(), decimals);
    const balance = await getStacksTokenBalance(serverWalletAddress, STACKS_BASE_STABLE);
    if (balance < amountIn) {
      throw new Error(
        `Insufficient ${STACKS_BASE_STABLE} balance: have ${formatUnits(balance, decimals)}, need ~$${amountUsd}`,
      );
    }
  }

  // Testnet demo: route USDCx <-> STX through our small swap contract (no ALEX dependency).
  if (
    STACKS_CONTRACTS.network === 'testnet' &&
    (tokenInSymbol === 'USDCx' || tokenInSymbol === 'STX') &&
    (tokenOutSymbol === 'STX' || tokenOutSymbol === 'USDCx')
  ) {
    const swapContractId = getTestSwapContractId();
    const swap = parseContractPrincipal(swapContractId);
    const senderKey = deriveStacksServerWalletKey(serverWalletId);
    const network = getStacksNetwork();

    const STX_DECIMALS = getTokenDecimals('STX');
    const USDCX_DECIMALS = getTokenDecimals('USDCx');

    if (direction === 'buy' && tokenInSymbol === 'USDCx' && tokenOutSymbol === 'STX') {
      const stxPriceUsd = await getTokenPriceUsd('STX');
      if (!stxPriceUsd || !Number.isFinite(stxPriceUsd) || stxPriceUsd <= 0) {
        throw new Error(`Invalid STX price: ${String(stxPriceUsd)}`);
      }

      const stxAmountOutHuman = amountUsd / stxPriceUsd;
      const stxAmountOut = parseUnits(stxAmountOutHuman.toString(), STX_DECIMALS);

      // Transfer input USDCx into the swap contract.
      await sendTokens({
        serverWalletId,
        serverWalletAddress,
        token: 'USDCx',
        amount: formatUnits(amountIn, USDCX_DECIMALS),
        recipient: swapContractId,
      });

      // Execute swap: contract sends STX back to tx-sender.
      const tx = await makeContractCall({
        contractAddress: swap.address,
        contractName: swap.name,
        functionName: 'swap-usdcx-to-stx',
        functionArgs: [uintCV(amountIn), uintCV(stxAmountOut)],
        senderKey,
        network,
        postConditionMode: PostConditionMode.Allow,
      });

      const response = await broadcastTransaction({ transaction: tx, network });
      const txId =
        typeof response === 'string'
          ? response
          : typeof (response as any)?.txid === 'string'
            ? (response as any).txid
            : tx.txid();

      return { txHash: txId, amountIn, amountOut: stxAmountOut, rate: stxPriceUsd };
    }

    // Demo mode supports BUY only (USDCx -> STX). Sells would require swap-stx-to-usdcx.
    throw new Error(
      `Testnet demo swap only supports buy: USDCx -> STX (got ${direction} ${tokenInSymbol} -> ${tokenOutSymbol})`,
    );
  }

  const quote = await getStacksQuote({
    tokenInSymbol,
    tokenOutSymbol,
    amountIn,
  });

  const amountOutMin = applySlippage(quote.amountOut, DEFAULT_SLIPPAGE_PCT);

  try {
    const { txId } = await executeStacksSwap({
      serverWalletId,
      serverWalletAddress,
      tokenInSymbol,
      tokenOutSymbol,
      amountIn,
      amountOutMin,
    });
    return {
      txHash: txId,
      amountIn,
      amountOut: quote.amountOut,
      rate: quote.rate,
    };
  } catch (err) {
    throw parseStacksError(err, `Swap ${direction} ${currency}`);
  }
}

/**
 * Execute a manual swap for an arbitrary token pair on Stacks.
 */
export async function executeSwap(params: {
  serverWalletId: string;
  serverWalletAddress: string;
  from: string;
  to: string;
  amount: string;
  slippagePct?: number;
}): Promise<TradeResult> {
  const {
    serverWalletId,
    serverWalletAddress,
    from,
    to,
    amount,
    slippagePct = DEFAULT_SLIPPAGE_PCT,
  } = params;

  const tokenInDecimals = await getAlexTokenDecimals(from);
  const amountIn = parseUnits(amount, tokenInDecimals);

  const quote = await getStacksQuote({
    tokenInSymbol: from,
    tokenOutSymbol: to,
    amountIn,
  });

  const amountOutMin = applySlippage(quote.amountOut, slippagePct);

  const balance = await getStacksTokenBalance(serverWalletAddress, from);
  if (balance < amountIn) {
    throw new Error(
      `Insufficient ${from} balance: have ${formatUnits(balance, tokenInDecimals)}, need ${amount}`,
    );
  }

  try {
    const { txId } = await executeStacksSwap({
      serverWalletId,
      serverWalletAddress,
      tokenInSymbol: from,
      tokenOutSymbol: to,
      amountIn,
      amountOutMin,
    });
    return {
      txHash: txId,
      amountIn,
      amountOut: quote.amountOut,
      rate: quote.rate,
    };
  } catch (err) {
    throw parseStacksError(err, `Swap ${from} → ${to}`);
  }
}

/**
 * Send tokens from the agent's server wallet to a recipient (Stacks principal).
 * Requires STACKS_AGENT_PRIVATE_KEY and SIP-10 transfer implementation when needed.
 */
export async function sendTokens(params: {
  serverWalletId: string;
  serverWalletAddress: string;
  token: string;
  amount: string;
  recipient: string;
}): Promise<{ txHash: string }> {
  const { serverWalletId, serverWalletAddress, token, amount, recipient } = params;

  if (!getTokenAddress(token)) {
    throw new Error(`Unknown token: ${token}`);
  }

  const decimals = getTokenDecimals(token);
  const amountWei = parseUnits(amount, decimals);

  const balance = await getStacksTokenBalance(serverWalletAddress, token);
  if (balance < amountWei) {
    throw new Error(
      `Insufficient ${token} balance: have ${formatUnits(balance, decimals)}, need ${amount}`,
    );
  }

  // Debug: verify that derived private key maps to the same principal as serverWalletAddress.
  try {
    const debugKey = deriveStacksServerWalletKey(serverWalletId);
    const debugAddress = (await import('../lib/stacks-server-wallet.js')).deriveStacksServerWallet(serverWalletId)
      .address;
    if (debugAddress !== serverWalletAddress) {
      console.warn('[sendTokens] Derived address mismatch', {
        serverWalletId,
        configServerWalletAddress: serverWalletAddress,
        derivedAddress: debugAddress,
      });
    }
  } catch {
    // ignore debug failure
  }

  // STX transfer: use native makeSTXTokenTransfer
  if (token === 'STX') {
    try {
      const network = getStacksNetwork();
      const senderKey = deriveStacksServerWalletKey(serverWalletId);
      const tx = await makeSTXTokenTransfer({
        recipient,
        amount: amountWei,
        senderKey,
        network,
      });

      // Debug: log STX balance vs fee before broadcast
      try {
        const stxBalance = await getStacksTokenBalance(serverWalletAddress, 'STX');
        const feeUstx = tx.auth?.spendingCondition?.fee ?? 0n;
        console.log('[sendTokens][STX]', {
          serverWalletAddress,
          amount,
          stxBalanceUstx: stxBalance.toString(),
          stxBalanceStx: formatUnits(stxBalance, 6),
          feeUstx: feeUstx.toString(),
          feeStx: formatUnits(feeUstx, 6),
        });
      } catch {
        // ignore debug failures
      }

      const response = await broadcastTransaction({ transaction: tx, network });

      // Handle broadcast error objects from Hiro (e.g. { error, reason }).
      if (typeof response === 'object' && response !== null && 'error' in response) {
        const errObj = response as { error?: string; reason?: string };
        throw new Error(
          `Send ${token} broadcast failed: ${errObj.error ?? 'unknown'} ${
            errObj.reason ? `(${errObj.reason})` : ''
          }`,
        );
      }

      const txId =
        typeof response === 'string'
          ? response
          : typeof (response as { txid?: string })?.txid === 'string'
            ? (response as { txid: string }).txid
            : tx.txid();

      return { txHash: txId };
    } catch (err) {
      throw parseStacksError(err, `Send ${token}`);
    }
  }

  // Non-STX tokens (SIP-10 fungible transfers via contract call).
  const assetId = getTokenAddress(token);
  if (!assetId || !assetId.includes('.')) {
    throw new Error(`Cannot resolve contract for token ${token}`);
  }

  const [contractAddress, contractName] = assetId.split('.');
  if (!contractAddress || !contractName) {
    throw new Error(`Invalid SIP-10 contract for ${token}: ${assetId}`);
  }

  try {
    const network = getStacksNetwork();
    const senderKey = deriveStacksServerWalletKey(serverWalletId);

    const tx = await makeContractCall({
      contractAddress,
      contractName,
      functionName: 'transfer',
      functionArgs: [
        uintCV(amountWei),
        standardPrincipalCV(serverWalletAddress),
        standardPrincipalCV(recipient),
        noneCV(), // memo (optional)
      ],
      senderKey,
      network,
      postConditionMode: PostConditionMode.Deny,
      postConditions: [],
    });

    // Debug: log STX balance vs fee for SIP-10 transfer
    try {
      const stxBalance = await getStacksTokenBalance(serverWalletAddress, 'STX');
      const feeUstx = tx.auth?.spendingCondition?.fee ?? 0n;
      console.log('[sendTokens][SIP-10]', {
        serverWalletAddress,
        token,
        amount,
        stxBalanceUstx: stxBalance.toString(),
        stxBalanceStx: formatUnits(stxBalance, 6),
        feeUstx: feeUstx.toString(),
        feeStx: formatUnits(feeUstx, 6),
      });
    } catch {
      // ignore debug failures
      console.warn('[sendTokens][SIP-10] Failed to log STX balance/fee debug info');
    }

    const response = await broadcastTransaction({ transaction: tx, network });

    // Handle broadcast error objects from Hiro (e.g. { error, reason }).
    if (typeof response === 'object' && response !== null && 'error' in response) {
      const errObj = response as { error?: string; reason?: string };
      throw new Error(
        `Send ${token} broadcast failed: ${errObj.error ?? 'unknown'} ${
          errObj.reason ? `(${errObj.reason})` : ''
        }`,
      );
    }

    const txId =
      typeof response === 'string'
        ? response
        : typeof (response as { txid?: string })?.txid === 'string'
          ? (response as { txid: string }).txid
          : tx.txid();

    return { txHash: txId };
  } catch (err) {
    throw parseStacksError(err, `Send ${token}`);
  }
}

/** No-op for Stacks (no approval cache). */
export function clearApprovalCache(): void {}
