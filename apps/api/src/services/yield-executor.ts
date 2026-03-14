/**
 * Stacks yield executor: deposit into and withdraw from Stacks yield opportunities.
 * Supports Stacking DAO (stSTX) deposit and instant-withdraw. Other opportunities
 * (native stacking, LP) can be added via env-configured contracts.
 */

import {
    AnchorMode,
    PostConditionMode,
    broadcastTransaction,
    makeContractCall,
    uintCV,
    noneCV,
    contractPrincipalCV,
  } from '@stacks/transactions';
  import type { YieldExecutionResult } from '@alphaclaw/shared';
  import { getStacksTokenBalance, getStacksNetwork, executeStacksSwap } from '../lib/stacks-trade.js';
  import { getStxBalance } from '../lib/stacks-client.js';
  import { deriveStacksServerWalletKey } from '../lib/stacks-server-wallet.js';
  import { getTokenAddress } from '@alphaclaw/shared';
  import { getTokenPriceUsd } from './price-service.js';
  
  const STX_DECIMALS = 6;
  const STACKING_DAO_ADDRESS = 'SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG';
  const STACKING_DAO_CORE = 'stacking-dao-core-v6';
  const DIRECT_HELPERS = 'direct-helpers-v4';
  const STAKING_CONTRACT = 'staking-v0';
  const COMMISSION_CONTRACT = 'commission-v2';
  const RESERVE = 'reserve-v1';
  
  /** stSTX token contract (vault identifier for positions) */
  export const STSTX_TOKEN_CONTRACT = `${STACKING_DAO_ADDRESS}.ststx-token`;
  
  function parseContractPrincipal(principal: string): { address: string; name: string } {
    const [address, name] = principal.split('.');
    if (!address || !name) throw new Error(`Invalid contract principal: ${principal}`);
    return { address, name };
  }
  
  /**
   * Check if vaultAddress refers to Stacking DAO stSTX (deposit STX -> receive stSTX).
   */
  function isStstxVault(vaultAddress: string): boolean {
    return (
      vaultAddress === STSTX_TOKEN_CONTRACT ||
      vaultAddress === 'SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token' ||
      vaultAddress.toLowerCase().includes('ststx')
    );
  }
  
  /**
   * Deposit: for stSTX we send STX to Stacking DAO and receive stSTX.
   * amountUsd is converted to STX using a rough price (or we use amount in STX if we have price feed).
   * If wallet has insufficient STX, we attempt to swap USDCx -> STX when STACKS_SWAP_CONTRACT is set.
   */
  export async function executeYieldDeposit(params: {
    serverWalletId: string;
    serverWalletAddress: string;
    vaultAddress: string;
    amountUsd: number;
  }): Promise<YieldExecutionResult> {
    const { serverWalletId, serverWalletAddress, vaultAddress, amountUsd } = params;
  
    if (!isStstxVault(vaultAddress)) {
      return {
        success: false,
        action: 'deposit',
        vaultAddress,
        error: `Unsupported vault for Stacks deposit: ${vaultAddress}. Only stSTX liquid staking is supported.`,
      };
    }
  
    try {
      // Resolve amount in uSTX (micro-STX) using live STX price where possible.
      let stxPriceUsd = await getTokenPriceUsd('STX');
      if (!stxPriceUsd || !Number.isFinite(stxPriceUsd) || stxPriceUsd <= 0) {
        // Fallback: conservative default if price feed unavailable.
        stxPriceUsd = Number(process.env.STX_PRICE_USD ?? '0.25');
      }
  
      const amountStxHuman = amountUsd / stxPriceUsd;
      const amountUstx = BigInt(Math.floor(amountStxHuman * 10 ** STX_DECIMALS));
      if (amountUstx <= 0n) {
        return {
          success: false,
          action: 'deposit',
          vaultAddress,
          error: `Amount too small: $${amountUsd} ≈ ${amountStxHuman.toFixed(6)} STX`,
        };
      }
  
      let stxBalance = await getStxBalance(serverWalletAddress);
      if (stxBalance < amountUstx) {
        // Try swapping USDCx -> STX if DEX is configured
        const swapContract = process.env.STACKS_SWAP_CONTRACT;
        const usdcxBalance = await getStacksTokenBalance(serverWalletAddress, 'USDCx');
        const neededUstx = amountUstx - stxBalance;
        const neededHuman = Number(neededUstx) / 10 ** STX_DECIMALS;
        const usdcxToSpend = BigInt(Math.ceil(neededHuman * stxPriceUsd * 1e6)); // 6 decimals USDCx
        if (swapContract && usdcxBalance >= usdcxToSpend) {
          const amountOutMin = (neededUstx * 95n) / 100n; // 5% slippage
          await executeStacksSwap({
            serverWalletId,
            serverWalletAddress,
            tokenInSymbol: 'USDCx',
            tokenOutSymbol: 'STX',
            amountIn: usdcxToSpend,
            amountOutMin,
          });
          stxBalance = await getStxBalance(serverWalletAddress);
        }
      }
  
      // Leave a safety buffer of STX for future gas: at most 95% of current STX
      // balance can be deposited. This prevents "Insufficient STX" errors when
      // trying to deposit the entire balance.
      const maxDepositable = (stxBalance * 95n) / 100n;
      let amountToDeposit = amountUstx;
      if (amountToDeposit > maxDepositable) {
        amountToDeposit = maxDepositable;
      }
  
      if (amountToDeposit <= 0n || stxBalance < amountToDeposit) {
        const haveStx = Number(stxBalance) / 10 ** STX_DECIMALS;
        return {
          success: false,
          action: 'deposit',
          vaultAddress,
          error: `Insufficient STX to deposit after reserving gas buffer. Have ${haveStx.toFixed(
            4,
          )} STX. Add STX or USDCx (to swap) to wallet.`,
        };
      }
  
      const senderKey = deriveStacksServerWalletKey(serverWalletId);
      const { address: contractAddress, name: contractName } = parseContractPrincipal(
        `${STACKING_DAO_ADDRESS}.${STACKING_DAO_CORE}`,
      );
  
      // Per Stacking DAO docs, deposit takes:
      // reserve, commission-contract, staking-contract, direct-helpers, stx-amount, referrer (optional principal), pool (optional principal)
      const reserve = parseContractPrincipal(`${STACKING_DAO_ADDRESS}.${RESERVE}`);
      const commission = parseContractPrincipal(`${STACKING_DAO_ADDRESS}.${COMMISSION_CONTRACT}`);
      const staking = parseContractPrincipal(`${STACKING_DAO_ADDRESS}.${STAKING_CONTRACT}`);
      const directHelpers = parseContractPrincipal(`${STACKING_DAO_ADDRESS}.${DIRECT_HELPERS}`);
  
      const tx = await makeContractCall({
        contractAddress,
        contractName,
        // Stacking DAO Core v6 deposit entrypoint
        functionName: 'deposit',
        functionArgs: [
          contractPrincipalCV(reserve.address, reserve.name),
          contractPrincipalCV(commission.address, commission.name),
          contractPrincipalCV(staking.address, staking.name),
          contractPrincipalCV(directHelpers.address, directHelpers.name),
          uintCV(amountToDeposit),
          noneCV(), // referrer (optional principal)
          noneCV(), // pool (optional principal)
        ],
        senderKey,
        network: getStacksNetwork(),
        // Allow STX to move without explicit post-conditions (we verify on-chain status separately).
        postConditionMode: PostConditionMode.Allow,
      });
  
      const network = getStacksNetwork();
      const response = await broadcastTransaction({ transaction: tx, network });
  
      // Log and surface broadcast-layer errors from Hiro (e.g. { error, reason }).
      if (typeof response === 'object' && response !== null && 'error' in response) {
        const errObj = response as { error?: string; reason?: string };
        const msg = `stSTX deposit broadcast failed: ${errObj.error ?? 'unknown'}${
          errObj.reason ? ` (${errObj.reason})` : ''
        }`;
        console.error('[yield-executor] ', msg);
        return {
          success: false,
          action: 'deposit',
          vaultAddress,
          error: msg,
        };
      }
  
      const txId =
        typeof response === 'string'
          ? response
          : typeof (response as any).txid === 'string'
            ? (response as any).txid
            : tx.txid();
  
      // Best-effort verification: check tx status and log it for debugging.
      try {
        const baseUrl =
          (network as { client?: { baseUrl?: string } })?.client?.baseUrl ?? '';
        const verifyUrl = `${baseUrl.replace(/\/$/, '')}/extended/v1/tx/${txId}`;
        const verifyRes = await fetch(verifyUrl);
        if (verifyRes.ok) {
          const txInfo = (await verifyRes.json()) as { tx_status?: string; tx_result?: { repr?: string } };
          console.info('[yield-executor] stSTX deposit tx status', {
            txId,
            status: txInfo.tx_status ?? 'unknown',
            result: txInfo.tx_result?.repr,
          });
        } else {
          console.warn(
            '[yield-executor] Could not verify stSTX deposit tx',
            txId,
            'status',
            verifyRes.status,
          );
        }
      } catch (e) {
        console.warn('[yield-executor] Error while verifying stSTX deposit tx', txId, e);
      }
  
      // Log the actual STX sent and its USD equivalent using the price we used.
      const actualUsd =
        (Number(amountToDeposit) / 10 ** STX_DECIMALS) * stxPriceUsd;
      console.info('[yield-executor] stSTX deposit executed', {
        serverWalletAddress,
        amountUstx: amountToDeposit.toString(),
        amountStx: (Number(amountToDeposit) / 10 ** STX_DECIMALS).toFixed(6),
        stxPriceUsd,
        amountUsdRequested: amountUsd,
        amountUsdEffective: actualUsd,
      });
  
      return {
        success: true,
        txHash: txId,
        action: 'deposit',
        vaultAddress,
        amountUsd: actualUsd,
      };
    } catch (err) {
      return {
        success: false,
        action: 'deposit',
        vaultAddress,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  
  /**
   * Withdraw: for stSTX we call Stacking DAO instant-withdraw (withdraw-idle) to get STX back.
   * sharesPct 0-100; we use stSTX balance when vault is stSTX (no LP shares).
   */
  export async function executeYieldWithdraw(params: {
    serverWalletId: string;
    serverWalletAddress: string;
    vaultAddress: string;
    sharesPct?: number;
  }): Promise<YieldExecutionResult> {
    const { serverWalletId, serverWalletAddress, vaultAddress, sharesPct = 100 } = params;
  
    if (!isStstxVault(vaultAddress)) {
      return {
        success: false,
        action: 'withdraw',
        vaultAddress,
        error: `Unsupported vault for Stacks withdraw: ${vaultAddress}. Only stSTX liquid staking is supported.`,
      };
    }
  
    try {
      const ststxAssetId = getTokenAddress('stSTX');
      if (!ststxAssetId) {
        return { success: false, action: 'withdraw', vaultAddress, error: 'stSTX token not configured' };
      }
      const balance = await getStacksTokenBalance(serverWalletAddress, 'stSTX');
      if (balance === 0n) {
        return { success: false, action: 'withdraw', vaultAddress, error: 'No stSTX to withdraw' };
      }
  
      const toWithdraw =
        sharesPct >= 100 ? balance : (balance * BigInt(Math.round(sharesPct))) / 100n;
      if (toWithdraw === 0n) {
        return { success: false, action: 'withdraw', vaultAddress, error: 'Withdraw amount is zero' };
      }
  
      const senderKey = deriveStacksServerWalletKey(serverWalletId);
      const { address: contractAddress, name: contractName } = parseContractPrincipal(
        `${STACKING_DAO_ADDRESS}.${STACKING_DAO_CORE}`,
      );
  
      // withdraw-idle (ststx-amount uint, staking-contract principal, commission-contract principal, direct-helpers principal, reserve principal)
      const directHelpers = parseContractPrincipal(`${STACKING_DAO_ADDRESS}.${DIRECT_HELPERS}`);
      const staking = parseContractPrincipal(`${STACKING_DAO_ADDRESS}.${STAKING_CONTRACT}`);
      const commission = parseContractPrincipal(`${STACKING_DAO_ADDRESS}.${COMMISSION_CONTRACT}`);
      const reserve = parseContractPrincipal(`${STACKING_DAO_ADDRESS}.${RESERVE}`);
  
      const { Cl } = await import('@stacks/transactions');
      const tx = await makeContractCall({
        contractAddress,
        contractName,
        functionName: 'withdraw-idle',
        functionArgs: [
          uintCV(toWithdraw),
          Cl.contractPrincipal(staking.address, staking.name),
          Cl.contractPrincipal(commission.address, commission.name),
          Cl.contractPrincipal(directHelpers.address, directHelpers.name),
          Cl.contractPrincipal(reserve.address, reserve.name),
        ],
        senderKey,
        network: getStacksNetwork(),
        postConditionMode: PostConditionMode.Deny,
      });
  
      const response = await broadcastTransaction({ transaction: tx, network: getStacksNetwork() });
      const txId =
        typeof response === 'string'
          ? response
          : typeof (response as any).txid === 'string'
            ? (response as any).txid
            : tx.txid();
  
      return {
        success: true,
        txHash: txId,
        action: 'withdraw',
        vaultAddress,
      };
    } catch (err) {
      return {
        success: false,
        action: 'withdraw',
        vaultAddress,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  