/**
 * Embedded LAN Discovery Scanner
 * --------------------------------
 * Real multi-protocol device discovery that runs inside the API process.
 *
 * Protocols implemented (no external service required):
 *   1. ARP table read      — `/proc/net/arp` on Linux, `arp -a` on macOS/Windows
 *   2. Ping sweep          — parallel `ping` per host (cross-platform flags)
 *   3. mDNS / DNS-SD       — UDP multicast to 224.0.0.251:5353
 *   4. SSDP / UPnP         — UDP multicast M-SEARCH to 239.255.255.250:1900
 *   5. HTTP probe          — fetch on an expanded port set incl. 631/9100/8001/9197/8060
 *   6. Fingerprinting      — categorise BLASTI / NETWORK / UPNP, type TV/PRINTER/APP/...
 *
 * All multicast/probe work is async, abortable, and concurrency-limited.
 * No raw sockets, no elevated privileges required.
 */

import os from 'node:os'
import fs from 'node:fs'
import dgram from 'node:dgram'
import net from 'node:net'
import dns from 'node:dns/promises'
import { spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'

// ─── Types ──────────────────────────────────────────────────────────────────

export type DiscoverySource = 'arp' | 'ping' | 'mdns' | 'ssdp' | 'http_probe' | 'usb' | 'local'
export type DeviceCategory = 'BLASTI' | 'NETWORK' | 'UPNP' | 'LOCAL'
export type DeviceType = 'TV' | 'KIOSK' | 'DISPLAY' | 'PRINTER' | 'APP' | 'PHONE' | 'ROUTER' | 'IOT' | 'UNKNOWN'

export interface DiscoveredDeviceRaw {
  id: string
  source: DiscoverySource
  category: DeviceCategory
  type: DeviceType
  name: string
  ip: string
  port: number
  mac?: string
  manufacturer?: string
  model?: string
  status: 'ONLINE' | 'STALE'
  lastSeen: number
  firstSeen: number
  connectionType: 'LAN' | 'WIFI' | 'USB' | 'UNKNOWN'
  capabilities: string[]
  httpUrl?: string
  httpTitle?: string
  httpServer?: string
  httpStatus?: number
  ssdpLocation?: string
  ssdpServer?: string
  ssdpSt?: string
  mdnsService?: string
  /** USB Vendor ID (e.g. "04b8" for Epson) — populated by USB probe */
  usbVendorId?: string
  /** USB Product ID (e.g. "0202") — populated by USB probe */
  usbProductId?: string
  /** CUPS printer URI (e.g. "ipp://localhost/printers/EPSON_L3250") */
  cupsUri?: string
  /** CUPS printer queue name (e.g. "EPSON_L3250_Series") */
  cupsName?: string
  /** CUPS printer state: idle, printing, stopped */
  cupsState?: string
  /** Bus:device path for USB (e.g. "001:003") — populated by USB probe */
  usbBusDevice?: string
  /** Optional inferred vendor from MAC OUI lookup */
  macVendor?: string
  /** Raw self-advertised name from mDNS/UPnP (preserved separately from display
   *  `name` so that re-fingerprinting uses the original advertised name, not a
   *  placeholder or HTTP title that may have overwritten `name`). */
  friendlyName?: string
  /** Reverse-DNS hostname (PTR record) resolved for this IP — set by the
   *  'names' phase. Used as a name source when mDNS/SSDP didn't advertise one. */
  reverseDnsName?: string
  /** NetBIOS workstation name (from NBNS port 137 query) — set by the
   *  'names' phase. Often the Windows machine name or printer hostname. */
  netbiosName?: string
  /** DHCP-lease hostname — read from the local DHCP server's lease file
   *  (dnsmasq.leases, dhcpd.leases, etc.). THE most reliable name source
   *  for Android phones, which don't advertise via mDNS/SSDP/NetBIOS but
   *  DO register their product name with the router when getting a lease. */
  dhcpHostname?: string
}

export type ScanPhase =
  | 'idle' | 'arp' | 'ping' | 'mdns' | 'ssdp' | 'names'
  | 'http' | 'local' | 'fingerprinting' | 'complete' | 'error'

export interface ScanProgress {
  phase: ScanPhase
  scannedIPs: number
  totalIPs: number
  currentSubnet: string
  protocolsUsed: string[]
  devicesFound: number
}

export interface ScanCallbacks {
  onProgress: (p: ScanProgress) => void
  onDevice: (d: DiscoveredDeviceRaw) => void
  isAborted: () => boolean
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Expanded port set — covers web apps + printers + TVs + media streamers. */
export const SCAN_PORTS = [
  80,    // router admin / printer web UI
  443,   // HTTPS
  631,   // IPP (printers)
  9100,  // raw print / HP JetDirect
  3000,  // BLASTI API / dev servers
  3003,  // BLASTI API
  5000,  // UPnP / synology / dev
  8001,  // Samsung TV
  8060,  // Roku
  8080,  // alt HTTP
  8443,  // alt HTTPS
  9197,  // Samsung TV (legacy)
  49152, // UPnP ephemeral
]

const PING_CONCURRENCY = 64
const PING_TIMEOUT_MS = 1000
const HTTP_CONCURRENCY = 16
const HTTP_TIMEOUT_MS = 1500
const MDNS_TIMEOUT_MS = 5000
const SSDP_TIMEOUT_MS = 6000

const MDNS_ADDR = '224.0.0.251'
const MDNS_PORT = 5353
const SSDP_ADDR = '239.255.255.250'
const SSDP_PORT = 1900

/** mDNS service types we actively query for.
 *
 * Includes TV-specific service types that smart TVs and streaming sticks
 * broadcast. Many Android TVs and Samsung/LG TVs respond to these even when
 * they ignore a generic `_services._dns-sd._udp.local` enumeration query. */
const MDNS_SERVICE_TYPES = [
  '_services._dns-sd._udp.local',     // enumerate all advertised services
  '_ipp._tcp.local',                   // printers (IPP)
  '_ipps._tcp.local',                  // printers (IPPS)
  '_printer._tcp.local',               // printers (LPD)
  '_pdl-datastream._tcp.local',        // printers (raw port 9100)
  '_http._tcp.local',                  // web services
  '_airplay._tcp.local',               // Apple TV / AirPlay (iOS devices when awake)
  '_googlecast._tcp.local',            // Chromecast / Android TV / Google TV
  '_android._tcp.local',               // Android (rarely advertised by OS — app-driven)
  '_androidtvremote._tcp.local',       // Android TV remote service
  '_apple-mobdev2._tcp.local',         // iPhone/iPad (companion link)
  '_companion-link._tcp.local',        // Apple companion link (iOS handoff)
  '_smb._tcp.local',                   // file shares (Windows / macOS / Linux)
  '_nfs._tcp.local',                   // NFS shares (NAS)
  '_mqtt._tcp.local',                  // IoT
  '_raop._tcp.local',                  // AirPlay audio (Apple TV, AirPlay speakers)
  '_sleep-proxy._udp.local',           // Apple sleep proxy
  '_homekit._tcp.local',               // HomeKit (IoT)
  '_hap._tcp.local',                   // HomeKit Accessory Protocol
  '_sftp-ssh._tcp.local',              // SSH file transfer
  '_ssh._tcp.local',                   // SSH
  '_vnc._tcp.local',                   // VNC remote screen
  '_rdp._tcp.local',                   // RDP
  '_workstation._tcp.local',           // workstation
  // ── TV / casting specific (added to catch smart TVs in standby) ──
  '_dial._tcp.local',                  // DIAL (Chromecast, Samsung/LG TVs)
  '_googlezone._tcp.local',            // Google Cast group
  '_spotify-connect._tcp.local',       // Spotify Connect (speakers, TVs)
  '_dacp._tcp.local',                  // Apple remote (iTunes Remote)
  '_touch-able._tcp.local',            // Apple Remote (older iOS)
  '_mediarenderer._tcp.local',         // UPnP MediaRenderer (DLNA TVs)
  '_mediasource._tcp.local',           // UPnP MediaServer (DLNA, NAS)
  '_leap._tcp.local',                  // Samsung multi-screen
  '_samsung._tcp.local',               // Samsung TV
  '_lg_dial._tcp.local',               // LG TV DIAL
  '_xiaomi._tcp.local',                // Xiaomi IoT / Mi devices
  '_miio._tcp.local',                  // Xiaomi Miio protocol
  '_esphome._tcp.local',               // ESPHome IoT
  '_hass._tcp.local',                  // Home Assistant
  '_nut._tcp.local',                   // Network UPS (smart plugs, IoT)
  '_p1streamer._tcp.local',            // Philips TV streamer
]

// ─── Network helpers ────────────────────────────────────────────────────────

export function getLocalSubnets(): string[] {
  const interfaces = os.networkInterfaces()
  const subnets: string[] = []
  for (const [, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        const parts = addr.address.split('.')
        if (parts.length === 4) {
          const subnet = `${parts[0]}.${parts[1]}.${parts[2]}`
          if (!subnets.includes(subnet)) subnets.push(subnet)
        }
      }
    }
  }
  return subnets.length > 0 ? subnets : ['192.168.1']
}

export interface NetworkInterfaceInfo {
  name: string
  ip: string
  netmask: string
  mac: string
  family: string
  internal: boolean
}

export function getNetworkInterfacesDetailed(): NetworkInterfaceInfo[] {
  const interfaces = os.networkInterfaces()
  const result: NetworkInterfaceInfo[] = []
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue
    for (const addr of addrs) {
      if (addr.family === 'IPv4') {
        result.push({
          name,
          ip: addr.address,
          netmask: addr.netmask,
          mac: addr.mac,
          family: addr.family,
          internal: addr.internal,
        })
      }
    }
  }
  return result
}

// ─── MAC OUI vendor lookup ─────────────────────────────────────────────────

/**
 * Map of MAC-address prefixes (first 3 octets, lowercase, no separators) to
 * the vendor / device class. Used as a heuristic when no UPnP/mDNS metadata is
 * available to classify bare ARP/ping entries.
 *
 * Sources: IEEE OUI registry (https://standards-oui.ieee.org/) — trimmed to
 * the most common consumer-device vendors seen on home networks.
 */
