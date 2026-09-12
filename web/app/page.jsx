import Hero from "./components/Hero";
import HowItWorks from "./components/HowItWorks";
import Gingham from "./components/Gingham";

export default function Home() {
  return (
    <main>
      <Hero />
      <Gingham />
      <HowItWorks />
      <Gingham />
    </main>
  );
}
