import { Navbar } from "./components/Navbar";
import { Hero } from "./components/Hero";
import { WorkflowSection } from "./components/WorkflowSection";
import { ComparisonSection } from "./components/ComparisonSection";
import { ResultPanel } from "./components/ResultPanel";
import { SecuritySection } from "./components/SecuritySection";
import { FeaturesSection } from "./components/FeaturesSection";
import { UseCases } from "./components/UseCases";
import { PricingSection } from "./components/PricingSection";
import { TargetUsers } from "./components/TargetUsers";
import { FinalCTA } from "./components/FinalCTA";
import { Footer } from "./components/Footer";

export default function App() {
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-md focus:bg-accent focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-ink"
      >
        Skip to content
      </a>

      <Navbar />
      <main id="main">
        <Hero />
        <WorkflowSection />
        <ComparisonSection />
        <ResultPanel />
        <SecuritySection />
        <FeaturesSection />
        <UseCases />
        <PricingSection />
        <TargetUsers />
        <FinalCTA />
      </main>
      <Footer />
    </>
  );
}