const MAC_OUI_VENDORS: Record<string, { vendor: string; type?: DeviceType }> = {
  // Apple — iPhones, iPads, Macs, Apple TV
  'f8:38:80': { vendor: 'Apple', type: 'PHONE' },
  '3c:15:c2': { vendor: 'Apple', type: 'PHONE' },
  'a4:5e:60': { vendor: 'Apple', type: 'PHONE' },
  'ac:3f:a4': { vendor: 'Apple', type: 'PHONE' },
  '78:7b:8a': { vendor: 'Apple', type: 'PHONE' },
  '70:14:a6': { vendor: 'Apple', type: 'PHONE' },
  'dc:a4:ca': { vendor: 'Apple', type: 'PHONE' },
  'dc:2b:2a': { vendor: 'Apple', type: 'PHONE' },
  'b0:be:83': { vendor: 'Apple', type: 'TV' },     // Apple TV
  '40:cb:a8': { vendor: 'Apple', type: 'TV' },     // Apple TV
  // Samsung — Galaxy phones, tablets, TVs
  '8c:77:5a': { vendor: 'Samsung', type: 'PHONE' },
  'b0:5a:da': { vendor: 'Samsung', type: 'PHONE' },
  '50:4f:4e': { vendor: 'Samsung', type: 'PHONE' },
  'd4:87:d8': { vendor: 'Samsung', type: 'TV' },   // Samsung TV
  '9c:ad:97': { vendor: 'Samsung', type: 'TV' },
  'f8:3f:51': { vendor: 'Samsung', type: 'TV' },
  // Huawei / Honor — phones
  'a4:c3:f0': { vendor: 'Huawei', type: 'PHONE' },
  '8c:79:67': { vendor: 'Huawei', type: 'PHONE' },
  'cc:79:cf': { vendor: 'Huawei', type: 'PHONE' },
  // Xiaomi / Poco / Redmi — phones, IoT (Poco is a Xiaomi sub-brand)
  '64:cc:2e': { vendor: 'Xiaomi', type: 'PHONE' },
  '7c:dd:a1': { vendor: 'Xiaomi', type: 'PHONE' },
  'a0:86:fb': { vendor: 'Xiaomi', type: 'PHONE' },
  '94:65:2d': { vendor: 'Xiaomi', type: 'PHONE' },
  '0c:1d:af': { vendor: 'Xiaomi', type: 'PHONE' },
  '0c:4b:54': { vendor: 'Xiaomi', type: 'PHONE' },
  '18:59:36': { vendor: 'Xiaomi', type: 'PHONE' },
  '34:ce:00': { vendor: 'Xiaomi', type: 'PHONE' },
  '38:a4:ed': { vendor: 'Xiaomi', type: 'PHONE' },
  '3c:bd:d8': { vendor: 'Xiaomi', type: 'PHONE' },
  '4c:49:e3': { vendor: 'Xiaomi', type: 'PHONE' },
  '50:83:8a': { vendor: 'Xiaomi', type: 'PHONE' },
  '58:44:98': { vendor: 'Xiaomi', type: 'PHONE' },
  '5c:e0:c5': { vendor: 'Xiaomi', type: 'PHONE' },
  '60:3a:7c': { vendor: 'Xiaomi', type: 'PHONE' },
  '64:16:66': { vendor: 'Xiaomi', type: 'PHONE' },
  '68:db:ca': { vendor: 'Xiaomi', type: 'PHONE' },
  '70:8a:0e': { vendor: 'Xiaomi', type: 'PHONE' },
  '74:da:38': { vendor: 'Xiaomi', type: 'PHONE' },
  '78:11:dc': { vendor: 'Xiaomi', type: 'PHONE' },
  '80:ad:16': { vendor: 'Xiaomi', type: 'PHONE' },
  '8c:53:c3': { vendor: 'Xiaomi', type: 'PHONE' },
  '9c:f6:dd': { vendor: 'Xiaomi', type: 'PHONE' },
  'a0:b4:a5': { vendor: 'Xiaomi', type: 'PHONE' },
  'ac:c1:ee': { vendor: 'Xiaomi', type: 'PHONE' },
  'b0:e2:35': { vendor: 'Xiaomi', type: 'PHONE' },
  'b8:37:65': { vendor: 'Xiaomi', type: 'PHONE' },
  'c4:0b:cb': { vendor: 'Xiaomi', type: 'PHONE' },
  'cc:32:e5': { vendor: 'Xiaomi', type: 'PHONE' },
  'd4:97:0b': { vendor: 'Xiaomi', type: 'PHONE' },
  'f8:a4:5f': { vendor: 'Xiaomi', type: 'PHONE' },
  'fc:64:ba': { vendor: 'Xiaomi', type: 'PHONE' },
  // OPPO / Realme / OnePlus
  '6a:8f:35': { vendor: 'OPPO', type: 'PHONE' },
  '08:00:27': { vendor: 'OPPO', type: 'PHONE' },
  '3c:36:e4': { vendor: 'OPPO', type: 'PHONE' },
  '80:32:53': { vendor: 'OPPO', type: 'PHONE' },
  'a0:4f:78': { vendor: 'OPPO', type: 'PHONE' },
  'c0:f8:54': { vendor: 'OPPO', type: 'PHONE' },
  // Google — Pixel, Chromecast, Nest
  'f4:f5:e8': { vendor: 'Google', type: 'PHONE' },
  '3c:28:6d': { vendor: 'Google', type: 'TV' },     // Chromecast
  '6c:ad:f8': { vendor: 'Google', type: 'TV' },     // Chromecast
  '18:b7:9e': { vendor: 'Google', type: 'IOT' },    // Nest
  // LG — TVs
  'a8:13:74': { vendor: 'LG', type: 'TV' },
  'cc:2d:8c': { vendor: 'LG', type: 'TV' },
  '78:5d:c8': { vendor: 'LG', type: 'TV' },
  // Sony — TVs, PlayStations
  '1c:9e:6e': { vendor: 'Sony', type: 'TV' },
  'a0:b3:cc': { vendor: 'Sony', type: 'TV' },
  // Epson — printers
  '00:1b:a9': { vendor: 'Epson', type: 'PRINTER' },
  'ac:18:26': { vendor: 'Epson', type: 'PRINTER' },
  // HP — printers
  'a0:48:1c': { vendor: 'HP', type: 'PRINTER' },
  'e4:75:a8': { vendor: 'HP', type: 'PRINTER' },
  '94:57:a5': { vendor: 'HP', type: 'PRINTER' },
  '54:bf:64': { vendor: 'HP', type: 'PRINTER' },
  // Canon — printers, cameras
  '00:1e:8f': { vendor: 'Canon', type: 'PRINTER' },
  '68:a0:3e': { vendor: 'Canon', type: 'PRINTER' },
  '00:00:48': { vendor: 'Canon', type: 'PRINTER' },
  '00:80:92': { vendor: 'Canon', type: 'PRINTER' },
  '00:a0:b8': { vendor: 'Canon', type: 'PRINTER' },
  '18:0e:1a': { vendor: 'Canon', type: 'PRINTER' },
  '28:0e:1a': { vendor: 'Canon', type: 'PRINTER' },
  '3c:3a:73': { vendor: 'Canon', type: 'PRINTER' },
  '54:04:9f': { vendor: 'Canon', type: 'PRINTER' },
  '5c:61:99': { vendor: 'Canon', type: 'PRINTER' },
  '9c:28:40': { vendor: 'Canon', type: 'PRINTER' },
  'ac:3c:0b': { vendor: 'Canon', type: 'PRINTER' },
  // Brother — printers
  '00:80:77': { vendor: 'Brother', type: 'PRINTER' },
  'c4:30:18': { vendor: 'Brother', type: 'PRINTER' },
  // Roku
  '2c:aa:8e': { vendor: 'Roku', type: 'TV' },
  'dc:3a:5e': { vendor: 'Roku', type: 'TV' },
  // TP-Link — routers, smart plugs
  '50:c7:bf': { vendor: 'TP-Link', type: 'ROUTER' },
  '5c:f9:dd': { vendor: 'TP-Link', type: 'ROUTER' },
  'ac:84:c6': { vendor: 'TP-Link', type: 'ROUTER' },
  // Netgear — routers
  '9c:3d:cf': { vendor: 'Netgear', type: 'ROUTER' },
  '44:94:fc': { vendor: 'Netgear', type: 'ROUTER' },
  // D-Link — routers
  '14:d6:4d': { vendor: 'D-Link', type: 'ROUTER' },
  'fc:75:16': { vendor: 'D-Link', type: 'ROUTER' },
  // Cisco / Linksys — routers
  '00:1a:6b': { vendor: 'Linksys', type: 'ROUTER' },
  'c0:3f:0e': { vendor: 'Linksys', type: 'ROUTER' },
  // Mikrotik — routers
  '00:0c:42': { vendor: 'Mikrotik', type: 'ROUTER' },
  'd4:ca:6d': { vendor: 'Mikrotik', type: 'ROUTER' },
  // Raspberry Pi — kiosks, IoT
  'b8:27:eb': { vendor: 'Raspberry Pi', type: 'KIOSK' },
  'dc:a6:32': { vendor: 'Raspberry Pi', type: 'KIOSK' },
  'e4:5f:01': { vendor: 'Raspberry Pi', type: 'KIOSK' },
  // Dell — desktops / kiosks
  '00:14:22': { vendor: 'Dell', type: 'KIOSK' },
  'f8:db:88': { vendor: 'Dell', type: 'KIOSK' },
  // Lenovo — laptops / kiosks
  '00:21:cc': { vendor: 'Lenovo', type: 'KIOSK' },
  '60:67:20': { vendor: 'Lenovo', type: 'KIOSK' },
  // Espressif / Tuya — ESP8266/ESP32 IoT
  '24:0a:c4': { vendor: 'Espressif', type: 'IOT' },
  '24:62:ab': { vendor: 'Espressif', type: 'IOT' },
  '5c:cf:7f': { vendor: 'Espressif', type: 'IOT' },
  // Tuya IoT
  'd8:f1:5b': { vendor: 'Tuya', type: 'IOT' },
  '10:d5:61': { vendor: 'Tuya', type: 'IOT' },
  // Shelly IoT
  'e8:db:84': { vendor: 'Shelly', type: 'IOT' },
  'c4:5b:be': { vendor: 'Shelly', type: 'IOT' },
  // ── TV vendors (expanded) ──────────────────────────────────────────────
  // Hisense — TVs
  '00:e0:a0': { vendor: 'Hisense', type: 'TV' },
  '08:bd:43': { vendor: 'Hisense', type: 'TV' },
  '20:0d:b0': { vendor: 'Hisense', type: 'TV' },
  'b0:cd:7e': { vendor: 'Hisense', type: 'TV' },
  // TCL — TVs (also Roku-built TCL TVs)
  '50:ac:9f': { vendor: 'TCL', type: 'TV' },
  '6c:49:7f': { vendor: 'TCL', type: 'TV' },
  '94:69:8a': { vendor: 'TCL', type: 'TV' },
  'b8:27:0b': { vendor: 'TCL', type: 'TV' },
  // Sharp — TVs
  '80:ea:96': { vendor: 'Sharp', type: 'TV' },
  'f0:27:2d': { vendor: 'Sharp', type: 'TV' },
  // Vizio — TVs
  '00:22:38': { vendor: 'Vizio', type: 'TV' },
  'd8:e4:80': { vendor: 'Vizio', type: 'TV' },
  '00:0d:4f': { vendor: 'Vizio', type: 'TV' },
  // Panasonic — TVs, Blu-ray players
  '00:0b:9b': { vendor: 'Panasonic', type: 'TV' },
  '40:b0:cd': { vendor: 'Panasonic', type: 'TV' },
  'a0:37:7c': { vendor: 'Panasonic', type: 'TV' },
  // Philips — TVs
  '00:1d:ba': { vendor: 'Philips', type: 'TV' },
  '18:8e:e5': { vendor: 'Philips', type: 'TV' },
  'a4:cf:99': { vendor: 'Philips', type: 'TV' },
  // Toshiba — TVs
  '00:14:a8': { vendor: 'Toshiba', type: 'TV' },
  'b0:c5:54': { vendor: 'Toshiba', type: 'TV' },
  // Xiaomi / Redmi TVs and Mi Box
  // (Most Xiaomi OUIs are already mapped to PHONE above — Xiaomi phones are
  // far more common than Xiaomi TVs on a home network. These are the few
  // Xiaomi OUIs that are TV-specific and not already in the phone section.)
  '04:cf:8c': { vendor: 'Xiaomi', type: 'TV' },
  // MediaTek — chipsets inside many Android TVs, Chromecast, smart TVs
  '00:09:f3': { vendor: 'MediaTek', type: 'TV' },
  'd8:5f:d0': { vendor: 'MediaTek', type: 'TV' },
  // Broadcom — chipsets inside Apple TV, many smart TVs, Chromecast
  '00:1d:a1': { vendor: 'Broadcom', type: 'TV' },
  '40:b8:9a': { vendor: 'Broadcom', type: 'TV' },
  'b0:70:2d': { vendor: 'Broadcom', type: 'TV' },
  // Amlogic — chipsets inside Android TV boxes
  '00:1e:06': { vendor: 'Amlogic', type: 'TV' },
  '22:03:21': { vendor: 'Amlogic', type: 'TV' },
  // ── Additional phone vendors (expanded) ───────────────────────────────
  // Vivo — phones
  '04:95:e6': { vendor: 'Vivo', type: 'PHONE' },
  '08:d2:3c': { vendor: 'Vivo', type: 'PHONE' },
  '18:91:e8': { vendor: 'Vivo', type: 'PHONE' },
  '8c:41:99': { vendor: 'Vivo', type: 'PHONE' },
  // OnePlus — phones (BBK Electronics, shared with Oppo/Vivo)
  'c0:ee:fb': { vendor: 'OnePlus', type: 'PHONE' },
  'a0:8d:cd': { vendor: 'OnePlus', type: 'PHONE' },
  // Realme — phones
  '24:73:f5': { vendor: 'Realme', type: 'PHONE' },
  '5c:2e:59': { vendor: 'Realme', type: 'PHONE' },
  '88:c1:58': { vendor: 'Realme', type: 'PHONE' },
  // Honor — phones (formerly Huawei sub-brand)
  '14:5f:94': { vendor: 'Honor', type: 'PHONE' },
  'a8:81:95': { vendor: 'Honor', type: 'PHONE' },
  // Motorola — phones
  '00:23:76': { vendor: 'Motorola', type: 'PHONE' },
  'a0:f4:50': { vendor: 'Motorola', type: 'PHONE' },
  'ec:9b:f4': { vendor: 'Motorola', type: 'PHONE' },
  // Nokia / HMD Global — phones
  '00:1f:de': { vendor: 'Nokia', type: 'PHONE' },
  '48:5a:b6': { vendor: 'Nokia', type: 'PHONE' },
  'a4:f1:32': { vendor: 'Nokia', type: 'PHONE' },
  // ZTE — phones, routers
  '00:19:c6': { vendor: 'ZTE', type: 'PHONE' },
  'c8:64:c7': { vendor: 'ZTE', type: 'PHONE' },
  'd8:97:ba': { vendor: 'ZTE', type: 'PHONE' },
  // Lenovo — tablets (Lenovo laptop OUI 00:21:cc already mapped to KIOSK)
  '5c:c6:30': { vendor: 'Lenovo', type: 'PHONE' },
  // Asus — phones, routers
  '00:0c:6e': { vendor: 'Asus', type: 'PHONE' },
  '08:60:6e': { vendor: 'Asus', type: 'PHONE' },
  'ac:9e:17': { vendor: 'Asus', type: 'PHONE' },
  // BlackBerry / TCL-made phones
  '00:1c:bb': { vendor: 'BlackBerry', type: 'PHONE' },
  // Wistron / Hon Hai (Foxconn) — iPhone/iPad assembler MACs
  '00:25:90': { vendor: 'Apple', type: 'PHONE' },
  '00:26:08': { vendor: 'Apple', type: 'PHONE' },
  // Intel — used in many laptops/Chromebooks (WiFi cards)
  '00:13:e8': { vendor: 'Intel', type: 'KIOSK' },
  'ac:72:89': { vendor: 'Intel', type: 'KIOSK' },
  'dc:71:96': { vendor: 'Intel', type: 'KIOSK' },
}

/** Look up a MAC address's OUI vendor. Returns the vendor + optional type hint. */
export function lookupMacVendor(mac?: string): { vendor?: string; type?: DeviceType } {
  if (!mac) return {}
  const normalized = mac.toLowerCase().replace(/[^0-9a-f]/g, '')
  if (normalized.length < 6) return {}
  const oui = `${normalized.slice(0,2)}:${normalized.slice(2,4)}:${normalized.slice(4,6)}`
  return MAC_OUI_VENDORS[oui] || {}
}

/**
 * Detect a randomized / locally-administered MAC address.
 *
 * Since Android 10 and iOS 14, phones randomize their WiFi MAC per network
 * by default — the second character of the first octet has the "locally
 * administered" bit (0x02) set. Examples:
 *   x2:xx:xx:xx:xx:xx   (e.g.  22:a9:... — iPhone)
 *   x6:xx:xx:xx:xx:xx   (e.g.  6a:fb:... — Android)
 *   xA:xx:xx:xx:xx:xx   (e.g.  a4:... — wait, this overlaps real vendors!)
 *   xE:xx:xx:xx:xx:xx   (e.g.  e0:... — wait, this overlaps real vendors!)
 *
 * We ONLY treat it as randomized if the full OUI is NOT in our known-vendor
 * table — that way we never misclassify a real Apple 'a4:5e:60' as random.
 *
 * On a typical home WiFi network, randomized MACs almost always belong to
 * phones (Android/iOS) or tablets — so the fingerprint uses this signal to
 * classify the device as a PHONE when nothing else identified it.
 */
export function isRandomizedMac(mac?: string): boolean {
  if (!mac) return false
  const normalized = mac.toLowerCase().replace(/[^0-9a-f]/g, '')
  if (normalized.length < 6) return false
  // Locally-administered bit = 0x02 in the first octet's low nibble.
  // The first character of the normalized MAC must be 0,2,4,6,8,a,c,e
  // AND the second character must be 2,6,a,e for the bit to be set.
  const firstByte = parseInt(normalized.slice(0, 2), 16)
  if ((firstByte & 0x02) !== 0x02) return false
  // Critical: confirm the OUI is NOT a known vendor. Real vendors' OUIs
  // occasionally have the locally-administered bit set by accident in our
  // table — trust the table over the bit.
  if (Object.keys(lookupMacVendor(mac)).length > 0) return false
  return true
}

// ─── USB Vendor ID lookup (for USB devices without metadata) ───────────────

const USB_VENDOR_IDS: Record<string, string> = {
  '03f0': 'HP',
  '04b8': 'Epson',
  '04a9': 'Canon',
  '04f9': 'Brother',
  '0519': 'Star Micronics',
  '0dd4': 'Custom',
  '154f': 'SNBC',
  '0c45': 'ZKTeco',
  '1a86': 'WCH (CH340 serial)',
  '04e8': 'Samsung',
  '05ac': 'Apple',
  '19d2': 'ZTE',
  '05c6': 'Qualcomm',
  '22b8': 'Motorola',
}

/** Classify USB device class for printer detection. */
const USB_PRINTER_DEVICE_CLASSES = new Set([0x07])
const USB_VENDOR_SUBCLASS_PRINTER = new Set([0x01, 0x02, 0x03, 0x04])

// ─── 1. ARP table ───────────────────────────────────────────────────────────

export interface ArpEntry { ip: string; mac: string; iface: string }

/**
 * Read the kernel ARP table.
 * Linux: `/proc/net/arp` (zero privileges, world-readable).
 * macOS / Windows: shell out to `arp -a`.
 */
export async function readArpTable(): Promise<ArpEntry[]> {
  if (process.platform === 'linux') {
    return readArpProcFs().catch(() => readArpCommand())
  }
  return readArpCommand()
}

async function readArpProcFs(): Promise<ArpEntry[]> {
  let content: string
  try {
    content = fs.readFileSync('/proc/net/arp', 'utf8')
  } catch {
    return []
  }
  const lines = content.split('\n').slice(1) // skip header
  const entries: ArpEntry[] = []
  for (const line of lines) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 6) continue
    const [ip, hw, flags, mac, mask, iface] = parts
    if (!ip || mac === '00:00:00:00:00:00' || mac === '<incomplete>') continue
    entries.push({ ip, mac, iface })
  }
  return entries
}

async function readArpCommand(): Promise<ArpEntry[]> {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'arp' : 'arp'
    const args = process.platform === 'win32' ? ['-a'] : ['-a']
    const child = spawn(cmd, args, { timeout: 3000 })
    let out = ''
    child.stdout.on('data', (d) => { out += d.toString() })
    child.on('error', () => resolve([]))
    child.on('close', () => resolve(parseArpOutput(out)))
  })
}

function parseArpOutput(out: string): ArpEntry[] {
  const entries: ArpEntry[] = []
  // Linux `arp -a` format: `? (192.168.1.5) at aa:bb:cc:dd:ee:ff [ether] on eth0`
  // macOS `arp -a` format: `hostname (192.168.1.5) at aa:bb:cc:dd:ee:ff on en0 ifscope [ethernet]`
  for (const line of out.split('\n')) {
    const m = line.match(/\((\d{1,3}(?:\.\d{1,3}){3})\)\s+at\s+([0-9a-fA-F:]{11,17})/)
    if (m) {
      const ifaceMatch = line.match(/\bon\s+(\S+)/)
      entries.push({ ip: m[1], mac: m[2].toLowerCase(), iface: ifaceMatch?.[1] || '' })
    }
  }
  return entries
}

// ─── 2. Ping sweep ──────────────────────────────────────────────────────────

/**
 * Probe every IP in `subnet.1..254` with a single ICMP echo.
 * Uses the system `ping` binary (no raw sockets, no privileges needed on most setups).
 * Returns the list of IPs that responded.
 */
export async function pingSweep(
  subnet: string,
  opts: {
    concurrency?: number
    timeoutMs?: number
    isAborted?: () => boolean
    onProgress?: () => void
  } = {},
): Promise<string[]> {
  const concurrency = opts.concurrency ?? PING_CONCURRENCY
  const timeoutMs = opts.timeoutMs ?? PING_TIMEOUT_MS
  const isAborted = opts.isAborted ?? (() => false)
  const onProgress = opts.onProgress ?? (() => {})

  const ips: string[] = []
  for (let i = 1; i <= 254; i++) ips.push(`${subnet}.${i}`)

  const alive: string[] = []
  const queue = [...ips]

  async function worker() {
    while (queue.length > 0) {
      if (isAborted()) return
      const ip = queue.shift()
      if (!ip) break
      const ok = await pingHost(ip, timeoutMs)
      if (ok) alive.push(ip)
      onProgress()
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker())
  await Promise.all(workers)
  return alive
}

/** Ping a single host. Returns true if it responds within timeoutMs. */
export function pingHost(ip: string, timeoutMs: number = PING_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    // Cross-platform ping flags
    let args: string[]
    if (process.platform === 'win32') {
      args = ['-n', '1', '-w', String(timeoutMs), ip]
    } else if (process.platform === 'darwin') {
      // macOS: -W is milliseconds
      args = ['-c', '1', '-W', String(timeoutMs), ip]
    } else {
      // Linux: -W is seconds (round up)
      args = ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), ip]
    }
    const child = spawn('ping', args, { timeout: timeoutMs + 500 })
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* ignore */ }
      resolve(ok)
    }
    child.on('error', () => done(false))
    child.on('close', (code) => done(code === 0))
    // Hard timeout in case ping itself hangs
    setTimeout(() => done(false), timeoutMs + 800)
  })
}

// ─── 3. mDNS / DNS-SD ───────────────────────────────────────────────────────

export interface MdnsRecord {
  ip: string
  port: number
  name: string
  serviceType: string
  txt?: Record<string, string>
}

/**
 * Send DNS-SD PTR queries via multicast to 224.0.0.251:5353 and collect
 * responses for `timeoutMs` milliseconds. Captures printers, Android, AirPlay,
 * Chromecast, and any other mDNS/Bonjour announcer.
 */
