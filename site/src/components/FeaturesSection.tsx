import {
  Boxes,
  History,
  ListChecks,
  Repeat,
  Search,
  ShieldCheck,
  Terminal,
  Workflow,
  type LucideIcon,
} from "lucide-react";

import { features } from "../data/site";
import { Reveal, Section, container } from "./Section";

const featureIcons: Record<string, LucideIcon> = {
  "Repository-aware": Search,
  "Multi-file changes": Boxes,
  "Sandboxed execution": Terminal,
  "Autonomous debugging": Repeat,
  "Repair loops": ListChecks,
  Verification: ShieldCheck,
  Sessions: Workflow,
  "Execution history": History,
};

export function FeaturesSection() {
  return (
    <Section id="features" labelledBy="features-heading" className="py-20 sm:py-24">
      <div className={container}>
        <Reveal>
          <h2 id="features-heading" className="text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
            What Kodevra handles.
          </h2>
        </Reveal>

        <div className="mt-12 grid gap-x-10 gap-y-1 sm:grid-cols-2 lg:grid-cols-4">
          {features.map((feature, index) => {
            const Icon = featureIcons[feature.title] ?? Search;
            return (
              <Reveal key={feature.title} delay={Math.min(index * 0.05, 0.25)}>
                <div className="group h-full border-t border-line py-6 transition-colors duration-200 hover:border-t-accent/60">
                  <Icon
                    size={18}
                    aria-hidden="true"
                    className="text-muted transition-colors duration-200 group-hover:text-accent"
                  />
                  <h3 className="mt-4 font-medium text-fg">{feature.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{feature.description}</p>
                </div>
              </Reveal>
            );
          })}
        </div>
      </div>
    </Section>
  );
}
