import { motion, useReducedMotion } from "framer-motion";
import { ChevronDown } from "lucide-react";

import { kodevraChain, typicalChain } from "../data/site";
import { Reveal, Section, container } from "./Section";

function Chain({ items, muted = false }: { items: readonly string[]; muted?: boolean }) {
  const reduceMotion = useReducedMotion();
  const lastIndex = items.length - 1;

  return (
    <ul className="flex flex-col items-center gap-1.5">
      {items.map((item, index) => {
        const isVerdict = item === "VERIFIED";
        const isQuote = item.startsWith("\u201c");

        return (
          <li key={item} className="contents">
            <motion.span
              initial={reduceMotion ? false : { opacity: 0, y: 8 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.5 }}
              transition={{ duration: 0.35, delay: 0.15 + index * 0.14, ease: "easeOut" }}
              className={`rounded border px-3.5 py-2 text-center text-sm ${
                isVerdict
                  ? "border-pass/40 bg-pass/10 font-medium tracking-[0.1em] text-pass"
                  : muted
                    ? "border-line bg-transparent text-muted"
                    : "border-line-strong bg-raised text-fg"
              } ${isQuote && muted ? "italic" : ""}`}
            >
              {item}
            </motion.span>
            {index < lastIndex && (
              <ChevronDown size={14} aria-hidden="true" className={muted ? "text-line-strong" : "text-muted/60"} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function ComparisonSection() {
  return (
    <Section id="comparison" labelledBy="comparison-heading" className="py-20 sm:py-24">
      <div className={container}>
        <Reveal>
          <h2
            id="comparison-heading"
            className="max-w-[22ch] text-3xl font-semibold tracking-[-0.02em] sm:text-4xl"
          >
            AI coding should not end with “Looks good.”
          </h2>
          <p className="mt-5 max-w-[60ch] text-lg leading-relaxed text-muted">
            Generating code is only part of software engineering. Kodevra checks whether the work actually runs.
          </p>
        </Reveal>

        <div className="mt-14 grid items-start gap-6 lg:grid-cols-2 lg:gap-8">
          <Reveal className="h-full">
            <div className="h-full rounded-lg border border-line bg-transparent p-6 sm:p-8">
              <h3 className="text-sm font-medium text-muted">Typical AI assistant</h3>
              <div className="py-10">
                <Chain items={typicalChain} muted />
              </div>
            </div>
          </Reveal>

          <Reveal delay={0.1} className="h-full">
            <div className="h-full rounded-lg border border-line-strong bg-surface p-6 sm:p-8">
              <h3 className="flex items-center gap-2 text-sm font-medium text-fg">
                <span aria-hidden="true" className="text-accent">
                  ◆
                </span>
                Kodevra
              </h3>
              <div className="py-6">
                <Chain items={kodevraChain} />
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </Section>
  );
}
