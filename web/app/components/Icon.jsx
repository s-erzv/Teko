/**
 * Set ikon garis minimal, dipakai di dalam chip lingkaran (step & feature
 * card). Line icon, bukan ilustrasi -- sengaja generik/geometris supaya
 * tidak menyaingi tipografi & motif tiket sebagai elemen visual utama.
 */
const PATHS = {
  users: (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M2.5 19c0-3.6 2.9-6 5.5-6s5.5 2.4 5.5 6" />
      <circle cx="16.5" cy="8.5" r="2.4" />
      <path d="M15 13c2.4.2 4.5 2.3 4.5 5.6" />
    </>
  ),
  link: (
    <>
      <path d="M9.5 14.5l5-5" />
      <path d="M8 15.5l-1.8 1.8a3.2 3.2 0 0 1-4.5-4.5L4.5 10" />
      <path d="M16 9.5l1.8-1.8a3.2 3.2 0 0 0-4.5-4.5L11.5 5" />
    </>
  ),
  shuffle: (
    <>
      <path d="M3 6h3.5c2 0 3 1 4 2.5l3 5c1 1.5 2 2.5 4 2.5H21" />
      <path d="M17.5 3.5 21 6l-3.5 2.5" />
      <path d="M3 18h3.5c2 0 3-1 4-2.5" />
      <path d="M17.5 20.5 21 18l-3.5-2.5" />
    </>
  ),
  wallet: (
    <>
      <rect x="3" y="6.5" width="18" height="12" rx="2.5" />
      <path d="M3 10h18" />
      <circle cx="16.5" cy="14" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  shield: (
    <path d="M12 3.5 19 6v5.5c0 4.3-3 7.4-7 9-4-1.6-7-4.7-7-9V6l7-2.5Z" />
  ),
  cube: (
    <>
      <path d="M12 3.5 19.5 8 12 12.5 4.5 8 12 3.5Z" />
      <path d="M4.5 8v8l7.5 4.5" />
      <path d="M19.5 8v8L12 20.5" />
      <path d="M12 12.5V20.5" />
    </>
  ),
  lock: (
    <>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
      <path d="M7.5 10.5V7a4.5 4.5 0 0 1 9 0v3.5" />
    </>
  ),
  spark: (
    <path d="M11 2 12.4 8.6 19 10 12.4 11.4 11 18 9.6 11.4 3 10 9.6 8.6 11 2Z" />
  ),
  flower: (
    <>
      <circle cx="8" cy="8" r="2.5" />
      <path d="M15 4a2.6 2.6 0 0 1 2.6 2.6c0 2.8-4.6 4.4-4.6 4.4s-.6-5 2-7z" />
    </>
  ),
  chat: (
    <path d="M4 5.5h14a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H10l-4 3.5V15.5H4A1.5 1.5 0 0 1 2.5 14V7A1.5 1.5 0 0 1 4 5.5Z" />
  ),
  bell: (
    <>
      <path d="M6 9.5a5 5 0 0 1 10 0c0 4 1.5 5.5 1.5 5.5h-13S6 13.5 6 9.5Z" />
      <path d="M9.5 18a2 2 0 0 0 4 0" />
    </>
  ),
  vote: (
    <>
      <path d="M4 10.5 9 6l5 4.5" />
      <path d="M6 10v8h6v-8" />
      <path d="M14 20h6" />
      <path d="M17 20v-6l3 2.5" />
    </>
  ),
  refresh: (
    <>
      <path d="M4 11a7.5 7.5 0 0 1 12.8-5.3L19 7.5" />
      <path d="M19 4v3.5h-3.5" />
      <path d="M19 12a7.5 7.5 0 0 1-12.8 5.3L4 15.5" />
      <path d="M4 19v-3.5h3.5" />
    </>
  ),
};

const FILLED = new Set(["spark", "flower"]);

export default function Icon({ name, size = 18, className = "" }) {
  const paths = PATHS[name];
  if (!paths) return null;
  const filled = FILLED.has(name);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 22 22"
      className={className}
      aria-hidden="true"
      focusable="false"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={filled ? 0 : 1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths}
    </svg>
  );
}
