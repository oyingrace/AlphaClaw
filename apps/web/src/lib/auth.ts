import { api } from './api-client';
import { setToken, clearToken, getToken } from './token-store';

/** Response from GET /api/auth/me — note snake_case from Supabase */
export interface AuthMeResponse {
  id: string;
  wallet_address: string;
  display_name: string | null;
  auth_method: string | null;
  risk_profile: string | null;
  risk_answers: Record<string, unknown> | null;
  preferred_currencies: string[] | null;
  onboarding_completed: boolean;
  created_at: string;
  updated_at: string;
}

interface StacksPayloadResponse {
  message: string;
}

interface StacksLoginResponse {
  token?: string;
  error?: string;
}

/**
 * Get the message to sign for Stacks auth (POST /api/auth/stacks-payload).
 */
export async function getStacksPayload(address: string): Promise<string> {
  const res = await api.post<StacksPayloadResponse>('/api/auth/stacks-payload', {
    address,
  });
  if (!res.message) throw new Error('No message in stacks-payload response');
  return res.message;
}

/**
 * Send signed message to backend, receive JWT (POST /api/auth/stacks-login).
 */
export async function loginStacks(params: {
  address: string;
  message: string;
  signature: string;
}): Promise<string> {
  const res = await api.post<StacksLoginResponse>('/api/auth/stacks-login', {
    address: params.address,
    message: params.message,
    signature: params.signature,
  });
  if (res.error || !res.token) {
    throw new Error(res.error ?? 'Stacks login failed: no token returned');
  }
  setToken(res.token);
  return res.token;
}

/**
 * Validate the current JWT and get the user profile.
 * Returns null if no token or token is invalid.
 */
export async function checkSession(): Promise<AuthMeResponse | null> {
  const token = getToken();
  if (!token) return null;

  try {
    return await api.get<AuthMeResponse>('/api/auth/me');
  } catch {
    return null;
  }
}

/**
 * Clear local JWT. Backend logout is a no-op acknowledgment.
 */
export async function logout(): Promise<void> {
  try {
    await api.post('/api/auth/logout');
  } catch {
    // Ignore — we're logging out regardless
  }
  clearToken();
}
