// ─── server-metrics.ts — SUPER ADMIN analyzer "Server" section collector ────
//
// Three cooperative parts (all fire-and-forget — a metrics bug must NEVER
// break traffic):
//
//   1. recordComponentRequest() — called from the /api/* middleware in
//      index.ts for EVERY request: pure in-memory counter increments tagged
//      with the logical engine/manager the path belongs to (classifyComponent).
//
//   2. startServerMetricsCollector() — a 60s interval that writes exactly one
//      ServerMetricSample row (CPU, iowait, load, RAM, disk space, disk
//      read/write KB/s, network up/down KB/s — all from /proc deltas measured
//      across the tick) plus one ServerComponentSample row per component with
//      activity in that minute. On boot it records an 'api-restart'
//      ServerOutage when the previous stored sample is older than the tick —
//      that is how "the server lost connection" becomes queryable history.
//      A daily prune keeps 180 days of samples.
//
//   3. getLinkMbpsCap() — the network-bottleneck ceiling, admin-overridable
//      via SystemSetting key 'serverMetrics.linkMbps' (default 100 Mbps).
//
// Deltas: the very first /proc read happens at import time, so the first
// flushed sample (T+60s) already covers a real 60-second window. If a /proc
// read fails (non-Linux host), counters carry forward and rates are written
// as 0 — never negative, never a crash.

import { readFileSync } from 'fs'
import { statfs } from 'fs/promises'
import os from 'os'
import { db } from '@blasti/db'

// ─── Component classification (engine/manager filter dimension) ─────────────

/** Stable component keys — the admin UI chips map 1:1 onto these. */
export const SERVER_COMPONENTS = [
  'sync-engine',
  'storage-manager',
  'logs-manager',
  'public-app-settings',
  'sales-manager',
  'billing-manager',
  'messaging',
  'reservations',
  'agencies',
  'auth',
  'admin-console',
  'other',
] as const
export type ServerComponent = (typeof SERVER_COMPONENTS)[number]

const COMPONENT_SET = new Set<string>(SERVER_COMPONENTS)

/**
 * HTTP path prefix → logical engine/manager. Order matters: the sync engine
 * claims its file-sync sub-routes BEFORE the storage manager, and the storage
 * manager claims uploads/files BEFORE the generic buckets. socket.io frames
 * never reach HTTP middleware — realtime load shows up through the sync
 * engine's pull/push endpoints instead.
 */
export function classifyComponent(path: string): ServerComponent {
  const p = String(path ?? '')
  if (
    p.startsWith('/api/sync') ||
    p.startsWith('/api/files/sync') ||
    p.startsWith('/api/offline-sync')
  ) {
    return 'sync-engine'
  }
  if (p.startsWith('/api/admin/storage') || p.startsWith('/api/admin/backups')) {
    return 'storage-manager'
  }
  if (p.startsWith('/api/logs')) {
    return 'logs-manager'
  }
  if (p.startsWith('/api/app-versions') || p.startsWith('/api/app-installs')) {
    return 'public-app-settings'
  }
  if (p.startsWith('/api/transactions') || p.startsWith('/api/payment')) {
    return 'sales-manager'
  }
  if (p.startsWith('/api/billing') || p.startsWith('/api/payment-settings')) {
    return 'billing-manager'
  }
  if (p.startsWith('/api/notifications') || p.startsWith('/api/sms') || p.startsWith('/api/webhooks')) {
    return 'messaging'
  }
  if (p.startsWith('/api/reservations') || p.startsWith('/api/queue')) {
    return 'reservations'
  }
  if (p.startsWith('/api/agencies') || p.startsWith('/api/agency')) {
    return 'agencies'
  }
  if (p.startsWith('/api/auth')) {
    return 'auth'
  }
  if (p.startsWith('/api/admin')) {
    return 'admin-console'
  }
  return 'other'
}

// ─── In-memory per-minute component counters ────────────────────────────────

interface ComponentCounter {
  requests: number
  errors: number
  bytesIn: number
  bytesOut: number
}

const componentCounters = new Map<ServerComponent, ComponentCounter>()

