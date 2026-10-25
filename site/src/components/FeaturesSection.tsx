import { primaryFeatures, secondaryFeatures } from "../data/site";
import { Reveal, Section, container } from "./Section";

export function FeaturesSection() {
  return (
    <Section id="features" labelledBy="features-heading" className="py-16 sm:py-20">
      <div className={container}>
        <Reveal>
          <h2 id="features-heading" className="text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
            What Kodevra handles.
          </h2>
        </Reveal>

        {/* Four primary capabilities, 2×2 with hairline dividers — no card chrome. */}
        <div className="mt-10 grid gap-x-14 lg:grid-cols-2">
          {primaryFeatures.map((feature, index) => {
            const Icon = feature.icon;
            return (
              <Reveal key={feature.title} delay={Math.min(index * 0.07, 0.28)}>
                <div className="group h-full border-t border-line py-7">
                  <Icon
                    size={18}
                    aria-hidden="true"
                    className="text-muted transition-colors duration-200 group-hover:text-accent"
                  />
                  <h3 className="mt-4 text-lg font-medium tracking-[-0.01em] text-fg">{feature.title}</h3>
                  <p className="mt-2 max-w-[46ch] text-sm leading-relaxed text-muted">
                    {feature.description}
                  </p>
                </div>
              </Reveal>
            );
          })}
        </div>

        {/* Secondary capabilities, deliberately quieter. */}
        <Reveal delay={0.1}>
          <ul className="mt-8 flex flex-wrap items-center gap-2.5 border-t border-line pt-7">
            {secondaryFeatures.map((feature) => (
              <li
                key={feature}
                className="rounded border border-line bg-surface px-2.5 py-1 font-mono text-[11px] text-muted"
              >
                {feature}
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
    </Section>
  );
}
