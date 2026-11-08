'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAppStore } from '@/store/use-app-store'
import { Loader2 } from 'lucide-react'

// 0.6.53 — Billing Manager replaces the old transactions page under
// "Managing Sales and Operations". Same SUPER_ADMIN guard + hash routing
// pattern as admin/transactions: set the SPA view, then bounce to '/'.
export default function AdminBillingPage() {
  const { setView, user, isAuthenticated } = useAppStore()
  const router = useRouter()

  useEffect(() => {
    if (!isAuthenticated || user?.role !== 'SUPER_ADMIN') {
      router.replace('/')
      return
    }
    setView('admin-billing-manager')
    router.replace('/')
  }, [setView, router, user, isAuthenticated])

  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <Loader2 className="h-8 w-8 animate-spin text-emerald-600" />
    </div>
  )
}
