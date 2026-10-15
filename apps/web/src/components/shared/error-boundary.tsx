'use client'

import React from 'react'
import { AlertTriangle, RefreshCw, Home, ClipboardCopy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useLanguage } from '@/hooks/use-language'
import { toast } from 'sonner'
// Side-effect import: installs the global uncaught-error reporter in the
// browser (window error + unhandledrejection → console + Electron terminal).
import { reportCaughtError } from '@/lib/error-reporter'
import { diagDump } from '@/lib/diag-log'
import { getAppVersion } from '@/lib/app-version'

interface ErrorBoundaryProps {
  children: React.ReactNode
  fallback?: React.ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

// Separate display component to use hooks inside class boundary
function ErrorBoundaryFallback({ onReset, onGoHome, errorMessage }: { onReset: () => void; onGoHome: () => void; errorMessage?: string }) {
  const { t } = useLanguage()
  const [version, setVersion] = React.useState<string | null>(null)

  // The REAL installed version (native versionName inside the shell, null on
  // web) — a user reporting "this page could not load" must be able to say
  // WHICH build showed it.
  React.useEffect(() => {
    let alive = true
    getAppVersion().then((v) => { if (alive) setVersion(v) }).catch(() => {})
    return () => { alive = false }
  }, [])

  const copyReport = React.useCallback(async () => {
    const lines = [
      '— BLASTI تقرير خطأ —',
      `الخطأ: ${errorMessage || 'غير معروف'}`,
      `الإصدار: ${version || 'غير معروف'}`,
      `الصفحة: ${typeof window !== 'undefined' ? (window.location.hash || '/') : '/'}`,
      '— آخر الأحداث —',
      diagDump('error-boundary'),
    ]
    const report = lines.join('\n')
    try {
      await navigator.clipboard.writeText(report)
      toast.success(t('diagCopied'))
    } catch {
      toast.error(t('diagCopyFailed'))
    }
  }, [errorMessage, version, t])

  return (
    <div className="flex items-center justify-center min-h-[60vh] p-6">
      <div className="max-w-sm w-full text-center space-y-6">
        {/* Error icon with animation */}
        <div className="mx-auto w-20 h-20 rounded-full bg-rose-100 dark:bg-rose-900/20 flex items-center justify-center">
          <div className="w-14 h-14 rounded-full bg-rose-200 dark:bg-rose-900/30 flex items-center justify-center animate-pulse">
            <AlertTriangle className="h-7 w-7 text-rose-600 dark:text-rose-400" />
          </div>
        </div>

        {/* Error message */}
        <div className="space-y-2">
          <h3 className="text-lg font-semibold text-foreground">
            {t('errorLoadingData')}
          </h3>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {t('errorLoadingData')}
          </p>
          {version && (
            <p className="text-xs font-mono text-muted-foreground" dir="ltr">v{version}</p>
          )}
        </div>

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Button
            onClick={onReset}
            className="min-h-[44px] gap-2 bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-600"
          >
            <RefreshCw className="h-4 w-4" />
            {t('tryAgain')}
          </Button>
          <Button
            variant="outline"
            onClick={onGoHome}
            className="min-h-[44px] gap-2"
          >
            <Home className="h-4 w-4" />
            {t('home')}
          </Button>
          <Button
            variant="ghost"
            onClick={() => void copyReport()}
            className="min-h-[44px] gap-2 text-muted-foreground"
          >
            <ClipboardCopy className="h-4 w-4" />
            {t('diagCopyReport')}
          </Button>
        </div>
      </div>
    </div>
  )
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary] Caught error:', error, errorInfo)
    // Forward the FULL stack to the Electron main terminal (no DevTools
    // needed) so renderer crashes like "Cannot read properties of null
    // (reading 'split')" become isolatable from the user's log alone.
    try {
      reportCaughtError(error, 'ErrorBoundary: ' + (errorInfo.componentStack || '').trim().split('\n')[0])
    } catch { /* reporter must never throw */ }
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  handleGoHome = () => {
    this.setState({ hasError: false, error: null })
    window.location.href = '/'
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <ErrorBoundaryFallback
          onReset={this.handleReset}
          onGoHome={this.handleGoHome}
          errorMessage={this.state.error?.message}
        />
      )
    }

    return this.props.children
  }
}
