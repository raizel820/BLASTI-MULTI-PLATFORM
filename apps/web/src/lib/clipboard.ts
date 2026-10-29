/**
 * safeCopyText — clipboard that works on EVERY device (user request: the
 * staff account-creation dialog failed to copy on some machines).
 *
 * `navigator.clipboard` is only available in secure contexts. The desktop
 * app normally renders from http://127.0.0.1:3080 (secure), but its
 * last-ditch fallback loads the static export via file:// where the async
 * Clipboard API is UNDEFINED — the credentials dialog then threw a raw
 * TypeError. This helper degrades gracefully:
 *   1. navigator.clipboard.writeText (secure contexts)
 *   2. hidden <textarea> + document.execCommand('copy') (legacy/WebView)
 * Returns true when the text actually reached the clipboard.
 */
export async function safeCopyText(text: string): Promise<boolean> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.top = '-1000px'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    textarea.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}
