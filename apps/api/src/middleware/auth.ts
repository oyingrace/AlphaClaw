import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyStacksJwt } from '../lib/stacks-auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      walletAddress: string;
    };
  }
}

export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Missing authorization token' });
  }

  const jwt = authHeader.slice(7);

  const stacksAddress = await verifyStacksJwt(jwt);
  if (stacksAddress) {
    request.user = { walletAddress: stacksAddress };
    return;
  }

  return reply.status(401).send({ error: 'Invalid token' });
}
