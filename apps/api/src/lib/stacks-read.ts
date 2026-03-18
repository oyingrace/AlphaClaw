import { fetchCallReadOnlyFunction, cvToJSON, Cl } from '@stacks/transactions';
import { STACKS_CONTRACTS } from '@alphaclaw/shared';
import { getStacksNetwork } from './stacks-trade.js';

function parseContractPrincipal(principal: string): { address: string; name: string } {
  const [address, name] = principal.split('.');
  if (!address || !name) {
    throw new Error(`Invalid contract principal: ${principal}`);
  }
  return { address, name };
}

export interface StakingStakeInfo {
  amount: bigint;
  lastClaim: bigint;
}

/**
 * Read the current stake position for a user from the AlphaClaw staking contract.
 * Testnet-only helper; on mainnet we currently use stSTX directly instead.
 */
export async function getStakingContractStake(userPrincipal: string): Promise<StakingStakeInfo> {
  const stakingId = STACKS_CONTRACTS.stakingContractId;
  if (!stakingId) {
    throw new Error('STACKS_STAKING_CONTRACT_ID is not configured');
  }

  const { address: contractAddress, name: contractName } = parseContractPrincipal(stakingId);

  const network = getStacksNetwork();
  const result = await fetchCallReadOnlyFunction({
    contractAddress,
    contractName,
    functionName: 'get-stake',
    functionArgs: [Cl.standardPrincipal(userPrincipal)],
    senderAddress: userPrincipal,
    network,
  });

  const json = cvToJSON(result) as any;
  const value = json?.value ?? {};
  const amount = BigInt(value.amount?.value ?? 0);
  const lastClaim = BigInt(value['last-claim']?.value ?? 0);

  return { amount, lastClaim };
}

/**
 * Read the currently accumulated rewards for a given stake from the AlphaClaw staking contract.
 * Uses the contract's calculate-rewards(amount, last-claim) read-only function.
 */
export async function getStakingContractRewards(
  amount: bigint,
  lastClaim: bigint,
  userPrincipal: string,
): Promise<bigint> {
  const stakingId = STACKS_CONTRACTS.stakingContractId;
  if (!stakingId) {
    throw new Error('STACKS_STAKING_CONTRACT_ID is not configured');
  }

  const { address: contractAddress, name: contractName } = parseContractPrincipal(stakingId);
  const network = getStacksNetwork();

  const result = await fetchCallReadOnlyFunction({
    contractAddress,
    contractName,
    functionName: 'calculate-rewards',
    functionArgs: [Cl.uint(amount), Cl.uint(lastClaim)],
    senderAddress: userPrincipal,
    network,
  });

  const json = cvToJSON(result) as any;
  const raw = json?.value?.value ?? 0;
  return BigInt(raw);
}

