import Hero from "./components/Hero";
import HowItWorks from "./components/HowItWorks";
import WhyOnchain from "./components/WhyOnchain";
import Footer from "./components/Footer";
import Gingham from "./components/Gingham";

export default function Home() {
  return (
    <main id="konten">
      <Hero />
      <Gingham />
      <HowItWorks />
      <Gingham />
      <WhyOnchain />
      <Footer />
    </main>
  );
}