function counterFor(component: ServerComponent): ComponentCounter {
  let c = componentCounters.get(component)
  if (!c) {
    c = { requests: 0, errors: 0, bytesIn: 0, bytesOut: 0 }
    componentCounters.set(component, c)
  }
  return c
}

const MAX_PER_EVENT_BYTES = 2_000_000_000

function clampBytes(n: unknown): number {
  const num = typeof n === 'number' && Number.isFinite(n) ? n : 0
  return Math.min(Math.max(0, Math.round(num)), MAX_PER_EVENT_BYTES)
}

/** Count one request against its engine/manager. NEVER throws. */
export function recordComponentRequest(path: string, status: number, bytesIn: number, bytesOut: number): void {
  try {
    const component = classifyComponent(path)
    const c = counterFor(component)
    c.requests += 1
    if (status >= 500) c.errors += 1
    c.bytesIn += clampBytes(bytesIn)
    c.bytesOut += clampBytes(bytesOut)
  } catch {
    // counter bug — drop the event, never the request
  }
}

function drainComponentCounters(): Array<ServerComponentSampleCreate> {
  const rows: Array<ServerComponentSampleCreate> = []
  for (const [component, c] of componentCounters) {
    if (c.requests === 0 && c.bytesIn === 0 && c.bytesOut === 0) continue
    rows.push({
      component,
      requests: c.requests,
      errors: c.errors,
      bytesIn: c.bytesIn,
      bytesOut: c.bytesOut,
    })
  }
  componentCounters.clear()
  return rows
}

interface ServerComponentSampleCreate {
  component: string
  requests: number
  errors: number
  bytesIn: number
  bytesOut: number
}

// ─── /proc readers ──────────────────────────────────────────────────────────

interface CpuTicks {
  busy: number
  total: number
  iowait: number
}

