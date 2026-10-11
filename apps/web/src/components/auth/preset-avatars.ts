'use client';

/**
 * Task 24 — preset profile icons: PEOPLE avatars.
 * Task 78 — extracted here so the desktop register form and the dedicated
 * mobile register form share ONE source of truth.
 *
 * Twelve ready-made "person" avatars (head-and-shoulders busts with varied
 * hairstyles, skin tones, clothing and accessories) built as compact SVG data
 * URIs. They are stored directly in `avatarUrl`, so they pass the server's
 * z.string().url() validation, render in every existing <img> (web, desktop
 * static export, mobile) with zero component changes, work offline, and stay
 * small enough for the JWT payload — no upload step needed for users who
 * don't want to upload a photo. (Task 23 shipped object glyphs; users asked
 * for people-style icons, so the whole set is illustrated people now.)
 */

type PersonSpec = {
  /** Background gradient stops */
  from: string;
  to: string;
  /** Skin tone */
  skin: string;
  /** Hair colour */
  hair: string;
  /** Clothing colour */
  cloth: string;
  /** Optional SVG drawn behind the torso (long hair, hijab hood, afro…) */
  back?: string;
  /** Optional fringe / top hair drawn over the head */
  top?: string;
  /** Optional extras drawn after the hair (beard, glasses, clip…) */
  extra?: string;
};

/** Shared face: two eyes + a warm smile. */
const PERSON_FACE =
  '<circle cx="43.5" cy="43.5" r="1.9" fill="#263238"/>' +
  '<circle cx="56.5" cy="43.5" r="1.9" fill="#263238"/>' +
  '<path d="M44.5 50.5c1.5 1.9 3.4 2.8 5.5 2.8s4-.9 5.5-2.8" fill="none" stroke="#263238" stroke-width="1.8" stroke-linecap="round"/>';

/** Short-hair crescent fringe (sits on the upper half of the head). */
function fringe(color: string): string {
  return `<path d="M33 44c0-10.5 7.6-18 17-18s17 7.5 17 18c-2.3-7.2-8.5-11.2-17-11.2S35.3 36.8 33 44z" fill="${color}"/>`;
}

/** Round glasses (white wire frames with a bridge). */
function glasses(): string {
  return (
    '<circle cx="43.5" cy="44" r="5.6" fill="none" stroke="#ffffff" stroke-width="1.9"/>' +
    '<circle cx="56.5" cy="44" r="5.6" fill="none" stroke="#ffffff" stroke-width="1.9"/>' +
    '<path d="M49.1 44h1.8" stroke="#ffffff" stroke-width="1.9"/>'
  );
}

export function buildPersonDataUri(s: PersonSpec): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${s.from}"/><stop offset="1" stop-color="${s.to}"/>` +
    `</linearGradient></defs>` +
    `<rect width="100" height="100" fill="url(#g)"/>` +
    (s.back || '') +
    // Torso — fills from the shoulders to the bottom edge.
    `<path d="M16 100c0-17 15-26.5 34-26.5s34 9.5 34 26.5z" fill="${s.cloth}"/>` +
    // Neck + head.
    `<rect x="43.5" y="55" width="13" height="14" rx="5.5" fill="${s.skin}"/>` +
    `<circle cx="50" cy="42" r="17" fill="${s.skin}"/>` +
    (s.top || '') +
    (s.extra || '') +
    PERSON_FACE +
    `</svg>`;
  // encodeURIComponent keeps the data URI valid inside an src attribute.
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

