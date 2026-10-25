import { useEffect, useState } from "react";

import { AccessProvider } from "./components/AccessModal";
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
import { DocsPage, PrivacyPage, TermsPage } from "./pages/StaticPages";

type Route = "docs" | "privacy" | "terms" | null;

function routeFromHash(hash: string): Route {
  const value = hash.replace(/^#/, "");
  if (value === "/docs") return "docs";
  if (value === "/privacy") return "privacy";
  if (value === "/terms") return "terms";
  return null;
}

function Landing() {
  return (
    <>
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
    </>
  );
}

function Shell() {
  const [route, setRoute] = useState<Route>(() => routeFromHash(window.location.hash));

  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (route) {
      window.scrollTo(0, 0);
      return;
    }
    // Back on the landing page: honor any section anchor in the hash.
    const id = window.location.hash.replace(/^#/, "");
    if (id && !id.startsWith("/")) {
      requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView());
    }
  }, [route]);

  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[110] focus:rounded-md focus:bg-accent focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-ink"
      >
        Skip to content
      </a>

      <Navbar />
      <main id="main">
        {route === "docs" && <DocsPage />}
        {route === "privacy" && <PrivacyPage />}
        {route === "terms" && <TermsPage />}
        {!route && <Landing />}
      </main>
      <Footer />
    </>
  );
}

export default function App() {
  return (
    <AccessProvider>
      <Shell />
    </AccessProvider>
  );
}