function readCpuTicks(): CpuTicks | null {
  try {
    const firstLine = readFileSync('/proc/stat', 'utf8').split('\n')[0]
    if (!firstLine.startsWith('cpu ')) return null
    const cols = firstLine.trim().split(/\s+/).slice(1).map(Number)
    if (cols.length < 4) return null
    const [user, nice, sys, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = cols
    return {
      busy: user + nice + sys + irq + softirq + steal,
      iowait,
      total: user + nice + sys + idle + iowait + irq + softirq + steal,
    }
  } catch {
    return null
  }
}

interface RamInfo {
  usedMb: number
  totalMb: number
}

function readRam(): RamInfo {
  try {
    const txt = readFileSync('/proc/meminfo', 'utf8')
    const getKb = (key: string): number | null => {
      const m = txt.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'))
      return m ? parseInt(m[1], 10) : null
    }
    const totalKb = getKb('MemTotal')
    const availKb = getKb('MemAvailable')
    if (totalKb && availKb !== null) {
      return {
        totalMb: Math.round(totalKb / 1024),
        usedMb: Math.max(0, Math.round((totalKb - availKb) / 1024)),
      }
    }
  } catch {
    // fall through to os module
  }
  const total = os.totalmem()
  const free = os.freemem()
  return { totalMb: Math.round(total / 1048576), usedMb: Math.max(0, Math.round((total - free) / 1048576)) }
}

interface DiskIo {
  readKbps: number
  writeKbps: number
}

function readDiskStatsSectors(): { read: number; written: number } | null {
  try {
    const txt = readFileSync('/proc/diskstats', 'utf8')
    let read = 0
    let written = 0
    let sawDisk = false
    for (const line of txt.split('\n')) {
      const cols = line.trim().split(/\s+/)
      // major minor name reads-read ... sectors-written ...
      const name = cols[2]
      if (!name || /^\.*(loop|ram|dm-|md)/.test(name)) continue
      const readsSectors = parseInt(cols[5], 10)
      const writtenSectors = parseInt(cols[9], 10)
      if (Number.isNaN(readsSectors) || Number.isNaN(writtenSectors)) continue
      sawDisk = true
      read += readsSectors
      written += writtenSectors
    }
    return sawDisk ? { read, written } : null
  } catch {
    return null
  }
}

interface NetIo {
  upKbps: number
  downKbps: number
}

function readNetBytes(): { rx: number; tx: number } | null {
  try {
    const txt = readFileSync('/proc/net/dev', 'utf8')
    let rx = 0
    let tx = 0
    let sawIface = false
    for (const line of txt.split('\n').slice(2)) {
      const [ifaceRaw, dataRaw] = line.split(':')
      if (!dataRaw) continue
      const iface = ifaceRaw.trim()
      if (iface === 'lo' || iface.startsWith('veth') || iface.startsWith('docker')) continue
      const cols = dataRaw.trim().split(/\s+/)
      const rxBytes = parseInt(cols[0], 10)
      const txBytes = parseInt(cols[8], 10)
      if (Number.isNaN(rxBytes) || Number.isNaN(txBytes)) continue
      sawIface = true
      rx += rxBytes
      tx += txBytes
    }
    return sawIface ? { rx, tx } : null
  } catch {
    return null
  }
}

async function readDiskSpace(): Promise<{ usedGb: number; totalGb: number } | null> {
  const dir = process.env.BLASTI_DATA_DIR || process.cwd()
  try {
    const s = await statfs(dir)
    if (s && s.blocks > 0) {
      const totalGb = (s.blocks * s.bsize) / 1073741824
      const freeGb = (s.bavail * s.bsize) / 1073741824
      return { totalGb: Math.round(totalGb * 10) / 10, usedGb: Math.round(Math.max(0, totalGb - freeGb) * 10) / 10 }
    }
  } catch {
    // fall through
  }
  return null
}

// ─── Link-cap setting (network bottleneck ceiling) ──────────────────────────

export const LINK_MBPS_SETTING_KEY = 'serverMetrics.linkMbps'
const DEFAULT_LINK_MBPS = 100

export async function getLinkMbpsCap(): Promise<number> {
  try {
    const row = await db.systemSetting.findUnique({ where: { key: LINK_MBPS_SETTING_KEY }, select: { value: true } })
    const parsed = row ? Number(row.value) : NaN
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  } catch {
    // default below
  }
  return DEFAULT_LINK_MBPS
}

// ─── Outage bookkeeping + prune ─────────────────────────────────────────────

const SAMPLE_INTERVAL_MS = 60_000
const SAMPLES_RETAIN_DAYS = 180
const OUTAGE_GAP_MS = SAMPLE_INTERVAL_MS * 5 // >5 min between samples = a loss

async function recordBootOutage(): Promise<void> {
  try {
    const last = await db.serverMetricSample.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    })
    const now = new Date()
    const startedAt = last?.createdAt ?? null
    const gapMs = startedAt ? now.getTime() - startedAt.getTime() : 0
    // First boot ever (no samples): nothing was "lost" — skip.
    // A gap within one tick+slack is a normal restart window, not an outage.
    if (!startedAt || gapMs < OUTAGE_GAP_MS) return
    await db.serverOutage.create({
      data: {
        startedAt,
        endedAt: now,
        durationSec: Math.round(gapMs / 1000),
        reason: 'api-restart',
        details: `last sample ${startedAt.toISOString()} → boot ${now.toISOString()}`,
      },
    })
  } catch (error) {
    console.error('[SERVER-METRICS] boot outage record failed:', error instanceof Error ? error.message : error)
  }
}

async function pruneOldSamples(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - SAMPLES_RETAIN_DAYS * 24 * 60 * 60 * 1000)
    await db.serverMetricSample.deleteMany({ where: { createdAt: { lt: cutoff } } })
    await db.serverComponentSample.deleteMany({ where: { createdAt: { lt: cutoff } } })
    await db.serverOutage.deleteMany({ where: { startedAt: { lt: cutoff } } })
  } catch (error) {
    console.error('[SERVER-METRICS] prune failed:', error instanceof Error ? error.message : error)
  }
}

// ─── The collector tick ─────────────────────────────────────────────────────

let lastCpu: CpuTicks | null = null
let lastDisk: { read: number; written: number } | null = null
let lastNet: { rx: number; tx: number } | null = null
let lastTickAt = Date.now()

