import {
  BadgeCheck,
  Bug,
  FileSearch,
  PencilLine,
  Play,
  Wrench,
  type LucideIcon,
} from "lucide-react";

export const navLinks = [
  { label: "Product", href: "#product" },
  { label: "How It Works", href: "#how-it-works" },
  { label: "Security", href: "#security" },
  { label: "Pricing", href: "#pricing" },
  { label: "Docs", href: "#early-access" },
] as const;

export const footerLinks = [
  { label: "Product", href: "#product" },
  { label: "Security", href: "#security" },
  { label: "Pricing", href: "#pricing" },
  { label: "Docs", href: "#early-access" },
  { label: "Privacy", href: "#legal" },
  { label: "Terms", href: "#legal" },
] as const;

/* ------------------------------------------------------------------ */
/* Hero product demo (terminal script)                                 */
/* ------------------------------------------------------------------ */

export type TerminalLine =
  | { kind: "meta"; label: string; value: string }
  | { kind: "gap" }
  | { kind: "command"; text: string; phase?: TerminalPhase }
  | { kind: "muted"; text: string; phase?: TerminalPhase }
  | { kind: "edit-heading"; text: string }
  | { kind: "file"; text: string }
  | { kind: "fail"; text: string; phase: TerminalPhase }
  | { kind: "pass"; text: string }
  | { kind: "result"; command: string; status: string }
  | { kind: "status"; label: string; value: string };

export type TerminalPhase = "running" | "failed" | "repairing" | "verified";

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
  { kind: "muted", text: "Analyzing failure...", phase: "repairing" },
  { kind: "muted", text: "Repairing expiration logic..." },
  { kind: "gap" },
  { kind: "muted", text: "Running tests..." },
  { kind: "pass", text: "48 passed" },
  { kind: "gap" },
  { kind: "muted", text: "Final verification" },
  { kind: "result", command: "npm test", status: "PASS" },
  { kind: "gap" },
  { kind: "status", label: "STATUS", value: "VERIFIED" },
];

/* ------------------------------------------------------------------ */
/* Workflow                                                            */
/* ------------------------------------------------------------------ */

export type WorkflowStep = { title: string; description: string; icon: LucideIcon };

export const workflowSteps: WorkflowStep[] = [
  { title: "Understand", description: "Reads the project before touching it.", icon: FileSearch },
  { title: "Edit", description: "Makes focused changes inside the selected workspace.", icon: PencilLine },
  { title: "Execute", description: "Runs the relevant commands in a controlled environment.", icon: Play },
  { title: "Debug", description: "Reads actual failures instead of guessing.", icon: Bug },
  { title: "Repair", description: "Iterates when the result is wrong.", icon: Wrench },
  { title: "Verify", description: "Completion is based on real execution results.", icon: BadgeCheck },
];

/* ------------------------------------------------------------------ */
/* Comparison                                                          */
/* ------------------------------------------------------------------ */

export const typicalChain = ["Generate code", "\u201cI fixed it.\u201d"] as const;

export const kodevraChain = [
  "Understand",
  "Change code",
  "Execute",
  "Observe failure",
  "Repair",
  "Execute again",
  "VERIFIED",
] as const;

/* ------------------------------------------------------------------ */
/* Result panel                                                        */
/* ------------------------------------------------------------------ */

export const resultRows = [
  { label: "Files changed", value: "3" },
  { label: "Commands executed", value: "4" },
  { label: "Verification", value: "npm test \u2192 PASS", emphasize: "PASS" },
  { label: "Repair attempts", value: "1" },
  { label: "Duration", value: "31.8s" },
  { label: "Execution", value: "Sandboxed" },
] as const;

/* ------------------------------------------------------------------ */
/* Security                                                            */
/* ------------------------------------------------------------------ */

export const securityChain = [
  "Kodevra Agent",
  "Workspace Scope",
  "Controlled Execution",
  "Sandbox",
  "Verification",
] as const;

