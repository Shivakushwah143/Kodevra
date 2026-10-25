import type { ReactNode } from "react";

type ButtonLinkProps = {
  href: string;
  children: ReactNode;
  variant?: "primary" | "secondary";
  size?: "sm" | "md";
  className?: string;
  ariaLabel?: string;
};

const base =
  "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-all duration-150 hover:-translate-y-px active:translate-y-0";

const variants = {
  primary: "bg-accent text-ink hover:bg-accent-strong shadow-[0_1px_0_rgba(255,255,255,0.15)_inset]",
  secondary: "border border-line-strong bg-transparent text-fg hover:bg-raised hover:border-muted/60",
};

const sizes = {
  sm: "px-3 py-1.5 text-[13px]",
  md: "px-5 py-2.5 text-sm",
};

export function ButtonLink({
  href,
  children,
  variant = "primary",
  size = "md",
  className = "",
  ariaLabel,
}: ButtonLinkProps) {
  return (
    <a href={href} aria-label={ariaLabel} className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}>
      {children}
    </a>
  );
}
