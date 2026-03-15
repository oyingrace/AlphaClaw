'use client';

import { useState } from 'react';
import { type ComponentProps, type ReactNode } from 'react';
import { useAuth } from '@/providers/auth-provider';
import { Button } from '@/components/ui/button';
import { connectStacksAndLogin } from '@/lib/stacks-connect';
import { toast } from 'sonner';

interface ConnectCTAProps extends Omit<ComponentProps<typeof Button>, 'onClick'> {
  children: ReactNode;
}

export function ConnectCTA({ children, ...buttonProps }: ConnectCTAProps) {
  const { handleLogin } = useAuth();
  const [loading, setLoading] = useState(false);

  const handleClick = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const { address, jwt } = await connectStacksAndLogin();
      await handleLogin(jwt, address);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to connect wallet';
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button
      onClick={handleClick}
      disabled={loading}
      {...buttonProps}
      className={buttonProps.className}
    >
      {loading ? 'Connecting...' : children}
    </Button>
  );
}
