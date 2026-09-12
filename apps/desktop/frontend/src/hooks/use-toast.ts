"use client"

// Minimal shim for use-toast hook (shadcn/ui toast integration)

export interface ToastOptions {
  title?: string
  description?: string
  action?: React.ReactElement
  variant?: "default" | "destructive"
}

export function useToast() {
  return {
    toast: (_opts: ToastOptions) => {},
    toasts: [] as any[],
    dismiss: (_id: string) => {},
  }
}
