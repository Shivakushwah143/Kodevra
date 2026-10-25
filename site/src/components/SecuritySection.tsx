import { ChevronDown, ChevronRight, Info } from "lucide-react";

import { securityChain, securityPoints } from "../data/site";
import { Reveal, Section, container } from "./Section";

export function SecuritySection() {
  return (
    <Section id="security" labelledBy="security-heading" className="py-20 sm:py-24">
      <div className={container}>
        <Reveal>
          <h2
            id="security-heading"
            className="max-w-[24ch] text-3xl font-semibold tracking-[-0.02em] sm:text-4xl"
          >
            Autonomous, without being careless.
          </h2>
          <p className="mt-5 max-w-[62ch] text-lg leading-relaxed text-muted">
            Powerful coding agents need boundaries. Kodevra is designed around controlled execution, scoped
            workspaces, and explicit verification.
          </p>
        </Reveal>

        <Reveal delay={0.1}>
          <ol
            aria-label="How Kodevra stays in control"
            className="mt-12 flex flex-col items-start gap-2 lg:flex-row lg:flex-wrap lg:items-center lg:gap-3"
          >
            {securityChain.map((node, index) => (
              <li key={node} className="flex items-center gap-2 lg:gap-3">
                <span className="rounded border border-line bg-surface px-3.5 py-2 font-mono text-xs text-fg">
                  {node}
                </span>
                {index < securityChain.length - 1 && (
                  <>
                    <ChevronDown size={14} aria-hidden="true" className="text-muted/70 lg:hidden" />
                    <ChevronRight size={14} aria-hidden="true" className="hidden text-muted/70 lg:block" />
                  </>
                )}
              </li>
            ))}
          </ol>
        </Reveal>

        <div className="mt-16 grid gap-x-12 gap-y-8 sm:grid-cols-2">
          {securityPoints.map((point, index) => (
            <Reveal key={point.title} delay={Math.min(index * 0.05, 0.2)}>
              <div className="border-t border-line pt-5">
                <h3 className="font-medium text-fg">{point.title}</h3>
                <p className="mt-2 max-w-[52ch] text-sm leading-relaxed text-muted">{point.description}</p>
              </div>
            </Reveal>
          ))}
        </div>

        <Reveal delay={0.1}>
          <p className="mt-12 flex max-w-[70ch] items-start gap-3 rounded-md border border-line bg-surface/60 px-4 py-3.5 text-xs leading-relaxed text-muted">
            <Info size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-muted" />
            Sandboxing reduces execution risk; no software environment should be described as perfectly
            isolated.
          </p>
        </Reveal>
      </div>
    </Section>
  );
}
