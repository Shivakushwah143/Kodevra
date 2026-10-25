import { useEffect, useRef, useState } from "react";
import { motion, useInView, useReducedMotion } from "framer-motion";
import { Check } from "lucide-react";

import { terminalScript, type TerminalLine, type TerminalPhase } from "../data/site";

const LINE_INTERVAL = 0.16; // seconds between revealed lines
const START_DELAY = 0.35;

const chipStyles: Record<TerminalPhase, { label: string; className: string }> = {
  running: { label: "executing", className: "text-muted border-line-strong" },
  failed: { label: "1 failing", className: "text-fail border-fail/40" },
  repairing: { label: "repairing", className: "text-warn border-warn/40" },
  verified: { label: "VERIFIED", className: "text-pass border-pass/40" },
};

function lineDelay(index: number) {
  return START_DELAY + index * LINE_INTERVAL;
}

function lineClass(kind: TerminalLine["kind"]) {
  switch (kind) {
    case "meta":
      return "text-fg";
    case "command":
      return "text-fg";
    case "muted":
      return "text-muted";
    case "edit-heading":
      return "text-muted";
    case "file":
      return "text-accent";
    case "fail":
      return "text-fail";
    case "pass":
      return "text-pass";
    case "result":
      return "text-fg";
    case "status":
      return "";
    case "gap":
      return "";
  }
}

export function TerminalDemo() {
  const containerRef = useRef<HTMLDivElement>(null);
  const inView = useInView(containerRef, { once: true, amount: 0.3 });
  const reduceMotion = useReducedMotion();
  const [phase, setPhase] = useState<TerminalPhase>("running");

  const animated = inView && !reduceMotion;

  useEffect(() => {
    if (!inView || reduceMotion) {
      if (reduceMotion) setPhase("verified");
      return;
    }

    const timers: number[] = [];
    terminalScript.forEach((line, index) => {
      const next = "phase" in line ? line.phase : undefined;
      if (!next) return;
      const timer = window.setTimeout(() => setPhase(next), lineDelay(index) * 1000);
      timers.push(timer);
    });

    return () => timers.forEach(window.clearTimeout);
  }, [inView, reduceMotion]);

  const chip = chipStyles[phase];

  return (
    <div
      ref={containerRef}
      className="w-full overflow-hidden rounded-lg border border-line bg-surface shadow-[0_24px_60px_-30px_rgba(0,0,0,0.9)]"
    >
      {/* Panel header */}
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <span className="font-mono text-[11px] tracking-[0.16em] text-muted">
          <span aria-hidden="true" className="text-accent">
            ◆
          </span>{" "}
          KODEVRA
        </span>
        <motion.span
          key={phase}
          initial={animated ? { opacity: 0, y: -3 } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[10px] tracking-[0.12em] ${chip.className}`}
        >
          {phase === "verified" && <Check size={11} aria-hidden="true" />}
          {chip.label}
        </motion.span>
      </div>

      {/* Panel body */}
      <div className="px-4 py-4 font-mono text-[12.5px] leading-[1.75] sm:px-5 sm:text-[13px]">
        {terminalScript.map((line, index) => (
          <motion.div
            key={index}
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={inView ? { opacity: 1 } : { opacity: 0 }}
            transition={{ duration: 0.28, delay: reduceMotion || !inView ? 0 : lineDelay(index) }}
            className={lineClass(line.kind)}
          >
            <TerminalLineView line={line} showCursor={animated && index === 4 && phase === "running"} />
          </motion.div>
        ))}
      </div>
    </div>
  );
}

function TerminalLineView({ line, showCursor }: { line: TerminalLine; showCursor: boolean }) {
  switch (line.kind) {
    case "gap":
      return <div aria-hidden="true" className="h-3" />;
    case "meta":
      return (
        <div className="whitespace-pre-wrap">
          <span className="text-muted">{line.label.padEnd(10, "\u00a0")}</span>
          <span>{line.value}</span>
        </div>
      );
    case "command":
      return (
        <div className="whitespace-pre-wrap break-words">
          <span className="text-accent">></span> {line.text}
          {showCursor && (
            <span aria-hidden="true" className="cursor-block ml-0.5 inline-block h-[1em] w-[0.5em] translate-y-[0.15em] bg-accent" />
          )}
        </div>
      );
    case "edit-heading":
      return <div className="text-muted">{line.text}</div>;
    case "file":
      return <div className="break-all pl-4">{line.text}</div>;
    case "fail":
      return (
        <div className="text-fail">
          <span aria-hidden="true">✕ </span>
          {line.text}
        </div>
      );
    case "pass":
      return (
        <div className="text-pass">
          <span aria-hidden="true">✓ </span>
          {line.text}
        </div>
      );
    case "result":
      return (
        <div className="whitespace-pre-wrap">
          {line.command} <span className="text-muted">→</span>{" "}
          <span className="text-pass">{line.status}</span>
        </div>
      );
    case "status":
      return (
        <div className="inline-flex items-center gap-3 rounded border border-pass/40 bg-pass/10 px-2.5 py-1">
          <span className="text-[11px] tracking-[0.16em] text-pass/80">{line.label}</span>
          <span className="font-medium tracking-[0.16em] text-pass">{line.value}</span>
        </div>
      );
    default:
      return <div className="text-muted">{line.text}</div>;
  }
}
