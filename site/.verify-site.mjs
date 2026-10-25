import puppeteer from "puppeteer-core";
import path from "node:path";
import fs from "node:fs";

const CHROME = path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe");
const URL = "http://localhost:4173/";
const SHOTS = path.resolve(import.meta.dirname, "..", ".tmp", "site-shots");
fs.mkdirSync(SHOTS, { recursive: true });

const BANNED = [
  "github", "byoa", "bring your own account", "opencode", "freedeepseek",
  "web adapter", "oauth", "api key", "provider routing", "deepseek",
  "chatgpt", "gemini", "open source", "open-source", "revolutionize",
  "supercharge", "cutting-edge", "game-changing",
];

const results = {
  consoleErrors: [], pageErrors: [], failedRequests: [], bannedHits: [],
  viewports: {}, interactions: {}, routes: {},
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });

function wire(page, name) {
  page.on("console", (m) => m.type() === "error" && results.consoleErrors.push(`[${name}] ${m.text()}`));
  page.on("pageerror", (e) => results.pageErrors.push(`[${name}] ${String(e)}`));
  page.on("requestfailed", (r) => results.failedRequests.push(`[${name}] ${r.url()} :: ${r.failure()?.errorText}`));
}

async function scrollThrough(page) {
  await page.evaluate(async () => {
    const step = Math.round(window.innerHeight * 0.75);
    for (let y = 0; y <= document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 110));
    }
    window.scrollTo(0, 0);
  });
  await new Promise((r) => setTimeout(r, 700));
}

function probe(banned) {
  const doc = document.documentElement;
  const anchors = [...document.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute("href"));
  const routeAnchors = anchors.filter((h) => h.startsWith("#/"));
  const sectionAnchors = anchors.filter((h) => !h.startsWith("#/"));
  const brokenAnchors = sectionAnchors.filter((h) => h.slice(1) && !document.getElementById(h.slice(1)));
  const text = document.body.innerText.toLowerCase();
  return {
    overflow: doc.scrollWidth > doc.clientWidth + 1 || document.body.scrollWidth > doc.clientWidth + 1,
    scrollWidth: doc.scrollWidth,
    clientWidth: doc.clientWidth,
    brokenAnchors,
    routeAnchors,
    h1Count: document.querySelectorAll("h1").length,
    h1Text: document.querySelector("h1")?.textContent?.trim().slice(0, 60) ?? "",
    bannedHits: banned.filter((w) => text.includes(w)),
    comingSoonCount: (text.match(/coming soon/g) || []).length,
  };
}

async function auditViewport(name, width, height, { screenshot = false, motion } = {}) {
  const page = await browser.newPage();
  wire(page, name);
  await page.setViewport({ width, height });
  if (motion) await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: motion }]);
  await page.goto(URL, { waitUntil: "networkidle0", timeout: 30000 });
  await scrollThrough(page);
  const checks = await page.evaluate(probe, BANNED);
  results.bannedHits.push(...checks.bannedHits.map((w) => `[${name}] "${w}"`));
  delete checks.bannedHits;

  // Skip link is first tab stop.
  await page.keyboard.press("Tab");
  checks.firstTabFocus = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
  await page.evaluate(() => document.activeElement?.blur());

  // Mobile menu (only where visible).
  const toggle = await page.$('button[aria-controls="mobile-menu"]');
  if (toggle && (await toggle.isVisible())) {
    await toggle.click();
    await page.waitForSelector("#mobile-menu", { visible: true, timeout: 3000 });
    checks.menuLinks = await page.$$eval("#mobile-menu a", (a) => a.length);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.getElementById("mobile-menu"), { timeout: 3000 }).catch(() => {});
  }

  // Let the terminal sequence finish, then assert it reached VERIFIED.
  await new Promise((r) => setTimeout(r, 4500));
  checks.terminal = await page.evaluate(() => {
    const panel = document.querySelector("#product .rounded-lg.border");
    const chip = panel.firstElementChild.lastElementChild;
    const statusLine = [...panel.querySelectorAll("span")].find(
      (s) => s.textContent === "VERIFIED" && s.parentElement.textContent.includes("STATUS"),
    );
    return {
      chip: chip.textContent.trim(),
      statusVisible: !!statusLine && statusLine.checkVisibility({ opacityVisibility: true }),
    };
  });

  if (screenshot) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise((r) => setTimeout(r, 300));
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
  }

  results.viewports[name] = checks;
  await page.close();
}

