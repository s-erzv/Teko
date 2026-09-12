import Sunflower from "./components/Sunflower";

/**
 * Netlify menyajikan berkas ini untuk setiap URL yang tidak ada. Tanpa
 * halaman ini, yang muncul adalah 404 bawaan Next: teks bahasa Inggris
 * tanpa tema sama sekali, di situs yang seluruhnya berbahasa Indonesia.
 */
export const metadata = {
  title: "Halaman nggak ketemu — Teko",
};

export default function NotFound() {
  return (
    <main className="goldenhour notfound" id="konten">
      <div className="wrap">
        <Sunflower size={56} />
        <h1>Wah, halamannya nggak ada.</h1>
        <p className="lead">
          Mungkin tautannya salah ketik, atau halamannya sudah pindah.
          Piknik masih jalan, kok.
        </p>
        <div className="btn-row">
          <a className="btn btn-primary" href="/">
            Balik ke depan
          </a>
        </div>
      </div>
    </main>
  );
}
