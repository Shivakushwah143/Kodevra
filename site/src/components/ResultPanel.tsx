import { motion, useReducedMotion } from "framer-motion";

import { resultRows, resultVerification } from "../data/site";
import { BrandMark } from "./BrandMark";
import { Reveal, Section, container } from "./Section";

export function ResultPanel() {
  const reduceMotion = useReducedMotion();

  return (
    <Section id="results" labelledBy="results-heading" className="py-20 sm:py-24">
      <div className={`grid items-center gap-12 lg:grid-cols-12 lg:gap-16 ${container}`}>
        <Reveal className="lg:col-span-5">
          <h2
            id="results-heading"
            className="text-[clamp(2rem,4vw,3.25rem)] font-semibold leading-[1.06] tracking-[-0.03em]"
          >
            <span className="text-muted">Don’t trust the response.</span>
            <br />
            Trust the result.
          </h2>
          <p className="mt-5 max-w-[46ch] text-lg leading-relaxed text-muted">
            Every run reports what changed, what executed, how long it took, and whether verification passed.
          </p>
        </Reveal>

        <Reveal delay={0.1} className="lg:col-span-7">
          <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-[0_24px_60px_-30px_rgba(0,0,0,0.9)]">
            <div className="flex items-center gap-2 border-b border-line px-5 py-3 font-mono text-[11px] font-medium tracking-[0.16em] text-fg sm:px-7">
              <BrandMark size={13} className="text-accent" />
              TASK VERIFIED
            </div>

            <dl className="px-5 py-2 sm:px-7">
              {resultRows.map((row) => (
                <div
                  key={row.label}
                  className="flex items-baseline justify-between gap-4 border-b border-line/70 py-3 last:border-b-0"
                >
                  <dt className="text-sm text-muted">{row.label}</dt>
                  <dd className="text-right font-mono text-sm text-fg">{row.value}</dd>
                </div>
              ))}
            </dl>

            <div className="border-t border-line px-5 py-1 sm:px-7">
              <div className="flex items-baseline justify-between gap-4 border-b border-line/70 py-3">
                <dt className="font-mono text-sm text-fg">{resultVerification.command}</dt>
                <dd className="font-mono text-sm font-medium text-pass">{resultVerification.status}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 py-3">
                <dt className="text-sm text-muted">Exit code</dt>
                <dd className="font-mono text-sm text-fg">{resultVerification.exit}</dd>
              </div>
            </div>

            <div className="flex items-center justify-between gap-4 border-t border-line bg-raised px-5 py-4 sm:px-7">
              <span className="text-sm text-muted">Status</span>
              <motion.span
                initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.8 }}
                transition={{ duration: 0.4, delay: 0.5, ease: "easeOut" }}
                className="inline-flex items-center gap-2 font-mono text-sm font-medium tracking-[0.14em] text-pass"
              >
                <BrandMark size={13} className="text-pass" />
                VERIFIED
              </motion.span>
            </div>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