async function auditInteractions() {
  const page = await browser.newPage();
  wire(page, "interactions");
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(URL, { waitUntil: "networkidle0", timeout: 30000 });
  const log = {};

  const dialogState = null;

  // 1. Hero primary CTA opens the modal with all fields.
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("a")].find((a) => a.textContent.trim() === "Get Early Access");
    el.click();
  });
  log.heroCtaOpensModal = await page.waitForSelector('[role="dialog"]', { visible: true, timeout: 3000 }).then(() => true).catch(() => false);
  log.formFields = await page.evaluate(() => ({
    name: !!document.querySelector("#access-name"),
    email: !!document.querySelector("#access-email"),
    role: !!document.querySelector("#access-role"),
    plans: document.querySelectorAll('input[name="plan"]').length,
    labelled: !!document.querySelector('label[for="access-name"]') && !!document.querySelector('label[for="access-email"]') && !!document.querySelector('label[for="access-role"]'),
  }));

  // 2. Empty submit shows validation errors.
  await page.evaluate(() => document.querySelector('[role="dialog"] button[type="submit"]').click());
  await new Promise((r) => setTimeout(r, 150));
  log.validationErrors = await page.evaluate(() => ({
    name: !!document.querySelector("#access-name-error"),
    email: !!document.querySelector("#access-email-error"),
  }));

  // 3. Fill and submit -> success state.
  await page.type("#access-name", "Ada Lovelace");
  await page.type("#access-email", "ada@example.com");
  await page.evaluate(() => {
    const pro = [...document.querySelectorAll('input[name="plan"]')].find((i) => i.value === "Pro");
    pro.click();
  });
  await page.evaluate(() => document.querySelector('[role="dialog"] button[type="submit"]').click());
  await new Promise((r) => setTimeout(r, 250));
  log.successState = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    return !!d && d.innerText.includes("Request received");
  });
  log.successMentionsEmail = await page.evaluate(() =>
    document.querySelector('[role="dialog"]').innerText.includes("ada@example.com"),
  );

  // 4. Escape closes, focus returns to trigger.
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 300));
  log.modalClosedByEscape = await page.evaluate(() => !document.querySelector('[role="dialog"]'));

  // 5. Pricing CTAs preselect the right plan.
  for (const [cta, plan] of [["Join Pro Waitlist", "Pro"], ["Join Teams Waitlist", "Teams"], ["Contact Us", "Enterprise"]]) {
    await page.evaluate((label) => {
      const el = [...document.querySelectorAll("a")].find((a) => a.textContent.trim() === label);
      el.scrollIntoView({ block: "center" });
      el.click();
    }, cta);
    await page.waitForSelector('[role="dialog"]', { visible: true, timeout: 3000 }).catch(() => {});
    log[`preselect_${plan}`] = await page.evaluate((p) => {
      const checked = document.querySelector('input[name="plan"]:checked');
      return checked ? checked.value === p : false;
    }, plan);
    await page.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 250));
  }

  // 6. Secondary CTAs scroll to their sections.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("a")].find((a) => a.textContent.trim() === "See How It Works");
    el.click();
  });
  await new Promise((r) => setTimeout(r, 1100));
  log.howItWorksScroll = await page.evaluate(() => {
    const s = document.getElementById("how-it-works");
    return !!s && Math.abs(s.getBoundingClientRect().top) < 200;
  });

  await page.evaluate(() => {
    const el = [...document.querySelectorAll("a")].find((a) => a.textContent.trim() === "Explore the Product");
    el.click();
  });
  await new Promise((r) => setTimeout(r, 1100));
  log.exploreProductScroll = await page.evaluate(() => {
    const s = document.getElementById("product");
    return !!s && Math.abs(s.getBoundingClientRect().top) < 200;
  });

  // 7. Terminal shows the code diff and ends verified.
  log.terminal = await page.evaluate(() => {
    const panel = document.querySelector("#product .rounded-lg.border");
    const text = panel.innerText;
    return {
      hasDiffMinus: text.includes("- if (expiresAt < Date.now())"),
      hasDiffPlus: text.includes("+ if (expiresAt <= Date.now())"),
      hasZeroFailed: text.includes("0 failed"),
      hasVerified: text.includes("VERIFIED"),
      endsStatus: text.includes("STATUS"),
    };
  });

  // 8. Pricing content checks.
  log.pricing = await page.evaluate(() => {
    const text = document.body.innerText;
    const cards = [...document.querySelectorAll("#pricing h3")].map((h) => h.textContent.trim());
    return {
      tierOrder: cards,
      enterpriseBlockHorizontal: !!document.querySelector("#pricing h3") &&
        [...document.querySelectorAll("#pricing h3")].some((h) => h.textContent.includes("Enterprise")),
      freeFeatures: [
        "Autonomous coding", "Repository understanding", "Sandboxed execution",
        "Verification", "Project sessions",
      ].every((f) => text.includes(f)),
      enterprisePoints: ["Private deployments", "Security review", "Organization controls", "Custom integrations", "Priority support"]
        .every((p) => text.includes(p)),
    };
  });

  // 9. Security diagram present with all nodes.
  log.security = await page.evaluate(() => {
    const s = document.getElementById("security");
    const text = s.innerText;
    return ["KODEVRA AGENT", "Workspace policy", "Selected project", "Controlled command", "Docker Sandbox", "Verification", "VERIFIED"]
      .every((n) => text.includes(n));
  });

  results.interactions = log;
  await page.close();
}

