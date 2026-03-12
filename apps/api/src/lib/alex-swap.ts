/**
 * ALEX DEX integration for Stacks. All swaps go through ALEX only.
 * Uses alex-sdk for token list, quotes, and swap tx construction; we sign and broadcast with the server key.
 * runSwap returns a contract-call payload (TxToBroadCast); we build the tx with makeContractCall.
 */

import {
    AnchorMode,
    PostConditionMode,
    makeContractCall,
  } from '@stacks/transactions';
  import { getStacksNetwork, getStacksNetworkName } from './stacks-trade.js';
  import { deriveStacksServerWalletKey } from './stacks-server-wallet.js';
  
  /** Broadcast serialized tx as raw binary (Stacks node expects application/octet-stream). */
  async function broadcastTxRaw(
    serializedTxHex: string,
    baseUrl: string,
  ): Promise<{ txid: string }> {
    const hex = serializedTxHex.startsWith('0x') ? serializedTxHex.slice(2) : serializedTxHex;
    const body = Buffer.from(hex, 'hex');
    const url = `${baseUrl.replace(/\/$/, '')}/v2/transactions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
    });
    if (!res.ok) {
      const errText = await res.text();
      try {
        const errJson = JSON.parse(errText) as {
          error?: string;
          reason?: string;
          reason_data?: { actual?: string; expected?: string };
        };
        if (errJson.reason === 'NotEnoughFunds') {
          throw new Error(
            'Agent wallet has insufficient STX (including fee). Send STX to your agent wallet first, then try again.',
          );
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('Agent wallet')) throw e;
      }
      throw new Error(`Broadcast failed ${res.status}: ${errText}`);
    }
    const text = await res.text();
    const txid = text.replace(/["'\s]/g, '').trim();
    if (!/^[a-fA-F0-9]{64}$/.test(txid)) {
      throw new Error(`Unexpected broadcast response: ${text.slice(0, 200)}`);
    }
    return { txid };
  }
  
  /** ALEX SDK uses 8 decimals (1e8) for amounts. */
  const ALEX_DECIMALS = 8;
  
  function toAlexAmount(amount: bigint, tokenDecimals: number): bigint {
    if (tokenDecimals >= ALEX_DECIMALS) {
      return amount / BigInt(10 ** (tokenDecimals - ALEX_DECIMALS));
    }
    return amount * BigInt(10 ** (ALEX_DECIMALS - tokenDecimals));
  }
  
  function fromAlexAmount(amount: bigint, tokenDecimals: number): bigint {
    if (tokenDecimals >= ALEX_DECIMALS) {
      return amount * BigInt(10 ** (ALEX_DECIMALS - tokenDecimals));
    }
    return amount / BigInt(10 ** (ALEX_DECIMALS - tokenDecimals));
  }
  
  type TokenInfo = import('alex-sdk').TokenInfo;
  
  /** Fetch ALEX SDK and swappable tokens (cached per request; no long-lived cache to avoid stale list). */
  async function getAlexAndTokens(): Promise<{
    alex: InstanceType<typeof import('alex-sdk').AlexSDK>;
    tokens: TokenInfo[];
  }> {
    const { AlexSDK } = await import('alex-sdk');
    const alex = new AlexSDK();
    const tokens = await alex.fetchSwappableCurrency();
    return { alex, tokens };
  }
  
  /** Return list of token symbols (names) that ALEX supports for swaps. */
  export async function getAlexSwappableSymbols(): Promise<string[]> {
    const { tokens } = await getAlexAndTokens();
    return tokens.map((t) => t.name).filter(Boolean);
  }
  
  /** Resolve symbol to ALEX Currency id. STX uses Currency.STX; others matched by name (case-insensitive). */
  async function getAlexCurrency(alex: InstanceType<typeof import('alex-sdk').AlexSDK>, tokens: TokenInfo[], symbol: string): Promise<string> {
    const upper = symbol.toUpperCase();
    if (upper === 'STX') {
      const { Currency } = await import('alex-sdk');
      return (Currency as { STX: string }).STX;
    }
    const t = tokens.find((x) => (x.name ?? '').toUpperCase() === upper);
    if (!t?.id) throw new Error(`ALEX does not support token: ${symbol}`);
    return t.id as string;
  }
  
  /** Get decimals for an ALEX token by symbol (name). */
  export async function getAlexTokenDecimals(symbol: string): Promise<number> {
    const { tokens } = await getAlexAndTokens();
    const upper = symbol.toUpperCase();
    if (upper === 'STX') return 6;
    const t = tokens.find((x) => (x.name ?? '').toUpperCase() === upper);
    return t?.wrapTokenDecimals ?? ALEX_DECIMALS;
  }
  
  /** Whether both symbols are in ALEX swappable list. */
  export async function isAlexPair(tokenIn: string, tokenOut: string): Promise<boolean> {
    const symbols = await getAlexSwappableSymbols();
    const set = new Set(symbols.map((s) => s.toUpperCase()));
    return set.has(tokenIn.toUpperCase()) && set.has(tokenOut.toUpperCase());
  }
  
  export interface AlexQuoteResult {
    amountOut: bigint;
    amountIn: bigint;
    rate: number;
    route: Array<{ tokenIn: string; tokenOut: string }>;
  }
  
  /**
   * Get ALEX quote for any two ALEX-supported tokens. Decimals are read from ALEX token list.
   */
  export async function getAlexQuote(params: {
    tokenInSymbol: string;
    tokenOutSymbol: string;
    amountIn: bigint;
  }): Promise<AlexQuoteResult> {
    const { tokenInSymbol, tokenOutSymbol, amountIn } = params;
    const { alex, tokens } = await getAlexAndTokens();
  
    const currencyIn = await getAlexCurrency(alex, tokens, tokenInSymbol);
    const currencyOut = await getAlexCurrency(alex, tokens, tokenOutSymbol);
  
    const tokenInInfo = tokens.find((t) => (t.name ?? '').toUpperCase() === tokenInSymbol.toUpperCase());
    const tokenOutInfo = tokens.find((t) => (t.name ?? '').toUpperCase() === tokenOutSymbol.toUpperCase());
    const decimalsIn = tokenInSymbol.toUpperCase() === 'STX' ? 6 : (tokenInInfo?.wrapTokenDecimals ?? ALEX_DECIMALS);
    const decimalsOut = tokenOutSymbol.toUpperCase() === 'STX' ? 6 : (tokenOutInfo?.wrapTokenDecimals ?? ALEX_DECIMALS);
  
    const amountInAlex = toAlexAmount(amountIn, decimalsIn);
    const amountOutAlex = await alex.getAmountTo(
      currencyIn as import('alex-sdk').Currency,
      amountInAlex,
      currencyOut as import('alex-sdk').Currency,
    );
    const amountOut = fromAlexAmount(BigInt(amountOutAlex), decimalsOut);
  
    const rate =
      decimalsIn === decimalsOut
        ? Number(amountOut) / Number(amountIn)
        : (Number(amountOut) / Number(amountIn)) * 10 ** (decimalsIn - decimalsOut);
  
    return {
      amountIn,
      amountOut,
      rate,
      route: [{ tokenIn: tokenInSymbol, tokenOut: tokenOutSymbol }],
    };
  }
  
  /**
   * Build swap tx via ALEX, sign with server key, broadcast.
   */
  export async function executeAlexSwap(params: {
    serverWalletId: string;
    serverWalletAddress: string;
    tokenInSymbol: string;
    tokenOutSymbol: string;
    amountIn: bigint;
    amountOutMin: bigint;
  }): Promise<{ txId: string }> {
    const {
      serverWalletId,
      serverWalletAddress,
      tokenInSymbol,
      tokenOutSymbol,
      amountIn,
      amountOutMin,
    } = params;
  
    const { alex, tokens } = await getAlexAndTokens();
    const currencyIn = await getAlexCurrency(alex, tokens, tokenInSymbol);
    const currencyOut = await getAlexCurrency(alex, tokens, tokenOutSymbol);
  
    const tokenInInfo = tokens.find((t) => (t.name ?? '').toUpperCase() === tokenInSymbol.toUpperCase());
    const tokenOutInfo = tokens.find((t) => (t.name ?? '').toUpperCase() === tokenOutSymbol.toUpperCase());
    const decimalsIn = tokenInSymbol.toUpperCase() === 'STX' ? 6 : (tokenInInfo?.wrapTokenDecimals ?? ALEX_DECIMALS);
    const decimalsOut = tokenOutSymbol.toUpperCase() === 'STX' ? 6 : (tokenOutInfo?.wrapTokenDecimals ?? ALEX_DECIMALS);
  
    const amountInAlex = toAlexAmount(amountIn, decimalsIn);
    const amountOutMinAlex = toAlexAmount(amountOutMin, decimalsOut);
  
    const payload = await alex.runSwap(
      serverWalletAddress,
      currencyIn as import('alex-sdk').Currency,
      currencyOut as import('alex-sdk').Currency,
      amountInAlex,
      amountOutMinAlex,
    );
  
    // TxToBroadCast has contractAddress = deployer (e.g. SP102...), contractName = contract (e.g. amm-pool-v2-01)
    const contractAddress = payload.contractAddress;
    const contractName = payload.contractName;
    if (!contractAddress || !contractName) {
      throw new Error(
        `ALEX returned invalid contract: address=${payload.contractAddress}, name=${payload.contractName}`,
      );
    }
  
    const privateKeyHex = deriveStacksServerWalletKey(serverWalletId);
    const network = getStacksNetwork();
    const networkName = getStacksNetworkName();
    const broadcastHost =
      (network as { client?: { baseUrl?: string } })?.client?.baseUrl ?? 'unknown';
    console.info(
      `[ALEX] Building swap for ${networkName}; broadcast URL: ${broadcastHost}/v2/transactions`,
    );
  
    const tx = await makeContractCall({
      contractAddress,
      contractName,
      functionName: payload.functionName,
      functionArgs: payload.functionArgs,
      senderKey: privateKeyHex,
      network,
      postConditionMode: PostConditionMode.Deny,
      postConditions: payload.postConditions ?? [],
    });
  
    const serializedHex = tx.serialize();
    const baseUrl = (network as { client?: { baseUrl?: string } })?.client?.baseUrl ?? '';
    const { txid: txId } = await broadcastTxRaw(serializedHex, baseUrl);
  
    console.info(
      `[ALEX] Swap broadcast: ${tokenInSymbol} → ${tokenOutSymbol} network=${networkName} txId=${txId}`,
    );
  
    const verifyUrl = `${baseUrl.replace(/\/$/, '')}/extended/v1/tx/${txId}`;
    try {
      const verifyRes = await fetch(verifyUrl);
      if (verifyRes.status === 404) {
        console.warn(
          `[ALEX] Tx ${txId} not found on network (404). Check STACKS_NETWORK and API URL.`,
        );
      } else if (verifyRes.ok) {
        const txInfo = (await verifyRes.json()) as { tx_status?: string };
        console.info(`[ALEX] Tx status: ${txInfo.tx_status ?? 'unknown'}`);
      }
    } catch (e) {
      console.warn('[ALEX] Could not verify tx:', e);
    }
  
    return { txId };
  }
  