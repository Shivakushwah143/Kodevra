import { motion, useReducedMotion } from "framer-motion";

import { PIPELINE_TASK, workflowSteps } from "../data/site";
import { BrandMark } from "./BrandMark";
import { Reveal, Section, container } from "./Section";

const ACCENT = "#4cc2ff";
const MUTED = "#8b929c";

function stateClasses(tone?: "fail" | "pass") {
  if (tone === "fail") return "border-fail/40 bg-fail/10 text-fail";
  if (tone === "pass") return "border-pass/40 bg-pass/10 text-pass";
  return "border-line bg-surface text-fg";
}

export function WorkflowSection() {
  const reduceMotion = useReducedMotion();

  return (
    <Section id="how-it-works" labelledBy="workflow-heading" className="py-16 sm:py-20">
      <div className={container}>
        <Reveal>
          <h2 id="workflow-heading" className="max-w-[24ch] text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
            From task to verified result.
          </h2>
          <p className="mt-4 max-w-[56ch] text-base leading-relaxed text-muted">
            Every task moves through the same six stages, in order.
          </p>
        </Reveal>

        {/* The task that enters the pipeline */}
        <Reveal delay={0.08}>
          <div className="mt-8 flex max-w-2xl items-center gap-3 rounded-md border border-line bg-surface px-4 py-3 font-mono text-xs">
            <BrandMark size={14} className="shrink-0 text-accent" />
            <span className="shrink-0 tracking-[0.14em] text-muted">TASK</span>
            <span className="truncate text-fg">{PIPELINE_TASK}</span>
          </div>
        </Reveal>

        {/* The pipeline itself */}
        <ol className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-6 lg:gap-0">
          {workflowSteps.map((step, index) => {
            const Icon = step.icon;
            const isLast = index === workflowSteps.length - 1;
            const reach = 0.45 + index * 0.17;

            return (
              <li key={step.title} className="relative">
                <Reveal delay={0.1 + index * 0.07}>
                  <div className="flex gap-4 lg:block lg:pr-6">
                    {reduceMotion ? (
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-line bg-surface text-accent">
                        <Icon size={16} aria-hidden="true" />
                      </span>
                    ) : (
                      <motion.span
                        initial={{ color: MUTED }}
                        whileInView={{ color: ACCENT }}
                        viewport={{ once: true, amount: 0.6 }}
                        transition={{ duration: 0.3, delay: reach }}
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-line bg-surface"
                      >
                        <Icon size={16} aria-hidden="true" />
                      </motion.span>
                    )}

                    <div className="min-w-0 lg:mt-4">
                      <h3 className="font-medium text-fg">{step.title}</h3>
                      <motion.span
                        initial={reduceMotion ? false : { opacity: 0 }}
                        whileInView={{ opacity: 1 }}
                        viewport={{ once: true, amount: 0.6 }}
                        transition={{ duration: 0.3, delay: reach + 0.12 }}
                        className={`mt-2 inline-block max-w-full truncate rounded border px-2 py-1 font-mono text-[11px] leading-none ${stateClasses(step.tone)}`}
                      >
                        {step.state}
                      </motion.span>
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
                        transition={{ duration: 0.35, delay: reach + 0.05, ease: "easeOut" }}
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
