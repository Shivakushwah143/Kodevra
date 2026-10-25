import { footerLinks } from "../data/site";
import { Wordmark } from "./BrandMark";
import { container } from "./Section";

export function Footer() {
  return (
    <footer className="border-t border-line">
      <div className={`py-12 ${container}`}>
        <div className="flex flex-col gap-8 sm:flex-row sm:items-center sm:justify-between">
          <a href="#product" aria-label="Kodevra home">
            <Wordmark />
          </a>

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

        <div className="mt-10 border-t border-line pt-6">
          <p className="font-mono text-xs text-muted">© 2026 Kodevra</p>
        </div>
      </div>
    </footer>
  );
}
