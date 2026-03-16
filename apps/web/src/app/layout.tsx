import type { Metadata } from 'next';
import { barlow, jetbrainsMono, dmSans } from '@/lib/fonts';
import { Providers } from './providers';
import { Toaster } from '@/components/ui/sonner';
import './globals.css';

export const metadata: Metadata = {
  title: 'AlphaClaw',
  description: 'Autonomous FX Trading on Stacks',
  icons: {
    icon: '/alphaclaw.webp',
    apple: '/alphaclaw.webp',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`dark antialiased ${barlow.variable} ${jetbrainsMono.variable} ${dmSans.variable}`}
      suppressHydrationWarning
    >
      <body>
        <Providers>{children}</Providers>
        <Toaster />
      </body>
    </html>
  );
}
