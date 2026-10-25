import { ArrowLeft, Check } from "lucide-react";

import { ACCESS_HREF } from "../data/site";
import { useAccess } from "../components/AccessModal";
import { ButtonLink } from "../components/ButtonLink";
import { container } from "../components/Section";

/* Lightweight real pages behind hash routes: #/docs, #/privacy, #/terms. */

function PageShell({
  title,
  intro,
  children,
}: {
  title: string;
  intro: string;
  children: React.ReactNode;
}) {
  return (
    <article className={`py-14 sm:py-20 ${container}`}>
      <a
        href="#product"
        className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-fg"
      >
        <ArrowLeft size={14} aria-hidden="true" />
        Back to home
      </a>

      <h1 className="mt-6 text-[clamp(2rem,4vw,3rem)] font-semibold tracking-[-0.03em]">{title}</h1>
      <p className="mt-4 max-w-[62ch] text-lg leading-relaxed text-muted">{intro}</p>

      <div className="mt-10 flex max-w-[68ch] flex-col gap-9">{children}</div>
    </article>
  );
}

function DocSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-medium text-fg">{title}</h2>
      <div className="mt-3 flex flex-col gap-3 text-sm leading-relaxed text-muted">{children}</div>
    </section>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-line bg-surface px-4 py-3.5 font-mono text-xs leading-relaxed text-fg">
      <code>{code}</code>
    </pre>
  );
}

export function DocsPage() {
  const { open } = useAccess();

  return (
    <PageShell
      title="Docs"
      intro="Kodevra takes a task, changes your code, runs it, and verifies the result. Here is what you need to start."
    >
      <DocSection title="Quick start">
        <p>Run a task with your verification command attached:</p>
        <CodeBlock code={'kodevra run "Fix the failing test" --verify "npm test"'} />
      </DocSection>

      <DocSection title="How verification works">
        <ul className="flex flex-col gap-2.5">
          <li className="flex gap-2.5">
            <Check size={15} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
            <span>You name the command; Kodevra runs it after the change, inside your workspace.</span>
          </li>
          <li className="flex gap-2.5">
            <Check size={15} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
            <span>The exit code decides the status: VERIFIED, FAILED, REFUSED or UNVERIFIED.</span>
          </li>
          <li className="flex gap-2.5">
            <Check size={15} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
            <span>A failing command is never reported as a pass. Bounded repair attempts may run first.</span>
          </li>
        </ul>
      </DocSection>

      <DocSection title="Workspace and sandbox">
        <p>
          Work is scoped to the project you select. Commands can run inside a Docker sandbox; if protected
          execution is unavailable, the run stops instead of quietly switching to host execution.
          Verification-sensitive changes require explicit approval.
        </p>
      </DocSection>

      <DocSection title="Sessions">
        <p>
          Continue related tasks in the same session. Every run keeps a structured execution history of what
          changed, what ran and what the result was.
        </p>
      </DocSection>

      <div className="border-t border-line pt-7">
        <p className="text-sm text-muted">Full documentation ships with public launch.</p>
        <div className="mt-5">
          <ButtonLink href={ACCESS_HREF} onClick={() => open("Free")}>
            Get Early Access
          </ButtonLink>
        </div>
      </div>
    </PageShell>
  );
}

export function PrivacyPage() {
  return (
    <PageShell
      title="Privacy"
      intro="This website is a static marketing site. It is built to collect as little as possible."
    >
      <DocSection title="This site">
        <p>
          No analytics, no cookies, no tracking and no accounts. The pages are served as static files and do
          not profile visitors.
        </p>
      </DocSection>

      <DocSection title="Early-access form">
        <p>
          The form on this site is a front-end preview. What you type is not transmitted or stored \u2014 it
          is the integration point for the waitlist backend, which does not exist yet.
        </p>
      </DocSection>

      <DocSection title="The application">
        <p>
          Kodevra runs locally on your machine. Your code, tasks and results stay with you; the application
          does not upload your repository.
        </p>
      </DocSection>

      <DocSection title="Changes">
        <p>
          If data collection is ever added, this page will be updated before it goes live, with a clear
          description of what is collected and why.
        </p>
      </DocSection>
    </PageShell>
  );
}

export function TermsPage() {
  return (
    <PageShell
      title="Terms"
      intro="Kodevra is in pre-launch. These terms cover the public site and the early-access preview."
    >
      <DocSection title="Preview, as-is">
        <p>
          The site and product are provided as-is, without warranties. Features may change, break or be
          removed while Kodevra is in preview.
        </p>
      </DocSection>

      <DocSection title="Early access">
        <p>
          Joining the early-access list is not a contract. Access is granted gradually and may be withdrawn.
        </p>
      </DocSection>

      <DocSection title="Pricing">
        <p>
          Prices are shown in Indian rupees and are indicative until launch. Paid plans marked COMING SOON
          are not available for purchase, and no payment is processed on this site.
        </p>
      </DocSection>

      <DocSection title="Acceptable use">
        <p>
          Use Kodevra only on projects you are allowed to modify, and only in ways that comply with the laws
          that apply to you.
        </p>
      </DocSection>

      <DocSection title="Changes to these terms">
        <p>
          These terms may be updated before public launch. Continued use of the site after an update means
          you accept the revised terms.
        </p>
      </DocSection>
    </PageShell>
  );
}
