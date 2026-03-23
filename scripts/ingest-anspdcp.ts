#!/usr/bin/env tsx
/**
 * ANSPDCP ingestion crawler — dataprotection.ro
 *
 * Crawls the Romanian National Data Protection Authority website and populates
 * the local SQLite database with:
 *   - Decisions & sanctions from the RGPD sanctions page
 *   - Guidelines & guidance documents from the statements page
 *
 * Two-phase pipeline:
 *   Phase 1 (Discovery): Fetch the allnews listing page, extract links and
 *                         classify them as decisions or guidelines.
 *   Phase 2 (Content):   Fetch each individual page, parse HTML with cheerio,
 *                         extract structured fields, and upsert into the DB.
 *
 * The crawler writes a progress file (data/ingest-progress.json) after each
 * page so that interrupted runs can be resumed with --resume.
 *
 * Usage:
 *   npx tsx scripts/ingest-anspdcp.ts                  # full crawl
 *   npx tsx scripts/ingest-anspdcp.ts --resume         # resume interrupted crawl
 *   npx tsx scripts/ingest-anspdcp.ts --dry-run        # discover pages, do not write DB
 *   npx tsx scripts/ingest-anspdcp.ts --force          # drop existing data, re-crawl
 *   npx tsx scripts/ingest-anspdcp.ts --limit 10       # crawl first 10 pages only
 *   npx tsx scripts/ingest-anspdcp.ts --year-start 2023  # only pages from 2023+
 */

import Database from "better-sqlite3";
import * as cheerio from "cheerio";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = process.env["ANSPDCP_DB_PATH"] ?? "data/anspdcp.db";
const DATA_DIR = resolve(__dirname, "..", "data");
const PROGRESS_PATH = resolve(DATA_DIR, "ingest-progress.json");

const BASE_URL = "https://www.dataprotection.ro";
const ALL_NEWS_URL = `${BASE_URL}/index.jsp?page=allnews&lang=ro`;
const SANCTIONS_URL = `${BASE_URL}/index.jsp?page=Sanctiuni_RGPD&lang=ro`;
const STATEMENTS_URL = `${BASE_URL}/index.jsp?page=Precizari_ale_ANSPDCP&lang=ro`;

const RATE_LIMIT_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 3000;

// Keywords that indicate a sanctions/enforcement press release
const SANCTION_KEYWORDS = [
  "sancțiune", "sancţiune", "sancțiuni", "sancţiuni",
  "amendă", "amenzi", "amenda",
  "încălcarea rgpd", "încălcarea gdpr",
  "încălcarea legii nr. 506",
  "încalcarea rgpd", "incalcarea rgpd",
];

// Keywords that indicate a guideline / guidance document
const GUIDELINE_KEYWORDS = [
  "ghid", "recomandare", "precizare", "precizări",
  "opinie", "informare", "avertizare",
  "decizia nr.", "decizie nr.",
  "clarificări", "clarificari",
];

// Topics mapped from Romanian keywords in the text
const TOPIC_MATCHERS: Array<{ pattern: RegExp; topic: string }> = [
  { pattern: /consimțământ|consimtamant|marketing\s+direct|comunicări?\s+comercial/i, topic: "consent" },
  { pattern: /cookie|instrumente\s+de\s+urmărire|urmărire\s+online/i, topic: "cookies" },
  { pattern: /transfer(uri)?\s+(internațional|către\s+țăr)/i, topic: "transfers" },
  { pattern: /evaluare(a)?\s+(de\s+)?impact|dpia/i, topic: "dpia" },
  { pattern: /încălcare(a)?\s+securității|breach|notificare(a)?\s+încălcăr|incident\s+de\s+securitate/i, topic: "breach_notification" },
  { pattern: /protecți(a|ei)\s+datelor\s+prin\s+proiectare|privacy\s+by\s+design|măsuri\s+tehnice/i, topic: "privacy_by_design" },
  { pattern: /videomonitorizare|supraveghere\s+video|cctv|camere?\s+de\s+supraveghere/i, topic: "cctv" },
  { pattern: /date\s+privind\s+sănătatea|date\s+medicale|sănătate|categori(i|e)\s+special/i, topic: "health_data" },
  { pattern: /minori(lor)?|copii(lor)?|persoane\s+minore/i, topic: "children" },
];

// GDPR article extraction pattern
const GDPR_ARTICLE_PATTERN = /art(?:\.?\s*|icolul(?:ui)?\s+)(\d+)(?:\s*(?:alin(?:eat(?:ul)?)?\.?\s*\(?\d+\)?|lit\.?\s*[a-z]\)?)?)*/gi;
const GDPR_ARTICLE_NUM = /\b(\d{1,3})\b/;

