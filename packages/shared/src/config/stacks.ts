// Lightweight process typing so this module can read env vars
// without requiring @types/node in every consumer.
declare const process:
  | {
      env: Record<string, string | undefined>;
    }
  | undefined;

export type StacksNetworkName = 'mainnet' | 'testnet';

export interface StacksContractsConfig {
  network: StacksNetworkName;
  apiUrl: string;
  stakingContractId: string;
  rewardTokenContractId: string;
}

function env(name: string, fallback = ''): string {
  if (typeof process === 'undefined' || !process.env) return fallback;
  return process.env[name] ?? fallback;
}

function getStacksNetworkFromEnv(): StacksNetworkName {
  const raw = (env('STACKS_NETWORK', 'mainnet') || 'mainnet').toLowerCase();
  return raw === 'testnet' ? 'testnet' : 'mainnet';
}

export const STACKS_CONTRACTS: StacksContractsConfig = {
  network: getStacksNetworkFromEnv(),
  apiUrl:
    env('STACKS_API_URL') ||
    (getStacksNetworkFromEnv() === 'testnet'
      ? 'https://api.testnet.hiro.so'
      : 'https://api.hiro.so'),
  // These should be set via process.env in deployed environments to the
  // actual testnet/mainnet contract IDs where the AlphaClaw contracts live.
  stakingContractId:
    env('STACKS_STAKING_CONTRACT_ID') ||
    '', // e.g. 'ST....alphaclaw'
  rewardTokenContractId:
    env('STACKS_REWARD_TOKEN_CONTRACT_ID') ||
    '', // e.g. 'ST....RewardToken'
};

