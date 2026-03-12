import crypto from 'node:crypto';
import { getAddressFromPrivateKey } from '@stacks/transactions';

function getMasterSecret(): string {
  const secret = process.env.STACKS_AGENT_MASTER_SECRET;
  if (!secret) {
    throw new Error(
      'STACKS_AGENT_MASTER_SECRET is required to derive per-user Stacks server wallets.',
    );
  }
  return secret;
}

function getNetwork(): 'mainnet' | 'testnet' {
  const network = (process.env.STACKS_NETWORK ?? 'mainnet').toLowerCase();
  return network === 'testnet' ? 'testnet' : 'mainnet';
}

export function deriveStacksServerWalletKey(serverWalletId: string): string {
  const secret = getMasterSecret();
  return crypto.createHmac('sha256', secret).update(serverWalletId).digest('hex');
}

export function deriveStacksServerWallet(serverWalletId: string): {
  address: string;
  privateKey: string;
} {
  const privateKey = deriveStacksServerWalletKey(serverWalletId);
  const address = getAddressFromPrivateKey(privateKey, getNetwork());
  return { address, privateKey };
}

