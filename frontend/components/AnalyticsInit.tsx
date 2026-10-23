"use client"

// Starts PostHog once on the client. Renders nothing; a no-op without a key.
import { useEffect } from "react"
import { initAnalytics } from "@/lib/analytics"

export default function AnalyticsInit() {
  useEffect(() => {
    initAnalytics()
  }, [])
  return null
}
