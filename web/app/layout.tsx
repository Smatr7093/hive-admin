import type { Metadata } from 'next';
import './globals.css';
import { SessionProvider } from '@/lib/session';
import { AppFrame } from '@/components/AppFrame';

export const metadata: Metadata = {
    title: 'Hive Admin',
    description: 'Operations console for Hive — Siante Technologies Private Limited',
    // The console must never be indexed, previewed, or cached by anything.
    robots: { index: false, follow: false, nocache: true },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en">
            <body>
                <SessionProvider>
                    <AppFrame>{children}</AppFrame>
                </SessionProvider>
            </body>
        </html>
    );
}
