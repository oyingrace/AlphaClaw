import type { FastifyInstance } from 'fastify';
import {
  createStacksAuthMessage,
  verifyStacksSignature,
  issueStacksJwt,
} from '../lib/stacks-auth.js';
import { authMiddleware } from '../middleware/auth.js';
import { createSupabaseAdmin } from '@alphaclaw/db';

const supabaseAdmin = createSupabaseAdmin(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export async function authRoutes(app: FastifyInstance) {
  // Stacks: get message to sign
  app.post('/api/auth/stacks-payload', async (request) => {
    const { address } = request.body as { address: string };
    const message = createStacksAuthMessage({ address });
    return { message };
  });

  // Stacks: verify signature and issue JWT
  app.post('/api/auth/stacks-login', async (request, reply) => {
    const { address, message, signature } = request.body as {
      address: string;
      message: string;
      signature: string;
    };
    if (!verifyStacksSignature({ address, message, signature })) {
      return reply.status(401).send({ error: 'Invalid Stacks signature' });
    }
    const jwt = await issueStacksJwt(address);
    return { token: jwt };
  });

  // Get current user profile (protected)
  app.get(
    '/api/auth/me',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const walletAddress = request.user!.walletAddress;

      // Upsert user profile
      const { data, error } = await supabaseAdmin
        .from('user_profiles')
        .upsert(
          { wallet_address: walletAddress },
          { onConflict: 'wallet_address' },
        )
        .select()
        .single();

      if (error) {
        return reply.status(500).send({ error: 'Failed to fetch user profile' });
      }

      return data;
    },
  );

  // Stateless JWT — token invalidation happens client-side.
  // For server-side revocation, implement a token blacklist.
  app.post('/api/auth/logout', async () => {
    return { success: true };
  });
}
