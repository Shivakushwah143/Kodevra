import { ChevronDown, Info } from "lucide-react";

import { SECURITY_DISCLAIMER, securityDiagram, securityPrinciples } from "../data/site";
import { BrandMark } from "./BrandMark";
import { Reveal, Section, container } from "./Section";

function DiagramNode({ label, index }: { label: string; index: number }) {
  const isFirst = index === 0;
  const isLast = label === "VERIFIED";

  return (
    <li className="flex flex-col items-center">
      <Reveal delay={Math.min(index * 0.09, 0.6)}>
        {isLast ? (
          <span className="inline-flex items-center gap-2 rounded border border-pass/40 bg-pass/10 px-4 py-2 font-mono text-xs font-medium tracking-[0.14em] text-pass">
            VERIFIED
          </span>
        ) : (
          <span
            className={`inline-flex items-center gap-2 rounded border px-4 py-2.5 font-mono text-xs ${
              isFirst
                ? "border-line-strong bg-raised text-fg"
                : "border-line bg-ink text-fg"
            }`}
          >
            {isFirst && <BrandMark size={13} className="text-accent" />}
            {label}
          </span>
        )}
      </Reveal>
      {index < securityDiagram.length - 1 && (
        <span aria-hidden="true" className="flex flex-col items-center">
          <span className="h-4 w-px bg-line-strong" />
          <ChevronDown size={12} className="text-muted/60" />
          <span className="h-4 w-px bg-line-strong" />
        </span>
      )}
    </li>
  );
}

export function SecuritySection() {
  return (
    <Section id="security" labelledBy="security-heading" className="bg-surface py-16 sm:py-20">
      <div className={container}>
        <Reveal>
          <h2
            id="security-heading"
            className="max-w-[24ch] text-3xl font-semibold tracking-[-0.02em] sm:text-4xl"
          >
            Autonomous, without being careless.
          </h2>
          <p className="mt-4 max-w-[62ch] text-base leading-relaxed text-muted">
            Powerful coding agents need boundaries. Kodevra is designed around controlled execution, scoped
            workspaces, and explicit verification.
          </p>
        </Reveal>

        <div className="mt-10 grid items-start gap-12 lg:grid-cols-2 lg:gap-16">
          {/* Execution boundary diagram */}
          <ol
            aria-label="Kodevra execution boundaries, from agent to verified result"
            className="mx-auto flex w-full max-w-sm flex-col items-center"
          >
            {securityDiagram.map((label, index) => (
              <DiagramNode key={label} label={label} index={index} />
            ))}
          </ol>

          {/* Four principles */}
          <div className="flex flex-col">
            {securityPrinciples.map((principle, index) => (
              <Reveal key={principle.title} delay={Math.min(index * 0.07, 0.28)}>
                <div className="border-t border-line py-5 first:border-t-0 first:pt-0 lg:first:border-t lg:first:pt-5">
                  <h3 className="font-medium text-fg">{principle.title}</h3>
                  <p className="mt-2 max-w-[52ch] text-sm leading-relaxed text-muted">
                    {principle.description}
                  </p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>

        <Reveal delay={0.1}>
          <p className="mt-12 flex max-w-[72ch] items-start gap-3 rounded-md border border-line bg-ink px-4 py-3.5 text-xs leading-relaxed text-muted">
            <Info size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-muted" />
            {SECURITY_DISCLAIMER}
          </p>
        </Reveal>
      </div>
    </Section>
  );
}
