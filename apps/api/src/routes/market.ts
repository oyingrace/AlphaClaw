import type { FastifyInstance } from 'fastify';
import { getMarketTokens } from '../services/market-data-service.js';

export async function marketRoutes(app: FastifyInstance) {
  app.get('/api/market/tokens', async () => {
    const tokens = await getMarketTokens();
    return {
      tokens,
      updatedAt: new Date().toISOString(),
    };
  });

  app.get('/api/market/stx-price', async () => {
    try {
      const res = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=blockstack&vs_currencies=usd',
      );
      const data = (await res.json()) as { blockstack?: { usd?: number } };
      const price = data.blockstack?.usd;
      return {
        priceUsd: price ?? 0,
        updatedAt: new Date().toISOString(),
      };
    } catch (err) {
      app.log.warn(err, 'Failed to fetch STX price');
      return { priceUsd: 0, updatedAt: new Date().toISOString() };
    }
  });
}
