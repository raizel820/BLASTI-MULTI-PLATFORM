# Task ID: 2 - Full-Stack Developer (UI Refactoring)

## Task
Refactor agency-devices.tsx (4307 lines) into clean, focused sub-components.

## Work Done

### Files Created
1. **`/apps/web/src/components/agency/devices/types.tsx`** (495 lines)
   - All type definitions (AgencyDevice, DiscoveredDevice, Branch, DisplaySettings, DeviceCommand, etc.)
   - All config constants (DEVICE_TYPE_CONFIG, STATUS_CONFIG, CONNECTION_TYPE_CONFIG, SCREEN_LAYOUT_CONFIG, COMMAND_TYPE_CONFIG, COMMAND_STATUS_CONFIG)
   - API_BASE, PORT_Q, HEARTBEAT_THRESHOLD_MS, PAIRING_EXPIRE_MS constants
   - All helper functions (parseDisplaySettings, isRecentlyAlive, getHeartbeatLabel, formatUptime, timeSince, formatDiscoveryLastSeen, getConnectionQuality, getLocalizedName, getLocalizedString, getLocalizedLabel)
   - Animation variants (fadeUp, staggerContainer, staggerItem)
   - Sub-components: PulseDot, StatusDot, HeartbeatIndicator, ConnectionQualityBar, ScreenLayoutIcon
   - useHeartbeatTick hook
   - initDeviceTypeIcons() function for runtime icon assignment

2. **`/apps/web/src/components/agency/devices/network-discovery-panel.tsx`** (400 lines)
   - NetworkDiscoveryPanel component with scan button, auto-scan toggle
   - Pairing devices section (highlighted with dashed border)
   - Devices grouped by type (KIOSK, TV, PRINTER) with register/connect buttons
   - Scanning skeleton and empty states
   - Printer test functionality

3. **`/apps/web/src/components/agency/devices/device-card.tsx`** (434 lines)
   - DeviceCard component with status bar, type/status badges, heartbeat, uptime, connection info
   - Quick action buttons (edit, pair, command, refresh, enable/disable, delete, TV preview, kiosk credentials)
   - DeviceGrid wrapper with loading skeletons, error state, empty state
   - Proper TooltipProvider usage for action button tooltips

4. **`/apps/web/src/components/agency/devices/device-detail-sheet.tsx`** (436 lines)
   - DeviceDetailSheet with 3 tabs: Info, Config, Commands
   - Info tab: status, connection, heartbeat, connection quality, details grid, pairing code, device token
   - Config tab: display settings JSON, print config, service filter, auto discovery, timestamps
   - Commands tab: send command button, command history list with status badges

5. **`/apps/web/src/components/agency/devices/device-dialogs.tsx`** (1831 lines)
   - Shared DeviceFormFields component (reused by Add and Edit dialogs)
   - AddDeviceDialog with token display after creation
   - EditDeviceDialog with status toggle and display settings editor
   - PairDeviceDialog with pairing code display, timer, QR placeholder, instructions
   - CommandDialog with type selector and JSON payload editor
   - DeleteConfirmDialog
   - RebootConfirmDialog
   - KioskCredentialsDialog with regenerate functionality
   - CreateKioskDialog with credentials result display
   - TvPreviewDialog with iframe preview and connection guide
   - TvQrDialog with QR code generation
   - ScanResultsDialog with progress bar and discovered device list

### File Modified
- **`/apps/web/src/components/agency/agency-devices.tsx`** — reduced from 4307 to 925 lines
  - Clean orchestrator importing all sub-components
  - State management, data fetching, event handlers preserved
  - Layout composition: Header → Stats → NetworkDiscoveryPanel → DeviceGrid → DeviceDetailSheet → All Dialogs
  - No functionality removed or changed

## Verification
- ESLint: 0 errors, 0 warnings
- Dev server: compiles successfully, no runtime errors
- Page import unchanged (lazy import from '@/components/agency/agency-devices')
