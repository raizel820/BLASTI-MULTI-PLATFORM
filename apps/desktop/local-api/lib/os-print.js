// os-print.js — OS-level printing helpers for printers physically attached to
// THIS machine (USB / CUPS queues). Raw JetDirect (TCP :9100) can never reach
// a USB printer — printing must go through the operating system's print
// service (CUPS on Linux/macOS, the Windows spooler via Electron).
//
// Extracted from lib/device-board-routes.js (0.6.103) so BOTH the host
// print-job route and the discovery print/probe routes share one
// implementation:
//   - printHtmlSilent(html, deviceName)  — hidden Electron window, silent print
//   - printEscposRaw(buffer, cupsName)   — `lp -d <queue> -o raw` (Linux/macOS)
//   - buildReceiptHtml(ticket)           — 80mm receipt HTML for the spooler
//
// All output/comments in English. No new npm dependencies.

'use strict'

/** Safe error message extraction (mirrors the local-api convention). */
function errorMessage(err) {
  return err && err.message ? String(err.message) : String(err)
}

/** Escape a string for HTML receipt rendering. */
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** 80mm receipt HTML — mirrors the kiosk browser fallback styling. */
function buildReceiptHtml(ticket) {
  const lines = Array.isArray(ticket.lines) ? ticket.lines.slice(0, 40) : []
  const lineRows = lines.map((l) => {
    const left = typeof l === 'string' ? l : String(l.left || '')
    const right = typeof l === 'object' && l && l.right != null ? String(l.right) : ''
    return `<div class="row"><span>${escHtml(left)}</span><span>${escHtml(right)}</span></div>`
  }).join('')
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      @page { margin: 4mm; }
      body { font-family: 'Courier New', monospace; width: 72mm; margin: 0; padding: 0; color: #000; }
      .center { text-align: center; }
      .title { font-size: 15px; font-weight: 700; margin: 4px 0 2px; }
      .sub { font-size: 11px; margin: 1px 0; }
      .num { font-size: 42px; font-weight: 700; letter-spacing: 2px; margin: 10px 0 6px; }
      .row { display: flex; justify-content: space-between; font-size: 11px; margin: 1px 0; }
      .sep { border-top: 1px dashed #000; margin: 6px 0; }
      .footer { text-align: center; font-size: 10px; margin-top: 8px; letter-spacing: 3px; }
    </style></head><body>
      <div class="center title">${escHtml(ticket.agencyName || 'BLASTI')}</div>
      ${ticket.branchName ? `<div class="center sub">${escHtml(ticket.branchName)}</div>` : ''}
      <div class="sep"></div>
      ${ticket.serviceName ? `<div class="center sub">${escHtml(ticket.serviceName)}</div>` : ''}
      <div class="center num">${escHtml(ticket.ticketNumber || '—')}</div>
      <div class="sep"></div>
      ${lineRows}
      <div class="sep"></div>
      ${ticket.qrData ? `<div class="center"><img src="https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(ticket.qrData)}" width="120" height="120" alt="QR" /></div>` : ''}
      <div class="footer">${escHtml(ticket.footer || 'BLASTI')}</div>
    </body></html>`
}

/** Print HTML via a hidden Electron window (silent, named printer). */
async function printHtmlSilent(html, deviceName) {
  const { BrowserWindow } = require('electron')
  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, sandbox: true },
  })
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    const printers = await win.webContents.getPrintersAsync().catch(() => [])
    if (Array.isArray(printers) && printers.length === 0) {
      return { ok: false, error: 'No printers available on this system' }
    }
    if (deviceName && Array.isArray(printers) && printers.length > 0 && !printers.some((p) => p.name === deviceName)) {
      return { ok: false, error: `Printer "${deviceName}" not found on this system` }
    }
    return await new Promise((resolve) => {
      win.webContents.print(
        { silent: true, printBackground: true, ...(deviceName ? { deviceName } : {}), margins: { marginType: 'none' } },
        (success, errorType) => resolve(success ? { ok: true } : { ok: false, error: errorType || 'print failed' }),
      )
    })
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  } finally {
    try { win.destroy() } catch { /* already gone */ }
  }
}

/** Raw ESC/POS through CUPS (`lp -o raw`) — Linux / macOS hosts. */
function printEscposRaw(buffer, cupsName) {
  const { spawnSync } = require('child_process')
  const os = require('os')
  const fs = require('fs')
  const path = require('path')
  const tmp = path.join(os.tmpdir(), `blasti-print-${Date.now()}-${Math.floor(Math.random() * 1e6)}.bin`)
  try {
    fs.writeFileSync(tmp, buffer)
    const res = spawnSync('lp', ['-d', String(cupsName).slice(0, 120), '-o', 'raw', tmp], { timeout: 15_000 })
    if (res.status === 0) return { ok: true, via: 'cups-raw' }
    return { ok: false, error: (res.stderr && res.stderr.toString().slice(0, 200)) || 'lp failed' }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  } finally {
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
  }
}

/**
 * Print a ticket/ESC-POS payload on a printer attached to THIS machine.
 * Strategies (first match wins):
 *   1. escposBase64 + CUPS queue (non-Windows) → raw ESC/POS via `lp -o raw`
 *      (thermal receipts keep their exact formatting: QR + cut).
 *   2. ticket JSON → HTML receipt rendered in a hidden Electron window and
 *      silently printed to the named printer (cross-platform default).
 */
async function printLocalTicket({ printerName, cupsName, ticket, escposBase64 }) {
  const name = (printerName || cupsName || '').trim()
  // 1) Raw ESC/POS when the caller provides the buffer AND a CUPS queue.
  if (escposBase64 && name && process.platform !== 'win32') {
    try {
      const buf = Buffer.from(escposBase64, 'base64')
      const raw = printEscposRaw(buf, name)
      if (raw.ok) return Object.assign({ via: 'cups-raw' }, raw)
    } catch { /* fall through to the spooler path */ }
  }
  // 2) Spooler path (HTML receipt) — works on every platform.
  const html = buildReceiptHtml(ticket && typeof ticket === 'object' ? ticket : {})
  return printHtmlSilent(html, name || undefined)
}

module.exports = {
  errorMessage,
  escHtml,
  buildReceiptHtml,
  printHtmlSilent,
  printEscposRaw,
  printLocalTicket,
}
