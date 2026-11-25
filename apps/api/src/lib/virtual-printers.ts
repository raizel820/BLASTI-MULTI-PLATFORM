/**
 * virtual-printers.ts — host-side spooler-queue detection (0.6.124).
 * ─────────────────────────────────────────────────────────────────────────────
 * Cloud twin of the desktop's discovery-scanner `isVirtualPrinterName`
 * (apps/desktop/local-api/lib/discovery-scanner.js).
 *
 * WHY THIS EXISTS: Windows ships software print queues beside every real
 * printer — "Send To OneNote 16", "OneNote for Windows 10", "Microsoft Print
 * to PDF", "Microsoft XPS Document Writer", "Fax" — and third-party PDF
 * writers pile on (CutePDF, PDF24, novaPDF …). They have NO physical device
 * behind them. The 0.6.123 keyword filter fixed the desktop scan, but rows
 * saved BEFORE that fix still lived in the cloud database and the desktop's
 * discovery cache, so "discovery still show OneNote for Windows 10 and Send
 * To OneNote 16". This helper lets every CLOUD surface (discovery registry
 * merge, register-peripheral) apply the same rule server-side.
 */

const EXACT_NAMES = new Set([
  'adobe pdf', 'adobe pdf converter', 'adobe pdf printer',
  'microsoft print to pdf', 'microsoft xps document writer', 'microsoft print to pdf converter',
  'onenote', 'onenote (desktop)', 'onenote 2016', 'onenote printer',
  'send to onenote', 'onenote for windows 10',
  'fax', 'windows fax and scan', 'microsoft fax',
  'cutepdf writer', 'cutepdf',
  'dopdf', 'dopdf7', 'dopdf8', 'dopdf9', 'dopdf10', 'dopdf11',
  'pdf24', 'pdf24 printer', 'pdf24 creator',
  'nova pdf', 'novapdf', 'novapdf printer',
  'freepdf', 'free pdf', 'free pdf creator',
  'pdfcreator', 'pdfcreator printer',
  'bullzip pdf printer', 'bullzip pdf',
  'primopdf', 'primo pdf',
  'snagit printer', 'snaggit printer',
  'quicktime pdf',
  'nitro pdf creator',
  'wondershare pdf element',
  'pdf995', 'pdf995 printer',
])

const KEYWORD_PATTERNS = [
  /\bonenote\b/i,
  /send\s+to\s+onenote/i,
  /print\s+to\s+pdf/i,
  /\bpdf\b/i,
  /\bxps\b/i,
  /document\s+writer/i,
  /\bfax\b/i,
]

/** True when `name` identifies a virtual / software printer queue that must
 * never be listed, selected or registered as a physical printer. */
export function isVirtualPrinterName(name: string | null | undefined): boolean {
  if (!name) return false
  const lower = String(name).toLowerCase().trim()
  if (!lower) return false
  if (EXACT_NAMES.has(lower)) return true
  for (const re of KEYWORD_PATTERNS) {
    if (re.test(lower)) return true
  }
  // "Adobe PDF (Copy 1)" style driver-copy suffixes.
  const base = lower.replace(/\s+\(.*\)$/, '').replace(/\s+copy\s*\d+$/, '')
  return EXACT_NAMES.has(base)
}

/** Strip virtual printer entries from a discovery-shaped device list. */
export function filterVirtualPrinterDevices<T extends Record<string, unknown>>(devices: T[]): T[] {
  return devices.filter((d) => {
    const candidates = [d.name, d.cupsName, d.model, d.httpTitle]
    return !candidates.some((c) => typeof c === 'string' && isVirtualPrinterName(c as string))
  })
}
