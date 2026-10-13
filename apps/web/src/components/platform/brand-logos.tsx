'use client';

/**
 * Brand logo SVGs for the download UIs (landing page header/hero + the
 * "BLASTI on Every Device" section).
 *
 * Why hand-rolled SVGs instead of icon-font/lucide: lucide has no store
 * logos, and the download buttons must carry the REAL App Store / Google
 * Play marks so users recognize them instantly. All paths below are the
 * CC0 simple-icons geometries (or simple original constructions), sized for
 * 16–24px inline use, and inherit `currentColor` unless the mark is
 * inherently multi-colored (Google Play).
 */

interface BrandLogoProps {
  className?: string;
}

/** Apple mark (simple-icons geometry, CC0) — monochrome, inherits currentColor. */
export function AppleLogo({ className = 'h-4 w-4' }: BrandLogoProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true" focusable="false">
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.56-1.701" />
    </svg>
  );
}

/** Android robot head (simple-icons geometry, CC0) — monochrome, inherits currentColor. */
export function AndroidLogo({ className = 'h-4 w-4' }: BrandLogoProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true" focusable="false">
      <path d="M17.523 15.3414c-.5511 0-.9993-.4486-.9993-.9997s.4482-.9993.9993-.9993c.5511 0 .9993.4482.9993.9993.0001.5511-.4482.9997-.9993.9997m-11.046 0c-.5511 0-.9993-.4486-.9993-.9997s.4482-.9993.9993-.9993c.5511 0 .9996.4482.9996.9993 0 .5511-.4485.9997-.9996.9997m11.4045-6.02l1.9973-3.4592a.416.416 0 00-.1521-.5676.416.416 0 00-.5676.1521l-2.0223 3.503C15.5902 8.2439 13.8533 7.8508 12 7.8508s-3.5902.3931-5.1367 1.0989L4.841 5.4467a.4161.4161 0 00-.5677-.1521.4157.4157 0 00-.1521.5676l1.9973 3.4592C2.6889 11.1867.3432 14.6589 0 18.761h24c-.3435-4.1021-2.6892-7.5743-6.1185-9.4396" />
    </svg>
  );
}

/** Windows mark — four panes, official blue, fixed colors. */
export function WindowsLogo({ className = 'h-4 w-4' }: BrandLogoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
      <path fill="#0078D4" d="M0 3.449L9.75 2.1v9.451H0zm10.949-1.5L23.999 0v11.4H10.949zM0 12.6h9.75v9.451L0 20.699zM10.949 12.6H24V24l-13.051-1.851z" />
    </svg>
  );
}

/** Google Play mark — the classic four-color play triangle. */
export function GooglePlayLogo({ className = 'h-4 w-4' }: BrandLogoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
      {/* Left body — blue */}
      <path fill="#00C4FF" d="M3.6 1.9c-.36.19-.6.57-.6 1.05v18.1c0 .48.24.86.6 1.05L13.7 12 3.6 1.9z" />
      {/* Top wedge — green */}
      <path fill="#00E85D" d="M3.6 1.9c.3-.16.7-.17 1.06.03l12.02 6.77-3 3.1L3.6 1.9z" />
      {/* Bottom wedge — red */}
      <path fill="#FF3A44" d="M3.6 22.1c.3.16.7.17 1.06-.03l12.02-6.77-3-3.1L3.6 22.1z" />
      {/* Right tip — yellow */}
      <path fill="#FFBC00" d="M16.68 8.7l3.42 1.93c.94.53.94 1.74 0 2.27l-3.42 1.93-3.15-3.06 3.15-3.07z" />
    </svg>
  );
}

/** Linux (Tux) — simplified penguin silhouette, monochrome, inherits currentColor. */
export function LinuxLogo({ className = 'h-4 w-4' }: BrandLogoProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true" focusable="false">
      <path d="M12.004.688c-2.55 0-4.072 1.796-4.072 4.427 0 1.9.664 3.264 1.473 4.355-.27.62-.67 1.135-1.332 1.456-1.352.655-2.61 1.24-3.44 2.19-.894 1.02-1.383 2.33-1.383 4.02 0 .14.007.28.015.42.02.31.28.55.59.55h.06c.33-.03.57-.32.55-.65a6.5 6.5 0 01-.015-.32c0-1.44.397-2.51 1.12-3.34.66-.75 1.72-1.28 3.02-1.91 1.1-.53 1.83-1.38 2.2-2.42.71.7 1.45 1.24 1.98 1.61.31.22.73.14.95-.17.21-.31.14-.73-.17-.95-.87-.61-2.11-1.65-2.98-2.94-.86-1.28-1.44-2.44-1.44-3.95 0-2.06 1.05-3.33 2.98-3.33s2.98 1.27 2.98 3.33c0 1.51-.58 2.67-1.44 3.95-.87 1.29-2.11 2.33-2.98 2.94a.686.686 0 00-.17.95c.22.31.64.39.95.17.53-.37 1.27-.91 1.98-1.61.37 1.04 1.1 1.89 2.2 2.42 1.3.63 2.36 1.16 3.02 1.91.72.83 1.12 1.9 1.12 3.34 0 .11-.005.21-.015.32a.578.578 0 00.55.65h.06c.31 0 .57-.24.59-.55.008-.14.015-.28.015-.42 0-1.69-.49-3-1.383-4.02-.83-.95-2.088-1.535-3.44-2.19-.662-.321-1.062-.836-1.332-1.456.809-1.09 1.473-2.455 1.473-4.355 0-2.631-1.522-4.427-4.072-4.427z" transform="translate(0 1.7) scale(0.85)" />
      <path d="M8.6 21.2c0 .9 1.52 1.62 3.4 1.62s3.4-.72 3.4-1.62-1.52-1.62-3.4-1.62-3.4.72-3.4 1.62z" opacity=".55" />
    </svg>
  );
}