// Fine amount patterns (lei and EUR)
const FINE_LEI_PATTERN = /(\d[\d.,]*)\s*lei/i;
const FINE_EUR_PATTERN = /(\d[\d.,]*)\s*(?:euro|eur|€)/i;

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CliOptions {
  resume: boolean;
  dryRun: boolean;
  force: boolean;
  limit: number;
  yearStart: number;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = {
    resume: false,
    dryRun: false,
    force: false,
    limit: 0,
    yearStart: 0,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--resume":
        options.resume = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--force":
        options.force = true;
        break;
      case "--limit":
        options.limit = parseInt(args[++i] ?? "0", 10);
        break;
      case "--year-start":
        options.yearStart = parseInt(args[++i] ?? "0", 10);
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        process.exit(1);
    }
  }

  return options;
}

// ---------------------------------------------------------------------------
// Progress tracking (for --resume)
// ---------------------------------------------------------------------------

interface ProgressState {
  discoveredAt: string;
  totalPages: number;
  completedPages: string[];       // page IDs already ingested
  failedPages: string[];          // page IDs that failed after all retries
  decisionsInserted: number;
  guidelinesInserted: number;
}

function loadProgress(): ProgressState | null {
  if (!existsSync(PROGRESS_PATH)) return null;
  try {
    const raw = readFileSync(PROGRESS_PATH, "utf-8");
    return JSON.parse(raw) as ProgressState;
  } catch {
    return null;
  }
}

function saveProgress(state: ProgressState): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  writeFileSync(PROGRESS_PATH, JSON.stringify(state, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, retries = MAX_RETRIES): Promise<string> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "AnsvarMCP/1.0 (ANSPDCP ingestion; +https://ansvar.eu)",
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "ro,en;q=0.5",
        },
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      return await response.text();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt < retries) {
        const backoff = RETRY_BACKOFF_MS * attempt;
        console.warn(`  RETRY ${attempt}/${retries} for ${url}: ${message} (waiting ${backoff}ms)`);
        await sleep(backoff);
      } else {
        throw new Error(`Failed after ${retries} attempts: ${url} — ${message}`);
      }
    }
  }

  // Unreachable, but satisfies TypeScript
  throw new Error("Unreachable");
}

// ---------------------------------------------------------------------------
// Phase 1: Discovery — parse index pages to find all decision/guideline links
// ---------------------------------------------------------------------------

interface DiscoveredPage {
  pageId: string;       // the ?page= value
  title: string;        // anchor text
  date: string | null;  // DD/MM/YYYY or DD.MM.YYYY parsed to YYYY-MM-DD
  url: string;          // full URL
  category: "decision" | "guideline" | "unknown";
}

/**
 * Parse a date string in DD/MM/YYYY or DD.MM.YYYY format to YYYY-MM-DD.
 */
function parseDate(raw: string): string | null {
  const cleaned = raw.replace(/\//g, ".").trim();
  const match = cleaned.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) return null;
  const [, dd, mm, yyyy] = match;
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Extract year from a date string (DD/MM/YYYY or DD.MM.YYYY).
 */
function extractYear(dateStr: string): number | null {
  const match = dateStr.match(/(\d{4})/);
  return match?.[1] ? parseInt(match[1], 10) : null;
}

/**
 * Classify a news entry as a decision/sanction, guideline, or unknown.
 */
function classifyEntry(title: string): "decision" | "guideline" | "unknown" {
  const lower = title.toLowerCase();

  for (const kw of SANCTION_KEYWORDS) {
    if (lower.includes(kw)) return "decision";
  }

  for (const kw of GUIDELINE_KEYWORDS) {
    if (lower.includes(kw)) return "guideline";
  }

  return "unknown";
}

/**
 * Discover all news pages from the allnews listing.
 * Also fetches the dedicated sanctions and statements pages for additional links.
 */
async function discoverPages(options: CliOptions): Promise<DiscoveredPage[]> {
  console.log("\n=== Phase 1: Discovery ===\n");

  const pages = new Map<string, DiscoveredPage>();

  // Fetch and parse the allnews page
  console.log("  Fetching allnews listing...");
  const allNewsHtml = await fetchWithRetry(ALL_NEWS_URL);
  parseListingPage(allNewsHtml, pages);
  console.log(`  Found ${pages.size} pages from allnews`);

  await sleep(RATE_LIMIT_MS);

  // Fetch the dedicated sanctions page for any links not in allnews
  console.log("  Fetching sanctions listing...");
  const sanctionsHtml = await fetchWithRetry(SANCTIONS_URL);
  const beforeSanctions = pages.size;
  parseSanctionsPage(sanctionsHtml, pages);
  console.log(`  Found ${pages.size - beforeSanctions} additional pages from sanctions listing`);

  await sleep(RATE_LIMIT_MS);

  // Fetch the statements/guidelines page
  console.log("  Fetching statements listing...");
  const statementsHtml = await fetchWithRetry(STATEMENTS_URL);
  const beforeStatements = pages.size;
  parseStatementsPage(statementsHtml, pages);
  console.log(`  Found ${pages.size - beforeStatements} additional pages from statements listing`);

  let results = Array.from(pages.values());

  // Filter by year if requested
  if (options.yearStart > 0) {
    results = results.filter((p) => {
      if (!p.date) return true; // keep dateless entries
      const year = extractYear(p.date);
      return year !== null && year >= options.yearStart;
    });
    console.log(`  Filtered to ${results.length} pages (year >= ${options.yearStart})`);
  }

  // Sort by date descending (newest first)
  results.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return b.date.localeCompare(a.date);
  });

  // Apply limit
  if (options.limit > 0 && results.length > options.limit) {
    results = results.slice(0, options.limit);
    console.log(`  Limited to ${results.length} pages`);
  }

  // Print summary by category
  const decisionCount = results.filter((p) => p.category === "decision").length;
  const guidelineCount = results.filter((p) => p.category === "guideline").length;
  const unknownCount = results.filter((p) => p.category === "unknown").length;

  console.log(`\n  Discovery summary:`);
  console.log(`    Decisions/sanctions: ${decisionCount}`);
  console.log(`    Guidelines:          ${guidelineCount}`);
  console.log(`    Unclassified:        ${unknownCount}`);
  console.log(`    Total:               ${results.length}`);

  return results;
}

