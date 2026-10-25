import { Check } from "lucide-react";

import { ACCESS_HREF, pricingTiers } from "../data/site";
import { ButtonLink } from "./ButtonLink";
import { Reveal, Section, container } from "./Section";

export function PricingSection() {
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

        <div className="mt-14 grid gap-6 md:grid-cols-2 xl:grid-cols-4">
          {pricingTiers.map((tier, index) => (
            <Reveal key={tier.name} delay={Math.min(index * 0.07, 0.28)} className="h-full">
              <div
                className={`flex h-full flex-col rounded-lg border p-6 transition-colors duration-200 ${
                  tier.featured
                    ? "border-accent/50 bg-surface"
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

                {tier.note && <p className="mt-2 text-sm text-muted">{tier.note}</p>}

                {tier.planned && <p className="mt-5 font-mono text-[10px] tracking-[0.14em] text-muted">PLANNED</p>}

                <ul className={`mt-4 flex flex-col gap-2.5 ${tier.planned ? "mb-6" : "mb-7"}`}>
                  {tier.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2.5 text-sm text-muted">
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
                  >
                    {tier.cta}
                  </ButtonLink>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </Section>
  );
}
