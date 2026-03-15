/**
 * Stacks wallet connect and sign-in. Uses @stacks/connect (Leather, etc.)
 * and our API /api/auth/stacks-payload + /api/auth/stacks-login.
 */
import { connect, request, getLocalStorage } from '@stacks/connect';
import { getStacksPayload, loginStacks } from './auth';

export interface StacksConnectResult {
  address: string;
  jwt: string;
}

function getStxAddress(): string | undefined {
  const data = getLocalStorage();
  return data?.addresses?.stx?.[0]?.address;
}

/**
 * Connect Stacks wallet, sign auth message, and log in to the API.
 * Opens the wallet (Leather, etc.) for connection and signing.
 */
export async function connectStacksAndLogin(): Promise<StacksConnectResult> {
  // 1. Connect wallet (opens Leather / wallet picker)
  await connect({});

  const address = getStxAddress();

  if (!address) {
    throw new Error('Could not get Stacks address from wallet');
  }

  // 2. Get message to sign from our API
  const message = await getStacksPayload(address);

  // 3. Request wallet to sign the message
  const signResult = await request('stx_signMessage', { message });
  const signature =
    typeof signResult === 'object' && signResult !== null && 'signature' in signResult
      ? (signResult as { signature: string }).signature
      : String(signResult);

  if (!signature) {
    throw new Error('Wallet did not return a signature');
  }

  // 4. Send to our API and get JWT
  const jwt = await loginStacks({ address, message, signature });

  return { address, jwt };
}

/**
 * Check if a Stacks wallet session is stored (user has connected before).
 */
export function isStacksConnected(): boolean {
  return !!getStxAddress();
}