/**
 * Parse the allnews listing page.
 *
 * Structure: <ul> containing <li> entries with inline date text + <a> link.
 * Date format varies: DD/MM/YYYY or DD.MM.YYYY.
 * Links use ?page=PAGE_ID&lang=ro pattern.
 */
function parseListingPage(html: string, pages: Map<string, DiscoveredPage>): void {
  const $ = cheerio.load(html);

  // The news entries are in <li> elements containing an <a> tag
  $("li").each((_i, el) => {
    const li = $(el);
    const anchor = li.find("a").first();
    if (!anchor.length) return;

    const href = anchor.attr("href");
    if (!href) return;

    // Extract page ID from href
    const pageIdMatch = href.match(/[?&]page=([^&]+)/);
    if (!pageIdMatch?.[1]) return;

    const pageId = decodeURIComponent(pageIdMatch[1]);

    // Skip non-content pages
    if (isNavigationPage(pageId)) return;

    const title = anchor.text().trim();
    if (!title) return;

    // Extract date from the text preceding the anchor
    const liText = li.text();
    const dateMatch = liText.match(/(\d{2}[/.]\d{2}[/.]\d{4})/);
    const date = dateMatch?.[1] ? parseDate(dateMatch[1]) : null;

    const category = classifyEntry(title);

    if (!pages.has(pageId)) {
      pages.set(pageId, {
        pageId,
        title,
        date,
        url: `${BASE_URL}/index.jsp?page=${encodeURIComponent(pageId)}&lang=ro`,
        category,
      });
    }
  });
}

/**
 * Parse the dedicated sanctions listing page.
 * All links on this page are reclassified as decisions.
 */
function parseSanctionsPage(html: string, pages: Map<string, DiscoveredPage>): void {
  const $ = cheerio.load(html);

  $("a").each((_i, el) => {
    const anchor = $(el);
    const href = anchor.attr("href");
    if (!href) return;

    const pageIdMatch = href.match(/[?&]page=([^&]+)/);
    if (!pageIdMatch?.[1]) return;

    const pageId = decodeURIComponent(pageIdMatch[1]);
    if (isNavigationPage(pageId)) return;

    const title = anchor.text().trim();
    if (!title || title.length < 5) return;

    // Try to find a date near this link
    const parentText = anchor.parent().text();
    const dateMatch = parentText.match(/(\d{2}[/.]\d{2}[/.]\d{4})/);
    const date = dateMatch?.[1] ? parseDate(dateMatch[1]) : null;

    if (!pages.has(pageId)) {
      pages.set(pageId, {
        pageId,
        title,
        date,
        url: `${BASE_URL}/index.jsp?page=${encodeURIComponent(pageId)}&lang=ro`,
        category: "decision", // everything on the sanctions page is a decision
      });
    } else {
      // Upgrade classification if already discovered as unknown
      const existing = pages.get(pageId)!;
      if (existing.category === "unknown") {
        existing.category = "decision";
      }
    }
  });
}

/**
 * Parse the statements/guidelines page.
 * Links here are classified as guidelines.
 */
