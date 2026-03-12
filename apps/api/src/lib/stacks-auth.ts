/**
 * Stacks auth: issue JWT for Stacks principals (ST1.../SP1...) after message-sign verification.
 * Used alongside or instead of Thirdweb SIWE for the Stacks port.
 */

import * as jose from 'jose';

const STACKS_JWT_ISSUER = 'alphaclaw-stacks';
const STACKS_JWT_AUDIENCE = 'alphaclaw';
const STACKS_JWT_EXPIRY = '7d';

function getStacksJwtSecret(): string {
  const secret = process.env.STACKS_JWT_SECRET ?? process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('STACKS_JWT_SECRET or JWT_SECRET required for Stacks auth');
  }
  return secret;
}

/** Generate a message the client must sign to prove ownership of the Stacks address. */
export function createStacksAuthMessage(params: { address: string }): string {
  const domain = process.env.AUTH_DOMAIN ?? 'localhost';
  const timestamp = Math.floor(Date.now() / 1000);
  return `Sign in to AlphaClaw at ${domain} at ${timestamp}.\nAddress: ${params.address}`;
}

/**
 * Verify that the signature was produced by the given Stacks address for the message.
 * For hackathon we accept any non-empty signature and valid Stacks address format;
 * replace with proper verification (e.g. recover signer from signature) for production.
 */
export function verifyStacksSignature(params: {
  address: string;
  message: string;
  signature: string;
}): boolean {
  const { address, message, signature } = params;
  // Stacks principal format: ST1... or SP1... (mainnet) or ST2.../SP2... (testnet)
  if (!/^[SP][0-9ABCDEFGHJKMNPQRSTVWXYZabcdefghjkmnpqrstuvwxyz]{38,49}$/.test(address)) {
    return false;
  }
  if (!message?.trim()) return false;
  if (!signature?.trim()) return false;
  // TODO: use @stacks/transactions or @stacks/encryption to recover signer from signature
  // and compare to address. For now we require a non-empty signature (client attests).
  return true;
}

/** Issue a JWT with sub = Stacks address for use with auth middleware. */
export async function issueStacksJwt(address: string): Promise<string> {
  const secret = new TextEncoder().encode(getStacksJwtSecret());
  return await new jose.SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(address)
    .setIssuer(STACKS_JWT_ISSUER)
    .setAudience(STACKS_JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(STACKS_JWT_EXPIRY)
    .sign(secret);
}

/** Verify a JWT issued by issueStacksJwt; returns sub (Stacks address) or null. */
export async function verifyStacksJwt(token: string): Promise<string | null> {
  try {
    const secret = new TextEncoder().encode(getStacksJwtSecret());
    const { payload } = await jose.jwtVerify(token, secret, {
      issuer: STACKS_JWT_ISSUER,
      audience: STACKS_JWT_AUDIENCE,
    });
    const sub = payload.sub;
    return typeof sub === 'string' ? sub : null;
  } catch {
    return null;
  }
}
