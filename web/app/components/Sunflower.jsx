/**
 * Bunga matahari, dipakai sebagai penanda heading & hiasan kecil. Terpisah
 * dari Logo (huruf T Teko) yang tetap jadi identitas resmi di navbar --
 * ini murni ornamen tema piknik. Inline SVG supaya warnanya ikut token CSS.
 */
const PETALS = Array.from({ length: 12 }, (_, i) => i * 30);

export default function Sunflower({ size = 26, className = "" }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {PETALS.map((deg) => (
        <ellipse
          key={deg}
          cx="24"
          cy="9.6"
          rx="4.4"
          ry="8"
          fill="var(--sun-400)"
          transform={`rotate(${deg} 24 24)`}
        />
      ))}
      <circle cx="24" cy="24" r="8.4" fill="var(--ink)" />
      <circle cx="21.4" cy="21.6" r="1.5" fill="var(--sun-500)" opacity="0.5" />
    </svg>
  );
}