function parseStatementsPage(html: string, pages: Map<string, DiscoveredPage>): void {
  const $ = cheerio.load(html);

  $("a").each((_i, el) => {
    const anchor = $(el);
    const href = anchor.attr("href");
    if (!href) return;

    // Handle both ?page= links and servlet/ViewDocument links
    const pageIdMatch = href.match(/[?&]page=([^&]+)/);
    if (!pageIdMatch?.[1]) return;

    const pageId = decodeURIComponent(pageIdMatch[1]);
    if (isNavigationPage(pageId)) return;

    const title = anchor.text().trim();
    if (!title || title.length < 5) return;

    if (!pages.has(pageId)) {
      pages.set(pageId, {
        pageId,
        title,
        date: null,
        url: `${BASE_URL}/index.jsp?page=${encodeURIComponent(pageId)}&lang=ro`,
        category: "guideline",
      });
    } else {
      const existing = pages.get(pageId)!;
      if (existing.category === "unknown") {
        existing.category = "guideline";
      }
    }
  });
}

/**
 * Navigation/structural page IDs to skip during discovery.
 */
function isNavigationPage(pageId: string): boolean {
  const nav = [
    "home", "allnews", "about", "contact", "IntrebariFrecvente1",
    "Sanctiuni_RGPD", "Precizari_ale_ANSPDCP", "Plangeri_RGPD",
    "ghid_notificare", "procedura_plangerilor", "Procedura-TFTP",
    "legislatie", "legislatie_nationala", "legislatie_europeana",
    "Informatii_plata_amenda_persoane_juridice_2016",
    "Informare_protectia_datelor_conf_GDPR",
    "Rapoarte_anuale", "publicatii",
  ];
  return nav.includes(pageId);
}

// ---------------------------------------------------------------------------
// Phase 2: Content extraction — fetch individual pages and parse them
// ---------------------------------------------------------------------------

interface ParsedDecision {
  reference: string;
  title: string;
  date: string | null;
  type: string;
  entity_name: string | null;
  fine_amount: number | null;
  summary: string;
  full_text: string;
  topics: string;           // JSON array
  gdpr_articles: string;    // JSON array
  status: string;
}

interface ParsedGuideline {
  reference: string | null;
  title: string;
  date: string | null;
  type: string;
  summary: string;
  full_text: string;
  topics: string;           // JSON array
  language: string;
}

/**
 * Fetch and parse an individual decision/sanction page.
 */
async function fetchDecisionPage(page: DiscoveredPage): Promise<ParsedDecision | null> {
  const html = await fetchWithRetry(page.url);
  const $ = cheerio.load(html);

  // The main content is in the body after navigation, typically in <p> tags
  // following an <h2> heading. Remove navigation, header, footer elements.
  $("script, style, nav, header, footer, .menu, #menu").remove();

  // Extract the main text content
  const bodyText = extractMainContent($);
  if (!bodyText || bodyText.length < 50) {
    console.warn(`  SKIP ${page.pageId}: content too short (${bodyText?.length ?? 0} chars)`);
    return null;
  }

  // Generate a reference from the page ID
  const reference = buildReference(page.pageId, page.date, "SANCTION");

  // Extract entity name from the text
  const entityName = extractEntityName(bodyText);

  // Extract fine amount in EUR (prefer EUR, fall back to lei converted)
  const fineAmount = extractFineEur(bodyText);

  // Detect decision type (sanction, warning, reprimand)
  const type = detectDecisionType(bodyText);

  // Build summary — first ~400 characters of the body text, trimmed at sentence boundary
  const summary = buildSummary(bodyText);

  // Detect GDPR articles
  const gdprArticles = extractGdprArticles(bodyText);

  // Detect topics
  const topics = detectTopics(bodyText);

  return {
    reference,
    title: page.title || extractTitle($) || `Comunicat ANSPDCP ${page.date ?? page.pageId}`,
    date: page.date ?? extractDateFromContent(bodyText),
    type,
    entity_name: entityName,
    fine_amount: fineAmount,
    summary,
    full_text: bodyText,
    topics: JSON.stringify(topics),
    gdpr_articles: JSON.stringify(gdprArticles),
    status: "final",
  };
}

/**
 * Fetch and parse an individual guideline/statement page.
 */
async function fetchGuidelinePage(page: DiscoveredPage): Promise<ParsedGuideline | null> {
  const html = await fetchWithRetry(page.url);
  const $ = cheerio.load(html);

  $("script, style, nav, header, footer, .menu, #menu").remove();

  const bodyText = extractMainContent($);
  if (!bodyText || bodyText.length < 50) {
    console.warn(`  SKIP ${page.pageId}: content too short (${bodyText?.length ?? 0} chars)`);
    return null;
  }

  const reference = buildReference(page.pageId, page.date, "GUIDE");
  const type = detectGuidelineType(bodyText, page.title);
  const summary = buildSummary(bodyText);
  const topics = detectTopics(bodyText);

  return {
    reference,
    title: page.title || extractTitle($) || `Document ANSPDCP ${page.date ?? page.pageId}`,
    date: page.date ?? extractDateFromContent(bodyText),
    type,
    summary,
    full_text: bodyText,
    topics: JSON.stringify(topics),
    language: "ro",
  };
}

