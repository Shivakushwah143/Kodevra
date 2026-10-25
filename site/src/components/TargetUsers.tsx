import { targetUsers } from "../data/site";
import { Reveal, Section, container } from "./Section";

export function TargetUsers() {
  return (
    <Section id="who-its-for" labelledBy="target-users-heading" className="py-20 sm:py-24">
      <div className={container}>
        <Reveal>
          <h2 id="target-users-heading" className="text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
            Built for people shipping software.
          </h2>
        </Reveal>

        <dl className="mt-12 grid gap-10 sm:grid-cols-3 sm:gap-12">
          {targetUsers.map((user, index) => (
            <Reveal key={user.title} delay={index * 0.07}>
              <dt className="font-medium text-fg">{user.title}</dt>
              <dd className="mt-2.5 max-w-[36ch] text-sm leading-relaxed text-muted">{user.description}</dd>
            </Reveal>
          ))}
        </dl>
      </div>
    </Section>
  );
}
