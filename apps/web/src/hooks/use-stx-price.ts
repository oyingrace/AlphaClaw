import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export const stxPriceKeys = {
  all: ['stx-price'] as const,
};

export function useStxPrice() {
  return useQuery({
    queryKey: stxPriceKeys.all,
    queryFn: async () => {
      const res = await api.get<{ priceUsd: number; updatedAt: string }>(
        '/api/market/stx-price',
      );
      return res;
    },
    staleTime: 60_000, // 1 minute
  });
}
