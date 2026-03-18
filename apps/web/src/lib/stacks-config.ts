import type { StacksContractsConfig, StacksNetworkName } from '@alphaclaw/shared';

function getEnv(name: string, fallback = ''): string {
  if (typeof process === 'undefined') return fallback;
  return (process.env as Record<string, string | undefined>)[name] ?? fallback;
}

function getBrowserNetwork(): StacksNetworkName {
  const raw = (getEnv('NEXT_PUBLIC_STACKS_NETWORK', 'mainnet') || 'mainnet').toLowerCase();
  return raw === 'testnet' ? 'testnet' : 'mainnet';
}

// Default testnet AlphaClaw staking contract (Clarinet project: `alpha-claw-stake`).
const TESTNET_ALPHA_CLAW_STAKING_CONTRACT_ID =
  'ST1HGXPGWSHPHW3PNC66FWQ5VG1PFNYKBCSCQ7WMJ.alpha-claw-stake';

export const browserStacksConfig: StacksContractsConfig = {
  network: getBrowserNetwork(),
  apiUrl:
    getEnv('NEXT_PUBLIC_STACKS_API_URL') ||
    (getBrowserNetwork() === 'testnet'
      ? 'https://api.testnet.hiro.so'
      : 'https://api.hiro.so'),
  stakingContractId:
    getEnv('NEXT_PUBLIC_STACKS_STAKING_CONTRACT_ID') ||
    (getBrowserNetwork() === 'testnet' ? TESTNET_ALPHA_CLAW_STAKING_CONTRACT_ID : ''),
  rewardTokenContractId: getEnv('NEXT_PUBLIC_STACKS_REWARD_TOKEN_CONTRACT_ID'),
};

