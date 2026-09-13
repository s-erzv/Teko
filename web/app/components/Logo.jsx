/**
 * Mark resmi Teko (public/logo.png). Dipakai berdampingan dengan teks
 * (wordmark, heading section) makanya decorative -- teks di sebelahnya
 * yang membawa makna, bukan gambarnya.
 */
const ASPECT = 525 / 487;

export default function Logo({ size = 28, className = "" }) {
  return (
    <img
      src="/logo.png"
      alt=""
      aria-hidden="true"
      width={size}
      height={Math.round(size * ASPECT)}
      className={className}
      style={{ width: size, height: "auto" }}
    />
  );
}
