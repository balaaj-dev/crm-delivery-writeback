import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Cymate — CRM Delivery & Writeback (skeleton)',
  description: 'Internal reference implementation. Not the production system.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900">
        <div className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-center text-sm text-amber-900">
          Skeleton reference implementation — not connected to any live client CRM unless
          DRY_RUN is explicitly set to false.
        </div>
        {children}
      </body>
    </html>
  );
}
