# Task ID: 3 — Web/Kiosk LAN Auto-Discovery Client

## Summary

Implemented the web/kiosk side of LAN auto-discovery for the BLASTI queue management app. Since browsers cannot receive UDP broadcasts, the web client uses HTTP-based scanning to discover BLASTI desktop servers on the LAN. The discovery integrates with the kiosk mode for automatic LAN connection, provides a UI panel for manual discovery, and includes a React hook for easy integration in other components.

## Files Created

### 1. `/apps/web/src/lib/lan-discovery.ts` — Core LAN Discovery Client

The core discovery engine for the web app. Since browsers can't receive UDP broadcasts, it uses HTTP-based scanning to find BLASTI desktop servers.

**Key features:**
- **Discovery Strategies** (executed in order):
  1. **Localhost check** — If served from localhost, checks `127.0.0.1:3080`
  2. **mDNS hostname** — Tries `blasti.local:3080` and `blasti._tcp.local:3080`
  3. **Current subnet scan** — If the page is served from a LAN IP, scans that subnet first
  4. **Full subnet scan** — Scans 7 common LAN subnets (192.168.1.x, 192.168.0.x, 192.168.2.x, 10.0.0.x, 10.0.1.x, 192.168.4.x, 172.16.0.x)

- **Exported types**: `DiscoveredServer`, `DiscoveryState`
- **Exported functions**:
  - `discoverLanServer()` — Full discovery scan with progress callbacks
  - `quickDiscover()` — Fast scan (localhost + mDNS + current subnet + 192.168.1)
  - `onDiscoveryStateChange()` — Subscribe to discovery state changes
  - `clearCache()` — Clear cached server info
  - `getLanApiUrl()` — Build API URL from discovered server
  - `getLanSocketUrl()` — Build Socket.IO URL from discovered server
  - `getLanWebUrl()` — Build web URL from discovered server

- **Performance**: Scans 10 IPs concurrently with 1.5s timeout per IP; caches results for 5 minutes in localStorage

### 2. `/apps/web/src/components/shared/lan-discovery-panel.tsx` — UI Panel Component

A reusable UI component that shows discovery status and allows users to manually trigger scanning or enter a server IP.

**Two modes:**
- **Compact mode** (`compact={true}`) — Inline status indicator with icons, ideal for embedding in headers or toolbars
- **Full mode** (default) — Card with progress bar, server details, quick/full scan buttons, and manual IP entry

**Bilingual labels** (Arabic + English) matching the app's RTL design

### 3. `/apps/web/src/hooks/use-lan-discovery.ts` — React Hook

A React hook for easy integration of LAN discovery in any component.

**Features:**
- Auto-restores LAN connection from localStorage on mount
- Auto-scans on mount if `autoScan=true`
- Manages `apiClient.setBaseUrl()` automatically when connecting/disconnecting
- Persists the LAN API URL in localStorage
- Returns full discovery state + action methods

### 4. `/apps/web/src/components/kiosk/kiosk-mode.tsx` — Kiosk Auto-Discovery Integration

**Changes made:**
- Added imports: `quickDiscover`, `getLanApiUrl`, `DiscoveredServer` from `@/lib/lan-discovery`
- Added imports: `apiClient` from `@/lib/api-client`
- Added imports: `Wifi`, `WifiOff` from `lucide-react`
- Added imports: `Badge` from `@/components/ui/badge`
- Added LAN auto-discovery state and `useEffect` that:
  - Runs `quickDiscover()` on component mount
  - If a server is found, switches `apiClient` base URL to the LAN server
  - Falls back gracefully to cloud mode if no server found
- Added fixed-position LAN connection indicator badge (bottom-left):
  - Green badge with Wifi icon when connected to LAN server (shows hostname)
  - Gray badge with WifiOff icon when in cloud mode
  - Only shows after discovery completes (avoids flashing during scan)

## Verification

- Dev server compiles successfully (HTTP 200 on `/`)
- No new lint errors introduced (only pre-existing warnings/errors in other files)
- All new files pass TypeScript compilation
- LAN discovery module is SSR-safe (all browser APIs guarded with `typeof window` checks)
