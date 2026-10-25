import type { ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";

export const container = "mx-auto w-full max-w-6xl px-5 sm:px-8 lg:px-10";

type RevealProps = {
  children: ReactNode;
  delay?: number;
  className?: string;
};

/**
 * One-shot entrance for a block of content. Disabled entirely when the
 * visitor prefers reduced motion.
 */
export function Reveal({ children, delay = 0, className }: RevealProps) {
  const reduceMotion = useReducedMotion();

  if (reduceMotion) return <div className={className}>{children}</div>;

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 14 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2 }}
      transition={{ duration: 0.5, delay, ease: "easeOut" }}
    >
      {children}
    </motion.div>
  );
}

/** Shared page section wrapper: hairline top border, generous vertical rhythm. */
export function Section({
  id,
  children,
  className = "",
  labelledBy,
}: {
  id?: string;
  children: ReactNode;
  className?: string;
  labelledBy?: string;
}) {
  return (
    <section id={id} aria-labelledby={labelledBy} className={`border-t border-line ${className}`}>
      {children}
    </section>
  );
}
