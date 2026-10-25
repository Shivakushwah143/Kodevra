import {
  BadgeCheck,
  Bug,
  PencilLine,
  Play,
  Search,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";

export const navLinks = [
  { label: "Product", href: "#product" },
  { label: "How It Works", href: "#how-it-works" },
  { label: "Security", href: "#security" },
  { label: "Pricing", href: "#pricing" },
  { label: "Docs", href: "#/docs" },
] as const;

export const footerLinks = [
  { label: "Product", href: "#product" },
  { label: "Security", href: "#security" },
  { label: "Pricing", href: "#pricing" },
  { label: "Docs", href: "#/docs" },
  { label: "Privacy", href: "#/privacy" },
  { label: "Terms", href: "#/terms" },
] as const;

export const ACCESS_HREF = "#early-access";

/* ------------------------------------------------------------------ */
/* Waitlist form options (UI-only; no backend)                         */
/* ------------------------------------------------------------------ */

export const ROLES = ["Developer", "Founder", "Team Lead", "Agency", "Other"] as const;
export const PLANS = ["Free", "Pro", "Teams", "Enterprise"] as const;
export type Plan = (typeof PLANS)[number];

/* ------------------------------------------------------------------ */
/* Hero terminal                                                       */
/* ------------------------------------------------------------------ */

export type TerminalPhase = "running" | "failed" | "repairing" | "verified";

export type TerminalLine =
  | { kind: "meta"; label: string; value: string }
  | { kind: "gap" }
  | { kind: "command"; text: string }
  | { kind: "plain"; text: string }
  | { kind: "muted"; text: string; phase?: TerminalPhase }
  | { kind: "edit-heading"; text: string }
  | { kind: "file"; text: string }
  | { kind: "fail"; text: string; phase: TerminalPhase }
  | { kind: "pass"; text: string }
  | { kind: "zero"; text: string }
  | { kind: "diff-del"; text: string }
  | { kind: "diff-add"; text: string }
  | { kind: "status"; label: string; value: string; phase?: TerminalPhase };

export const terminalScript: TerminalLine[] = [
  { kind: "meta", label: "Workspace", value: "payments-service" },
  { kind: "meta", label: "Mode", value: "Workspace Write" },
  { kind: "meta", label: "Sandbox", value: "Ready" },
  { kind: "gap" },
  { kind: "command", text: "Fix the authentication regression and verify it." },
  { kind: "gap" },
  { kind: "muted", text: "Reading project..." },
  { kind: "muted", text: "Tracing authentication flow..." },
  { kind: "gap" },
  { kind: "edit-heading", text: "Editing" },
  { kind: "file", text: "src/auth/session.ts" },
  { kind: "file", text: "src/auth/token.ts" },
  { kind: "gap" },
  { kind: "muted", text: "Running tests..." },
  { kind: "fail", text: "1 failing", phase: "failed" },
  { kind: "gap" },
  { kind: "muted", text: "Inspecting failure output...", phase: "repairing" },
  { kind: "file", text: "src/auth/session.ts:84" },
  { kind: "edit-heading", text: "Repairing expiration check" },
  { kind: "diff-del", text: "if (expiresAt < Date.now())" },
  { kind: "diff-add", text: "if (expiresAt <= Date.now())" },
  { kind: "gap" },
  { kind: "muted", text: "Final verification" },
  { kind: "plain", text: "npm test" },
  { kind: "pass", text: "48 passed" },
  { kind: "zero", text: "0 failed" },
  { kind: "gap" },
  { kind: "status", label: "STATUS", value: "VERIFIED", phase: "verified" },
];

/* ------------------------------------------------------------------ */
/* How it works: execution pipeline                                    */
/* ------------------------------------------------------------------ */

export type WorkflowStep = {
  title: string;
  state: string;
  tone?: "fail" | "pass";
  icon: LucideIcon;
};

export const PIPELINE_TASK = "Fix the authentication regression and verify it.";

export const workflowSteps: WorkflowStep[] = [
  { title: "Understand", state: "17 relevant files", icon: Search },
  { title: "Edit", state: "src/auth/session.ts", icon: PencilLine },
  { title: "Execute", state: "npm test", icon: Play },
  { title: "Debug", state: "1 failing", tone: "fail", icon: Bug },
  { title: "Repair", state: "patch applied", icon: Wrench },
  { title: "Verify", state: "48 passed", tone: "pass", icon: BadgeCheck },
];

/* ------------------------------------------------------------------ */
/* Comparison                                                          */
/* ------------------------------------------------------------------ */

export const typicalChain = ["Prompt", "Generate code", "\u201cFixed.\u201d"] as const;

export const kodevraChain = [
  "Prompt",
  "Understand",
  "Change",
  "Execute",
  "Fail",
  "Repair",
  "Execute",
  "VERIFIED",
] as const;

/* ------------------------------------------------------------------ */
/* Result proof                                                        */
/* ------------------------------------------------------------------ */

export const resultRows = [
  { label: "Files changed", value: "3" },
  { label: "Commands executed", value: "4" },
  { label: "Tests", value: "48 passed" },
  { label: "Failures repaired", value: "1" },
  { label: "Duration", value: "31.8s" },
  { label: "Execution", value: "Sandboxed" },
] as const;

export const resultVerification = { command: "npm test", status: "PASS", exit: "0" };

/* ------------------------------------------------------------------ */
/* Security                                                            */
/* ------------------------------------------------------------------ */

export const securityDiagram = [
  "KODEVRA AGENT",
  "Workspace policy",
  "Selected project",
  "Controlled command",
  "Docker Sandbox",
  "Verification",
  "VERIFIED",
] as const;

export const securityPrinciples = [
  {
    title: "Workspace scoped",
    description: "The agent works inside the selected project.",
  },
  {
    title: "Sandboxed execution",
    description: "Autonomous commands can run in isolated containers.",
  },
  {
    title: "No silent fallback",
    description: "Protected execution does not quietly downgrade to host execution.",
  },
  {
    title: "Verification control",
    description: "Verification-sensitive changes require explicit approval.",
  },
] as const;

export const SECURITY_DISCLAIMER =
  "Sandboxing reduces execution risk; no environment should be described as perfectly isolated.";

/* ------------------------------------------------------------------ */
/* Features                                                            */
/* ------------------------------------------------------------------ */

export const primaryFeatures: { title: string; description: string; icon: LucideIcon }[] = [
  {
    title: "Repository-aware",
    description: "Understands the project before changing it.",
    icon: Search,
  },
  {
    title: "Sandboxed execution",
    description: "Runs development commands in controlled environments.",
    icon: Terminal,
  },
  {
    title: "Autonomous repair",
    description: "Reads real failures and determines the next change.",
    icon: Wrench,
  },
  {
    title: "Verified completion",
    description: "Success depends on execution results, not model confidence.",
    icon: BadgeCheck,
  },
];

export const secondaryFeatures = [
  "Multi-file edits",
  "Sessions",
  "Execution history",
  "Controlled permissions",
] as const;

/* ------------------------------------------------------------------ */
/* Use cases                                                           */
/* ------------------------------------------------------------------ */

export const useCases = [
  {
    title: "Fix bugs",
    description: "Trace the failure, change the implementation and prove it passes.",
    example: "src/auth/session.ts \u2192 npm test",
  },
  {
    title: "Build features",
    description: "Handle changes spanning services, routes, validation and tests.",
    example: "routes \u00b7 services \u00b7 tests",
  },
  {
    title: "Repair tests",
    description: "Understand why a suite fails and fix the implementation.",
    example: "expected 3 got 2 \u2192 fixed",
  },
  {
    title: "Refactor safely",
    description: "Change existing code while continuously checking behavior.",
    example: "working tree \u2192 verified",
  },
] as const;

/* ------------------------------------------------------------------ */
/* Pricing                                                             */
/* ------------------------------------------------------------------ */

export type PricingTier = {
  name: string;
  price: string;
  period: string;
  note: string;
  badge: string | null;
  features: string[];
  cta: string;
  plan: "Free" | "Pro" | "Teams";
  featured: boolean;
};

export const pricingTiers: PricingTier[] = [
  {
    name: "Free",
    price: "\u20b90",
    period: "",
    note: "For individual developers getting started.",
    badge: null,
    features: [
      "Autonomous coding",
      "Repository understanding",
      "Sandboxed execution",
      "Verification",
      "Project sessions",
    ],
    cta: "Get Early Access",
    plan: "Free",
    featured: true,
  },
  {
    name: "Pro",
    price: "\u20b9499",
    period: "/ month",
    note: "For developers using Kodevra daily.",
    badge: "COMING SOON",
    features: [
      "Everything in Free",
      "Persistent project memory",
      "Advanced debugging workflows",
      "Code review workflows",
      "Extended execution history",
    ],
    cta: "Join Pro Waitlist",
    plan: "Pro",
    featured: false,
  },
  {
    name: "Teams",
    price: "\u20b91,499",
    period: "/ developer / month",
    note: "For startups, agencies and engineering teams.",
    badge: "COMING SOON",
    features: [
      "Everything in Pro",
      "Shared engineering policies",
      "Approval workflows",
      "Team audit history",
      "Shared workflows",
      "CI/CD integrations",
    ],
    cta: "Join Teams Waitlist",
    plan: "Teams",
    featured: false,
  },
];

export const enterpriseTier = {
  name: "Enterprise",
  price: "Custom",
  points: [
    "Private deployments",
    "Security review",
    "Organization controls",
    "Custom integrations",
    "Priority support",
  ],
  cta: "Contact Us",
} as const;

/* ------------------------------------------------------------------ */
/* Target users                                                        */
/* ------------------------------------------------------------------ */

export const targetUsers = [
  {
    title: "Individual developers",
    description: "Delegate implementation work without giving up control over the result.",
  },
  {
    title: "Startups",
    description: "Move faster while keeping execution and verification visible.",
  },
  {
    title: "Agencies",
    description: "Use repeatable engineering workflows across multiple client projects.",
  },
] as const;
