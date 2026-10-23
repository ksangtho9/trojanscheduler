// Root layout — sets up Inter font, global styles, metadata
import type { Metadata } from "next"
import { Analytics } from "@vercel/analytics/next"
import AnalyticsInit from "@/components/AnalyticsInit"
import "./globals.css"

export const metadata: Metadata = {
  title: "Trojan Scheduler",
  description: "Build your perfect USC schedule",
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>
        {children}
        <Analytics />
        <AnalyticsInit />
      </body>
    </html>
  )
}