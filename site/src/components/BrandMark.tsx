/**
 * The Kodevra brand mark: a geometric K built from a thick stem and two thin,
 * sharp-angled arms. One flat colour, no gradients — reads at 16px, works in
 * the navbar, the terminal header, the favicon and verified states.
 */
export function BrandMark({ size = 18, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path d="M7 4V28" stroke="currentColor" strokeWidth="4.6" />
      <path d="M27.5 4 9.5 16" stroke="currentColor" strokeWidth="3" />
      <path d="M9.5 16 27.5 28" stroke="currentColor" strokeWidth="3" />
    </svg>
  );
}

/** Wordmark: mark + KODEVRA, for navbar and footer. */
export function Wordmark({ markSize = 16 }: { markSize?: number }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <BrandMark size={markSize} className="text-accent" />
      <span className="font-mono text-[13px] font-semibold tracking-[0.18em] text-fg">KODEVRA</span>
    </span>
  );
}
