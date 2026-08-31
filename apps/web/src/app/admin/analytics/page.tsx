'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAppStore } from '@/store/use-app-store'
import { Loader2 } from 'lucide-react'

export default function AdminAnalyticsPage() {
  const { setView, user, isAuthenticated } = useAppStore()
  const router = useRouter()

  useEffect(() => {
    if (!isAuthenticated || user?.role !== 'SUPER_ADMIN') {
      router.replace('/')
      return
    }
    setView('admin-analytics')
    router.replace('/')
  }, [setView, router, user, isAuthenticated])

  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <Loader2 className="h-8 w-8 animate-spin text-emerald-600" />
    </div>
  )
}
