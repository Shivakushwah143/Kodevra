import { motion, useReducedMotion } from "framer-motion";

import { workflowSteps } from "../data/site";
import { Reveal, Section, container } from "./Section";

export function WorkflowSection() {
  const reduceMotion = useReducedMotion();

  return (
    <Section id="how-it-works" labelledBy="workflow-heading" className="py-20 sm:py-24">
      <div className={container}>
        <Reveal>
          <h2
            id="workflow-heading"
            className="max-w-[24ch] text-3xl font-semibold tracking-[-0.02em] sm:text-4xl"
          >
            From task to verified result.
          </h2>
        </Reveal>

        <ol className="mt-14 grid gap-8 sm:grid-cols-2 lg:grid-cols-6 lg:gap-0">
          {workflowSteps.map((step, index) => {
            const Icon = step.icon;
            const isLast = index === workflowSteps.length - 1;

            return (
              <li key={step.title} className="relative">
                <Reveal delay={index * 0.07}>
                  <div className="flex gap-4 lg:block lg:pr-6">
                    <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-line bg-surface text-accent">
                      <Icon size={16} aria-hidden="true" />
                    </div>
                    <div className="lg:mt-5">
                      <h3 className="font-medium text-fg">{step.title}</h3>
                      <p className="mt-1.5 text-sm leading-relaxed text-muted">{step.description}</p>
                    </div>
                  </div>

                  {!isLast && (
                    <span
                      aria-hidden="true"
                      className="absolute left-8 right-0 top-[17px] hidden h-px bg-line lg:block"
                    >
                      <motion.span
                        className="block h-px origin-left bg-accent/70"
                        initial={reduceMotion ? { scaleX: 1 } : { scaleX: 0 }}
                        whileInView={{ scaleX: 1 }}
                        viewport={{ once: true, amount: 0.6 }}
                        transition={{ duration: 0.4, delay: 0.35 + index * 0.18, ease: "easeOut" }}
                      />
                    </span>
                  )}
                </Reveal>
              </li>
            );
          })}
        </ol>
      </div>
    </Section>
  );
}
