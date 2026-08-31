'use client'

import React from 'react'
import { AlertTriangle, RefreshCw, Home } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useLanguage } from '@/hooks/use-language'

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
          {errorMessage && process.env.NODE_ENV === 'development' && (
            <div className="mt-3 p-3 rounded-lg bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-800/30 text-start">
              <p className="text-xs font-mono text-red-600 dark:text-red-400 break-all">
                {errorMessage}
              </p>
            </div>
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