export async function mdnsQuery(
  serviceTypes: string[] = MDNS_SERVICE_TYPES,
  opts: { timeoutMs?: number; isAborted?: () => boolean } = {},
): Promise<MdnsRecord[]> {
  const timeoutMs = opts.timeoutMs ?? MDNS_TIMEOUT_MS
  const isAborted = opts.isAborted ?? (() => false)
  const records: MdnsRecord[] = []
  const seen = new Set<string>()

  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    let closed = false
    const cleanup = () => {
      if (closed) return
      closed = true
      try { sock.close() } catch { /* ignore */ }
      resolve(records)
    }

    sock.on('error', () => cleanup())
    sock.on('message', (msg, rinfo) => {
      const parsed = parseMdnsResponse(msg)
      for (const rec of parsed) {
        rec.ip = rec.ip || rinfo.address
        const key = `${rec.ip}:${rec.port}:${rec.serviceType}`
        if (!seen.has(key)) {
          seen.add(key)
          records.push(rec)
        }
      }
    })

    sock.bind(0, '0.0.0.0', () => {
      // Build a DNS-SD PTR query for each requested service type
      for (const st of serviceTypes) {
        const query = buildMdnsQuery(st)
        try {
          sock.send(query, 0, query.length, MDNS_PORT, MDNS_ADDR)
        } catch { /* ignore */ }
      }
    })

    setTimeout(cleanup, timeoutMs)
    if (isAborted()) cleanup()
  })
}

/**
 * Minimal mDNS response parser. Extracts A, PTR, SRV, TXT records.
 * Returns at most one record per answer, with IP/port filled where available.
 */
function parseMdnsResponse(msg: Buffer): MdnsRecord[] {
  const records: MdnsRecord[] = []
  if (msg.length < 12) return records
  const qdCount = msg.readUInt16BE(4)
  const anCount = msg.readUInt16BE(6)
  let offset = 12

  // Skip questions
  for (let i = 0; i < qdCount; i++) {
    const res = skipName(msg, offset)
    offset = res + 4 // skip QTYPE (2) + QCLASS (2)
  }

  // Parse answers
  for (let i = 0; i < anCount && offset < msg.length; i++) {
    const nameEnd = skipName(msg, offset)
    if (nameEnd + 10 > msg.length) break
    const rtype = msg.readUInt16BE(nameEnd)
    const rdlength = msg.readUInt16BE(nameEnd + 8)
    const rdataStart = nameEnd + 10
    if (rdataStart + rdlength > msg.length) break

    const name = readName(msg, offset)
    const rdata = msg.subarray(rdataStart, rdataStart + rdlength)

    if (rtype === 1) {
      // A record: 4 bytes IPv4
      const ip = `${rdata[0]}.${rdata[1]}.${rdata[2]}.${rdata[3]}`
      records.push({ ip, port: 0, name, serviceType: 'A' })
    } else if (rtype === 12) {
      // PTR record: rdata is a DNS name
      const target = readName(msg, rdataStart)
      records.push({ ip: '', port: 0, name: target, serviceType: target })
    } else if (rtype === 33) {
      // SRV record: priority(2) + weight(2) + port(2) + target name
      if (rdata.length >= 6) {
        const port = rdata.readUInt16BE(4)
        const target = readName(msg, rdataStart + 6)
        records.push({ ip: '', port, name: target, serviceType: name })
      }
    } else if (rtype === 16) {
      // TXT record: skip (we don't parse txt key=value pairs for now)
      records.push({ ip: '', port: 0, name, serviceType: 'TXT' })
    }

    offset = rdataStart + rdlength
  }

  return records
}

/** Build a minimal mDNS PTR query packet for the given service type. */
function buildMdnsQuery(serviceType: string): Buffer {
  // Header: ID=0, flags=0, QDCOUNT=1, ANCOUNT=0, NSCOUNT=0, ARCOUNT=0
  const header = Buffer.alloc(12)
  // QNAME: encode serviceType as DNS labels
  const labels = serviceType.split('.').filter(Boolean)
  const qnameParts: Buffer[] = []
  for (const label of labels) {
    const len = Buffer.from([label.length])
    const str = Buffer.from(label, 'utf8')
    qnameParts.push(Buffer.concat([len, str]))
  }
  qnameParts.push(Buffer.from([0])) // root label
  const qname = Buffer.concat(qnameParts)
  // QTYPE=12 (PTR), QCLASS=1 (IN) + cache-flush bit (0x8000) for mDNS
  const qtail = Buffer.alloc(4)
  qtail.writeUInt16BE(12, 0)
  qtail.writeUInt16BE(0x8001, 2)
  return Buffer.concat([header, qname, qtail])
}

/** Skip a DNS name (handling compression pointers) and return the offset after it. */
function skipName(msg: Buffer, offset: number): number {
  let p = offset
  while (p < msg.length) {
    const len = msg[p]
    if (len === 0) { p++; break }
    if ((len & 0xc0) === 0xc0) { p += 2; break } // compression pointer
    p += 1 + len
  }
  return p
}

/** Read a DNS name into dotted string form, following compression pointers. */
function readName(msg: Buffer, offset: number): string {
  const labels: string[] = []
  let p = offset
  let jumps = 0
  while (p < msg.length && jumps < 16) {
    const len = msg[p]
    if (len === 0) break
    if ((len & 0xc0) === 0xc0) {
      const ptr = ((len & 0x3f) << 8) | msg[p + 1]
      p = ptr
      jumps++
      continue
    }
    p++
    if (p + len > msg.length) break
    labels.push(msg.subarray(p, p + len).toString('utf8'))
    p += len
  }
  return labels.join('.')
}

// ─── 4. SSDP / UPnP ─────────────────────────────────────────────────────────

export interface SsdpRecord {
  location: string
  server: string
  st: string
  usn: string
  ip: string
  port: number
}

/**
 * Send SSDP M-SEARCH multicast to 239.255.255.250:1900 and collect
 * LOCATION URLs for `timeoutMs`. Smart TVs, routers, and media renderers
 * typically respond.
 */
export async function ssdpDiscover(
  opts: { timeoutMs?: number; isAborted?: () => boolean } = {},
): Promise<SsdpRecord[]> {
  const timeoutMs = opts.timeoutMs ?? SSDP_TIMEOUT_MS
  const isAborted = opts.isAborted ?? (() => false)
  const records: SsdpRecord[] = []
  const seen = new Set<string>()

  // Multiple search targets broaden coverage. Smart TVs in eco-standby often
  // ignore a generic `ssdp:all` but respond to a specific device-type ST.
  // Adding MediaRenderer / MediaServer / Dial / Basic catches Samsung, LG,
  // Sony, Roku, Chromecast, and Android TV devices that would otherwise
  // stay invisible until you wake them with the remote.
  const searchTypes = [
    'ssdp:all',
    'upnp:rootdevice',
    'urn:schemas-upnp-org:device:MediaRenderer:1',   // Samsung / LG / Sony TVs
    'urn:schemas-upnp-org:device:MediaServer:1',     // DLNA NAS, TVs as source
    'urn:schemas-upnp-org:device:Basic:1',           // generic UPnP
    'urn:schemas-upnp-org:device:MediaRenderer:2',   // newer TVs
    'urn:dial-multiscreen-org:service:dial:1',       // Chromecast / DIAL
    'urn:schemas-upnp-org:device:InternetGatewayDevice:1',  // routers
    'urn:schemas-upnp-org:service:RenderingControl:1',
    'urn:schemas-upnp-org:service:AVTransport:1',
  ]
  const message = (st: string, mx: number) =>
    Buffer.from(
      [
        'M-SEARCH * HTTP/1.1',
        'HOST: 239.255.255.250:1900',
        `ST: ${st}`,
        'MAN: "ssdp:discover"',
        `MX: ${mx}`,
        '',
        '',
      ].join('\r\n'),
    )

  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    let closed = false
    const cleanup = () => {
      if (closed) return
      closed = true
      try { sock.close() } catch { /* ignore */ }
      resolve(records)
    }

    sock.on('error', () => cleanup())
    sock.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8')
      const rec = parseSsdpResponse(text, rinfo.address, rinfo.port)
      if (rec && !seen.has(rec.location)) {
        seen.add(rec.location)
        records.push(rec)
      }
    })

    sock.bind(0, '0.0.0.0', () => {
      try { sock.setBroadcast(true) } catch { /* ignore */ }
      try { sock.setMulticastTTL(2) } catch { /* ignore */ }
      const sendAll = (mx: number) => {
        for (const st of searchTypes) {
          const pkt = message(st, mx)
          try {
            sock.send(pkt, 0, pkt.length, SSDP_PORT, SSDP_ADDR)
          } catch { /* ignore */ }
        }
      }
      // Send the first wave immediately with MX=3 (devices randomise 0..3s).
      sendAll(3)
      // Send a second wave at 2s with MX=2. Many smart TVs in eco-standby
      // wake their network stack on the first multicast and only respond to
      // a re-send. Staggering the queries doubles the chance of catching
      // standby TVs without lengthening the total timeout.
      setTimeout(() => sendAll(2), 2000)
    })

    setTimeout(cleanup, timeoutMs)
    if (isAborted()) cleanup()
  })
}

function parseSsdpResponse(text: string, ip: string, port: number): SsdpRecord | null {
  const lines = text.split('\r\n')
  const headers: Record<string, string> = {}
  for (const line of lines) {
    const idx = line.indexOf(':')
    if (idx > 0) {
      const key = line.slice(0, idx).trim().toUpperCase()
      const val = line.slice(idx + 1).trim()
      headers[key] = val
    }
  }
  const location = headers['LOCATION']
  if (!location) return null
  return {
    location,
    server: headers['SERVER'] || '',
    st: headers['ST'] || '',
    usn: headers['USN'] || '',
    ip,
    port,
  }
}

// ─── 4b. Reverse DNS lookup ─────────────────────────────────────────────────
//
// Many network devices register a PTR record in the local DNS resolver
// (router-provided DNS, or `.home`, `.lan`, `.local` zones). A reverse DNS
// lookup on the IP often returns a hostname like `raspberrypi.home`,
// `DESKTOP-ABC7.lan`, or `canon-printer.local` — giving us a real device
// name for hosts that did NOT respond to mDNS / SSDP / HTTP.
//
// This is especially valuable for:
//   - Ping-only devices (firewalled hosts that respond to ICMP but no app ports)
//   - Network printers that don't advertise via mDNS/SSDP but are registered
//     in the router's DNS
//   - IoT devices with minimal service exposure

export interface ReverseDnsRecord {
  ip: string
  hostname: string | null
}

/**
 * Resolve a single IP to a hostname via reverse DNS (PTR lookup).
 * Returns null if no PTR record exists or the lookup fails.
 * Time-limited to 800ms so a slow DNS server doesn't stall the scan.
 */
export async function reverseDnsLookup(ip: string, timeoutMs = 800): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const done = (val: string | null) => {
      if (settled) return
      settled = true
      resolve(val)
    }
    // Race the lookup against a hard timeout — dns.reverse can hang on
    // misconfigured resvers that drop PTR queries instead of NXDOMAINing.
    const timer = setTimeout(() => done(null), timeoutMs)
    dns.reverse(ip)
      .then((hostnames) => {
        clearTimeout(timer)
        if (Array.isArray(hostnames) && hostnames.length > 0) {
          // Pick the first non-empty hostname and clean it up
          const host = hostnames[0].trim()
          done(host || null)
        } else {
          done(null)
        }
      })
      .catch(() => {
        clearTimeout(timer)
        done(null)
      })
  })
}

/**
 * Batch reverse-DNS lookup for a list of IPs, with bounded concurrency.
 * Returns only the IPs that resolved to a hostname.
 */
export async function reverseDnsBatch(
  ips: string[],
  opts: { concurrency?: number; isAborted?: () => boolean } = {},
): Promise<ReverseDnsRecord[]> {
  const concurrency = Math.min(opts.concurrency ?? 32, 64)
  const isAborted = opts.isAborted ?? (() => false)
  const results: ReverseDnsRecord[] = []
  const queue = [...ips]

  async function worker() {
    while (queue.length > 0) {
      if (isAborted()) return
      const ip = queue.shift()
      if (!ip) break
      const hostname = await reverseDnsLookup(ip)
      if (hostname) results.push({ ip, hostname })
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker())
  await Promise.all(workers)
  return results
}

/**
 * Clean a reverse-DNS hostname into a human-friendly device name.
 *   "raspberrypi.home"      → "raspberrypi"
 *   "DESKTOP-ABC7.lan"      → "DESKTOP-ABC7"
 *   "canon-printer.local"   → "canon-printer"
 *   "192.168.1.5"           → null  (reverse resolved to itself — useless)
 */
export function cleanReverseDnsHostname(hostname: string | null): string | undefined {
  if (!hostname) return undefined
  let cleaned = hostname.trim().toLowerCase()
  if (!cleaned) return undefined
  // Strip common local-domain suffixes
  cleaned = cleaned.replace(/\.(?:local|home|lan|localdomain|internal|fritz\.box|box)\.?$/, '')
  // If the hostname is just the IP itself, it's useless (some resolvers do this)
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(cleaned)) return undefined
  // Strip a trailing dot
  cleaned = cleaned.replace(/\.$/, '')
  // Capitalize first letter of each word for readability (preserves hyphens)
  cleaned = cleaned.split('.').map((part) =>
    part.charAt(0).toUpperCase() + part.slice(1)
  ).join('.')
  return cleaned || undefined
}

// ─── 4c. NetBIOS Name Service (NBNS) query ─────────────────────────────────
//
// NetBIOS over TCP/IP (NBT) runs on UDP port 137. Windows hosts, Samba
// servers, many network printers, and some NAS boxes respond to a NetBIOS
// Name Service query with their machine name. This is a valuable name
// source for devices that:
//   - Don't advertise via mDNS / SSDP (older Windows machines, some printers)
//   - Are firewalled against ICMP/mDNS but still expose file sharing
//   - Live on networks where the router doesn't register PTR records
//
// The query is a single UDP packet; responses include the workstation
// name + workgroup. No privileges required (UDP, ephemeral source port).

export interface NbnsRecord {
  ip: string
  /** The workstation / machine name (e.g. "DESKTOP-ABC7", "CANON-PRINTER") */
  name: string
  /** Optional workgroup / domain (e.g. "WORKGROUP", "MSHOME") */
  workgroup?: string
}

/**
 * Build a NetBIOS Name Service query packet.
 * Asks for the wildcard name "*" (NetBIOS wildcard) which returns all
 * registered names for the target host.
 */
function buildNbnsQuery(): Buffer {
  // NetBIOS header (12 bytes):
  //   Transaction ID: 0x0001
  //   Flags: 0x0010 (standard query, recursion desired)
  //   Questions: 1, AnswerRRs: 0, AuthorityRRs: 0, AdditionalRRs: 0
  const header = Buffer.from([
    0x00, 0x01,  // transaction ID
    0x00, 0x10,  // flags: standard query, recursion desired
    0x00, 0x01,  // questions: 1
    0x00, 0x00,  // answer RRs
    0x00, 0x00,  // authority RRs
    0x00, 0x00,  // additional RRs
  ])
  // Encoded NetBIOS name: "*" padded to 16 chars, then encoded as level-1
  // half-ASCII. The wildcard name "*" returns all names registered by the host.
  // Padding char is space (0x20).
  const rawName = ('*' + ' '.repeat(15)).slice(0, 16)
  const encoded: number[] = []
  for (let i = 0; i < rawName.length; i++) {
    const c = rawName.charCodeAt(i)
    encoded.push(0x41 + ((c >> 4) & 0x0f))
    encoded.push(0x41 + (c & 0x0f))
  }
  // Length-prefixed label: 0x20 (32 bytes) + encoded name
  const nameLabel = Buffer.from([0x20, ...encoded])
  // Null terminator for the name
  const nullTerm = Buffer.from([0x00])
  // Question type: 0x0021 (NB_STAT — NetBIOS Node Status)
  // Question class: 0x0001 (IN)
  const qTail = Buffer.from([0x00, 0x21, 0x00, 0x01])
  return Buffer.concat([header, nameLabel, nullTerm, qTail])
}

/**
 * Parse a NetBIOS Node Status response.
 * Extracts the workstation name (type 0x00) and workgroup (type 0x00 with
 * group flag). Returns { name, workgroup } or null.
 */
