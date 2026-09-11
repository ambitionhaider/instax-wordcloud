import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Fujifilm Instax – Live Word Cloud',
  description: 'Real-time word cloud for Fujifilm Instax audience sessions',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>{children}</body>
    </html>
  )
}
