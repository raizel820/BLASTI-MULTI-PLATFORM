#!/usr/bin/env python3
"""
rtl-fixes.py — Task B2: replace physical direction utilities with logical
ones (or direction-safe centering) on LIVE files. Exact-match replacements;
each entry asserts an expected count so drift fails loudly.
"""
import sys

BASE = "/home/z/my-project/apps/web/src/"

# (file, old, new, expected_count)
FIXES = [
    # A1: Best Value badge over-constrained centering (RTL hangs off edge)
    ("components/customer/profile/profile-sms-wallet.tsx",
     'absolute -top-2.5 start-1/2 left-1/2 -translate-x-1/2',
     'absolute -top-2.5 left-1/2 -translate-x-1/2', 1),
    # A3: dropdown-menu — item padding + indicator + shortcut + submenu chevron
    ("components/ui/dropdown-menu.tsx",
     'rounded-sm py-1.5 pr-2 pl-8 text-sm',
     'rounded-sm py-1.5 pe-2 ps-8 text-sm', 2),
    ("components/ui/dropdown-menu.tsx",
     'pointer-events-none absolute left-2 flex size-3.5',
     'pointer-events-none absolute start-2 flex size-3.5', 2),
    ("components/ui/dropdown-menu.tsx",
     'data-[inset]:pl-8',
     'data-[inset]:ps-8', 3),
    ("components/ui/dropdown-menu.tsx", 'ml-auto', 'ms-auto', 2),
    ("components/ui/dropdown-menu.tsx",
     '<ChevronRightIcon className="ms-auto size-4" />',
     '<ChevronRightIcon className="ms-auto size-4 rtl:rotate-180" />', 1),
    # A4: select — chevron belongs at inline-end, text padded at start
    ("components/ui/select.tsx",
     'rounded-sm py-1.5 pr-8 pl-2 text-sm',
     'rounded-sm py-1.5 pe-8 ps-2 text-sm', 1),
    ("components/ui/select.tsx",
     'absolute right-2 flex size-3.5',
     'absolute end-2 flex size-3.5', 1),
    # A5: command shortcut
    ("components/ui/command.tsx", 'ml-auto', 'ms-auto', 1),
    # A6: queue-timeline peak-zone overlays must track the flipped bar
    ("components/agency/dashboard/queue-timeline.tsx",
     'left-[10%]', 'start-[10%]', 1),
    ("components/agency/dashboard/queue-timeline.tsx",
     'left-[60%]', 'start-[60%]', 1),
    # A7/A8: kiosk pairing cards text alignment
    ("components/devices/kiosk/kiosk-discovery-login.tsx",
     'text-left', 'text-start', 3),
    # A11: dialog / alert-dialog footers
    ("components/ui/dialog.tsx", 'sm:text-left', 'sm:text-start', 1),
    ("components/ui/alert-dialog.tsx", 'sm:text-left', 'sm:text-start', 1),
    # B12: active-nav pill rounded side
    ("components/platform/adaptive-sidebar.tsx",
     'rounded-r-full', 'rounded-e-full', 3),
    # B13: QR scan-frame corners track the logical border edges
    ("components/devices/device-qr-scanner.tsx",
     'rounded-tl-3xl', 'rounded-ss-3xl', 1),
    ("components/devices/device-qr-scanner.tsx",
     'rounded-tr-3xl', 'rounded-se-3xl', 1),
    ("components/devices/device-qr-scanner.tsx",
     'rounded-bl-3xl', 'rounded-es-3xl', 1),
    ("components/devices/device-qr-scanner.tsx",
     'rounded-br-3xl', 'rounded-ee-3xl', 1),
    ("components/customer/customer-qr-scanner.tsx",
     'rounded-tl-2xl', 'rounded-ss-2xl', 1),
    ("components/customer/customer-qr-scanner.tsx",
     'rounded-tr-2xl', 'rounded-se-2xl', 1),
    ("components/customer/customer-qr-scanner.tsx",
     'rounded-bl-2xl', 'rounded-es-2xl', 1),
    ("components/customer/customer-qr-scanner.tsx",
     'rounded-br-2xl', 'rounded-ee-2xl', 1),
    # B15: auto-dismiss progress bar origin
    ("components/agency/dashboard/ticket-confirmation.tsx",
     'origin-left', 'origin-left rtl:origin-right', 1),
    # B16: sound toggle position
    ("components/customer/AggressiveTurnAlert.tsx",
     'absolute top-6 right-6', 'absolute top-6 end-6', 1),
    # B17/B21: kiosk badge + wifi icon
    ("components/devices/device-kiosk.tsx",
     'fixed bottom-4 left-4', 'fixed bottom-4 end-4', 1),
    ("components/devices/device-kiosk.tsx",
     'className="h-3 w-3 ml-1"', 'className="h-3 w-3 me-1"', 2),
    # B18: agency-devices menu icons
    ("components/agency/agency-devices.tsx",
     'className="h-4 w-4 mr-2"', 'className="h-4 w-4 me-2"', 5),
    # B19: device-dialogs status dot
    ("components/agency/devices/device-dialogs.tsx",
     'mr-1', 'me-1', 1),
    # B20: kiosk ticket screen icons
    ("components/devices/kiosk/kiosk-ticket-display.tsx",
     'className="h-4 w-4 inline mr-1"', 'className="h-4 w-4 inline me-1"', 1),
    ("components/devices/kiosk/kiosk-ticket-display.tsx",
     'ml-2', 'ms-2', 1),
    # B22: walk-in badge
    ("components/agency/agency-fullscreen-history.tsx",
     'ml-2', 'ms-2', 1),
    # B26: calendar range edges
    ("components/ui/calendar.tsx", 'rounded-l-md', 'rounded-s-md', 3),
    ("components/ui/calendar.tsx", 'rounded-r-md', 'rounded-e-md', 3),
]

# B31: centered decorative halos — `start-1/2 -translate-x-1/2` shifts by the
# full width in RTL (right:50% + left shift). Physical centering is neutral.
HALO_FILES = {
    "components/shared/empty-state.tsx": 2,
    "components/shared/payment-result.tsx": 3,
    "components/customer/queue/QueueEmptyState.tsx": 2,
    "components/customer/customer-home.tsx": 1,
    "components/customer/customer-queue.tsx": 1,
    "components/auth/landing-page.tsx": 3,
}
for f, n in HALO_FILES.items():
    FIXES.append((f, 'start-1/2 -translate-x-1/2', 'left-1/2 -translate-x-1/2', n))

errors = 0
applied_before = 0
for f, old, new, expected in FIXES:
    path = BASE + f
    try:
        src = open(path, encoding="utf-8").read()
    except FileNotFoundError:
        print(f"MISSING FILE: {f}")
        errors += 1
        continue
    n = src.count(old)
    if n == 0 and new in src:
        applied_before += 1  # already fixed in a previous run
        continue
    if n != expected:
        print(f"COUNT MISMATCH: {f}: '{old[:50]}' expected {expected}, found {n}")
        errors += 1
        continue
    open(path, "w", encoding="utf-8").write(src.replace(old, new))
    print(f"OK ({expected:2d}x) {f}: {old[:44]!r}")

print(f"\n{'FAILED: ' + str(errors) if errors else 'ALL RTL FIXES APPLIED'} ({len(FIXES)} replacements)")
sys.exit(1 if errors else 0)
