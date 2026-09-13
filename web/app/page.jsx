import Hero from "./components/Hero";
import Wave from "./components/Wave";
import Problem from "./components/Problem";
import ChatDemo from "./components/ChatDemo";
import HowItWorks from "./components/HowItWorks";
import Features from "./components/Features";
import WhyOnchain from "./components/WhyOnchain";
import Footer from "./components/Footer";

export default function Home() {
  return (
    <main id="content">
      <Hero />
      <Wave from="var(--cream)" to="var(--paper)" />
      <Problem />
      <ChatDemo />
      <HowItWorks />
      <Features />
      <WhyOnchain />
      <Footer />
    </main>
  );
}