// ---------------------------------------------------------------------------
// Content extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract the main textual content from the page, stripping navigation and
 * boilerplate elements.
 */
function extractMainContent($: cheerio.CheerioAPI): string {
  // The ANSPDCP site uses a simple layout: the main content appears after
  // navigation elements, typically in <p>, <ol>, <ul> blocks under an <h2>.
  // There is no consistent content wrapper class/ID.

  // Strategy: find the <h2> that looks like a content heading, then take
  // all following sibling text up to the footer attribution line.
  const contentParts: string[] = [];

  // Collect all text from <h2>, <h3>, <p>, <ol>, <ul>, <div> in order
  const contentSelectors = "h2, h3, p, ol, ul, div.content, td";
  const seenTexts = new Set<string>();

  $(contentSelectors).each((_i, el) => {
    const text = $(el).text().trim();
    if (!text) return;
    if (text.length < 10) return;

    // Skip navigation/menu text
    if (isBoilerplateText(text)) return;

    // Deduplicate
    const normalized = text.replace(/\s+/g, " ").substring(0, 200);
    if (seenTexts.has(normalized)) return;
    seenTexts.add(normalized);

    contentParts.push(text.replace(/\s+/g, " ").trim());
  });

  // Join and clean up
  let content = contentParts.join("\n\n");

  // Remove the footer attribution line if present
  content = content.replace(/Direcția\s+juridică\s+și\s+comunicare\s*\/?\s*A\.?N\.?S\.?P\.?D\.?C\.?P\.?/gi, "").trim();

  // Remove repeated whitespace
  content = content.replace(/\n{3,}/g, "\n\n");

  return content;
}

/**
 * Check whether a text block is navigation boilerplate.
 */
function isBoilerplateText(text: string): boolean {
  const lower = text.toLowerCase();
  const boilerplate = [
    "pagina principală", "informații generale", "legislație",
    "relații internaționale", "proceduri", "contact",
    "termeni de utilizare", "© anspdcp", "webmaster",
    "acasa", "despre noi", "abonare rss",
    "cookies policy", "politica de confidentialitate",
  ];
  return boilerplate.some((bp) => lower.includes(bp));
}

/**
 * Extract the page title from an <h2> tag.
 */
function extractTitle($: cheerio.CheerioAPI): string | null {
  const h2 = $("h2").first().text().trim();
  if (h2 && h2.length > 5 && !isBoilerplateText(h2)) return h2;
  return null;
}

/**
 * Build a reference ID from the page ID and date.
 */
function buildReference(pageId: string, date: string | null, prefix: string): string {
  // Extract date components from page ID if available
  // Common patterns: Comunicat_Presa_20_03_2026, Comunicat_Presa_20.03.2026
  const dateFromId = pageId.match(/(\d{2})[._/](\d{2})[._/](\d{4})/);

  if (dateFromId) {
    const [, dd, mm, yyyy] = dateFromId;
    return `ANSPDCP-${prefix}-${yyyy}-${mm}${dd}`;
  }

  if (date) {
    // date is YYYY-MM-DD
    return `ANSPDCP-${prefix}-${date.replace(/-/g, "")}`;
  }

  // Fall back to the page ID cleaned up
  const cleanId = pageId
    .replace(/^Comunicat_Presa_?/i, "")
    .replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 40);

  return `ANSPDCP-${prefix}-${cleanId}`;
}

/**
 * Extract the sanctioned entity name from the press release text.
 *
 * ANSPDCP press releases commonly follow these patterns:
 *   - "operatorul X S.R.L."
 *   - "SC X S.R.L."
 *   - "S.C. X S.A."
 *   - "entitatea X"
 *   - direct company name followed by S.R.L./S.A./S.R.L/SRL
 */
function extractEntityName(text: string): string | null {
  // Pattern 1: "operatorul [NAME] S.R.L./S.A./SRL/SA"
  const opMatch = text.match(
    /operator(?:ul|ului)?\s+(?:de\s+date\s+)?(.{5,80}?\s+(?:S\.?R\.?L\.?|S\.?A\.?|S\.?C\.?S\.?))/i
  );
  if (opMatch?.[1]) return cleanEntityName(opMatch[1]);

  // Pattern 2: "SC [NAME] S.R.L." or "S.C. [NAME] S.A."
  const scMatch = text.match(
    /S\.?C\.?\s+(.{3,70}?\s+(?:S\.?R\.?L\.?|S\.?A\.?))/i
  );
  if (scMatch?.[1]) return cleanEntityName(`SC ${scMatch[1]}`);

  // Pattern 3: "[NAME] S.R.L./S.A." directly mentioned
  const directMatch = text.match(
    /(?:^|\s)([A-ZĂÂÎȘȚ][A-Za-zăâîșțĂÂÎȘȚ\s&.-]{3,60}?\s+(?:S\.?R\.?L\.?|S\.?A\.?))/m
  );
  if (directMatch?.[1]) return cleanEntityName(directMatch[1]);

  // Pattern 4: "persoană fizică" (natural person)
  if (/persoană\s+fizică/i.test(text)) {
    return "Persoană fizică (anonimizat)";
  }

  return null;
}

