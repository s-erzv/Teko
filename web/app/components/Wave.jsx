/**
 * Pembatas gelombang antar bagian. Menggantikan pita titik-titik: batas
 * lurus bikin hero terasa seperti kotak yang dipotong, lengkung lembut
 * bikin peralihannya mengalir.
 *
 * `from` = warna yang sedang ditinggalkan (bagian atas), `to` = warna
 * bagian bawah. Keduanya token CSS, bukan hex mentah.
 */
export default function Wave({ from = "var(--sun-300)", to = "var(--paper)" }) {
  return (
    <div className="wave" aria-hidden="true" style={{ background: from }}>
      <svg viewBox="0 0 1440 90" preserveAspectRatio="none">
        <path
          d="M0 46c120-30 240-38 360-22s240 52 360 52 240-36 360-52 240-8 360 22v44H0z"
          fill={to}
        />
      </svg>
    </div>
  );
}
