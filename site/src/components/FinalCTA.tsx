import { ACCESS_HREF } from "../data/site";
import { ButtonLink } from "./ButtonLink";
import { Reveal, Section, container } from "./Section";

export function FinalCTA() {
  return (
    <Section id="early-access" labelledBy="final-cta-heading" className="py-24 sm:py-32">
      <div className={`flex flex-col items-center text-center ${container}`}>
        <Reveal>
          <h2
            id="final-cta-heading"
            className="text-[clamp(2rem,5vw,3.5rem)] font-semibold leading-[1.08] tracking-[-0.03em]"
          >
            Give it the task.
            <br />
            Get back verified code.
          </h2>
          <p className="mx-auto mt-6 max-w-[48ch] text-lg text-muted">
            Kodevra handles the work between the request and the result.
          </p>
        </Reveal>

        <Reveal delay={0.12}>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <ButtonLink href={ACCESS_HREF}>Get Early Access</ButtonLink>
            <ButtonLink href="#product" variant="secondary">
              Explore the Product
            </ButtonLink>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
