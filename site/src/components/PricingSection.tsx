import { Check } from "lucide-react";

import { enterpriseTier, pricingTiers, type Plan } from "../data/site";
import { useAccess } from "./AccessModal";
import { ButtonLink } from "./ButtonLink";
import { Reveal, Section, container } from "./Section";
import { ACCESS_HREF } from "../data/site";

export function PricingSection() {
  const { open } = useAccess();

  return (
    <Section id="pricing" labelledBy="pricing-heading" className="py-20 sm:py-24">
      <div className={container}>
        <Reveal>
          <h2
            id="pricing-heading"
            className="max-w-[30ch] text-3xl font-semibold tracking-[-0.02em] sm:text-4xl"
          >
            Start free. Upgrade when Kodevra becomes part of your workflow.
          </h2>
        </Reveal>

        {/* Three primary tiers */}
        <div className="mt-12 grid gap-5 md:grid-cols-3">
          {pricingTiers.map((tier, index) => {
            const isIncludes = (feature: string) => feature.startsWith("Everything in");
            return (
              <Reveal key={tier.name} delay={Math.min(index * 0.07, 0.28)} className="h-full">
                <div
                  className={`flex h-full flex-col rounded-lg border p-6 transition-colors duration-200 ${
                    tier.featured
                      ? "border-accent/50 bg-surface hover:border-accent"
                      : "border-line bg-transparent hover:border-line-strong"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-medium text-fg">{tier.name}</h3>
                    {tier.badge && (
                      <span className="rounded border border-line-strong px-1.5 py-0.5 font-mono text-[9px] tracking-[0.14em] text-muted">
                        {tier.badge}
                      </span>
                    )}
                  </div>

                  <div className="mt-5 flex items-baseline gap-1.5">
                    <span className="font-mono text-3xl font-medium tracking-[-0.02em] text-fg">
                      {tier.price}
                    </span>
                    {tier.period && <span className="text-xs text-muted">{tier.period}</span>}
                  </div>

                  <p className="mt-2 text-sm text-muted">{tier.note}</p>

                  <ul className="mt-6 mb-7 flex flex-col gap-2.5">
                    {tier.features.map((feature) => (
                      <li
                        key={feature}
                        className={`flex items-start gap-2.5 text-sm ${
                          isIncludes(feature) ? "font-medium text-fg" : "text-muted"
                        }`}
                      >
                        <Check
                          size={14}
                          aria-hidden="true"
                          className={`mt-1 shrink-0 ${tier.featured ? "text-accent" : "text-muted/70"}`}
                        />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>

                  <div className="mt-auto">
                    <ButtonLink
                      href={ACCESS_HREF}
                      variant={tier.featured ? "primary" : "secondary"}
                      size="sm"
                      className="w-full"
                      ariaLabel={tier.cta}
                      onClick={() => open(tier.plan as Plan)}
                    >
                      {tier.cta}
                    </ButtonLink>
                  </div>
                </div>
              </Reveal>
            );
          })}
        </div>

        {/* Enterprise: full-width horizontal block */}
        <Reveal delay={0.1}>
          <div className="mt-5 flex flex-col gap-6 rounded-lg border border-line-strong bg-surface px-6 py-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <div className="flex items-baseline gap-4">
                <h3 className="text-sm font-medium text-fg">{enterpriseTier.name}</h3>
                <span className="font-mono text-2xl font-medium tracking-[-0.02em] text-fg">
                  {enterpriseTier.price}
                </span>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                {enterpriseTier.points.join(" \u00b7 ")}
              </p>
            </div>
            <div className="shrink-0">
              <ButtonLink
                href={ACCESS_HREF}
                variant="secondary"
                size="sm"
                ariaLabel={enterpriseTier.cta}
                onClick={() => open("Enterprise")}
              >
                {enterpriseTier.cta}
              </ButtonLink>
            </div>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