function parseNbnsResponse(msg: Buffer): { name: string; workgroup?: string } | null {
  if (msg.length < 12) return null
  // Skip the 12-byte header
  let offset = 12
  // Skip the question section (name + 4 bytes type/class)
  offset = skipName(msg, offset) + 4
  // Now we're at the answer section. The answer record's NAME is usually a
  // compression pointer (2 bytes) back to the question name.
  if (offset + 12 > msg.length) return null
  // Skip answer name (compression pointer = 2 bytes)
  const nameLen = (msg[offset] & 0xc0) === 0xc0 ? 2 : skipName(msg, offset) - offset
  offset += nameLen
  // Skip TYPE (2) + CLASS (2) + TTL (4) = 8 bytes, then RDLENGTH (2)
  if (offset + 10 > msg.length) return null
  const rdlength = msg.readUInt16BE(offset + 8)
  offset += 10
  if (offset + rdlength > msg.length) return null
  // The RDATA starts with a 1-byte "number of names" field, followed by
  // 18-byte name entries: 15-byte name + 1-byte type + 2-byte flags.
  const numNames = msg[offset]
  offset += 1
  let workstationName: string | undefined
  let workgroup: string | undefined
  for (let i = 0; i < numNames && offset + 18 <= msg.length; i++) {
    const nameRaw = msg.subarray(offset, offset + 15).toString('ascii').trim()
    const type = msg[offset + 15]
    const flags = msg.readUInt16BE(offset + 16)
    const isGroup = (flags & 0x8000) !== 0
    // Type 0x00 = Workstation / Redirector (unique) or Workgroup (group)
    if (type === 0x00) {
      if (isGroup) {
        if (!workgroup) workgroup = nameRaw
      } else {
        if (!workstationName) workstationName = nameRaw
      }
    }
    // Type 0x20 = File Server Service — also a good machine-name source
    if (type === 0x20 && !workstationName) {
      workstationName = nameRaw
    }
    offset += 18
  }
  if (!workstationName) return null
  return { name: workstationName, workgroup }
}

/**
 * Query a single host's NetBIOS name (UDP port 137).
 * Returns null if the host doesn't respond or isn't a NetBIOS host.
 */
export async function nbnsQueryHost(
  ip: string,
  opts: { timeoutMs?: number; isAborted?: () => boolean } = {},
): Promise<NbnsRecord | null> {
  const timeoutMs = opts.timeoutMs ?? 800
  const isAborted = opts.isAborted ?? (() => false)
  if (isAborted()) return null

  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    let closed = false
    const cleanup = (result: NbnsRecord | null) => {
      if (closed) return
      closed = true
      try { sock.close() } catch { /* ignore */ }
      resolve(result)
    }
    sock.on('error', () => cleanup(null))
    sock.on('message', (msg) => {
      const parsed = parseNbnsResponse(msg)
      if (parsed) {
        cleanup({ ip, name: parsed.name, workgroup: parsed.workgroup })
      } else {
        cleanup(null)
      }
    })
    sock.bind(0, '0.0.0.0', () => {
      const query = buildNbnsQuery()
      try {
        sock.send(query, 0, query.length, 137, ip)
      } catch {
        cleanup(null)
      }
    })
    setTimeout(() => cleanup(null), timeoutMs)
  })
}

/**
 * Batch NetBIOS name query for a list of IPs, with bounded concurrency.
 * Returns only the IPs that responded with a name.
 */
export async function nbnsBatch(
  ips: string[],
  opts: { concurrency?: number; isAborted?: () => boolean } = {},
): Promise<NbnsRecord[]> {
  const concurrency = Math.min(opts.concurrency ?? 32, 64)
  const isAborted = opts.isAborted ?? (() => false)
  const results: NbnsRecord[] = []
  const queue = [...ips]

  async function worker() {
    while (queue.length > 0) {
      if (isAborted()) return
      const ip = queue.shift()
      if (!ip) break
      const rec = await nbnsQueryHost(ip, { isAborted })
      if (rec) results.push(rec)
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker())
  await Promise.all(workers)
  return results
}

// ─── 4d. DHCP lease file parsing ────────────────────────────────────────────
//
// THE most reliable name source for Android phones. When a phone joins a WiFi
// network, it sends its product name (e.g. "Poco X6 Pro", "SM-S901B", "iPhone")
// as DHCP option 12 (hostname) to the router. The router writes this into its
// lease file along with the assigned IP and the phone's MAC.
//
// Android phones do NOT advertise any standard mDNS service (the "_android._tcp"
// myth is just that — a myth). They don't run NetBIOS. They don't respond to
// reverse-DNS unless the router's DNS is configured to serve lease names. So
// the DHCP lease file is often the ONLY place a phone's real name is recorded.
//
// Common lease-file locations:
//   /tmp/dnsmasq.leases              — OpenWrt, dd-wrt, most consumer routers
//   /var/lib/misc/dnsmasq.leases     — Debian/Ubuntu dnsmasq
//   /var/db/dnsmasq.leases           — macOS / FreeBSD dnsmasq
//   /var/lib/dhcp/dhcpd.leases       — ISC dhcpd
//   /var/state/dhcp/dhcpd.leases     — older ISC dhcpd
//   /var/lib/NetworkManager/dnsmasq.leases — NetworkManager-managed dnsmasq
//
// dnsmasq format:  <expiry> <mac> <ip> <hostname> <client-id>
// dhcpd format:    lease <ip> { hardware ethernet <mac>; client-hostname "<hostname>"; ... }
//
// On the BLASTI server's host (Linux), we can read these files directly. On
// networks where the BLASTI server IS the router (OpenWrt), this is perfect.
// On networks where the BLASTI server is just another host, this will find
// nothing — but then the reverse-DNS / NetBIOS fallbacks still apply.

export interface DhcpLeaseRecord {
  ip: string
  mac?: string
  hostname: string
  /** Source file the lease was read from (for debugging) */
  source: string
}

/** Common DHCP lease-file locations across Linux/macOS/router distros. */
const DHCP_LEASE_FILES = [
  '/tmp/dnsmasq.leases',
  '/var/lib/misc/dnsmasq.leases',
  '/var/db/dnsmasq.leases',
  '/var/lib/NetworkManager/dnsmasq.leases',
  '/var/lib/dhcp/dhcpd.leases',
  '/var/state/dhcp/dhcpd.leases',
  '/tmp/dhcp.leases',           // OpenWrt alternative
  '/var/dhcpd/dhcpd.leases',    // pfSense / OPNsense
  '/data/dhcp.leases',          // some embedded routers
]

/**
 * Parse a dnsmasq lease file line.
 * Format:  <expiry> <mac> <ip> <hostname> <client-id>
 * The hostname may be "*" if the client didn't send one.
 * Returns null for unparseable lines or "*" hostnames.
 */
function parseDnsmasqLeaseLine(line: string): DhcpLeaseRecord | null {
  const parts = line.trim().split(/\s+/)
  if (parts.length < 4) return null
  const [, mac, ip, hostname] = parts
  if (!ip || !hostname || hostname === '*') return null
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return null
  return { ip, mac: mac !== '*' ? mac : undefined, hostname, source: 'dnsmasq' }
}

/**
 * Parse an ISC dhcpd lease file.
 * Extracts `lease <ip> { ... hardware ethernet <mac>; ... client-hostname "<name>"; ... }`
 * blocks. Returns one record per lease that has both an IP and a hostname.
 */
function parseDhcpdLeases(content: string): DhcpLeaseRecord[] {
  const records: DhcpLeaseRecord[] = []
  const leaseRe = /lease\s+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s*\{([^}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = leaseRe.exec(content)) !== null) {
    const ip = m[1]
    const body = m[2]
    const macMatch = body.match(/hardware\s+ethernet\s+([0-9a-fA-F:]{17})/)
    const nameMatch = body.match(/client-hostname\s+"([^"]+)"/)
    if (nameMatch && nameMatch[1] && nameMatch[1] !== '*') {
      records.push({
        ip,
        mac: macMatch ? macMatch[1].toLowerCase() : undefined,
        hostname: nameMatch[1],
        source: 'dhcpd',
      })
    }
  }
  return records
}

/**
 * Read all available DHCP lease files and return parsed records.
 * Silently skips files that don't exist or aren't readable.
 * Deduplicates by IP (first file wins).
 */
export async function readDhcpLeases(
  opts: { isAborted?: () => boolean } = {},
): Promise<DhcpLeaseRecord[]> {
  const isAborted = opts.isAborted ?? (() => false)
  const records: DhcpLeaseRecord[] = []
  const seenIps = new Set<string>()

  for (const file of DHCP_LEASE_FILES) {
    if (isAborted()) break
    let content: string
    try {
      content = fs.readFileSync(file, 'utf8')
    } catch {
      continue // file doesn't exist or isn't readable — skip silently
    }
    if (file.includes('dhcpd')) {
      const parsed = parseDhcpdLeases(content)
      for (const rec of parsed) {
        if (!seenIps.has(rec.ip)) {
          seenIps.add(rec.ip)
          rec.source = `${rec.source}:${file}`
          records.push(rec)
        }
      }
    } else {
      // dnsmasq-style: one lease per line
      for (const line of content.split('\n')) {
        if (isAborted()) break
        const rec = parseDnsmasqLeaseLine(line)
        if (rec && !seenIps.has(rec.ip)) {
          seenIps.add(rec.ip)
          rec.source = `${rec.source}:${file}`
          records.push(rec)
        }
      }
    }
    // Stop early once we've found a file — most hosts only run one DHCP server.
    if (records.length > 0) break
  }

  return records
}

/**
 * Clean a DHCP hostname into a human-friendly device name.
 *   "Poco X6 Pro"      → "Poco X6 Pro"        (already clean)
 *   "SM-S901B"         → "Samsung SM-S901B"   (Samsung model code → vendor prefix)
 *   "iPhone"           → "iPhone"
 *   "android-abc123"   → "Android Device"    (generic Android hostname)
 *   "DESKTOP-ABC7"     → "DESKTOP-ABC7"      (Windows machine name, keep as-is)
 */
export function cleanDhcpHostname(hostname: string | null): string | undefined {
  if (!hostname) return undefined
  let cleaned = hostname.trim()
  if (!cleaned || cleaned === '*') return undefined
  // dnsmasq sometimes wraps hostnames in quotes
  cleaned = cleaned.replace(/^"+|"+$/g, '')
  // Generic "android-xxxxx" hostname → just say "Android Device"
  if (/^android-[a-f0-9]{4,}$/i.test(cleaned)) return 'Android Device'
  // Samsung model codes: SM-Gxxxx, SM-Sxxxx, SM-Exxxx, SM-Jxxxx, SM-Nxxxx, SM-Txxxx
  if (/^SM-[A-Z]\d{2,4}[A-Z]?$/i.test(cleaned)) return `Samsung ${cleaned}`
  // iPhone/iPad hostnames: "iPhone", "iPhone de X", "iPad"
  // Preserve the standard Apple capitalization (lowercase 'i', capital 'P')
  if (/^iphone$/i.test(cleaned)) return 'iPhone'
  if (/^ipad$/i.test(cleaned)) return 'iPad'
  return cleaned
}

// ─── 5. HTTP probe ──────────────────────────────────────────────────────────

export interface HttpProbeResult {
  title: string
  server: string
  status: number
  body?: string
}

/** Probe `http://ip:port/` and extract <title> + Server header. */
export async function httpProbe(
  ip: string,
  port: number,
  opts: { timeoutMs?: number; isAborted?: () => boolean } = {},
): Promise<HttpProbeResult | null> {
  const timeoutMs = opts.timeoutMs ?? HTTP_TIMEOUT_MS
  const isAborted = opts.isAborted ?? (() => false)
  if (isAborted()) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`http://${ip}:${port}/`, {
      signal: controller.signal,
      redirect: 'manual',
    })
    clearTimeout(timer)
    let title = ''
    let body = ''
    try {
      body = await res.text()
      const m = body.match(/<title[^>]*>(.*?)<\/title>/i)
      if (m) title = m[1].trim().slice(0, 200)
    } catch { /* ignore */ }
    return {
      title,
      server: res.headers.get('server') || '',
      status: res.status,
      body: body.slice(0, 4096),
    }
  } catch {
    clearTimeout(timer)
    return null
  }
}

// ─── UPnP device description fetch ──────────────────────────────────────────

export interface UpnpDevice {
  friendlyName?: string
  manufacturer?: string
  modelName?: string
  deviceType?: string
  modelDescription?: string
}

/** Fetch and parse the UPnP device description XML at `locationUrl`. */
export async function fetchUpnpDescription(locationUrl: string): Promise<UpnpDevice | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2000)
  try {
    const res = await fetch(locationUrl, { signal: controller.signal })
    clearTimeout(timer)
    const xml = await res.text()
    return {
      friendlyName: extractXmlTag(xml, 'friendlyName'),
      manufacturer: extractXmlTag(xml, 'manufacturer'),
      modelName: extractXmlTag(xml, 'modelName'),
      deviceType: extractXmlTag(xml, 'deviceType'),
      modelDescription: extractXmlTag(xml, 'modelDescription'),
    }
  } catch {
    clearTimeout(timer)
    return null
  }
}

function extractXmlTag(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 'is'))
  return m ? m[1].trim().slice(0, 200) : undefined
}

// ─── 5b. Local USB / CUPS printers ──────────────────────────────────────────

export interface LocalPrinterRecord {
  id: string
  name: string
  source: 'usb' | 'local'
  /** CUPS queue name (when available) */
  cupsName?: string
  /** CUPS printer URI (e.g. "ipp://localhost/printers/X", "usb://EPSON/L3250?serial=...") */
  cupsUri?: string
  /** CUPS state: idle, printing, stopped */
  cupsState?: string
  /** USB vendor ID (hex) — when known */
  usbVendorId?: string
  /** USB product ID (hex) — when known */
  usbProductId?: string
  /** USB bus:device path — when known */
  usbBusDevice?: string
  /** Manufacturer string from USB descriptor */
  manufacturer?: string
  /** Product name string from USB descriptor or CUPS Model */
  model?: string
  /** Detected transport: USB / Parallel / CUPS-local */
  connection: 'USB' | 'PARALLEL' | 'CUPS_LOCAL'
}

/**
 * Enumerate local printers connected to this host that are NOT visible on the
 * network layer (USB, parallel-port, or only configured in CUPS). These are
 * invisible to ARP/ping/mDNS/SSDP/HTTP and require OS-specific probing.
 *
 * Strategy (each layer adds richer metadata; all are best-effort and silent):
 *   1. `lpstat -p -d -l`   — CUPS queue inventory (state + name + reason)
 *   2. `lpinfo -v`         — CUPS device URIs (ipp://, usb://, socket://...)
 *   3. `lsusb -v`          — USB device descriptors (vendor/product names)
 *   4. `/etc/cups/printers.conf` — fallback if lpstat unavailable
 *
 * Returns an empty array on platforms that have no CUPS / USB stack (Windows
 * without USBView, etc.).
 */
export async function discoverLocalPrinters(
  opts: { isAborted?: () => boolean } = {},
): Promise<LocalPrinterRecord[]> {
  const isAborted = opts.isAborted ?? (() => false)
  if (isAborted()) return []

  // Run all probes in parallel — each is fail-safe.
  const [cupsPrinters, cupsDeviceUris, usbDevices] = await Promise.all([
    queryCupsPrinters(isAborted),
    queryCupsDeviceUris(isAborted),
    queryUsbDevices(isAborted),
  ])

  // Merge: primary key = CUPS queue name → USB bus:device
  const byId = new Map<string, LocalPrinterRecord>()

  for (const cp of cupsPrinters) {
    byId.set(cp.id, cp)
  }

  // Enrich with CUPS device URIs (e.g. "usb://EPSON/L3250?serial=...")
  for (const uri of cupsDeviceUris) {
    if (uri.scheme === 'usb') {
      // Look for matching queue by name in URI; if not found, add as standalone
      const matchName = uri.uri.match(/printers\/([^/?]+)/)
      const name = matchName?.[1] || uri.deviceName
      const id = `local-cups:${name}`
      const existing = byId.get(id)
      if (existing) {
        existing.cupsUri = uri.uri
        if (!existing.manufacturer && uri.deviceName.includes('/')) {
          existing.manufacturer = uri.deviceName.split('/')[0]
          existing.model = uri.deviceName.split('/').slice(1).join('/')
        }
      } else {
        byId.set(id, {
          id,
          name: uri.deviceName.replace(/\?.*$/, ''),
          source: 'local',
          cupsUri: uri.uri,
          manufacturer: uri.deviceName.includes('/')
            ? uri.deviceName.split('/')[0]
            : undefined,
          model: uri.deviceName.includes('/')
            ? uri.deviceName.split('/').slice(1).join('/').replace(/\?.*$/, '')
            : uri.deviceName,
          connection: 'USB',
        })
      }
    }
  }

  // Merge in USB devices that look like printers (interface class 0x07)
  for (const usb of usbDevices) {
    if (!usb.isPrinter) {
      // Still consider devices from known printer vendors
      const vendorName = USB_VENDOR_IDS[usb.vendorId.toLowerCase()]
      if (!vendorName || !['HP', 'Epson', 'Canon', 'Brother', 'Star Micronics', 'Custom', 'SNBC'].includes(vendorName)) {
        continue
      }
    }
    const id = `local-usb:${usb.busDevice}`
    const existing = byId.get(id)
    if (existing) {
      existing.usbVendorId = usb.vendorId
      existing.usbProductId = usb.productId
      existing.usbBusDevice = usb.busDevice
      if (!existing.manufacturer) existing.manufacturer = usb.manufacturer || USB_VENDOR_IDS[usb.vendorId.toLowerCase()]
      if (!existing.model) existing.model = usb.productName
      if (!existing.connection) existing.connection = 'USB'
    } else {
      byId.set(id, {
        id,
        name: usb.productName || usb.manufacturer || `USB Printer ${usb.busDevice}`,
        source: 'usb',
        usbVendorId: usb.vendorId,
        usbProductId: usb.productId,
        usbBusDevice: usb.busDevice,
        manufacturer: usb.manufacturer || USB_VENDOR_IDS[usb.vendorId.toLowerCase()],
        model: usb.productName,
        connection: 'USB',
      })
    }
  }

  return Array.from(byId.values()).filter((p) => {
    // ── Hard filter: NEVER surface virtual / software print queues ──
    // "Adobe PDF", "Microsoft Print to PDF", "Fax", "OneNote", "CutePDF",
    // etc. are host-side spooler queues with no physical printer behind
    // them. They must never appear as discovered devices, regardless of
    // how they were detected (CUPS queue name, USB descriptor, etc.).
    if (isVirtualPrinterName(p.name) || isVirtualPrinterName(p.cupsName) || isVirtualPrinterName(p.model)) {
      return false
    }
    // Filter: keep anything that has a clear printer signal
    if (p.connection === 'USB' || p.cupsUri?.startsWith('usb://') || p.cupsUri?.startsWith('ipp://') || p.cupsName) {
      return true
    }
    // Otherwise must be from a known printer vendor
    const vendor = (p.manufacturer || '').toLowerCase()
    return ['hp', 'epson', 'canon', 'brother', 'star', 'custom', 'snbc', 'star micronics'].some((v) => vendor.includes(v))
  })
}

