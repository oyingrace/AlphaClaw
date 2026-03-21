import type { Metadata } from 'next';
import { HeroSection } from './_components/hero-section';
import { DashboardMockup } from './_components/dashboard-mockup';
import { TaglineBanner } from './_components/tagline-banner';
import { FeaturesSection } from './_components/features-section';
import { CryptosSection } from './_components/cryptos-section';
import { HowItWorks } from './_components/how-it-works';
import { Testimonials } from './_components/testimonials';
import { FaqSection } from './_components/faq-section';
import { CtaSection } from './_components/cta-section';
import { LandingPageClient } from './_components/landing-page-client';

export const dynamic = 'force-static';

export const metadata: Metadata = {
  other: {
    'talentapp:project_verification':
      '7d95b3e5125e4d8e4eb263c77605f458b10155e78631d2c0efc3bbc1bbdc7e1115e96d2698acb1a826f6d7b45162c2cfc81b4fb06b1316eedc843bb901354752',
  },
};

export default function LandingPage() {
  return (
    <LandingPageClient>
      <HeroSection />
      <DashboardMockup />
      <TaglineBanner />
      <FeaturesSection />
      <CryptosSection />
      <HowItWorks />
      <Testimonials />
      <FaqSection />
      <CtaSection />
    </LandingPageClient>
  );
}
