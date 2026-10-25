import { motion, useReducedMotion } from "framer-motion";

import { ACCESS_HREF } from "../data/site";
import { useAccess } from "./AccessModal";
import { ButtonLink } from "./ButtonLink";
import { TerminalDemo } from "./TerminalDemo";
import { container } from "./Section";

export function Hero() {
  const reduceMotion = useReducedMotion();
  const { open } = useAccess();

  const enter = (delay: number) =>
    reduceMotion
      ? {}
      : {
          initial: { opacity: 0, y: 18 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.55, delay, ease: "easeOut" as const },
        };

  return (
    <section id="product" aria-labelledby="hero-heading" className="relative">
      <div className={`grid items-center gap-12 py-16 sm:py-20 lg:grid-cols-12 lg:gap-12 lg:py-24 ${container}`}>
        <div className="lg:col-span-7">
          <motion.h1
            id="hero-heading"
            {...enter(0)}
            className="text-[clamp(2.5rem,6.5vw,4.6rem)] font-semibold leading-[1.04] tracking-[-0.03em]"
          >
            Code that proves it works.
          </motion.h1>

          <motion.p {...enter(0.08)} className="mt-6 max-w-[54ch] text-lg leading-relaxed text-muted">
            Kodevra is an autonomous software engineering agent that understands your repository, writes the
            change, executes it safely, repairs failures, and verifies completion.
          </motion.p>

          <motion.div {...enter(0.16)} className="mt-9 flex flex-wrap items-center gap-3">
            <ButtonLink href={ACCESS_HREF} onClick={() => open("Free")}>
              Get Early Access
            </ButtonLink>
            <ButtonLink href="#how-it-works" variant="secondary">
              See How It Works
            </ButtonLink>
          </motion.div>

          <motion.p {...enter(0.24)} className="mt-10 border-t border-line pt-6 text-sm text-muted">
            Built for developers who want results, not another chat window.
          </motion.p>
        </div>

        <motion.div
          {...(reduceMotion
            ? {}
            : {
                initial: { opacity: 0, y: 24 },
                animate: { opacity: 1, y: 0 },
                transition: { duration: 0.6, delay: 0.2, ease: "easeOut" as const },
              })}
          className="min-w-0 lg:col-span-5"
        >
          <TerminalDemo />
        </motion.div>
      </div>
    </section>
  );
}