// ─── CUPS query: lpstat -p -d -l ────────────────────────────────────────────

interface CupsPrinterInfo {
  id: string
  name: string
  cupsName?: string
  cupsState?: string
  cupsUri?: string
}

async function queryCupsPrinters(isAborted: () => boolean): Promise<LocalPrinterRecord[]> {
  if (isAborted()) return []
  // Try `lpstat -p` (works on Linux + macOS with CUPS)
  if (process.platform === 'win32') {
    // Windows: query WMI for printer objects via PowerShell
    return queryWindowsPrinters(isAborted)
  }
  return new Promise((resolve) => {
    const child = spawn('lpstat', ['-p', '-l'], { timeout: 4000 })
    let out = ''
    child.stdout.on('data', (d) => { out += d.toString() })
    child.on('error', () => resolve([]))
    child.on('close', () => resolve(parseLpstat(out)))
  })
}

function parseLpstat(out: string): LocalPrinterRecord[] {
  const printers: LocalPrinterRecord[] = []
  // Format: "printer <name> is idle.  enabled since <date>"
  //         "printer <name> now printing <job>.  enabled since <date>"
  //         "printer <name> disabled since <date> -"
  for (const line of out.split('\n')) {
    const m = line.match(/^printer\s+(\S+)\s+(is idle|now printing|disabled|is not ready)/i)
    if (m) {
      const name = m[1]
      // SKIP virtual / software print queues — "Adobe PDF", "Microsoft Print
      // to PDF", "Fax", etc. are NOT real hardware printers. They are host-side
      // spooler queues that show up in `lpstat -p` but have no physical device
      // behind them. Surfacing them as discovered printers is misleading (the
      // user sees "Adobe PDF" and thinks the scanner found their Canon).
      if (isVirtualPrinterName(name)) continue
      const stateRaw = m[2].toLowerCase()
      const state = stateRaw.includes('idle') ? 'idle'
        : stateRaw.includes('printing') ? 'printing'
        : 'stopped'
      printers.push({
        id: `local-cups:${name}`,
        name,
        source: 'local',
        cupsName: name,
        cupsState: state,
        connection: 'CUPS_LOCAL',
      })
    }
  }
  return printers
}

// ─── CUPS query: lpinfo -v ──────────────────────────────────────────────────

interface CupsDeviceUri {
  scheme: string  // 'usb', 'ipp', 'socket', 'lpd', 'http'
  uri: string
  deviceName: string  // e.g. "EPSON/L3250?serial=..."
}

async function queryCupsDeviceUris(isAborted: () => boolean): Promise<CupsDeviceUri[]> {
  if (isAborted() || process.platform === 'win32') return []
  return new Promise((resolve) => {
    const child = spawn('lpinfo', ['-v'], { timeout: 4000 })
    let out = ''
    child.stdout.on('data', (d) => { out += d.toString() })
    child.on('error', () => resolve([]))
    child.on('close', () => {
      const uris: CupsDeviceUri[] = []
      for (const line of out.split('\n')) {
        // Format: "network ipp://localhost/printers/EPSON_L3250"
        //         "direct usb://EPSON/L3250?serial=..."
        const m = line.match(/^(?:network|direct|file)\s+(\w+):\/\/(\S+)/)
        if (m) {
          const scheme = m[1]
          const rest = m[2]
          uris.push({
            scheme,
            uri: `${scheme}://${rest}`,
            deviceName: decodeURIComponent(rest).split('?')[0],
          })
        }
      }
      resolve(uris)
    })
  })
}

// ─── USB enumeration: lsusb ─────────────────────────────────────────────────

interface UsbDeviceInfo {
  busDevice: string  // "001:003"
  vendorId: string   // "04b8"
  productId: string  // "0202"
  manufacturer?: string
  productName?: string
  isPrinter: boolean  // USB device class 0x07 or printer interface
}

async function queryUsbDevices(isAborted: () => boolean): Promise<UsbDeviceInfo[]> {
  if (isAborted()) return []
  if (process.platform === 'win32') return []  // Windows uses different USB stack
  // On Linux: `lsusb` (or `lsusb -v` for verbose)
  // On macOS: `system_profiler SPUSBDataType` (XML)
  if (process.platform === 'darwin') {
    return queryMacUsbDevices(isAborted)
  }
  return new Promise((resolve) => {
    // First try lsusb (no verbose — fast, lists all devices)
    const child = spawn('lsusb', [], { timeout: 4000 })
    let out = ''
    child.stdout.on('data', (d) => { out += d.toString() })
    child.on('error', () => resolve([]))
    child.on('close', () => resolve(parseLsusb(out)))
  })
}

function parseLsusb(out: string): UsbDeviceInfo[] {
  const devices: UsbDeviceInfo[] = []
  // Format: "Bus 001 Device 003: ID 04b8:0202 Seiko Epson Corp. L3250 Series"
  for (const line of out.split('\n')) {
    const m = line.match(/Bus\s+(\d+)\s+Device\s+(\d+):\s+ID\s+([0-9a-fA-F]{4}):([0-9a-fA-F]{4})\s*(.*)/)
    if (m) {
      const bus = m[1].padStart(3, '0')
      const dev = m[2].padStart(3, '0')
      const vendorId = m[3].toLowerCase()
      const productId = m[4].toLowerCase()
      const desc = m[5].trim()
      // Split manufacturer from product name on first space
      let manufacturer: string | undefined
      let productName: string | undefined
      if (desc) {
        const spaceIdx = desc.indexOf(' ')
        if (spaceIdx > 0 && spaceIdx < desc.length - 1) {
          // Heuristic: common manufacturer tokens include "Corp.", "Inc.", "Ltd."
          if (/Corp\.?|Inc\.?|Ltd\.?|Co\.|LLC/i.test(desc.slice(0, spaceIdx + 10))) {
            const endCorp = desc.indexOf(' ', spaceIdx + 1)
            if (endCorp > 0) {
              manufacturer = desc.slice(0, endCorp)
              productName = desc.slice(endCorp + 1)
            } else {
              manufacturer = desc
            }
          } else {
            manufacturer = desc.slice(0, spaceIdx)
            productName = desc.slice(spaceIdx + 1)
          }
        } else {
          productName = desc
        }
      }
      // Heuristic: known printer vendors OR "printer" in description
      const knownPrinterVendors = ['03f0', '04b8', '04a9', '04f9', '0519', '0dd4', '154f']
      const isPrinter = knownPrinterVendors.includes(vendorId) ||
        /printer|laserjet|jetdirect|inkjet/i.test(desc)
      devices.push({
        busDevice: `${bus}:${dev}`,
        vendorId,
        productId,
        manufacturer,
        productName,
        isPrinter,
      })
    }
  }
  return devices
}

async function queryMacUsbDevices(isAborted: () => boolean): Promise<UsbDeviceInfo[]> {
  if (isAborted()) return []
  return new Promise((resolve) => {
    const child = spawn('system_profiler', ['SPUSBDataType', '-xml'], { timeout: 5000 })
    let out = ''
    child.stdout.on('data', (d) => { out += d.toString() })
    child.on('error', () => resolve([]))
    child.on('close', () => resolve(parseMacUsbXml(out)))
  })
}

function parseMacUsbXml(xml: string): UsbDeviceInfo[] {
  const devices: UsbDeviceInfo[] = []
  // Minimal plist XML extraction — avoid pulling in a plist parser dependency
  const items = xml.split('<dict>')
  for (const item of items) {
    const vid = item.match(/<key>vendor_id<\/key>\s*<integer>(\d+)<\/integer>/)?.[1]
    const pid = item.match(/<key>product_id<\/key>\s*<integer>(\d+)<\/integer>/)?.[1]
    const name = item.match(/<key>_name<\/key>\s*<string>([^<]+)<\/string>/)?.[1]
    const mfg = item.match(/<key>manufacturer<\/key>\s*<string>([^<]+)<\/string>/)?.[1]
    if (vid && pid) {
      const vendorId = parseInt(vid, 10).toString(16).padStart(4, '0').toLowerCase()
      const productId = parseInt(pid, 10).toString(16).padStart(4, '0').toLowerCase()
      const knownPrinterVendors = ['03f0', '04b8', '04a9', '04f9', '0519', '0dd4', '154f']
      const isPrinter = knownPrinterVendors.includes(vendorId) ||
        /printer|laserjet|jetdirect|inkjet/i.test(name || '')
      devices.push({
        busDevice: `mac:${vendorId}:${productId}`,
        vendorId,
        productId,
        manufacturer: mfg,
        productName: name,
        isPrinter,
      })
    }
  }
  return devices
}

/**
 * Convert a Windows `PrinterStatus` value (which arrives as a NUMBER via
 * `Get-Printer | ConvertTo-Json`, NOT as text) into a human-readable state
 * string that matches the CUPS vocabulary the rest of the scanner uses.
 *
 * Two enum mappings exist in Windows — we handle both defensively:
 *
 *   MSFT_Printer (Get-Printer, modern):
 *     0 = Unknown, 1 = Other, 2 = Idle, 3 = Printing,
 *     4 = WarmingUp, 5 = StoppedPrinting, 6 = Offline
 *
 *   Win32_Printer (WMI, legacy — off-by-one):
 *     1 = Other, 2 = Unknown, 3 = Idle, 4 = Printing,
 *     5 = WarmingUp, 6 = StoppedPrinting, 7 = Offline
 *
 * Before this fix, the scanner stored the raw number (e.g. "0") as
 * `cupsState`, which the frontend rendered as a red "CUPS: 0" error badge.
 * Now the user sees "CUPS: idle" / "CUPS: printing" / "CUPS: offline" etc.
 */
function mapWindowsPrinterStatus(raw: unknown, workOffline?: boolean): string {
  // WorkOffline=true → printer is explicitly taken offline by the user
  if (workOffline === true) return 'offline'

  // Already a readable string (some PowerShell versions return text) → normalise
  if (typeof raw === 'string') {
    const lower = raw.toLowerCase().trim()
    if (/^(idle|normal|ready)$/.test(lower)) return 'idle'
    if (/^(printing|busy)$/.test(lower)) return 'printing'
    if (/^(stopped|stoppedprinting|error|paused|pause)$/.test(lower)) return 'stopped'
    if (/^(offline|workoffline)$/.test(lower)) return 'offline'
    if (/^(warm|warmingup|warming)/.test(lower)) return 'warming_up'
    if (/^(unknown|other)?$/.test(lower)) return 'unknown'
  }

  // Numeric enum (the common case from ConvertTo-Json) → map to text
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10)
  if (!Number.isNaN(n)) {
    // MSFT_Printer mapping
    switch (n) {
      case 0: return 'unknown'        // MSFT_Printer Unknown
      case 1: return 'other'          // MSFT_Printer Other (or Win32 Other)
      case 2: return 'idle'           // MSFT_Printer Idle (or Win32 Unknown → treat as idle)
      case 3: return 'printing'       // MSFT_Printer Printing (or Win32 Idle)
      case 4: return 'warming_up'     // MSFT_Printer WarmingUp (or Win32 Printing)
      case 5: return 'stopped'        // MSFT_Printer StoppedPrinting (or Win32 WarmingUp)
      case 6: return 'offline'        // MSFT_Printer Offline (or Win32 StoppedPrinting)
      case 7: return 'offline'        // Win32_Printer Offline
      default: return 'unknown'
    }
  }
  return 'unknown'
}

async function queryWindowsPrinters(_isAborted: () => boolean): Promise<LocalPrinterRecord[]> {
  // PowerShell: Get-Printer with all the properties we need to build a rich
  // LocalPrinterRecord. `WorkOffline` lets us detect a printer the user has
  // manually taken offline (state shows as "offline" instead of "unknown").
  return new Promise((resolve) => {
    const ps = `Get-Printer | Select-Object Name, PortName, PrinterStatus, Type, WorkOffline, Shared, ShareName, DriverName | ConvertTo-Json`
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 5000 })
    let out = ''
    child.stdout.on('data', (d) => { out += d.toString() })
    child.on('error', () => resolve([]))
    child.on('close', () => {
      try {
        const data = JSON.parse(out)
        const arr = Array.isArray(data) ? data : (data ? [data] : [])
        const printers: LocalPrinterRecord[] = arr.map((p: any) => ({
          id: `local-win:${p.Name}`,
          name: p.Name,
          source: 'local',
          cupsName: p.Name,
          cupsUri: p.PortName,
          // Convert the numeric PrinterStatus enum to readable text so the
          // frontend shows "CUPS: idle" instead of a red "CUPS: 0" error.
          cupsState: mapWindowsPrinterStatus(p.PrinterStatus, p.WorkOffline),
          // USB001 / USB002 / LPT1 → USB; everything else → CUPS_LOCAL
          connection: (p.Type === 'Local' || /^USB\d/i.test(String(p.PortName || '')))
            ? 'USB'
            : 'CUPS_LOCAL',
        }))
        resolve(printers)
      } catch {
        resolve([])
      }
    })
  })
}

// ─── Name-quality scoring + virtual-printer detection ───────────────────────
//
// These helpers solve two related problems:
//   1. A device discovered first by the HTTP probe may pick up a misleading
//      <title> (e.g. "Adobe PDF" served by the host's CUPS web admin on :631).
//      When mDNS / SSDP later identifies the real device (e.g. "Canon TS3400"),
//      we need to know that "Canon TS3400" is a *better* name than "Adobe PDF"
//      so we replace it.
//   2. Bare ARP entries start with placeholder names like "Device @ 192.168.1.5".
//      Any real advertised name should beat that placeholder.
//
// `nameQuality()` scores a name string on a 0-100 scale so the upsert merge
// logic can always keep the richest, most authoritative name.

/** Host-side virtual / software printer queue names. These are NOT real
 *  network printers — they're print queues configured on a desktop CUPS /
 *  Windows spooler. Their HTTP/mDNS titles must never be used as the device
 *  name when a real hardware signal (MAC OUI vendor, UPnP manufacturer) is
 *  available. */
