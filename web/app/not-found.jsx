import Logo from "./components/Logo";

/**
 * Netlify menyajikan berkas ini untuk setiap URL yang tidak ada. Tanpa
 * halaman ini, yang muncul adalah 404 bawaan Next: tanpa tema sama sekali.
 */
export const metadata = {
  title: "Page not found — Teko",
};

export default function NotFound() {
  return (
    <main className="goldenhour notfound" id="content">
      <div className="wrap">
        <Logo size={56} />
        <h1>This page doesn&rsquo;t exist.</h1>
        <p className="lead">
          Maybe the link&rsquo;s mistyped, or the page has moved. Everything
          else is still running.
        </p>
        <div className="btn-row">
          <a className="btn btn-primary" href="/">
            Back to home
          </a>
        </div>
      </div>
    </main>
  );
}