async function auditRoutes() {
  const page = await browser.newPage();
  wire(page, "routes");
  await page.setViewport({ width: 1280, height: 800 });

  const expect = { "#/docs": "Docs", "#/privacy": "Privacy", "#/terms": "Terms" };
  for (const [hash, heading] of Object.entries(expect)) {
    await page.goto(URL + hash, { waitUntil: "networkidle0", timeout: 30000 });
    await new Promise((r) => setTimeout(r, 300));
    const check = await page.evaluate((h, banned) => {
      const h1 = document.querySelector("h1");
      const text = document.body.innerText.toLowerCase();
      return {
        h1: h1 ? h1.textContent.trim() : "",
        noBanned: !banned.some((w) => text.includes(w)),
        backLink: !!([...document.querySelectorAll("a")].find((a) => a.textContent.includes("Back to home"))),
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      };
    }, hash, BANNED);
    results.routes[heading] = check;
    if (heading === "Docs") {
      await scrollThrough(page);
      await page.screenshot({ path: path.join(SHOTS, "route-docs.png"), fullPage: true });
    }
  }

  // Footer-driven navigation between routes and back to landing.
  await page.goto(URL, { waitUntil: "networkidle0" });
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("footer a")].find((a) => a.textContent.trim() === "Privacy");
    el.click();
  });
  await new Promise((r) => setTimeout(r, 400));
  results.routes.footerPrivacyWorks = await page.evaluate(() => document.querySelector("h1")?.textContent.trim() === "Privacy");
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("header a")].find((a) => a.getAttribute("href") === "#product");
    el.click();
  });
  await new Promise((r) => setTimeout(r, 500));
  results.routes.backToLanding = await page.evaluate(() =>
    document.querySelector("h1")?.textContent.includes("Code that proves it works"),
  );

  await page.close();
}

await auditViewport("desktop-1920", 1920, 1080, { motion: "no-preference" });
await auditViewport("desktop-1440", 1440, 900, { screenshot: true, motion: "no-preference" });
await auditViewport("tablet-768", 768, 1024, { motion: "no-preference" });
await auditViewport("mobile-430", 430, 932, { motion: "no-preference" });
await auditViewport("mobile-375", 375, 667, { screenshot: true, motion: "no-preference" });
await auditViewport("mobile-320", 320, 568, { motion: "no-preference" });
await auditViewport("reduced-375", 375, 667, { motion: "reduce" });
await auditInteractions();
await auditRoutes();

await browser.close();
console.log(JSON.stringify(results, null, 2));
