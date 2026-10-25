import { motion, useReducedMotion } from "framer-motion";
import { ChevronRight } from "lucide-react";

import { kodevraChain, typicalChain } from "../data/site";
import { BrandMark } from "./BrandMark";
import { Reveal, Section, container } from "./Section";

type BandProps = {
  label: string;
  items: readonly string[];
  strong?: boolean;
  animated?: boolean;
};

function Band({ label, items, strong = false, animated = false }: BandProps) {
  const reduceMotion = useReducedMotion();

  return (
    <div
      className={`flex h-full flex-col justify-between rounded-lg border px-5 py-5 sm:px-7 sm:py-6 ${
        strong ? "border-line-strong bg-raised" : "border-line bg-transparent"
      }`}
    >
      <h3 className={`flex items-center gap-2 text-sm font-medium ${strong ? "text-fg" : "text-muted"}`}>
        {strong && <BrandMark size={13} className="text-accent" />}
        {label}
      </h3>

      <ul className="mt-6 flex flex-wrap items-center gap-2 sm:gap-2.5">
        {items.map((item, index) => {
          const isVerdict = item === "VERIFIED";
          const isQuote = item.startsWith("\u201c");
          const isLast = index === items.length - 1;

          const chip = isVerdict
            ? "border-pass/40 bg-pass/10 font-medium tracking-[0.08em] text-pass"
            : strong
              ? "border-line-strong bg-ink text-fg"
              : "border-line bg-transparent text-muted";

          return (
            <li key={item} className="flex items-center gap-2 sm:gap-2.5">
              <motion.span
                initial={animated && !reduceMotion ? { opacity: 0, y: 6 } : false}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.5 }}
                transition={{ duration: 0.3, delay: 0.15 + index * 0.13, ease: "easeOut" }}
                className={`rounded border px-3 py-1.5 text-center text-xs sm:text-sm ${chip} ${
                  isQuote && !strong ? "italic" : ""
                }`}
              >
                {item}
              </motion.span>
              {!isLast && (
                <ChevronRight
                  size={13}
                  aria-hidden="true"
                  className={strong ? "text-muted/60" : "text-muted/40"}
                />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function ComparisonSection() {
  return (
    <Section
      id="comparison"
      labelledBy="comparison-heading"
      className="border-y border-line bg-surface py-16 sm:py-20"
    >
      <div className={container}>
        <Reveal>
          <h2
            id="comparison-heading"
            className="max-w-[22ch] text-3xl font-semibold tracking-[-0.02em] sm:text-4xl"
          >
            AI coding should not end with “Looks good.”
          </h2>
          <p className="mt-4 max-w-[60ch] text-base leading-relaxed text-muted">
            Generating code is only part of software engineering. Kodevra checks whether the work actually runs.
          </p>
        </Reveal>

        <div className="mt-9 grid gap-4 lg:grid-cols-2">
          <Reveal>
            <Band label="Typical AI assistant" items={typicalChain} />
          </Reveal>
          <Reveal delay={0.1}>
            <Band label="Kodevra" items={kodevraChain} strong animated />
          </Reveal>
        </div>
      </div>
    </Section>
  );
}