const PRESET_PEOPLE: PersonSpec[] = [
  // 1 — short dark hair + beard (man)
  {
    from: '#10b981', to: '#059669', skin: '#f6cfa8', hair: '#3a2e2a', cloth: '#065f46',
    top: fringe('#3a2e2a'),
    extra: '<path d="M34.5 45c0 11 6.5 17.5 15.5 17.5S65.5 56 65.5 45c-1.6 8.6-6.9 13-15.5 13S36.1 53.6 34.5 45z" fill="#3a2e2a"/>',
  },
  // 2 — long dark hair (woman)
  {
    from: '#f43f5e', to: '#e11d48', skin: '#e8b088', hair: '#47281f', cloth: '#9f1239',
    back: '<path d="M30 44c0-13 8.7-22.5 20-22.5S70 31 70 44v30h-40z" fill="#47281f"/>',
    top: fringe('#47281f'),
  },
  // 3 — curly hair + glasses (man)
  {
    from: '#f59e0b', to: '#d97706', skin: '#a8734b', hair: '#241b16', cloth: '#b45309',
    top: '<path d="M32.5 44c-1.5-13 6.5-21 17.5-21s19 8 17.5 21c-1.2-4.4-4.4-6.6-8-5.6-1.2-3.4-4.4-5.4-9.5-5.4-4.4 0-7.6 1.6-9.2 4.4-4.6-.6-7.1 2.4-8.3 6.6z" fill="#241b16"/>',
    extra: glasses(),
  },
  // 4 — hair bun (woman)
  {
    from: '#8b5cf6', to: '#7c3aed', skin: '#f6cfa8', hair: '#2e2320', cloth: '#6d28d9',
    top: fringe('#2e2320') + '<circle cx="50" cy="19.5" r="6.8" fill="#2e2320"/>',
  },
  // 5 — spiky hair (boy)
  {
    from: '#14b8a6', to: '#0f766e', skin: '#f6cfa8', hair: '#4a312c', cloth: '#0f766e',
    top: '<path d="M34 42l3-9 5.5 6L50 30l7.5 9 5.5-6 3 9c-3-7.5-8.7-11.2-16-11.2S37 34.5 34 42z" fill="#4a312c"/>',
  },
  // 6 — pigtails (girl)
  {
    from: '#06b6d4', to: '#0891b2', skin: '#e8b088', hair: '#3a2e2a', cloth: '#0e7490',
    back: '<circle cx="27" cy="47" r="7.5" fill="#3a2e2a"/><circle cx="73" cy="47" r="7.5" fill="#3a2e2a"/>',
    top: fringe('#3a2e2a'),
  },
  // 7 — bald + full beard (man)
  {
    from: '#f97316', to: '#ea580c', skin: '#c98850', hair: '#4a312c', cloth: '#c2410c',
    extra: '<path d="M34 45.5c0 11.5 6.7 18 16 18s16-6.5 16-18c-1.8 9.2-7.2 13.8-16 13.8S35.8 54.7 34 45.5z" fill="#4a312c"/>',
  },
  // 8 — hijab (woman)
  {
    from: '#d946ef', to: '#c026d3', skin: '#e8b088', hair: '#86198f', cloth: '#86198f',
    back: '<path d="M50 17.5c-13.8 0-21.5 9.8-21.5 23.5 0 7.2 2.6 13.4 6.3 17.5h30.4c3.7-4.1 6.3-10.3 6.3-17.5 0-13.7-7.7-23.5-21.5-23.5z" fill="#86198f"/>',
    extra: '<path d="M36.5 56h27c-2.6 3.6-7.3 5.8-13.5 5.8S39.1 59.6 36.5 56z" fill="#86198f"/>',
  },
  // 9 — grey hair + glasses (elder man)
  {
    from: '#64748b', to: '#475569', skin: '#f6cfa8', hair: '#cbd5e1', cloth: '#334155',
    top: fringe('#cbd5e1'),
    extra: glasses(),
  },
  // 10 — bob cut (woman)
  {
    from: '#84cc16', to: '#65a30d', skin: '#a8734b', hair: '#1f1a17', cloth: '#4d7c0f',
    back: '<path d="M31 45c0-13.5 8.3-23 19-23s19 9.5 19 23v9.5c0 2.5-1 4.5-2.5 6h-33c-1.5-1.5-2.5-3.5-2.5-6z" fill="#1f1a17"/>',
    top: fringe('#1f1a17'),
  },
  // 11 — afro (man)
  {
    from: '#ef4444', to: '#dc2626', skin: '#7c4a32', hair: '#17110d', cloth: '#991b1b',
    back: '<circle cx="50" cy="31" r="15.5" fill="#17110d"/>',
    top: '<path d="M33.5 42c1.5-8 7-12.5 16.5-12.5S65 34 66.5 42c-2.6-5.6-8.2-8.4-16.5-8.4S36.1 36.4 33.5 42z" fill="#17110d"/>',
  },
  // 12 — long hair + golden clip (woman)
  {
    from: '#22c55e', to: '#16a34a', skin: '#f6cfa8', hair: '#6b4423', cloth: '#15803d',
    back: '<path d="M30 44c0-13 8.7-22.5 20-22.5S70 31 70 44v30h-40z" fill="#6b4423"/>',
    top: fringe('#6b4423'),
    extra: '<rect x="59.5" y="28.5" width="9" height="4.6" rx="2.3" fill="#fbbf24" transform="rotate(-18 64 30.8)"/>',
  },
];

export const PRESET_AVATARS: string[] = PRESET_PEOPLE.map(buildPersonDataUri);