function cleanEntityName(raw: string): string {
  return raw
    .replace(/^[,.\s]+|[,.\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract the fine amount in EUR from the text.
 * Prefers the EUR amount if both lei and EUR are mentioned.
 */
function extractFineEur(text: string): number | null {
  // Try EUR first
  const eurMatch = text.match(FINE_EUR_PATTERN);
  if (eurMatch?.[1]) {
    const val = parseNumericValue(eurMatch[1]);
    if (val !== null && val > 0) return val;
  }

  // Fall back to lei, rough conversion (1 EUR ~ 5 lei, but we store the lei figure
  // only if we cannot find EUR — better to have approximate data than none)
  const leiMatch = text.match(FINE_LEI_PATTERN);
  if (leiMatch?.[1]) {
    const leiVal = parseNumericValue(leiMatch[1]);
    // Only store the lei value if it is small enough to be plausible as lei
    // (ANSPDCP fines are typically quoted in both currencies)
    // We return null here to avoid storing inaccurate EUR conversions.
    // The full_text contains the lei amount for reference.
    if (leiVal !== null && leiVal > 0) {
      // Check if a EUR equivalent is stated nearby
      // e.g. "10.190 lei (echivalentul a 2.000 euro)"
      const nearbyEur = text.match(/(\d[\d.,]*)\s*lei[^.]{0,50}?(\d[\d.,]*)\s*(?:euro|eur|€)/i);
      if (nearbyEur?.[2]) {
        const eurVal = parseNumericValue(nearbyEur[2]);
        if (eurVal !== null && eurVal > 0) return eurVal;
      }
    }
  }

  return null;
}

function parseNumericValue(raw: string): number | null {
  // Romanian number formatting: 10.190 (dot as thousands separator) or 10,190
  // Euro amounts: 2.000 or 2,000
  let cleaned = raw.trim();

  // If it contains both dots and commas, dots are thousands separators
  if (cleaned.includes(".") && cleaned.includes(",")) {
    cleaned = cleaned.replace(/\./g, "").replace(",", ".");
  } else if (cleaned.includes(".")) {
    // Ambiguous: could be 2.000 (two thousand) or 2.5
    // If digits after dot are exactly 3, treat as thousands separator
    const parts = cleaned.split(".");
    if (parts.length === 2 && parts[1]?.length === 3) {
      cleaned = cleaned.replace(/\./g, "");
    }
  } else if (cleaned.includes(",")) {
    // Comma as decimal separator
    cleaned = cleaned.replace(",", ".");
  }

  const val = parseFloat(cleaned);
  return isNaN(val) ? null : val;
}

/**
 * Detect the type of decision: sanction, warning, or reprimand.
 */
function detectDecisionType(text: string): string {
  const lower = text.toLowerCase();

  if (/amendă|amenzi|amend[aă]|fine/i.test(lower)) return "sanction";
  if (/avertisment/i.test(lower)) return "warning";
  if (/mustrare/i.test(lower)) return "reprimand";

  // Default to sanction for pages on the sanctions listing
  return "sanction";
}

/**
 * Detect guideline type from content.
 */
function detectGuidelineType(text: string, title: string): string {
  const combined = `${title} ${text}`.toLowerCase();

  if (/ghid\b/i.test(combined)) return "guideline";
  if (/recomandare/i.test(combined)) return "recommendation";
  if (/opinie/i.test(combined)) return "opinion";
  if (/decizia?\s+nr\./i.test(combined)) return "decision";
  if (/precizăr|clarificăr/i.test(combined)) return "clarification";
  if (/informare/i.test(combined)) return "notice";
  if (/avertizare/i.test(combined)) return "warning";
  if (/comunica[tț]/i.test(combined)) return "press_release";

  return "statement";
}

/**
 * Build a summary from the first ~400 characters, trimmed at a sentence boundary.
 */
function buildSummary(text: string): string {
  if (text.length <= 400) return text;

  // Find the last sentence-ending punctuation before 400 chars
  const segment = text.substring(0, 500);
  const lastPeriod = segment.lastIndexOf(".", 400);
  const lastSemicolon = segment.lastIndexOf(";", 400);
  const cutoff = Math.max(lastPeriod, lastSemicolon);

  if (cutoff > 100) {
    return segment.substring(0, cutoff + 1).trim();
  }

  // Fall back to hard cut at ~400 chars
  return text.substring(0, 400).trim() + "…";
}

/**
 * Extract GDPR article numbers from the text.
 */
function extractGdprArticles(text: string): string[] {
  const articles = new Set<string>();

  // Reset lastIndex for global regex
  GDPR_ARTICLE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = GDPR_ARTICLE_PATTERN.exec(text)) !== null) {
    const numMatch = match[1]?.match(GDPR_ARTICLE_NUM);
    if (numMatch?.[1]) {
      const num = parseInt(numMatch[1], 10);
      // GDPR has 99 articles
      if (num >= 1 && num <= 99) {
        articles.add(String(num));
      }
    }
  }

  // Also look for "Regulamentul ... 2016/679" context references
  // to article numbers stated nearby
  const regMatch = text.match(/art(?:\.?\s*|icol\w*\s+)(\d+(?:\s*,\s*\d+)*)/gi);
  if (regMatch) {
    for (const m of regMatch) {
      const nums = m.match(/\d+/g);
      if (nums) {
        for (const n of nums) {
          const v = parseInt(n, 10);
          if (v >= 1 && v <= 99) articles.add(String(v));
        }
      }
    }
  }

  return Array.from(articles).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
}

/**
 * Detect data protection topics from keywords in the text.
 */
function detectTopics(text: string): string[] {
  const topics: string[] = [];

  for (const { pattern, topic } of TOPIC_MATCHERS) {
    if (pattern.test(text)) {
      topics.push(topic);
    }
  }

  return [...new Set(topics)];
}

/**
 * Try to extract a date from the content body (DD.MM.YYYY pattern).
 */
function extractDateFromContent(text: string): string | null {
  const match = text.match(/(\d{2}[.]\d{2}[.]\d{4})/);
  return match?.[1] ? parseDate(match[1]) : null;
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

function openDb(force: boolean): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`Deleted existing database at ${DB_PATH}`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  return db;
}

function upsertDecision(db: Database.Database, d: ParsedDecision): void {
  db.prepare(`
    INSERT INTO decisions
      (reference, title, date, type, entity_name, fine_amount, summary, full_text, topics, gdpr_articles, status)
    VALUES
      (:reference, :title, :date, :type, :entity_name, :fine_amount, :summary, :full_text, :topics, :gdpr_articles, :status)
    ON CONFLICT(reference) DO UPDATE SET
      title = excluded.title,
      date = excluded.date,
      type = excluded.type,
      entity_name = excluded.entity_name,
      fine_amount = excluded.fine_amount,
      summary = excluded.summary,
      full_text = excluded.full_text,
      topics = excluded.topics,
      gdpr_articles = excluded.gdpr_articles,
      status = excluded.status
  `).run({
    reference: d.reference,
    title: d.title,
    date: d.date,
    type: d.type,
    entity_name: d.entity_name,
    fine_amount: d.fine_amount,
    summary: d.summary,
    full_text: d.full_text,
    topics: d.topics,
    gdpr_articles: d.gdpr_articles,
    status: d.status,
  });
}

function upsertGuideline(db: Database.Database, g: ParsedGuideline): void {
  // Guidelines don't have a UNIQUE reference constraint in the schema,
  // so we check for existing entries by reference before inserting.
  if (g.reference) {
    const existing = db.prepare(
      "SELECT id FROM guidelines WHERE reference = ? LIMIT 1"
    ).get(g.reference) as { id: number } | undefined;

    if (existing) {
      db.prepare(`
        UPDATE guidelines SET
          title = :title, date = :date, type = :type,
          summary = :summary, full_text = :full_text,
          topics = :topics, language = :language
        WHERE reference = :reference
      `).run({
        reference: g.reference,
        title: g.title,
        date: g.date,
        type: g.type,
        summary: g.summary,
        full_text: g.full_text,
        topics: g.topics,
        language: g.language,
      });
      return;
    }
  }

  db.prepare(`
    INSERT INTO guidelines
      (reference, title, date, type, summary, full_text, topics, language)
    VALUES
      (:reference, :title, :date, :type, :summary, :full_text, :topics, :language)
  `).run({
    reference: g.reference,
    title: g.title,
    date: g.date,
    type: g.type,
    summary: g.summary,
    full_text: g.full_text,
    topics: g.topics,
    language: g.language,
  });
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseArgs();

  console.log("ANSPDCP Ingestion Crawler");
  console.log("========================");
  console.log(`  Database:   ${DB_PATH}`);
  console.log(`  Dry run:    ${options.dryRun}`);
  console.log(`  Resume:     ${options.resume}`);
  console.log(`  Force:      ${options.force}`);
  console.log(`  Limit:      ${options.limit || "none"}`);
  console.log(`  Year start: ${options.yearStart || "all"}`);

  // ── Phase 1: Discovery ────────────────────────────────────────────────────

  let pages: DiscoveredPage[];
  let progress: ProgressState;

  if (options.resume) {
    const saved = loadProgress();
    if (!saved) {
      console.error("No progress file found. Run without --resume first.");
      process.exit(1);
    }
    progress = saved;

    // Re-discover to get the full list, then filter out completed
    pages = await discoverPages(options);
    const completedSet = new Set(saved.completedPages);
    const beforeFilter = pages.length;
    pages = pages.filter((p) => !completedSet.has(p.pageId));
    console.log(`\n  Resuming: ${beforeFilter - pages.length} pages already done, ${pages.length} remaining`);
  } else {
    pages = await discoverPages(options);
    progress = {
      discoveredAt: new Date().toISOString(),
      totalPages: pages.length,
      completedPages: [],
      failedPages: [],
      decisionsInserted: 0,
      guidelinesInserted: 0,
    };
  }

  if (options.dryRun) {
    console.log("\n=== Dry Run — discovered pages ===\n");
    for (const p of pages) {
      console.log(`  [${p.category.padEnd(9)}] ${p.date ?? "no-date   "} ${p.title.substring(0, 70)}`);
    }
    console.log(`\n  Total: ${pages.length} pages would be crawled.`);
    return;
  }

  // ── Phase 2: Content fetching & DB insertion ──────────────────────────────

  console.log("\n=== Phase 2: Content Extraction ===\n");

  const db = openDb(options.force);
  let processedCount = 0;

  for (const page of pages) {
    processedCount++;
    const pct = Math.round((processedCount / pages.length) * 100);
    console.log(`  [${processedCount}/${pages.length}] (${pct}%) ${page.category} — ${page.pageId}`);

    try {
      if (page.category === "decision") {
        const decision = await fetchDecisionPage(page);
        if (decision) {
          upsertDecision(db, decision);
          progress.decisionsInserted++;
          console.log(`    -> decision: ${decision.reference} | ${decision.entity_name ?? "unknown"} | ${decision.fine_amount != null ? `€${decision.fine_amount}` : "no fine"}`);
        }
      } else if (page.category === "guideline") {
        const guideline = await fetchGuidelinePage(page);
        if (guideline) {
          upsertGuideline(db, guideline);
          progress.guidelinesInserted++;
          console.log(`    -> guideline: ${guideline.reference} | ${guideline.type}`);
        }
      } else {
        // Unknown category — try as decision first (most content is sanctions)
        const decision = await fetchDecisionPage(page);
        if (decision && decision.full_text.length > 100) {
          upsertDecision(db, decision);
          progress.decisionsInserted++;
          console.log(`    -> decision (auto): ${decision.reference}`);
        }
      }

      progress.completedPages.push(page.pageId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`    FAILED: ${message}`);
      progress.failedPages.push(page.pageId);
    }

    // Save progress after each page
    saveProgress(progress);

    // Rate limit between requests
    if (processedCount < pages.length) {
      await sleep(RATE_LIMIT_MS);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  const decisionCount = (
    db.prepare("SELECT count(*) as cnt FROM decisions").get() as { cnt: number }
  ).cnt;
  const guidelineCount = (
    db.prepare("SELECT count(*) as cnt FROM guidelines").get() as { cnt: number }
  ).cnt;
  const ftsDecisions = (
    db.prepare("SELECT count(*) as cnt FROM decisions_fts").get() as { cnt: number }
  ).cnt;
  const ftsGuidelines = (
    db.prepare("SELECT count(*) as cnt FROM guidelines_fts").get() as { cnt: number }
  ).cnt;

  db.close();

  console.log("\n=== Ingestion Complete ===\n");
  console.log(`  Decisions inserted/updated: ${progress.decisionsInserted}`);
  console.log(`  Guidelines inserted/updated: ${progress.guidelinesInserted}`);
  console.log(`  Failed pages:                ${progress.failedPages.length}`);
  console.log(`\n  Database totals:`);
  console.log(`    Decisions:  ${decisionCount} (FTS: ${ftsDecisions})`);
  console.log(`    Guidelines: ${guidelineCount} (FTS: ${ftsGuidelines})`);
  console.log(`\n  Database: ${DB_PATH}`);
  console.log(`  Progress: ${PROGRESS_PATH}`);

  if (progress.failedPages.length > 0) {
    console.log(`\n  Failed pages (re-run with --resume to retry):`);
    for (const p of progress.failedPages) {
      console.log(`    - ${p}`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