function takeSystemSample(): {
  cpuUsagePct: number
  cpuIowaitPct: number
  loadAvg1: number
  ramUsedMb: number
  ramTotalMb: number
  diskUsedGb: number
  diskTotalGb: number
  diskReadKbps: number
  diskWriteKbps: number
  netUpKbps: number
  netDownKbps: number
} {
  const now = Date.now()
  const elapsedSec = Math.max(1, Math.round((now - lastTickAt) / 1000))

  const cpu = readCpuTicks()
  let cpuUsagePct = 0
  let cpuIowaitPct = 0
  if (cpu && lastCpu) {
    const dTotal = cpu.total - lastCpu.total
    if (dTotal > 0) {
      cpuUsagePct = Math.max(0, Math.min(100, ((cpu.busy - lastCpu.busy) / dTotal) * 100))
      cpuIowaitPct = Math.max(0, Math.min(100, ((cpu.iowait - lastCpu.iowait) / dTotal) * 100))
    }
  }
  if (cpu) lastCpu = cpu

  const disk = readDiskStatsSectors()
  let diskReadKbps = 0
  let diskWriteKbps = 0
  if (disk && lastDisk) {
    // 512-byte sectors → KB/s across the elapsed window
    diskReadKbps = Math.max(0, ((disk.read - lastDisk.read) * 0.5) / elapsedSec)
    diskWriteKbps = Math.max(0, ((disk.written - lastDisk.written) * 0.5) / elapsedSec)
  }
  if (disk) lastDisk = disk

  const net = readNetBytes()
  let netUpKbps = 0
  let netDownKbps = 0
  if (net && lastNet) {
    netUpKbps = Math.max(0, ((net.tx - lastNet.tx) / 1024) / elapsedSec)
    netDownKbps = Math.max(0, ((net.rx - lastNet.rx) / 1024) / elapsedSec)
  }
  if (net) lastNet = net

  const ram = readRam()
  lastTickAt = now

  return {
    cpuUsagePct: Math.round(cpuUsagePct * 10) / 10,
    cpuIowaitPct: Math.round(cpuIowaitPct * 10) / 10,
    loadAvg1: Math.round(os.loadavg()[0] * 100) / 100,
    ramUsedMb: ram.usedMb,
    ramTotalMb: ram.totalMb,
    diskUsedGb: 0,
    diskTotalGb: 0,
    diskReadKbps: Math.round(diskReadKbps * 10) / 10,
    diskWriteKbps: Math.round(diskWriteKbps * 10) / 10,
    netUpKbps: Math.round(netUpKbps * 10) / 10,
    netDownKbps: Math.round(netDownKbps * 10) / 10,
  }
}

async function collectorTick(): Promise<void> {
  try {
    const sys = takeSystemSample()
    const space = await readDiskSpace()
    if (space) {
      sys.diskUsedGb = space.usedGb
      sys.diskTotalGb = space.totalGb
    }
    const components = drainComponentCounters()

    await db.$transaction([
      db.serverMetricSample.create({ data: sys }),
      ...(components.length > 0 ? [db.serverComponentSample.createMany({ data: components })] : []),
    ])
  } catch (error) {
    // DB unreachable counts as a connection loss — but the row cannot be
    // written while down; the analyzer derives the outage from the sample gap.
    console.error('[SERVER-METRICS] tick failed:', error instanceof Error ? error.message : error)
  }
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

let started = false
let tickTimer: ReturnType<typeof setInterval> | null = null
let pruneTimer: ReturnType<typeof setInterval> | null = null

/**
 * Boot the 60s resource sampler. Idempotent — a second call is a no-op (the
 * API process boot path is the only caller).
 */
export function startServerMetricsCollector(): void {
  if (started) return
  started = true

  // Baseline /proc reads NOW so the first flushed tick covers a real window.
  lastCpu = readCpuTicks()
  lastDisk = readDiskStatsSectors()
  lastNet = readNetBytes()
  lastTickAt = Date.now()

  void recordBootOutage()
  void pruneOldSamples()

  tickTimer = setInterval(() => {
    void collectorTick()
  }, SAMPLE_INTERVAL_MS)
  tickTimer.unref?.()

  pruneTimer = setInterval(
    () => {
      void pruneOldSamples()
    },
    6 * 60 * 60 * 1000,
  )
  pruneTimer.unref?.()
}
