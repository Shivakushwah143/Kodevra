import { footerLinks } from "../data/site";
import { container } from "./Section";

export function Footer() {
  return (
    <footer className="border-t border-line">
      <div className={`py-12 ${container}`}>
        <div className="flex flex-col gap-8 sm:flex-row sm:items-center sm:justify-between">
          <span className="font-mono text-[13px] font-semibold tracking-[0.18em] text-fg">
            <span aria-hidden="true" className="text-accent">
              ◆
            </span>{" "}
            KODEVRA
          </span>

          <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-7 gap-y-3">
            {footerLinks.map((link) => (
              <a
                key={link.label}
                href={link.href}
                className="text-sm text-muted transition-colors hover:text-fg"
              >
                {link.label}
              </a>
            ))}
          </nav>
        </div>

        <div id="legal" className="mt-10 border-t border-line pt-6">
          <p className="font-mono text-xs text-muted">© 2026 Kodevra</p>
        </div>
      </div>
    </footer>
  );
}
