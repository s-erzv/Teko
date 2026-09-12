import Sunflower from "./components/Sunflower";
import Gingham from "./components/Gingham";

export default function Home() {
  return (
    <main>
      <section className="goldenhour section">
        <div className="wrap">
          <Sunflower size={64} />
          <div className="card" style={{ marginTop: 24 }}>
            Kartu di atas golden hour.
          </div>
        </div>
      </section>
      <Gingham />
    </main>
  );
}
