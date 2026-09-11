import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'Trading Platform',
  description: 'Professional trading terminal.',
};

export const viewport: Viewport = {
  themeColor: '#0b0e13',
  width: 'device-width',
  initialScale: 1,
  /**
   * Zoom is **not** capped, and the reason it once was is worth keeping.
   *
   * `maximumScale: 1` was here so a trader double-tapping a Close button did
   * not zoom the page instead of closing a position. That is a real problem
   * with a wrong remedy: it takes pinch-zoom away from everyone who needs it,
   * permanently, to stop an accidental gesture — and somebody who cannot read
   * a price without magnifying it cannot trade at all. WCAG 1.4.4 says as
   * much, and the accessibility audit in `scripts/smoke-web.ts` flagged it on
   * every screen.
   *
   * The gesture is handled where it happens instead: `touch-action:
   * manipulation` in `globals.css` stops double-tap zoom on controls while
   * leaving the page pinchable.
   */
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
