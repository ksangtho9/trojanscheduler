// Root layout — sets up Inter font, global styles, metadata
import type { Metadata } from "next"
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
      <body>{children}</body>
    </html>
  )
}