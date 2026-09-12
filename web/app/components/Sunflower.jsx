/**
 * Kepala bunga matahari, SVG inline. Dipakai sebagai penanda bagian dan
 * butir daftar. Inline, bukan file, supaya warnanya ikut token CSS dan
 * tidak ada permintaan jaringan tambahan.
 */
export default function Sunflower({ size = 28, className = "" }) {
  const petals = Array.from({ length: 12 }, (_, i) => i * 30);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {petals.map((deg) => (
        <ellipse
          key={deg}
          cx="50"
          cy="22"
          rx="8"
          ry="20"
          fill="var(--sun-400)"
          transform={`rotate(${deg} 50 50)`}
        />
      ))}
      <circle cx="50" cy="50" r="18" fill="var(--ink)" />
      <circle cx="50" cy="50" r="12" fill="var(--sun-600)" />
    </svg>
  );
}
