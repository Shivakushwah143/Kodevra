import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowRight, Check, X } from "lucide-react";

import { PLANS, ROLES, type Plan } from "../data/site";
import { BrandMark } from "./BrandMark";

/* ------------------------------------------------------------------ */
/* Context: lets any CTA open the modal without prop drilling.          */
/* ------------------------------------------------------------------ */

type AccessValue = { open: (plan?: Plan) => void };

const AccessContext = createContext<AccessValue | null>(null);

export function useAccess(): AccessValue {
  const ctx = useContext(AccessContext);
  if (!ctx) throw new Error("useAccess must be used inside <AccessProvider>");
  return ctx;
}

export function AccessProvider({ children }: { children: ReactNode }) {
  const [plan, setPlan] = useState<Plan>("Free");
  const [isOpen, setIsOpen] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const open = useCallback((nextPlan: Plan = "Free") => {
    setPlan(nextPlan);
    setSubmitted(false);
    setIsOpen(true);
  }, []);
  const close = useCallback(() => setIsOpen(false), []);

  return (
    <AccessContext.Provider value={{ open }}>
      {children}
      <AnimatePresence>
        {isOpen && (
          <AccessDialog
            key="access-dialog"
            plan={plan}
            submitted={submitted}
            onSubmitComplete={() => setSubmitted(true)}
            onClose={close}
          />
        )}
      </AnimatePresence>
    </AccessContext.Provider>
  );
}

/* ------------------------------------------------------------------ */
/* Dialog                                                              */
/* ------------------------------------------------------------------ */

type DialogProps = {
  plan: Plan;
  submitted: boolean;
  onSubmitComplete: () => void;
  onClose: () => void;
};

const focusableSelector =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function AccessDialog({ plan, submitted, onSubmitComplete, onClose }: DialogProps) {
  const reduceMotion = useReducedMotion();
  const panelRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>(ROLES[0]);
  const [selectedPlan, setSelectedPlan] = useState<Plan>(plan);
  const [errors, setErrors] = useState<{ name?: string; email?: string }>({});

  // Focus lifecycle: remember the trigger, focus the form, restore on close,
  // lock background scroll, close on Escape.
  useEffect(() => {
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = "hidden";
    const timer = window.setTimeout(() => firstFieldRef.current?.focus(), 60);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      // Simple focus trap.
      const nodes = [...panelRef.current.querySelectorAll<HTMLElement>(focusableSelector)];
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
      restoreRef.current?.focus();
    };
  }, [onClose]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const nextErrors: { name?: string; email?: string } = {};
    if (!name.trim()) nextErrors.name = "Enter your name.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) nextErrors.email = "Enter a valid email address.";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    // UI-only integration point. When a waitlist backend exists, POST here:
    // { name, email, role, plan: selectedPlan }. Nothing is sent or stored today.
    onSubmitComplete();
  };

  const enter = reduceMotion
    ? {}
    : {
        initial: { opacity: 0, y: 10, scale: 0.98 },
        animate: { opacity: 1, y: 0, scale: 1 },
        exit: { opacity: 0, y: 6, scale: 0.98 },
        transition: { duration: 0.22, ease: "easeOut" as const },
      };

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto p-4 sm:p-8">
      <motion.div
        className="fixed inset-0 bg-ink/80 backdrop-blur-sm"
        initial={reduceMotion ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={reduceMotion ? undefined : { opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={onClose}
        aria-hidden="true"
      />

      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="access-title"
        {...enter}
        className="relative my-auto w-full max-w-md rounded-xl border border-line-strong bg-raised p-6 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.9)] sm:p-7"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <span className="inline-flex items-center gap-2 font-mono text-[11px] tracking-[0.16em] text-muted">
              <BrandMark size={13} className="text-accent" />
              KODEVRA
            </span>
            <h2 id="access-title" className="mt-3 text-xl font-semibold tracking-[-0.01em] text-fg">
              {submitted ? "Request received." : "Get early access"}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="-mr-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface hover:text-fg"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        {submitted ? (
          <div className="mt-6">
            <div className="flex items-center gap-3 rounded-lg border border-pass/40 bg-pass/10 px-4 py-3.5">
              <Check size={18} className="shrink-0 text-pass" aria-hidden="true" />
              <p className="text-sm text-fg">
                You{"\u2019"}re on the list{email ? `, ${email.trim()}` : ""}.
              </p>
            </div>
            <p className="mt-4 text-sm leading-relaxed text-muted">
              Early access opens gradually. This preview form does not send or store your details yet{" "}
              <span aria-hidden="true">{"\u2014"}</span> it is the integration point for the waitlist
              backend.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-6 inline-flex w-full items-center justify-center rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-accent-strong"
            >
              Back to the site
            </button>
          </div>
        ) : (
          <form onSubmit={submit} noValidate className="mt-6">
            <p className="text-sm leading-relaxed text-muted">
              Tell us who you are and which plan you want. No account required.
            </p>

            <div className="mt-5 flex flex-col gap-4">
              <div>
                <label htmlFor="access-name" className="mb-1.5 block text-sm text-fg">
                  Name
                </label>
                <input
                  ref={firstFieldRef}
                  id="access-name"
                  name="name"
                  type="text"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  aria-invalid={!!errors.name}
                  aria-describedby={errors.name ? "access-name-error" : undefined}
                  className="w-full rounded-md border border-line-strong bg-ink px-3 py-2.5 text-sm text-fg transition-colors placeholder:text-muted/60 focus:border-accent focus:outline-none"
                  placeholder="Ada Lovelace"
                />
                {errors.name && (
                  <p id="access-name-error" className="mt-1.5 text-xs text-fail">
                    {errors.name}
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="access-email" className="mb-1.5 block text-sm text-fg">
                  Email
                </label>
                <input
                  id="access-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  aria-invalid={!!errors.email}
                  aria-describedby={errors.email ? "access-email-error" : undefined}
                  className="w-full rounded-md border border-line-strong bg-ink px-3 py-2.5 text-sm text-fg transition-colors placeholder:text-muted/60 focus:border-accent focus:outline-none"
                  placeholder="ada@example.com"
                />
                {errors.email && (
                  <p id="access-email-error" className="mt-1.5 text-xs text-fail">
                    {errors.email}
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="access-role" className="mb-1.5 block text-sm text-fg">
                  Role
                </label>
                <select
                  id="access-role"
                  name="role"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  className="w-full rounded-md border border-line-strong bg-ink px-3 py-2.5 text-sm text-fg focus:border-accent focus:outline-none"
                >
                  {ROLES.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>

              <fieldset>
                <legend className="mb-2 block text-sm text-fg">Interested plan</legend>
                <div className="flex flex-wrap gap-2">
                  {PLANS.map((option) => (
                    <label
                      key={option}
                      className={`cursor-pointer rounded-md border px-3 py-1.5 text-sm transition-colors ${
                        selectedPlan === option
                          ? "border-accent/60 bg-accent/10 text-fg"
                          : "border-line-strong text-muted hover:border-muted/60 hover:text-fg"
                      }`}
                    >
                      <input
                        type="radio"
                        name="plan"
                        value={option}
                        checked={selectedPlan === option}
                        onChange={() => setSelectedPlan(option)}
                        className="sr-only"
                      />
                      {option}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>

            <button
              type="submit"
              className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-accent-strong"
            >
              Request access
              <ArrowRight size={15} aria-hidden="true" />
            </button>

            <p className="mt-3 text-center text-xs text-muted">
              Preview form <span aria-hidden="true">{"\u2014"}</span> nothing is sent or stored yet.
            </p>
          </form>
        )}
      </motion.div>
    </div>
  );
}
