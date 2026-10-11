'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAppStore } from '@/store/use-app-store'
import { Loader2 } from 'lucide-react'

export default function RegisterPage() {
  const { setView, user, isAuthenticated } = useAppStore()
  const router = useRouter()

  useEffect(() => {
    // If already authenticated, redirect to appropriate dashboard
    if (isAuthenticated && user) {
      if (user.role === 'SUPER_ADMIN') {
        router.replace('/admin')
      } else if (user.role === 'AGENCY_STAFF' || user.role === 'AGENCY_OWNER') {
        router.replace('/agency')
      } else {
        router.replace('/customer')
      }
      return
    }
    setView('register')
    router.replace('/')
  }, [setView, router, user, isAuthenticated])

  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <Loader2 className="h-8 w-8 animate-spin text-emerald-600" />
    </div>
  )
}
