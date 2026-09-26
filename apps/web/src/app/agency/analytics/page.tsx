'use client'

// Task 42-e: deep-link shim for the agency Analytics & Statistics section
// (#/agency/analytics on the SPA root). Mirrors app/agency/settings/page.tsx.

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAppStore } from '@/store/use-app-store'
import { Loader2 } from 'lucide-react'

export default function AgencyAnalyticsPage() {
  const { setView, user, isAuthenticated } = useAppStore()
  const router = useRouter()

  useEffect(() => {
    if (!isAuthenticated || (user?.role !== 'AGENCY_STAFF' && user?.role !== 'AGENCY_OWNER')) {
      router.replace('/')
      return
    }
    setView('agency-analytics')
    router.replace('/')
  }, [setView, router, user, isAuthenticated])

  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <Loader2 className="h-8 w-8 animate-spin text-emerald-600" />
    </div>
  )
}