const VIRTUAL_PRINTER_NAMES = new Set([
  'adobe pdf', 'adobe pdf converter', 'adobe pdf printer',
  'microsoft print to pdf', 'microsoft xps document writer', 'microsoft print to pdf converter',
  'onenote', 'onenote (desktop)', 'onenote 2016', 'onenote printer',
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

/** Vendor tokens used by `nameQuality()` to recognise self-advertised names
 *  that include a real vendor + model (e.g. "Canon TS3400 series"). */
const VENDOR_TOKENS = [
  'canon', 'epson', 'hp', 'hewlett', 'brother', 'samsung', 'lg',
  'xiaomi', 'apple', 'google', 'sony', 'tp-link', 'tp link', 'tplink',
  'netgear', 'd-link', 'dlink', 'linksys', 'mikrotik', 'raspberry',
  'oppo', 'huawei', 'honor', 'roku', 'poco', 'redmi', 'realme',
  'pixma', 'laserjet', 'officejet', 'deskjet', 'workforce', 'jetdirect',
  'chromecast', 'echo', 'alexa', 'nest', 'hue', 'tuya', 'shelly',
  'bravia', 'galaxy', 'iphone', 'ipad', 'macbook', 'imac',
]

/** MAC OUI prefixes for known printer vendors — used to confirm that a
 *  device is a real hardware printer (not a host running CUPS). */
const PRINTER_MAC_OUI_PREFIXES = [
  '00:1b:a9', 'ac:18:26',     // Epson
  'a0:48:1c', 'e4:75:a8', '94:57:a5', '54:bf:64',  // HP
  '00:1e:8f', '68:a0:3e', '00:00:48', '00:80:92', '00:a0:b8',
  '18:0e:1a', '28:0e:1a', '3c:3a:73', '54:04:9f', '5c:61:99',
  '9c:28:40', 'ac:3c:0b',     // Canon (expanded)
  '00:80:77', 'c4:30:18',     // Brother
  '00:40:db',                 // Lexmark
  '00:1e:68',                 // Konica Minolta
  '00:00:74',                 // Ricoh
  '00:1c:c2',                 // Sharp
  '00:00:aa',                 // Xerox
]

/** Returns true if the MAC belongs to a known printer vendor. */
export function isPrinterMacVendor(mac?: string): boolean {
  if (!mac) return false
  const normalized = mac.toLowerCase().replace(/[^0-9a-f]/g, '')
  if (normalized.length < 6) return false
  const oui = `${normalized.slice(0,2)}:${normalized.slice(2,4)}:${normalized.slice(4,6)}`
  return PRINTER_MAC_OUI_PREFIXES.includes(oui)
}

/** Returns true if `name` is a known virtual / software printer queue name. */
export function isVirtualPrinterName(name: string | undefined): boolean {
  if (!name) return false
  const lower = name.toLowerCase().trim()
  if (VIRTUAL_PRINTER_NAMES.has(lower)) return true
  // Also catch "Adobe PDF (Copy 1)" style variants
  const base = lower.replace(/\s+\(.*\)$/, '').replace(/\s+copy\s*\d+$/, '')
  return VIRTUAL_PRINTER_NAMES.has(base)
}

/**
 * Score how "rich" / trustworthy a device name is on a 0-100 scale.
 * Higher = better. Used by upsertDevice() to decide whether a newly
 * fingerprinted name should replace the existing one.
 *
 *   100  vendor + model (e.g. "Canon TS3400 series")
 *   90   model-like name with digits (e.g. "Poco X6 Pro", "L3250 Series")
 *   85   multi-word self-advertised name (e.g. "Living Room TV")
 *   70   single-word recognisable name (e.g. "Roku", "Chromecast")
 *   60   vendor + type label (e.g. "Xiaomi Phone", "Apple TV")
 *   50   generic HTTP title / server header (non-virtual-printer)
 *   40   short / unclear string
 *   25   generic type-label placeholder without IP
 *   20   placeholder with IP (e.g. "Device @ 192.168.1.5")
 *   10   very generic single word ("unknown", "device")
 *    0   empty / virtual-printer name (NEVER use as device name)
 */
export function nameQuality(name: string | undefined): number {
  if (!name) return 0
  const trimmed = name.trim()
  if (!trimmed) return 0
  const lower = trimmed.toLowerCase()

  // Virtual / software printer queue names — host-side artifacts (Adobe PDF,
  // Microsoft Print to PDF, etc.). These must NEVER win over any real name,
  // including IP-based placeholders. Score 0 so they're always replaced.
  if (isVirtualPrinterName(trimmed)) return 0

  // Generic placeholder with IP address — lowest meaningful tier
  if (/^(device|phone|tv|printer|router|iot|kiosk|computer|cast device|smart tv|upnp device|http|blasti|usb printer|network device)\s+@\s+\d+\.\d+\.\d+\.\d+/.test(lower)) {
    return 20
  }
  // Generic type-label placeholders without IP (e.g. "Printer @ 192.168...")
  if (/^(printer|phone|tv|router|iot|kiosk|computer|cast device|smart tv)\s+@\s+/.test(lower)) {
    return 25
  }

  // Very generic single-word names
  if (['unknown', 'device', 'printer', 'tv', 'phone', 'router', 'kiosk'].includes(lower)) {
    return 10
  }

  // Self-advertised names with vendor + model (e.g. "Canon TS3400 series")
  const hasVendor = VENDOR_TOKENS.some((v) => {
    const pattern = v.replace(/[- ]/g, '[-\\s]?')
    return new RegExp(`\\b${pattern}\\b`, 'i').test(trimmed)
  })
  // "has digits" — model numbers almost always contain digits (TS3400, X6,
  // L3250, 9100). Using /\d/ instead of a stricter model regex so we catch
  // short model codes like "X6" that single-letter + single-digit tokens
  // produce.
  const hasDigits = /\d/.test(trimmed)
  if (hasVendor && hasDigits) return 100

  // Pure model/product name (no vendor but has digits) — likely a real device model
  if (hasDigits && trimmed.length >= 4) return 90

  // Multi-word self-advertised name (e.g. "Living Room TV", "Xiaomi Phone")
  if (trimmed.split(/\s+/).length >= 2 && trimmed.length >= 4) return 85

  // Single-word but recognisable — could be a real device
  if (trimmed.length >= 4) return 70

  // Short / unclear
  return 40
}

/**
 * Clean an mDNS instance / SRV target name by stripping DNS service-type
 * suffixes and trailing ".local". Examples:
 *   "Poco X6 Pro._android._tcp.local"  → "Poco X6 Pro"
 *   "Canon TS3400._ipp._tcp.local"     → "Canon TS3400"
 *   "Pocos-MacBook.local"              → "Pocos-MacBook"
 */
export function cleanMdnsName(name: string | undefined): string | undefined {
  if (!name) return undefined
  let cleaned = name.trim()
  if (!cleaned) return undefined
  // Strip "._<service>._tcp.local" / "._<service>._udp.local" suffix
  cleaned = cleaned.replace(/\._[a-z0-9-]+\._(?:tcp|udp)\.local\.?$/i, '')
  // Strip trailing ".local"
  cleaned = cleaned.replace(/\.local\.?$/i, '')
  // Strip "_services._dns-sd._udp" enumeration artifacts
  cleaned = cleaned.replace(/^_services\._dns-sd\._(?:tcp|udp)$/i, '')
  cleaned = cleaned.trim()
  return cleaned || undefined
}

// ─── 6. Fingerprinting ──────────────────────────────────────────────────────

export interface FingerprintResult {
  category: DeviceCategory
  type: DeviceType
  name: string
}

/**
 * Categorise a discovered device based on all signals collected about it.
 *
 * Naming philosophy:
 *   - Self-advertised names (UPnP friendlyName, mDNS instance name, USB product
 *     name) are the most authoritative — the device names itself.
 *   - Manufacturer + model from UPnP description XML is the next best thing.
 *   - MAC OUI vendor lookup gives a vendor + type hint for bare ARP entries.
 *   - HTTP <title> is the LEAST reliable — a CUPS server on :631 may serve the
 *     host's default print queue name (e.g. "Adobe PDF"), which has nothing to
 *     do with the device's real identity. We refuse to use HTTP titles that
 *     match known virtual-printer names.
 *   - Generic placeholders ("Device @ 192.168.1.5") are only used as a last
 *     resort and are always overwritten by any richer name.
 *
 * Heuristics (checked in priority order):
 *   1. USB / CUPS local printer probe           → LOCAL / PRINTER
 *   2. "blasti" in any title/server             → BLASTI / APP
 *   3. UPnP printer device type / keywords      → UPNP / PRINTER
 *   4. UPnP MediaRenderer / DMP / TV keywords   → UPNP / TV
 *   5. UPnP InternetGatewayDevice               → UPNP / ROUTER
 *   6. mDNS _ipp/_ipps/_printer/_pdl OR port 9100 (STRONG printer signals)
 *      → NETWORK / PRINTER  (port 631 alone is NOT enough — every CUPS host
 *      exposes a queue there)
 *   7. HTTP port 8001/9197/8060 + TV keywords   → NETWORK / TV
 *   8. mDNS _airplay / _googlecast / _raop      → NETWORK / TV
 *   9. mDNS _androidtvremote / "android tv"     → NETWORK / TV
 *  10. mDNS _android / _apple-mobdev2 / _companion-link → NETWORK / PHONE
 *  11. HTTP title / mDNS router keywords        → NETWORK / ROUTER
 *  12. mDNS _homekit / _hap / _mqtt / Tuya/etc  → NETWORK / IOT
 *  13. mDNS _smb / _ssh / _vnc / _rdp           → NETWORK / KIOSK  (desktop-like)
 *  14. MAC OUI vendor lookup                    → vendor + type hint
 *  15. HTTP title (non-virtual-printer)         → NETWORK / UNKNOWN
 *  16. otherwise                                → NETWORK / UNKNOWN
 *
 * `usbSource` is set when this fingerprint is for a USB / CUPS local printer
 * (not on the network) — the category becomes LOCAL with type PRINTER.
 */
export function fingerprintDevice(input: {
  ip: string
  port: number
  httpTitle?: string
  httpServer?: string
  ssdpSt?: string
  ssdpServer?: string
  upnpManufacturer?: string
  upnpModelName?: string
  upnpFriendlyName?: string
  upnpDeviceType?: string
  mdnsService?: string
  mac?: string
  usbSource?: 'usb' | 'local'
  usbManufacturer?: string
  usbProductName?: string
  cupsName?: string
  reverseDnsName?: string
  netbiosName?: string
  /** DHCP-lease hostname (from dnsmasq.leases / dhcpd.leases). Stronger than
   *  reverse-DNS for phones — Android registers its product name via DHCP
   *  option 12 but does NOT advertise via mDNS. */
  dhcpHostname?: string
}): FingerprintResult {
  // ── USB / CUPS local printer — never on the network ──
  if (input.usbSource) {
    const vendor = input.usbManufacturer || input.upnpManufacturer
    const model = input.usbProductName || input.upnpModelName
    const cups = input.cupsName
    let name: string
    if (vendor && model) name = `${vendor} ${model}`
    else if (model) name = model
    else if (cups && !isVirtualPrinterName(cups)) name = cups
    else if (vendor) name = `${vendor} Printer`
    else name = 'USB Printer'
    return { category: 'LOCAL', type: 'PRINTER', name }
  }

  // Build lowercased signal strings for keyword matching
  const signals: string[] = [
    input.httpTitle, input.httpServer,
    input.ssdpSt, input.ssdpServer,
    input.upnpManufacturer, input.upnpModelName,
    input.upnpFriendlyName, input.upnpDeviceType,
    input.mdnsService,
    input.reverseDnsName, input.netbiosName,
    input.dhcpHostname,
  ].filter(Boolean).map((s) => (s as string).toLowerCase())
  const joined = signals.join(' ')

  // MAC vendor OUI lookup — strong hint for bare ARP entries
  const macInfo = lookupMacVendor(input.mac)

  // The "self-advertised name" — this is the device's own name for itself.
  // It may come from a UPnP friendlyName or an mDNS service instance name.
  // mDNS names often arrive with a service-type suffix (e.g.
  // "Poco X6 Pro._android._tcp.local") so we clean them first.
  const rawFriendlyName = input.upnpFriendlyName?.trim() || undefined
  const friendlyName = rawFriendlyName ? cleanMdnsName(rawFriendlyName) || rawFriendlyName : undefined

  // A safe version of friendlyName that skips virtual-printer names like
  // "Adobe PDF" (those are host CUPS queue names, not real device names).
  const safeFriendlyName = friendlyName && !isVirtualPrinterName(friendlyName) ? friendlyName : undefined

  // ── Secondary name sources (used when no mDNS/UPnP friendlyName) ──
  // Three name sources can rescue a phone/TV that didn't advertise via mDNS
  // or SSDP:
  //   1. DHCP-lease hostname (STRONGEST for phones — Android sends its
  //      product name as DHCP option 12)
  //   2. Reverse-DNS hostname (PTR record — the router's DNS resolver
  //      usually has a hostname for every DHCP lease)
  //   3. NetBIOS workstation name (Windows hosts, Samba servers, printers)
  //
  // DHCP hostname is the most reliable phone-name source on home networks
  // where the BLASTI server is also the router. Reverse-DNS is next. NetBIOS
  // is last (phones don't run NetBIOS).
  const cleanedDhcp = cleanDhcpHostname(input.dhcpHostname || null)
  const safeDhcpName = cleanedDhcp && !isVirtualPrinterName(cleanedDhcp) ? cleanedDhcp : undefined
  const cleanedReverseDns = cleanReverseDnsHostname(input.reverseDnsName || null)
  const safeReverseDnsName = cleanedReverseDns && !isVirtualPrinterName(cleanedReverseDns) ? cleanedReverseDns : undefined
  const cleanedNetbios = input.netbiosName?.trim()
  const safeNetbiosName = cleanedNetbios && !isVirtualPrinterName(cleanedNetbios) ? cleanedNetbios : undefined

  // Best available secondary name — used as a fallback before the
  // "Device @ IP" / "Printer @ IP" / "TV @ IP" placeholders.
  // Priority: DHCP hostname (phones) > reverse-DNS (router DNS) > NetBIOS.
  const bestSecondaryName = safeDhcpName || safeReverseDnsName || safeNetbiosName

  // Detect a randomized / locally-administered MAC. Since Android 10 and
  // iOS 14, phones randomize their WiFi MAC per network. This means the OUI
  // vendor table can't identify them — but the very presence of a randomized
  // MAC on a home WiFi network is a strong signal that the device is a phone
  // or tablet. We use this in the bare-ARP fallback below.
  const hasRandomizedMac = isRandomizedMac(input.mac)

  // ── Strong printer signals ──
  // Port 631 (IPP / CUPS web admin) alone is NOT a strong printer signal —
  // every desktop running CUPS exposes a queue on :631. We require:
  //   - mDNS _ipp / _ipps / _printer / _pdl-datastream service type, OR
  //   - Port 9100 (raw JetDirect — only real printers use this), OR
  //   - A known printer-vendor MAC OUI, OR
  //   - UPnP device-type or SSDP ST containing "printer"
  const mdnsServiceLower = (input.mdnsService || '').toLowerCase()
  const hasPrinterServiceMdns = ['_ipp', '_ipps', '_printer', '_pdl-datastream'].some(
    (s) => mdnsServiceLower.includes(s),
  )
  const hasPrinterPort = input.port === 9100
  const hasPrinterMac = isPrinterMacVendor(input.mac)
  const hasPrinterUpnpSignal = !!(input.ssdpSt || input.upnpDeviceType) && /printer|jetdirect|laserjet|pixma|workforce|deskjet|officejet/.test(joined)
  const hasStrongPrinterSignal = hasPrinterServiceMdns || hasPrinterPort || hasPrinterMac || hasPrinterUpnpSignal

  // ── 1. BLASTI app detection ──
  if (joined.includes('blasti') || joined.includes('blast')) {
    const name = safeFriendlyName || input.httpTitle || bestSecondaryName || `BLASTI @ ${input.ip}`
    return { category: 'BLASTI', type: 'APP', name }
  }

  // ── 2. UPnP category (any SSDP response counts) ──
  if (input.ssdpSt || input.upnpDeviceType) {
    // Printer in UPnP
    if (hasPrinterUpnpSignal || /printer|jetdirect|laserjet|pixma|workforce|deskjet|officejet/.test(joined)) {
      const manufacturer = input.upnpManufacturer || macInfo.vendor
      const model = input.upnpModelName
      const name = safeFriendlyName
        || (manufacturer && model ? `${manufacturer} ${model}` : null)
        || model
        || (manufacturer ? `${manufacturer} Printer` : null)
        || bestSecondaryName
        || `Printer @ ${input.ip}`
      return { category: 'UPNP', type: 'PRINTER', name }
    }
    // TV detection within UPnP
    const tvHints = ['tv', 'television', 'samsung', 'lg ', 'roku', 'chromecast', 'cast', 'dlna', 'media', 'renderer', 'bravia', 'sharp', 'android tv']
    if (tvHints.some((h) => joined.includes(h))) {
      const name = safeFriendlyName
        || input.upnpModelName
        || bestSecondaryName
        || (macInfo.vendor ? `${macInfo.vendor} TV` : `Smart TV @ ${input.ip}`)
      return { category: 'UPNP', type: 'TV', name }
    }
    // Router/gateway in UPnP
    const routerHints = ['router', 'modem', 'gateway', 'wanrouter', 'wlan', 'internetgatewaydevice']
    if (routerHints.some((h) => joined.includes(h))) {
      const name = safeFriendlyName
        || input.upnpModelName
        || bestSecondaryName
        || (macInfo.vendor ? `${macInfo.vendor} Router` : `Router @ ${input.ip}`)
      return { category: 'UPNP', type: 'ROUTER', name }
    }
    // Generic UPnP device — keep the self-advertised name if we have one
    if (safeFriendlyName) {
      return { category: 'UPNP', type: 'UNKNOWN', name: safeFriendlyName }
    }
    return { category: 'UPNP', type: 'UNKNOWN', name: bestSecondaryName || `UPnP device @ ${input.ip}` }
  }

  // ── 3. Network printer detection (requires STRONG signal) ──
  // Port 631 alone is NOT enough — every CUPS server exposes a queue there.
  // A "CUPS-only host" is a desktop computer that shares its print queue via
  // mDNS _ipp but has NO real printer hardware signals (no printer-vendor MAC,
  // no JetDirect port 9100, no UPnP printer device type). Such hosts must
  // ALWAYS be classified as KIOSK/Computer — never as PRINTER — regardless of
  // what name the queue advertises ("Adobe PDF", "DESKTOP-ABC", etc.).
  const isCupsOnlyHost = hasPrinterServiceMdns && !hasPrinterMac && !hasPrinterPort && !hasPrinterUpnpSignal
  if (hasStrongPrinterSignal && !isCupsOnlyHost) {
    const manufacturer = input.upnpManufacturer || macInfo.vendor
    const model = input.upnpModelName
    let name: string
    if (safeFriendlyName) {
      name = safeFriendlyName
    } else if (manufacturer && model) {
      name = `${manufacturer} ${model}`
    } else if (model) {
      name = model
    } else if (manufacturer) {
      name = `${manufacturer} Printer`
    } else if (bestSecondaryName) {
      name = bestSecondaryName
    } else {
      name = `Printer @ ${input.ip}`
    }
    return { category: 'NETWORK', type: 'PRINTER', name }
  }

  // ── 4. TV detection without UPnP (vendor HTTP ports or mDNS cast services) ──
  if (input.port === 8001 || input.port === 9197 || input.port === 8060) {
    const name = safeFriendlyName || input.httpTitle || bestSecondaryName || (macInfo.vendor ? `${macInfo.vendor} TV` : `Smart TV @ ${input.ip}`)
    return { category: 'NETWORK', type: 'TV', name }
  }
  // mDNS cast / media-renderer services → TV or streaming stick
  if (
    joined.includes('airplay') ||
    joined.includes('googlecast') ||
    joined.includes('raop') ||
    joined.includes('_dial._tcp') ||
    joined.includes('_mediarenderer') ||
    joined.includes('_samsung._tcp') ||
    joined.includes('_lg_dial') ||
    joined.includes('_leap._tcp') ||
    joined.includes('_spotify-connect')
  ) {
    const name = safeFriendlyName || bestSecondaryName || (macInfo.vendor ? `${macInfo.vendor} TV` : `Smart TV @ ${input.ip}`)
    return { category: 'NETWORK', type: 'TV', name }
  }
  // mDNS _androidtvremote → Android TV
  if (joined.includes('_androidtvremote') || joined.includes('android tv')) {
    const name = safeFriendlyName || bestSecondaryName || `Android TV @ ${input.ip}`
    return { category: 'NETWORK', type: 'TV', name }
  }

  // ── 5. Phone detection — mDNS service types that phones advertise ──
  // Phones advertise their actual product name via mDNS (e.g. "Poco X6 Pro").
  // Prefer that over a generic "Vendor phone @ ip" placeholder.
  if (
    joined.includes('_android._tcp') ||
    joined.includes('_apple-mobdev2') ||
    joined.includes('_companion-link') ||
    joined.includes('_dacp') ||
    joined.includes('_touch-able') ||
    (joined.includes('_airplay') && joined.includes('iphone'))
  ) {
    if (safeFriendlyName) {
      return { category: 'NETWORK', type: 'PHONE', name: safeFriendlyName }
    }
    // Fall back to MAC vendor + "Phone" (no IP — cleaner)
    const vendor = macInfo.vendor
      || (joined.includes('apple') ? 'Apple'
        : joined.includes('samsung') ? 'Samsung'
          : (joined.includes('xiaomi') || joined.includes('poco') || joined.includes('redmi')) ? 'Xiaomi'
            : (joined.includes('huawei') || joined.includes('honor')) ? 'Huawei'
              : (joined.includes('oppo') || joined.includes('realme')) ? 'OPPO'
                : joined.includes('google') ? 'Google'
                  : undefined)
    const name = vendor ? `${vendor} Phone` : (bestSecondaryName || `Phone @ ${input.ip}`)
    return { category: 'NETWORK', type: 'PHONE', name }
  }

  // ── 6. Router / modem / gateway detection ──
  // Gateway heuristic: an IP ending in .1 on a /24 subnet is almost always
  // the network gateway/router, even if its HTTP title doesn't contain a
  // router keyword. This catches routers with generic web UIs (e.g. a page
  // titled just "Home" or with an empty <title>).
  const isGatewayIp = /\.1$/.test(input.ip)
  const routerHints = [
    'router', 'modem', 'gateway', 'wlan', 'ap ', 'access point',
    'thomson', 'technicolor', 'arris', 'tp-link', 'tp link', 'tplink',
    'netgear', 'd-link', 'dlink', 'linksys', 'asus router', 'mikrotik',
    'huawei router', 'fiber', 'fibre', 'ont',
  ]
  if (isGatewayIp || routerHints.some((h) => joined.includes(h))) {
    const httpTitleSafe = input.httpTitle && !isVirtualPrinterName(input.httpTitle) ? input.httpTitle : undefined
    const name = safeFriendlyName || httpTitleSafe || bestSecondaryName || (macInfo.vendor ? `${macInfo.vendor} Router` : `Router @ ${input.ip}`)
    return { category: 'NETWORK', type: 'ROUTER', name }
  }

  // ── 7. IoT detection — HomeKit, HAP, MQTT, etc. ──
  if (
    joined.includes('_homekit') ||
    joined.includes('_hap._tcp') ||
    joined.includes('_mqtt') ||
    joined.includes('_sleep-proxy') ||
    joined.includes('tuya') ||
    joined.includes('shelly') ||
    joined.includes('espressif') ||
    joined.includes('xiaomi smart') ||
    joined.includes('sonoff')
  ) {
    const httpTitleSafe = input.httpTitle && !isVirtualPrinterName(input.httpTitle) ? input.httpTitle : undefined
    const name = safeFriendlyName || httpTitleSafe || bestSecondaryName || (macInfo.vendor ? `${macInfo.vendor} IoT` : `IoT device @ ${input.ip}`)
    return { category: 'NETWORK', type: 'IOT', name }
  }

  // ── 8. Kiosk / desktop detection — SMB, SSH, VNC, RDP, workstation ──
  // Also catch a CUPS-only host (mDNS _ipp but no printer-vendor MAC and no
  // real printer model) — that's a desktop sharing a print queue, not a
  // dedicated network printer. Label it as a Computer/Kiosk.
  // (isCupsOnlyHost is defined above in the printer-detection section.)
  if (
    joined.includes('_smb._tcp') ||
    joined.includes('_ssh._tcp') ||
    joined.includes('_vnc._tcp') ||
    joined.includes('_rdp._tcp') ||
    joined.includes('_workstation._tcp') ||
    joined.includes('_sftp-ssh._tcp') ||
    isCupsOnlyHost
  ) {
    const httpTitleSafe = input.httpTitle && !isVirtualPrinterName(input.httpTitle) ? input.httpTitle : undefined
    // For CUPS-only hosts, prefer the hostname/MAC-vendor name — NEVER use
    // the virtual-printer queue name ("Adobe PDF") as the device name.
    const name = safeFriendlyName || bestSecondaryName || httpTitleSafe || (macInfo.vendor ? `${macInfo.vendor} Computer` : `Computer @ ${input.ip}`)
    return { category: 'NETWORK', type: 'KIOSK', name }
  }

  // ── 9. MAC OUI vendor hint — strong signal for bare ARP entries ──
  // If we have a reverse-DNS or NetBIOS hostname, prefer it over the
  // generic "Vendor Type" label — the hostname is the device's actual name.
  if (bestSecondaryName && macInfo.vendor && macInfo.type) {
    const typeLabel = macInfo.type.charAt(0) + macInfo.type.slice(1).toLowerCase()
    return {
      category: 'NETWORK',
      type: macInfo.type,
      name: bestSecondaryName,
      // macInfo.vendor/type still inform the type field; name = hostname
    }
  }
  if (macInfo.vendor && macInfo.type) {
    // Use "Vendor Type" (e.g. "Xiaomi Phone", "Canon Printer") — no IP
    const typeLabel = macInfo.type.charAt(0) + macInfo.type.slice(1).toLowerCase()
    return {
      category: 'NETWORK',
      type: macInfo.type,
      name: `${macInfo.vendor} ${typeLabel}`,
    }
  }
  if (bestSecondaryName) {
    // We have a hostname but no MAC vendor — still better than "Device @ IP"
    return {
      category: 'NETWORK',
      type: 'UNKNOWN',
      name: bestSecondaryName,
    }
  }
  if (macInfo.vendor) {
    // At least surface the vendor name even if type is unknown
    return {
      category: 'NETWORK',
      type: 'UNKNOWN',
      name: `${macInfo.vendor} Device`,
    }
  }

  // ── 10. Generic HTTP service (with a title that is NOT a virtual printer) ──
  const httpTitleSafe = input.httpTitle && !isVirtualPrinterName(input.httpTitle) ? input.httpTitle : undefined
  if (httpTitleSafe || input.httpServer) {
    // If the MAC is randomized, this is almost certainly a phone whose
    // embedded web server happens to serve a generic title (or a captive
    // portal). Classify it as a PHONE, not UNKNOWN.
    if (hasRandomizedMac) {
      return {
        category: 'NETWORK',
        type: 'PHONE',
        name: httpTitleSafe || 'Mobile Device',
      }
    }
    return {
      category: 'NETWORK',
      type: 'UNKNOWN',
      name: httpTitleSafe || input.httpServer || `HTTP @ ${input.ip}:${input.port}`,
    }
  }

  // ── 11. Bare ARP/ping entry ──
  // Last resort: no name, no vendor, no HTTP title.
  //
  // If the MAC is randomized (locally-administered bit set AND not in our
  // vendor table), the device is almost certainly a phone or tablet —
  // Android 10+ and iOS 14+ randomize WiFi MACs by default, and these are
  // by far the most common randomized-MAC devices on a home network. We
  // classify it as a PHONE rather than leaving it as "Device @ IP".
  if (hasRandomizedMac) {
    return {
      category: 'NETWORK',
      type: 'PHONE',
      name: bestSecondaryName || `Mobile Device @ ${input.ip}`,
    }
  }

  // If we have ANY secondary name (DHCP / rDNS / NetBIOS), surface it even
  // though we can't classify the device type — the name is still real.
  if (bestSecondaryName) {
    return {
      category: 'NETWORK',
      type: 'UNKNOWN',
      name: bestSecondaryName,
    }
  }

  // True last resort: an anonymous ICMP-responding host with no name, no
  // vendor, no HTTP. This is now rare with DHCP/rDNS/NBNS all running.
  return {
    category: 'NETWORK',
    type: 'UNKNOWN',
    name: `Device @ ${input.ip}`,
  }
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

/**
 * Run a full multi-protocol scan across all `subnets`.
 * Calls `cb.onProgress` for each phase transition and IP scanned,
 * and `cb.onDevice` for each unique device discovered.
 */
export async function runDiscoveryScan(
  subnets: string[],
  cb: ScanCallbacks,
): Promise<DiscoveredDeviceRaw[]> {
  const devicesByIp = new Map<string, DiscoveredDeviceRaw>()
  const protocolsUsed: string[] = []
  const totalIPs = subnets.length * 254

  const emitProgress = (phase: ScanPhase, scannedIPs: number, currentSubnet: string = '') => {
    cb.onProgress({
      phase,
      scannedIPs,
      totalIPs,
      currentSubnet,
      protocolsUsed: [...protocolsUsed],
      devicesFound: devicesByIp.size,
    })
  }

  const upsertDevice = (ip: string, patch: Partial<DiscoveredDeviceRaw>) => {
    const existing = devicesByIp.get(ip)
    if (existing) {
      // Merge: keep richer fields
      const merged: DiscoveredDeviceRaw = {
        ...existing,
        ...patch,
        capabilities: Array.from(new Set([...(existing.capabilities || []), ...(patch.capabilities || [])])),
        lastSeen: Date.now(),
        // Don't overwrite a known port with 0
        port: patch.port || existing.port,
        // Don't downgrade source priority (ssdp > mdns > http_probe > ping > arp)
        source: sourcePriority(patch.source as DiscoverySource) > sourcePriority(existing.source as DiscoverySource)
          ? patch.source as DiscoverySource
          : existing.source,
        // Preserve the raw self-advertised name across merges — the first
        // non-empty friendlyName wins (mDNS/UPnP names are richer than HTTP).
        friendlyName: patch.friendlyName || existing.friendlyName,
        // Preserve secondary name sources across merges too — reverse-DNS,
        // NetBIOS, and DHCP hostnames are set during the 'names' phase and
        // must survive subsequent HTTP-probe merges (which don't carry them).
        reverseDnsName: patch.reverseDnsName || existing.reverseDnsName,
        netbiosName: patch.netbiosName || existing.netbiosName,
        dhcpHostname: patch.dhcpHostname || existing.dhcpHostname,
      }
      // Re-fingerprint with merged signals. Use the preserved raw friendlyName
      // (NOT merged.name, which may be a placeholder or HTTP title) so the
      // fingerprint logic sees the real self-advertised device name.
      const fp = fingerprintDevice({
        ip: merged.ip, port: merged.port,
        httpTitle: merged.httpTitle, httpServer: merged.httpServer,
        ssdpSt: merged.ssdpSt, ssdpServer: merged.ssdpServer,
        upnpManufacturer: merged.manufacturer, upnpModelName: merged.model,
        upnpFriendlyName: merged.friendlyName, upnpDeviceType: undefined,
        mdnsService: merged.mdnsService, mac: merged.mac,
        reverseDnsName: merged.reverseDnsName, netbiosName: merged.netbiosName,
        dhcpHostname: merged.dhcpHostname,
      })
      merged.category = fp.category
      merged.type = fp.type
      // Keep the higher-quality name — real self-advertised device names beat
      // placeholders and virtual-printer titles. Virtual-printer names score 0,
      // so they're always replaced by any real name (even a placeholder).
      // Use >= so a fingerprint refresh can fix capitalisation / cleanup.
      merged.name = nameQuality(fp.name) >= nameQuality(existing.name) ? fp.name : existing.name
      devicesByIp.set(ip, merged)
      cb.onDevice(merged)
    } else {
      const now = Date.now()
      const device: DiscoveredDeviceRaw = {
        id: `disco:${ip}`,
        source: patch.source || 'arp',
        category: patch.category || 'NETWORK',
        type: patch.type || 'UNKNOWN',
        name: patch.name || `Device @ ${ip}`,
        ip,
        port: patch.port || 0,
        mac: patch.mac,
        manufacturer: patch.manufacturer,
        model: patch.model,
        status: 'ONLINE',
        lastSeen: now,
        firstSeen: now,
        connectionType: 'LAN',
        capabilities: patch.capabilities || [],
        httpUrl: patch.httpUrl,
        httpTitle: patch.httpTitle,
        httpServer: patch.httpServer,
        httpStatus: patch.httpStatus,
        ssdpLocation: patch.ssdpLocation,
        ssdpServer: patch.ssdpServer,
        ssdpSt: patch.ssdpSt,
        mdnsService: patch.mdnsService,
        friendlyName: patch.friendlyName,
        reverseDnsName: patch.reverseDnsName,
        netbiosName: patch.netbiosName,
        dhcpHostname: patch.dhcpHostname,
      }
      // Re-fingerprint using the raw friendlyName, not the display name.
      const fp = fingerprintDevice({
        ip, port: device.port,
        httpTitle: device.httpTitle, httpServer: device.httpServer,
        ssdpSt: device.ssdpSt, ssdpServer: device.ssdpServer,
        upnpManufacturer: device.manufacturer, upnpModelName: device.model,
        upnpFriendlyName: device.friendlyName, upnpDeviceType: undefined,
        mdnsService: device.mdnsService, mac: device.mac,
        reverseDnsName: device.reverseDnsName, netbiosName: device.netbiosName,
        dhcpHostname: device.dhcpHostname,
      })
      device.category = fp.category
      device.type = fp.type
      // Use the fingerprint's name if it's higher quality than the patch name.
      if (nameQuality(fp.name) > nameQuality(device.name)) device.name = fp.name
      devicesByIp.set(ip, device)
      cb.onDevice(device)
    }
  }

  // ── Phase 1: ARP ──
  emitProgress('arp', 0)
  if (!protocolsUsed.includes('ARP')) protocolsUsed.push('ARP')
  try {
    const arp = await readArpTable()
    for (const entry of arp) {
      if (cb.isAborted()) break
      // Only keep entries on our scanned subnets
      if (!subnets.some((s) => entry.ip.startsWith(s + '.'))) continue
      upsertDevice(entry.ip, {
        source: 'arp',
        mac: entry.mac,
        capabilities: ['ARP'],
      })
    }
  } catch { /* ignore */ }
  emitProgress('arp', totalIPs)

  // ── Phase 2: Ping sweep ──
  let scanned = 0
  for (const subnet of subnets) {
    if (cb.isAborted()) break
    emitProgress('ping', scanned, subnet)
    if (!protocolsUsed.includes('Ping')) protocolsUsed.push('Ping')
    const alive = await pingSweep(subnet, {
      isAborted: cb.isAborted,
      onProgress: () => {
        scanned++
        if (scanned % 16 === 0) emitProgress('ping', scanned, subnet)
      },
    })
    for (const ip of alive) {
      upsertDevice(ip, { source: 'ping', capabilities: ['ICMP'] })
    }
    scanned = Math.max(scanned, totalIPs / subnets.length)
  }
  emitProgress('ping', totalIPs)

  // ── Phase 2b: Re-read ARP table (capture MACs for ping-only devices) ──
  // The initial ARP read (Phase 1) only sees devices the OS already had in
  // its neighbour cache. Devices that responded to our ping sweep just now
  // will have a fresh ARP entry — re-reading the table here lets us backfill
  // the MAC (and therefore the OUI vendor) for ping-only devices that mDNS /
  // SSDP / HTTP won't be able to name later. Without this step, a firewalled
  // phone or IoT gadget that only answers ICMP ends up as "Device @ IP"
  // because the fingerprint has no MAC-vendor hint to fall back on.
  if (!cb.isAborted()) {
    try {
      const arpRefresh = await readArpTable()
      for (const entry of arpRefresh) {
        if (cb.isAborted()) break
        if (!subnets.some((s) => entry.ip.startsWith(s + '.'))) continue
        const existing = devicesByIp.get(entry.ip)
        // Only backfill if we already know this IP (from ping) but have no MAC
        if (existing && !existing.mac && entry.mac) {
          upsertDevice(entry.ip, {
            mac: entry.mac,
            capabilities: ['ARP'],
          })
        }
      }
    } catch { /* ignore — best-effort */ }
  }

  // ── Phase 3: mDNS ──
  if (!cb.isAborted()) {
    emitProgress('mdns', totalIPs)
    if (!protocolsUsed.includes('mDNS')) protocolsUsed.push('mDNS')
    try {
      const records = await mdnsQuery(MDNS_SERVICE_TYPES, {
        timeoutMs: MDNS_TIMEOUT_MS,
        isAborted: cb.isAborted,
      })
      for (const rec of records) {
        if (!rec.ip) continue
        // Filter to our subnets
        if (!subnets.some((s) => rec.ip.startsWith(s + '.'))) continue
        // Store the raw mDNS instance name in friendlyName (preserved across
        // merges for re-fingerprinting). Only set it as the display `name` if
        // it's NOT a virtual-printer queue name ("Adobe PDF", etc.) — those are
        // host-side CUPS artifacts, not real device names.
        const cleanName = cleanMdnsName(rec.name) || rec.name
        const safeName = cleanName && !isVirtualPrinterName(cleanName) ? cleanName : undefined
        upsertDevice(rec.ip, {
          source: 'mdns',
          port: rec.port || 0,
          mdnsService: rec.serviceType,
          friendlyName: cleanName,
          name: safeName,
          capabilities: [`mDNS:${rec.serviceType}`],
        })
      }
    } catch { /* ignore */ }
  }
  emitProgress('mdns', totalIPs)

  // ── Phase 4: SSDP ──
  if (!cb.isAborted()) {
    emitProgress('ssdp', totalIPs)
    if (!protocolsUsed.includes('SSDP')) protocolsUsed.push('SSDP')
    try {
      const ssdpRecords = await ssdpDiscover({
        timeoutMs: SSDP_TIMEOUT_MS,
        isAborted: cb.isAborted,
      })
      // Fetch UPnP descriptions in parallel (limited concurrency)
      const descResults = await Promise.all(
        ssdpRecords.slice(0, 32).map(async (r) => {
          const desc = await fetchUpnpDescription(r.location)
          return { ssdp: r, desc }
        }),
      )
      for (const { ssdp, desc } of descResults) {
        // Parse IP:port from LOCATION URL
        const m = ssdp.location.match(/^https?:\/\/([^:/]+)(?::(\d+))?/)
        if (!m) continue
        const ip = m[1]
        const port = m[2] ? parseInt(m[2], 10) : 80
        if (!subnets.some((s) => ip.startsWith(s + '.'))) continue
        upsertDevice(ip, {
          source: 'ssdp',
          port,
          ssdpLocation: ssdp.location,
          ssdpServer: ssdp.server,
          ssdpSt: ssdp.st,
          manufacturer: desc?.manufacturer,
          model: desc?.modelName,
          friendlyName: desc?.friendlyName,
          // Only use the UPnP friendlyName as display name if it's not a
          // virtual-printer queue name.
          name: desc?.friendlyName && !isVirtualPrinterName(desc.friendlyName) ? desc.friendlyName : undefined,
          capabilities: ['SSDP/UPnP', ...(desc?.deviceType ? [`UPnP:${desc.deviceType.split(':').slice(-1)[0]}`] : [])],
        })
      }
    } catch { /* ignore */ }
  }
  emitProgress('ssdp', totalIPs)

  // ── Phase 4b: Reverse DNS + NetBIOS name resolution ──
  // For devices that responded to ping/ARP but NOT to mDNS/SSDP, we have no
  // self-advertised name. Two more name sources can rescue these "Device @ IP"
  // entries before the HTTP probe runs:
  //
  //   1. Reverse DNS (PTR record) — the router's DNS resolver often has a
  //      hostname for every DHCP lease (e.g. "canon-printer", "DESKTOP-ABC").
  //   2. NetBIOS Name Service (UDP 137) — Windows hosts, Samba servers, and
  //      many network printers respond with their machine name.
  //
  // Both run in parallel with bounded concurrency. They're UDP/DNS queries
  // (no privileges) and time out quickly (800ms each). The results are stored
  // in `reverseDnsName` / `netbiosName` on the device and used by the
  // fingerprint logic as a fallback before "Device @ IP".
  //
  // This phase runs AFTER mDNS/SSDP (so self-advertised names win) but BEFORE
  // the HTTP probe (so devices that only respond to ping can still get a real
  // name instead of an IP placeholder).
  if (!cb.isAborted() && devicesByIp.size > 0) {
    emitProgress('names', 0)
    if (!protocolsUsed.includes('rDNS/NBNS')) protocolsUsed.push('rDNS/NBNS')
    try {
      // Only query IPs that don't already have a friendlyName (mDNS/SSDP
      // already gave us a name) — saves time and avoids redundant lookups.
      const ipsToResolve = Array.from(devicesByIp.entries())
        .filter(([, d]) => !d.friendlyName)
        .map(([ip]) => ip)
        .filter((ip) => !ip.startsWith('local:')) // skip USB/local printers

      // Run reverse DNS and NetBIOS in parallel — they're independent.
      const [rdnsResults, nbnsResults] = await Promise.all([
        reverseDnsBatch(ipsToResolve, { concurrency: 32, isAborted: cb.isAborted }),
        nbnsBatch(ipsToResolve, { concurrency: 32, isAborted: cb.isAborted }),
      ])

      // Apply reverse-DNS names
      for (const rec of rdnsResults) {
        if (cb.isAborted()) break
        const cleaned = cleanReverseDnsHostname(rec.hostname)
        if (!cleaned || isVirtualPrinterName(cleaned)) continue
        upsertDevice(rec.ip, {
          reverseDnsName: cleaned,
          capabilities: ['rDNS'],
        })
      }

      // Apply NetBIOS names
      for (const rec of nbnsResults) {
        if (cb.isAborted()) break
        const name = rec.name?.trim()
        if (!name || isVirtualPrinterName(name)) continue
        upsertDevice(rec.ip, {
          netbiosName: name,
          capabilities: ['NBNS', ...(rec.workgroup ? [`Workgroup:${rec.workgroup}`] : [])],
        })
      }
    } catch { /* ignore */ }
  }
  emitProgress('names', totalIPs)

  // ── Phase 4c: DHCP lease file lookup ──
  // THE most reliable name source for Android phones. Android does NOT
  // advertise via mDNS (the "_android._tcp" service type is a myth — vanilla
  // Android OS never broadcasts it), does NOT run NetBIOS, and only responds
  // to reverse-DNS if the router's DNS is configured to serve lease names.
  // But every phone DOES register its product name (e.g. "Poco X6 Pro",
  // "SM-S901B", "iPhone") as DHCP option 12 (hostname) when getting its lease.
  //
  // The router writes this into a lease file (dnsmasq.leases / dhcpd.leases).
  // If the BLASTI server's host can read that file, we get the phone's real
  // name with zero network traffic — just a file read.
  //
  // This phase runs AFTER mDNS/SSDP/rDNS/NBNS (so self-advertised names win)
  // but BEFORE the HTTP probe (so phones that only respond to ping can still
  // get their real name from the DHCP lease).
  if (!cb.isAborted() && devicesByIp.size > 0) {
    emitProgress('names', totalIPs)
    if (!protocolsUsed.includes('DHCP')) protocolsUsed.push('DHCP')
    try {
      const leases = await readDhcpLeases({ isAborted: cb.isAborted })
      for (const lease of leases) {
        if (cb.isAborted()) break
        // Skip leases that aren't on our scanned subnets
        if (!subnets.some((s) => lease.ip.startsWith(s + '.'))) continue
        // Skip if the lease has no hostname
        if (!lease.hostname) continue
        // Skip leases whose hostname we already have as a friendlyName
        // (mDNS/SSDP already gave us a richer name).
        const existing = devicesByIp.get(lease.ip)
        if (existing?.friendlyName) continue
        // If the lease has a MAC and the existing device doesn't, backfill it.
        // The DHCP lease MAC is the device's REAL hardware MAC (not a
        // randomized one) — useful for vendor lookup.
        const patch: Partial<DiscoveredDeviceRaw> = {
          dhcpHostname: lease.hostname,
          capabilities: ['DHCP'],
        }
        if (lease.mac && (!existing || !existing.mac)) {
          patch.mac = lease.mac
        }
        upsertDevice(lease.ip, patch)
      }
    } catch { /* ignore */ }
  }

  // ── Phase 5: Local USB / CUPS printers ──
  // Runs BEFORE the HTTP probe so that local printer metadata is enriched
  // first. USB printers are NOT on the network layer — they cannot be
  // discovered by ARP/ping/mDNS/SSDP/HTTP. We probe the host's CUPS daemon
  // (`lpstat`, `lpinfo`) and USB enumeration (`lsusb`) to find printers
  // connected directly to this machine (USB cable, parallel port, or local
  // CUPS queue).
  if (!cb.isAborted()) {
    emitProgress('local', totalIPs)
    if (!protocolsUsed.includes('USB/CUPS')) protocolsUsed.push('USB/CUPS')
    try {
      const localPrinters = await discoverLocalPrinters({ isAborted: cb.isAborted })
      for (const lp of localPrinters) {
        if (cb.isAborted()) break
        // USB/local printers don't have a network IP — use the cups/usb id as the map key
        const key = `local:${lp.id}`
        const now = Date.now()
        const device: DiscoveredDeviceRaw = {
          id: lp.id,
          source: lp.source,
          category: 'LOCAL',
          type: 'PRINTER',
          name: lp.name,
          ip: '127.0.0.1',  // local-only, not on the network
          port: 0,
          mac: undefined,
          manufacturer: lp.manufacturer,
          model: lp.model,
          status: 'ONLINE',
          lastSeen: now,
          firstSeen: now,
          connectionType: 'USB',
          capabilities: [
            `USB:${lp.connection}`,
            ...(lp.cupsName ? [`CUPS:${lp.cupsName}`] : []),
            ...(lp.cupsState ? [`STATE:${lp.cupsState}`] : []),
            ...(lp.usbVendorId ? [`VID:${lp.usbVendorId}`] : []),
            ...(lp.usbProductId ? [`PID:${lp.usbProductId}`] : []),
          ],
          cupsName: lp.cupsName,
          cupsUri: lp.cupsUri,
          cupsState: lp.cupsState,
          usbVendorId: lp.usbVendorId,
          usbProductId: lp.usbProductId,
          usbBusDevice: lp.usbBusDevice,
          macVendor: undefined,
        }
        // Don't upsert into the IP-keyed map (no real IP); emit directly.
        // Replace any existing LOCAL entry with the same id.
        const existingIdx = Array.from(devicesByIp.values()).findIndex((d) => d.id === lp.id)
        if (existingIdx >= 0) {
          // Find its IP key and replace
          for (const [k, v] of devicesByIp.entries()) {
            if (v.id === lp.id) { devicesByIp.set(k, device); break }
          }
        } else {
          devicesByIp.set(key, device)
        }
        cb.onDevice(device)
      }
    } catch { /* ignore */ }
  }
  emitProgress('local', totalIPs)

  // ── Phase 6: HTTP probe (LAST — after all richer metadata sources) ──
  // HTTP <title> is the LEAST reliable name signal (a CUPS server on :631 may
  // serve the host's default print-queue name, e.g. "Adobe PDF"). By running
  // HTTP last, devices already have their real name from mDNS/SSDP/UPnP, and
  // the name-quality scoring in upsertDevice() ensures the HTTP title only
  // replaces a placeholder — never a real self-advertised name.
  if (!cb.isAborted()) {
    emitProgress('http', 0)
    if (!protocolsUsed.includes('HTTP')) protocolsUsed.push('HTTP')
    // Probe each known IP on each SCAN_PORT
    const ips = Array.from(devicesByIp.keys())
    // Also probe all .1-.254 on each subnet if we didn't find many devices yet
    const allProbeIps = new Set<string>(ips)
    if (ips.length < 32) {
      for (const subnet of subnets) {
        for (let i = 1; i <= 254; i++) allProbeIps.add(`${subnet}.${i}`)
      }
    }
    const probeQueue: Array<{ ip: string; port: number }> = []
    for (const ip of allProbeIps) {
      for (const port of SCAN_PORTS) probeQueue.push({ ip, port })
    }

    let httpScanned = 0
    const totalHttp = probeQueue.length
    const workers = Array.from({ length: HTTP_CONCURRENCY }, async () => {
      while (probeQueue.length > 0) {
        if (cb.isAborted()) return
        const job = probeQueue.shift()
        if (!job) break
        const result = await httpProbe(job.ip, job.port, { isAborted: cb.isAborted })
        if (result) {
          upsertDevice(job.ip, {
            source: 'http_probe',
            port: job.port,
            httpUrl: `http://${job.ip}:${job.port}`,
            httpTitle: result.title,
            httpServer: result.server,
            httpStatus: result.status,
            capabilities: [`HTTP:${job.port}`],
          })
        }
        httpScanned++
        if (httpScanned % 32 === 0) {
          emitProgress('http', Math.floor((httpScanned / totalHttp) * totalIPs))
        }
      }
    })
    await Promise.all(workers)
  }
  emitProgress('http', totalIPs)

  // ── Phase 7: Fingerprinting (final pass) ──
  if (!cb.isAborted()) {
    emitProgress('fingerprinting', totalIPs)
    // Already fingerprinted during upsert; this phase is just visual.
  }

  // Final emit
  emitProgress('complete', totalIPs)
  return Array.from(devicesByIp.values())
}

function sourcePriority(s: DiscoverySource): number {
  switch (s) {
    case 'ssdp': return 5
    case 'mdns': return 4
    case 'http_probe': return 3
    case 'ping': return 2
    case 'arp': return 1
    case 'local': return 6  // CUPS queues are authoritative for local printers
    case 'usb': return 7    // USB probe is most authoritative
    default: return 0
  }
}

// ─── Protocol availability (for /discovery/protocols) ───────────────────────

export interface ProtocolAvailability {
  name: string
  status: 'available' | 'unavailable'
  description: string
}

export function getProtocolAvailability(): ProtocolAvailability[] {
  const isLinux = process.platform === 'linux'
  const isMac = process.platform === 'darwin'
  const isWin = process.platform === 'win32'
  return [
    {
      name: 'ARP',
      status: 'available',
      description: isLinux
        ? 'Reads /proc/net/arp for live host inventory'
        : 'Uses `arp -a` for live host inventory',
    },
    {
      name: 'Ping',
      status: 'available',
      description: `ICMP echo sweep with ${PING_CONCURRENCY} concurrent workers (${PING_TIMEOUT_MS}ms timeout)`,
    },
    {
      name: 'mDNS',
      status: 'available',
      description: `DNS-SD multicast on ${MDNS_ADDR}:${MDNS_PORT} (${MDNS_SERVICE_TYPES.length} service types incl. phones, TVs, printers)`,
    },
    {
      name: 'SSDP',
      status: 'available',
      description: `UPnP M-SEARCH on ${SSDP_ADDR}:${SSDP_PORT} with device description fetch`,
    },
    {
      name: 'rDNS/NBNS',
      status: 'available',
      description: 'Reverse-DNS (PTR) + NetBIOS Name Service (UDP 137) — resolves hostnames for ping-only devices that did not respond to mDNS/SSDP',
    },
    {
      name: 'DHCP',
      status: 'available',
      description: 'Reads dnsmasq.leases / dhcpd.leases — THE most reliable name source for Android phones (which do NOT advertise via mDNS)',
    },
    {
      name: 'HTTP',
      status: 'available',
      description: `Probes ports: ${SCAN_PORTS.join(', ')} (runs LAST so mDNS/SSDP/rDNS/DHCP names are not overwritten by HTTP titles)`,
    },
    {
      name: 'USB/CUPS',
      status: 'available',
      description: isLinux
        ? 'lpstat + lpinfo + lsusb — finds USB printers invisible to the network layer'
        : isMac
          ? 'lpstat + system_profiler SPUSBDataType — finds USB printers invisible to the network layer'
          : isWin
            ? 'PowerShell Get-Printer — finds local USB printers invisible to the network layer'
            : 'Local printer discovery via CUPS / USB enumeration',
    },
    {
      name: 'OUI-Lookup',
      status: 'available',
      description: 'MAC-address vendor fingerprinting (Apple, Samsung, Xiaomi, HP, Canon, Hisense, TCL, LG, …) for bare ARP entries. Also detects randomized MACs (Android 10+ / iOS 14+) and classifies them as phones.',
    },
    {
      name: 'UDP-BDP',
      status: 'unavailable',
      description: 'BLASTI UDP broadcast protocol — desktop app only (port 3081)',
    },
  ]
}
