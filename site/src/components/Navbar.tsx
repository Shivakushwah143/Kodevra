import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Menu, X } from "lucide-react";

import { navLinks, ACCESS_HREF } from "../data/site";
import { useAccess } from "./AccessModal";
import { ButtonLink } from "./ButtonLink";
import { Wordmark } from "./BrandMark";
import { container } from "./Section";

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const reduceMotion = useReducedMotion();
  const { open } = useAccess();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  // When the menu closes, keyboard focus must not be dropped to <body>:
  // return it to the toggle so the next Tab continues from the navbar.
  // Deferred one task so it runs after the browser's own focus fixup for the
  // unmounted menu link, which would otherwise win the race.
  useEffect(() => {
    if (!menuOpen) {
      const wasOpenNow = wasOpen.current;
      wasOpen.current = false;
      if (!wasOpenNow) return;
      const timer = window.setTimeout(() => {
        const active = document.activeElement;
        if (!active || active === document.body || !active.isConnected) {
          toggleRef.current?.focus();
        }
      }, 0);
      return () => window.clearTimeout(timer);
    }
    wasOpen.current = true;
  }, [menuOpen]);

  const requestAccess = () => open("Free");

  return (
    <header
      className={`sticky top-0 z-50 transition-colors duration-200 ${
        scrolled ? "border-b border-line bg-ink/80 backdrop-blur" : "border-b border-transparent"
      }`}
    >
      <div className={`flex h-16 items-center justify-between ${container}`}>
        <a href="#product" aria-label="Kodevra home">
          <Wordmark />
        </a>

        <nav aria-label="Primary" className="hidden items-center gap-7 md:flex">
          {navLinks.map((link) => (
            <a
              key={link.label}
              href={link.href}
              className="text-sm text-muted transition-colors hover:text-fg"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-3">
          <ButtonLink
            href={ACCESS_HREF}
            size="sm"
            className="hidden md:inline-flex"
            onClick={requestAccess}
          >
            Get Early Access
          </ButtonLink>
          <button
            ref={toggleRef}
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            aria-controls="mobile-menu"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-line text-muted transition-colors hover:text-fg md:hidden"
          >
            {menuOpen ? <X size={16} aria-hidden="true" /> : <Menu size={16} aria-hidden="true" />}
          </button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {menuOpen && (
          <motion.div
            id="mobile-menu"
            key="mobile-menu"
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="overflow-hidden border-t border-line bg-ink/95 backdrop-blur-md md:hidden"
          >
            <nav aria-label="Mobile" className={`flex flex-col gap-1 py-4 ${container}`}>
              {navLinks.map((link) => (
                <a
                  key={link.label}
                  href={link.href}
                  onClick={() => setMenuOpen(false)}
                  className="rounded-md px-2 py-2.5 text-[15px] text-muted transition-colors hover:bg-surface hover:text-fg"
                >
                  {link.label}
                </a>
              ))}
              <ButtonLink
                href={ACCESS_HREF}
                className="mt-3 w-full"
                ariaLabel="Get Early Access"
                onClick={requestAccess}
              >
                Get Early Access
              </ButtonLink>
            </nav>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