export const securityPoints = [
  {
    title: "Workspace boundaries",
    description: "Changes stay scoped to the selected project.",
  },
  {
    title: "Sandboxed execution",
    description: "Autonomous commands can run inside isolated environments.",
  },
  {
    title: "No silent fallback",
    description:
      "If protected execution is unavailable, Kodevra fails instead of quietly switching to a weaker path.",
  },
  {
    title: "Verification control",
    description: "Verification-sensitive changes require explicit approval.",
  },
  {
    title: "Local-first workflow",
    description: "Core development work happens on the developer\u2019s machine.",
  },
] as const;

/* ------------------------------------------------------------------ */
/* Features                                                            */
/* ------------------------------------------------------------------ */

export const features = [
  { title: "Repository-aware", description: "Works from the actual project context." },
  { title: "Multi-file changes", description: "Handles changes that span more than one file." },
  { title: "Sandboxed execution", description: "Runs development commands in controlled environments." },
  { title: "Autonomous debugging", description: "Reads failures and uses them to determine the next change." },
  { title: "Repair loops", description: "Retries failed implementations within bounded limits." },
  { title: "Verification", description: "Success is based on real command results." },
  { title: "Sessions", description: "Continue development work across related tasks." },
  { title: "Execution history", description: "Keep structured records of what happened during a run." },
] as const;

/* ------------------------------------------------------------------ */
/* Use cases                                                           */
/* ------------------------------------------------------------------ */

export const useCases = [
  { title: "Fix bugs", description: "Give Kodevra a failing behavior and let it trace, change, run and verify." },
  { title: "Build features", description: "Implement changes that span routes, services, validation and tests." },
  { title: "Repair tests", description: "Understand failures, fix the implementation and confirm the suite." },
  { title: "Refactor safely", description: "Change existing code while continuously checking behavior." },
] as const;

/* ------------------------------------------------------------------ */
/* Pricing                                                             */
/* ------------------------------------------------------------------ */

export type PricingTier = {
  name: string;
  price: string;
  period: string;
  note: string | null;
  badge: string | null;
  planned: boolean;
  features: string[];
  cta: string;
  featured: boolean;
};

export const pricingTiers: PricingTier[] = [
  {
    name: "Free",
    price: "\u20b90",
    period: "",
    note: "For developers getting started.",
    badge: null,
    planned: false,
    features: [
      "Autonomous coding",
      "Repository understanding",
      "Workspace editing",
      "Sandboxed execution",
      "Verification",
      "Sessions",
      "Local development workflow",
    ],
    cta: "Get Early Access",
    featured: true,
  },
  {
    name: "Pro",
    price: "\u20b9499",
    period: "/ month",
    note: null,
    badge: "COMING SOON",
    planned: true,
    features: [
      "Advanced repository intelligence",
      "Persistent project memory",
      "Advanced debugging workflows",
      "Code-review workflows",
      "Extended execution history",
      "Premium development workflows",
    ],
    cta: "Join Pro Waitlist",
    featured: false,
  },
  {
    name: "Teams",
    price: "\u20b91,499",
    period: "/ developer / month",
    note: null,
    badge: "COMING SOON",
    planned: true,
    features: [
      "Shared engineering policies",
      "Team-level rules",
      "Approval workflows",
      "Organization audit history",
      "Shared workflows",
      "CI/CD integrations",
      "Central administration",
    ],
    cta: "Join Teams Waitlist",
    featured: false,
  },
  {
    name: "Enterprise",
    price: "Custom",
    period: "",
    note: null,
    badge: "COMING SOON",
    planned: true,
    features: [
      "Private deployments",
      "Organization controls",
      "Custom integrations",
      "Security review",
      "Priority support",
    ],
    cta: "Contact Us",
    featured: false,
  },
];

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

export const ACCESS_HREF = "#early-access";
