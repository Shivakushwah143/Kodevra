import { useCases } from "../data/site";
import { Reveal, Section, container } from "./Section";

function Example({ value }: { value: string }) {
  const [from, to] = value.split("\u2192");
  return (
    <code className="block truncate font-mono text-xs text-muted">
      {from.trim()}
      {to && (
        <>
          {" "}
          <span aria-hidden="true" className="text-muted/60">
            {'\u2192'}
          </span>{" "}
          <span className="text-fg">{to.trim()}</span>
        </>
      )}
    </code>
  );
}

export function UseCases() {
  return (
    <Section id="use-cases" labelledBy="use-cases-heading" className="py-20 sm:py-24">
      <div className={container}>
        <Reveal>
          <h2 id="use-cases-heading" className="text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
            Built for real development work.
          </h2>
        </Reveal>

        <div className="mt-12 border-t border-line">
          {useCases.map((useCase, index) => (
            <Reveal key={useCase.title} delay={Math.min(index * 0.06, 0.24)}>
              <div className="grid gap-2 border-b border-line py-7 sm:grid-cols-12 sm:items-baseline sm:gap-8">
                <h3 className="text-lg font-medium tracking-[-0.01em] text-fg sm:col-span-3">
                  {useCase.title}
                </h3>
                <p className="max-w-[52ch] text-sm leading-relaxed text-muted sm:col-span-6">
                  {useCase.description}
                </p>
                <div className="sm:col-span-3 sm:text-right">
                  <Example value={useCase.example} />
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </Section>
  );
}
