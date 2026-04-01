# Plan 1: US Lead Scraper + Bad Site Scorer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scrape 100 US business leads/day with bad websites, score each site's quality, store in Supabase.

**Architecture:** Fork the existing Georgian scraper (`/Users/macintoshi/projects/allone-perf/scraper/`), replace geography/queries for US market, add a PageSpeed+heuristic bad-site scorer, store leads with scores in a new Supabase project. Google Maps is the sole scraping source.

**Tech Stack:** Node.js, TypeScript, Puppeteer + stealth, Supabase, Google PageSpeed Insights API (free), Groq (edge-case visual scoring), Winston logging.

**Spec:** `docs/superpowers/specs/2026-04-02-lead-machine-design.md` — Steps 1-2.

---

## File Structure

```
/opt/lead-machine/
├── package.json
├── tsconfig.json
├── .env
├── src/
│   ├── config.ts                    # US cities, segments, queries, env config
│   ├── types.ts                     # LeadData, ScoredLead, ScoreResult interfaces
│   ├── scrapers/
│   │   ├── base.scraper.ts          # Abstract base (from existing, adapted)
│   │   └── google-maps.scraper.ts   # Google Maps US scraper (adapted)
│   ├── scorer/
│   │   ├── pagespeed.ts             # Google PageSpeed API wrapper
│   │   ├── heuristics.ts            # Code-based site quality checks via Playwright
│   │   └── score.ts                 # Orchestrator: combines all signals into bad_score
│   ├── database/
│   │   ├── client.ts                # Supabase client init
│   │   └── leads.repo.ts           # Lead CRUD + dedup
│   ├── extractors/
│   │   └── contact.extractor.ts     # Extract email/phone from lead websites
│   ├── scheduler/
│   │   └── scrape.cron.ts           # Daily orchestration
│   └── utils/
│       ├── browser.ts               # Puppeteer singleton + stealth
│       └── logger.ts                # Winston setup
└── tests/
    ├── scorer.test.ts               # Scorer unit tests
    └── scraper.test.ts              # Scraper integration test
```

---

### Task 1: Project Scaffold + Config

**Files:**
- Create: `/opt/lead-machine/package.json`
- Create: `/opt/lead-machine/tsconfig.json`
- Create: `/opt/lead-machine/.env`
- Create: `/opt/lead-machine/src/config.ts`
- Create: `/opt/lead-machine/src/types.ts`

- [ ] **Step 1: Create project directory on server**

```bash
ssh root@178.104.47.126 "mkdir -p /opt/lead-machine/src/{scrapers,scorer,database,extractors,scheduler,utils} /opt/lead-machine/tests && echo 'dirs created'"
```

- [ ] **Step 2: Create package.json**

```bash
ssh root@178.104.47.126 "cat > /opt/lead-machine/package.json << 'PKGJSON'
{
  \"name\": \"lead-machine\",
  \"version\": \"1.0.0\",
  \"type\": \"module\",
  \"scripts\": {
    \"dev\": \"tsx watch src/scheduler/scrape.cron.ts\",
    \"scrape\": \"tsx src/scheduler/scrape.cron.ts\",
    \"score\": \"tsx src/scorer/score.ts\",
    \"test\": \"tsx --test tests/*.test.ts\"
  },
  \"dependencies\": {
    \"@supabase/supabase-js\": \"^2.89.0\",
    \"cheerio\": \"^1.0.0\",
    \"dotenv\": \"^16.4.0\",
    \"groq-sdk\": \"^0.37.0\",
    \"puppeteer\": \"^22.0.0\",
    \"puppeteer-extra\": \"^3.3.6\",
    \"puppeteer-extra-plugin-stealth\": \"^2.11.2\",
    \"winston\": \"^3.12.0\"
  },
  \"devDependencies\": {
    \"@types/node\": \"^20.11.0\",
    \"tsx\": \"^4.7.0\",
    \"typescript\": \"^5.3.3\"
  }
}
PKGJSON"
```

- [ ] **Step 3: Create tsconfig.json**

Write to `/opt/lead-machine/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "resolveJsonModule": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 4: Create .env with Supabase + API keys**

Write to `/opt/lead-machine/.env`:
```env
# Supabase (new project for lead-machine, or reuse existing)
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_key

# Groq (free tier — for edge-case scoring)
GROQ_API_KEY=from_keychain

# Scraper
SCRAPE_DELAY_MS=2500
MAX_LEADS_PER_SEARCH=50
LOG_LEVEL=info

# Scorer
PAGESPEED_API_KEY=
```
Note: PageSpeed API works without a key (lower rate limits). Key is optional.

- [ ] **Step 5: Create src/types.ts**

Write to `/opt/lead-machine/src/types.ts`:
```typescript
export interface LeadData {
  id?: string;
  name: string;
  company?: string;
  email?: string;
  phone?: string;
  website?: string;
  industry?: string;
  segment?: string;
  description?: string;
  address?: string;
  city?: string;
  state?: string;
  country: string;
  linkedin_url?: string;
  facebook_url?: string;
  instagram_url?: string;
  source_url?: string;
  is_scraped?: boolean;
}

export interface ScoreResult {
  bad_score: number;           // 0-100, higher = worse site (better lead)
  pagespeed_mobile: number;    // 0-100 from PageSpeed API
  pagespeed_desktop: number;
  is_mobile_responsive: boolean;
  uses_system_fonts: boolean;
  has_table_layout: boolean;
  no_https: boolean;
  missing_meta: boolean;
  color_count: number;
  breakdown: Record<string, number>;  // per-check scores
}

export interface ScoredLead extends LeadData {
  bad_score: number;
  score_result?: ScoreResult;
  status: LeadStatus;
}

export type LeadStatus =
  | 'scraped'
  | 'scored'
  | 'brand_extracted'
  | 'template_matched'
  | 'swapped'
  | 'quality_scored'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'deployed'
  | 'emailed'
  | 'clicked'
  | 'contacted'
  | 'expired'
  | 'converted';

export type Segment = 'law' | 'dental' | 'realestate' | 'construction';

export interface ScrapeResult {
  leads: LeadData[];
  errors: string[];
}
```

- [ ] **Step 6: Create src/config.ts**

Write to `/opt/lead-machine/src/config.ts`:
```typescript
import 'dotenv/config';

export const US_CITIES: Record<string, { lat: number; lng: number; state: string }> = {
  'New York':       { lat: 40.7128, lng: -74.0060, state: 'NY' },
  'Los Angeles':    { lat: 34.0522, lng: -118.2437, state: 'CA' },
  'Chicago':        { lat: 41.8781, lng: -87.6298, state: 'IL' },
  'Houston':        { lat: 29.7604, lng: -95.3698, state: 'TX' },
  'Phoenix':        { lat: 33.4484, lng: -112.0742, state: 'AZ' },
  'Philadelphia':   { lat: 39.9526, lng: -75.1652, state: 'PA' },
  'San Antonio':    { lat: 29.4241, lng: -98.4936, state: 'TX' },
  'San Diego':      { lat: 32.7157, lng: -117.1611, state: 'CA' },
  'Dallas':         { lat: 32.7767, lng: -96.7970, state: 'TX' },
  'Austin':         { lat: 30.2672, lng: -97.7431, state: 'TX' },
  'Jacksonville':   { lat: 30.3322, lng: -81.6557, state: 'FL' },
  'San Francisco':  { lat: 37.7749, lng: -122.4194, state: 'CA' },
  'Columbus':       { lat: 39.9612, lng: -82.9988, state: 'OH' },
  'Charlotte':      { lat: 35.2271, lng: -80.8431, state: 'NC' },
  'Indianapolis':   { lat: 39.7684, lng: -86.1581, state: 'IN' },
  'Seattle':        { lat: 47.6062, lng: -122.3321, state: 'WA' },
  'Denver':         { lat: 39.7392, lng: -104.9903, state: 'CO' },
  'Nashville':      { lat: 36.1627, lng: -86.7816, state: 'TN' },
  'Miami':          { lat: 25.7617, lng: -80.1918, state: 'FL' },
  'Atlanta':        { lat: 33.7490, lng: -84.3880, state: 'GA' },
};

export const SEGMENTS: Record<string, string[]> = {
  law: [
    'law firm', 'attorney', 'lawyer', 'legal services',
    'personal injury lawyer', 'criminal defense attorney',
    'divorce lawyer', 'immigration attorney', 'estate planning lawyer',
  ],
  dental: [
    'dentist', 'dental clinic', 'dental office', 'orthodontist',
    'family dentist', 'cosmetic dentist', 'pediatric dentist',
    'dental implants', 'teeth whitening',
  ],
  realestate: [
    'real estate agent', 'realtor', 'real estate agency',
    'property management', 'real estate broker',
    'homes for sale', 'real estate office',
  ],
  construction: [
    'general contractor', 'construction company', 'home builder',
    'roofing contractor', 'plumbing company', 'electrician',
    'remodeling contractor', 'landscaping company', 'HVAC contractor',
  ],
};

export const config = {
  supabase: {
    url: process.env.SUPABASE_URL || '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  },
  groq: {
    apiKey: process.env.GROQ_API_KEY || '',
  },
  scraper: {
    delayMs: parseInt(process.env.SCRAPE_DELAY_MS || '2500'),
    maxLeadsPerSearch: parseInt(process.env.MAX_LEADS_PER_SEARCH || '50'),
  },
  pagespeed: {
    apiKey: process.env.PAGESPEED_API_KEY || '',
  },
  logLevel: process.env.LOG_LEVEL || 'info',
};
```

- [ ] **Step 7: Install dependencies on server**

```bash
ssh root@178.104.47.126 "cd /opt/lead-machine && npm install 2>&1 | tail -5"
```

- [ ] **Step 8: Commit**

```bash
ssh root@178.104.47.126 "cd /opt/lead-machine && git init && git add -A && git commit -m 'task 1: project scaffold, config, types for US lead scraper'"
```

---

### Task 2: Utility Modules (Browser + Logger)

**Files:**
- Create: `/opt/lead-machine/src/utils/browser.ts`
- Create: `/opt/lead-machine/src/utils/logger.ts`

- [ ] **Step 1: Create logger.ts**

Write to `/opt/lead-machine/src/utils/logger.ts`:
```typescript
import winston from 'winston';
import { config } from '../config.js';

export const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) =>
      `[${timestamp}] ${level.toUpperCase().padEnd(5)} ${message}`
    ),
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: '/var/log/lead-machine/error.log', level: 'error' }),
    new winston.transports.File({ filename: '/var/log/lead-machine/combined.log' }),
  ],
});
```

- [ ] **Step 2: Create browser.ts**

Write to `/opt/lead-machine/src/utils/browser.ts`:
```typescript
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, Page } from 'puppeteer';

puppeteer.use(StealthPlugin());

let browser: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return browser;
}

export async function getPage(): Promise<Page> {
  const b = await getBrowser();
  const page = await b.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  return page;
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}
```

- [ ] **Step 3: Create log directory on server**

```bash
ssh root@178.104.47.126 "mkdir -p /var/log/lead-machine"
```

- [ ] **Step 4: Commit**

```bash
ssh root@178.104.47.126 "cd /opt/lead-machine && git add -A && git commit -m 'task 2: browser singleton with stealth + winston logger'"
```

---

### Task 3: Database Client + Leads Repository

**Files:**
- Create: `/opt/lead-machine/src/database/client.ts`
- Create: `/opt/lead-machine/src/database/leads.repo.ts`

- [ ] **Step 1: Create Supabase client**

Write to `/opt/lead-machine/src/database/client.ts`:
```typescript
import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';

export const supabase = createClient(config.supabase.url, config.supabase.serviceRoleKey);
```

- [ ] **Step 2: Create leads repository**

Write to `/opt/lead-machine/src/database/leads.repo.ts`:
```typescript
import { supabase } from './client.js';
import type { ScoredLead, LeadData, LeadStatus } from '../types.js';
import { logger } from '../utils/logger.js';

export async function insertLead(lead: LeadData): Promise<{ inserted: boolean; duplicate: boolean }> {
  // Dedup check on website or phone+city
  if (lead.website) {
    const { data } = await supabase.from('leads').select('id').eq('website', lead.website).limit(1);
    if (data && data.length > 0) return { inserted: false, duplicate: true };
  }
  if (lead.phone && lead.city) {
    const { data } = await supabase.from('leads').select('id').eq('phone', lead.phone).eq('city', lead.city).limit(1);
    if (data && data.length > 0) return { inserted: false, duplicate: true };
  }

  const { error } = await supabase.from('leads').insert({
    ...lead,
    status: 'scraped',
    created_at: new Date().toISOString(),
  });

  if (error) {
    logger.error(`Insert failed: ${error.message}`);
    return { inserted: false, duplicate: false };
  }
  return { inserted: true, duplicate: false };
}

export async function bulkInsertLeads(leads: LeadData[]): Promise<{ inserted: number; duplicates: number }> {
  let inserted = 0, duplicates = 0;
  for (const lead of leads) {
    const result = await insertLead(lead);
    if (result.inserted) inserted++;
    if (result.duplicate) duplicates++;
  }
  return { inserted, duplicates };
}

export async function getLeadsByStatus(status: LeadStatus, limit = 100): Promise<ScoredLead[]> {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('status', status)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) { logger.error(`Query failed: ${error.message}`); return []; }
  return data as ScoredLead[];
}

export async function updateLeadScore(id: string, bad_score: number, score_result: object): Promise<void> {
  await supabase.from('leads').update({
    bad_score,
    score_result,
    status: 'scored',
    updated_at: new Date().toISOString(),
  }).eq('id', id);
}

export async function updateLeadStatus(id: string, status: LeadStatus, extra?: object): Promise<void> {
  await supabase.from('leads').update({
    status,
    ...extra,
    updated_at: new Date().toISOString(),
  }).eq('id', id);
}
```

- [ ] **Step 3: Create Supabase leads table**

Run this SQL in Supabase SQL editor (or via CLI):
```sql
CREATE TABLE IF NOT EXISTS leads (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  company TEXT,
  email TEXT,
  phone TEXT,
  website TEXT,
  industry TEXT,
  segment TEXT,
  description TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  country TEXT DEFAULT 'US',
  linkedin_url TEXT,
  facebook_url TEXT,
  instagram_url TEXT,
  source_url TEXT,
  is_scraped BOOLEAN DEFAULT FALSE,
  bad_score INTEGER,
  score_result JSONB,
  brand JSONB,
  template_id TEXT,
  swap_version TEXT,
  swap_score INTEGER,
  swap_issues TEXT[],
  clone_dir TEXT,
  status TEXT DEFAULT 'scraped',
  deploy_url TEXT,
  deployed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  email_sent_at TIMESTAMPTZ,
  email_opened_at TIMESTAMPTZ,
  email_clicked_at TIMESTAMPTZ,
  claude_review JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_leads_status ON leads(status);
CREATE INDEX idx_leads_website ON leads(website);
CREATE INDEX idx_leads_segment ON leads(segment);
CREATE INDEX idx_leads_bad_score ON leads(bad_score);
```

- [ ] **Step 4: Commit**

```bash
ssh root@178.104.47.126 "cd /opt/lead-machine && git add -A && git commit -m 'task 3: supabase client + leads repo with dedup'"
```

---

### Task 4: Google Maps Scraper (US)

**Files:**
- Create: `/opt/lead-machine/src/scrapers/base.scraper.ts`
- Create: `/opt/lead-machine/src/scrapers/google-maps.scraper.ts`

- [ ] **Step 1: Create base scraper**

Write to `/opt/lead-machine/src/scrapers/base.scraper.ts`:
```typescript
import type { Page } from 'puppeteer';
import { getPage, closeBrowser } from '../utils/browser.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import type { LeadData, ScrapeResult } from '../types.js';

export abstract class BaseScraper {
  protected page: Page | null = null;

  abstract getName(): string;
  abstract scrape(query: string, city: string, state: string): Promise<ScrapeResult>;

  protected async getPage(): Promise<Page> {
    if (!this.page || this.page.isClosed()) {
      this.page = await getPage();
    }
    return this.page;
  }

  protected async resetPage(): Promise<void> {
    if (this.page && !this.page.isClosed()) {
      await this.page.close().catch(() => {});
    }
    this.page = null;
  }

  protected async delay(ms?: number): Promise<void> {
    const d = ms || config.scraper.delayMs;
    await new Promise(r => setTimeout(r, d + Math.random() * 1000));
  }

  protected log(msg: string): void {
    logger.info(`[${this.getName()}] ${msg}`);
  }

  protected normalizePhone(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return phone.trim();
  }

  protected normalizeUrl(url: string): string {
    if (!url) return '';
    url = url.trim();
    if (!url.startsWith('http')) url = 'https://' + url;
    try { return new URL(url).origin; } catch { return url; }
  }

  async close(): Promise<void> {
    await this.resetPage();
  }
}
```

- [ ] **Step 2: Create Google Maps US scraper**

Write to `/opt/lead-machine/src/scrapers/google-maps.scraper.ts`:
```typescript
import { BaseScraper } from './base.scraper.js';
import { US_CITIES } from '../config.js';
import { config } from '../config.js';
import type { LeadData, ScrapeResult } from '../types.js';

export class GoogleMapsScraper extends BaseScraper {
  getName() { return 'GoogleMaps-US'; }

  async scrape(query: string, city: string, state: string): Promise<ScrapeResult> {
    const leads: LeadData[] = [];
    const errors: string[] = [];
    const cityData = US_CITIES[city];
    if (!cityData) { errors.push(`City not found: ${city}`); return { leads, errors }; }

    try {
      const page = await this.getPage();
      const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query + ' ' + city + ' ' + state)}/@${cityData.lat},${cityData.lng},13z`;

      this.log(`Searching: "${query}" in ${city}, ${state}`);
      await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 60000 });
      await this.delay(4000);

      // Accept cookies if present
      try {
        const acceptBtn = await page.$('button[aria-label*="Accept"]');
        if (acceptBtn) await acceptBtn.click();
      } catch {}

      // Scroll results panel to load more
      for (let i = 0; i < 6; i++) {
        await page.evaluate(() => {
          const panel = document.querySelector('div[role="feed"]') || document.querySelector('.m6QErb');
          if (panel) panel.scrollBy(0, 3000);
        });
        await this.delay(1500);
      }

      // Extract businesses
      const raw = await page.evaluate(() => {
        const results: Array<{
          name: string; phone?: string; website?: string;
          address?: string; rating?: string; category?: string; url?: string;
        }> = [];

        const links = document.querySelectorAll('a[href*="/maps/place/"]');
        const seen = new Set<string>();

        links.forEach(link => {
          const container = link.closest('[jsaction]')?.parentElement;
          if (!container) return;
          const text = container.innerText || '';
          const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
          if (lines.length < 2) return;

          const name = lines[0];
          if (seen.has(name)) return;
          seen.add(name);

          let phone: string | undefined;
          let address: string | undefined;
          let website: string | undefined;
          let rating: string | undefined;
          let category: string | undefined;

          for (const line of lines) {
            if (/\(\d{3}\)\s*\d{3}[\-\s]\d{4}/.test(line) || /\+1[\s\-]?\d{3}[\s\-]?\d{3}[\s\-]?\d{4}/.test(line)) {
              phone = line.match(/[\+\(]?[\d\s\-\(\)]{10,}/)?.[0];
            }
            if (/\d+\.\d/.test(line) && line.includes('(')) {
              rating = line.match(/(\d[.,]\d)/)?.[1];
            }
            if (/\d+\s+\w/.test(line) && (line.includes('St') || line.includes('Ave') || line.includes('Blvd') || line.includes('Dr') || line.includes('Rd') || line.includes('Ln') || line.includes('Ct') || line.includes('#'))) {
              address = line;
            }
            if (line.length > 3 && line.length < 50 && /^[A-Za-z\s&,]+$/.test(line) && !phone && line !== name) {
              category = category || line;
            }
          }

          // Try to find website link
          const allLinks = container.querySelectorAll('a[href]');
          allLinks.forEach(a => {
            const href = (a as HTMLAnchorElement).href;
            if (href && !href.includes('google.com') && !href.includes('gstatic') && href.startsWith('http')) {
              website = href;
            }
          });

          results.push({ name, phone, website, address, rating, category, url: (link as HTMLAnchorElement).href });
        });

        return results;
      });

      for (const r of raw.slice(0, config.scraper.maxLeadsPerSearch)) {
        if (!r.phone && !r.website) continue;
        leads.push({
          name: r.name,
          company: r.name,
          phone: r.phone ? this.normalizePhone(r.phone) : undefined,
          website: r.website ? this.normalizeUrl(r.website) : undefined,
          address: r.address,
          city,
          state,
          country: 'US',
          industry: r.category,
          source_url: r.url,
          is_scraped: true,
        });
      }

      this.log(`Found ${leads.length} leads for "${query}" in ${city}`);
    } catch (err: any) {
      errors.push(`${city}/${query}: ${err.message?.slice(0, 100)}`);
      this.log(`Error: ${err.message?.slice(0, 100)}`);
      await this.resetPage();
    }

    return { leads, errors };
  }
}
```

- [ ] **Step 3: Commit**

```bash
ssh root@178.104.47.126 "cd /opt/lead-machine && git add -A && git commit -m 'task 4: google maps US scraper with stealth + phone normalization'"
```

---

### Task 5: Contact Extractor

**Files:**
- Create: `/opt/lead-machine/src/extractors/contact.extractor.ts`

- [ ] **Step 1: Create contact extractor**

Write to `/opt/lead-machine/src/extractors/contact.extractor.ts`:
```typescript
import { getPage } from '../utils/browser.js';
import { logger } from '../utils/logger.js';

const CONTACT_PATHS = ['', '/contact', '/contact-us', '/about', '/about-us'];
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(?:\+1[\s\-]?)?(?:\(?\d{3}\)?[\s\-]?)?\d{3}[\s\-]?\d{4}/g;

export async function extractContactInfo(websiteUrl: string): Promise<{
  email?: string;
  phone?: string;
  linkedin_url?: string;
  facebook_url?: string;
  instagram_url?: string;
}> {
  const result: any = {};
  const page = await getPage();

  try {
    for (const path of CONTACT_PATHS) {
      const url = websiteUrl.replace(/\/$/, '') + path;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(2000);
      } catch { continue; }

      const data = await page.evaluate(() => {
        const text = document.body?.innerText || '';
        const html = document.body?.innerHTML || '';
        const links = [...document.querySelectorAll('a[href]')].map(a => (a as HTMLAnchorElement).href);
        return { text, html, links };
      });

      // Emails
      if (!result.email) {
        const emails = data.text.match(EMAIL_RE) || [];
        const valid = emails.filter(e => !e.includes('example') && !e.includes('sentry') && !e.includes('wixpress'));
        if (valid.length > 0) result.email = valid[0];
      }

      // Phone
      if (!result.phone) {
        const phones = data.text.match(PHONE_RE) || [];
        if (phones.length > 0) result.phone = phones[0].trim();
      }

      // Social links
      for (const link of data.links) {
        if (!result.linkedin_url && link.includes('linkedin.com/')) result.linkedin_url = link;
        if (!result.facebook_url && link.includes('facebook.com/')) result.facebook_url = link;
        if (!result.instagram_url && link.includes('instagram.com/')) result.instagram_url = link;
      }

      // Stop if we found email (main goal)
      if (result.email) break;
    }
  } catch (err: any) {
    logger.debug(`Contact extraction failed for ${websiteUrl}: ${err.message?.slice(0, 80)}`);
  } finally {
    await page.close().catch(() => {});
  }

  return result;
}
```

- [ ] **Step 2: Commit**

```bash
ssh root@178.104.47.126 "cd /opt/lead-machine && git add -A && git commit -m 'task 5: contact extractor — email, phone, socials from lead websites'"
```

---

### Task 6: Bad Website Scorer

**Files:**
- Create: `/opt/lead-machine/src/scorer/pagespeed.ts`
- Create: `/opt/lead-machine/src/scorer/heuristics.ts`
- Create: `/opt/lead-machine/src/scorer/score.ts`
- Create: `/opt/lead-machine/tests/scorer.test.ts`

- [ ] **Step 1: Write scorer test**

Write to `/opt/lead-machine/tests/scorer.test.ts`:
```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { computeBadScore } from '../src/scorer/score.js';

describe('computeBadScore', () => {
  it('scores a terrible site high', () => {
    const result = computeBadScore({
      pagespeed_mobile: 25,
      pagespeed_desktop: 40,
      is_mobile_responsive: false,
      uses_system_fonts: true,
      has_table_layout: true,
      no_https: true,
      missing_meta: true,
      color_count: 30,
    });
    assert.ok(result.bad_score >= 70, `Expected >= 70, got ${result.bad_score}`);
  });

  it('scores a good site low', () => {
    const result = computeBadScore({
      pagespeed_mobile: 90,
      pagespeed_desktop: 95,
      is_mobile_responsive: true,
      uses_system_fonts: false,
      has_table_layout: false,
      no_https: false,
      missing_meta: false,
      color_count: 5,
    });
    assert.ok(result.bad_score <= 30, `Expected <= 30, got ${result.bad_score}`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
ssh root@178.104.47.126 "cd /opt/lead-machine && npx tsx --test tests/scorer.test.ts 2>&1 | tail -5"
```
Expected: FAIL — `computeBadScore` not found.

- [ ] **Step 3: Create PageSpeed wrapper**

Write to `/opt/lead-machine/src/scorer/pagespeed.ts`:
```typescript
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export async function getPageSpeedScores(url: string): Promise<{ mobile: number; desktop: number }> {
  const result = { mobile: 50, desktop: 50 };

  for (const strategy of ['mobile', 'desktop'] as const) {
    try {
      const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${strategy}${config.pagespeed.apiKey ? '&key=' + config.pagespeed.apiKey : ''}`;
      const res = await fetch(apiUrl, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) continue;
      const data = await res.json();
      const score = Math.round((data.lighthouseResult?.categories?.performance?.score || 0.5) * 100);
      result[strategy] = score;
    } catch (err: any) {
      logger.debug(`PageSpeed ${strategy} failed for ${url}: ${err.message?.slice(0, 60)}`);
    }
  }

  return result;
}
```

- [ ] **Step 4: Create heuristics checker**

Write to `/opt/lead-machine/src/scorer/heuristics.ts`:
```typescript
import { getPage } from '../utils/browser.js';
import { logger } from '../utils/logger.js';

export interface HeuristicResult {
  is_mobile_responsive: boolean;
  uses_system_fonts: boolean;
  has_table_layout: boolean;
  no_https: boolean;
  missing_meta: boolean;
  color_count: number;
}

export async function runHeuristics(url: string): Promise<HeuristicResult> {
  const result: HeuristicResult = {
    is_mobile_responsive: true,
    uses_system_fonts: false,
    has_table_layout: false,
    no_https: !url.startsWith('https'),
    missing_meta: false,
    color_count: 5,
  };

  const page = await getPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);

    // Mobile responsive check: render at 375px, check if horizontal scroll exists
    await page.setViewport({ width: 375, height: 812 });
    await page.waitForTimeout(1000);
    const hasHScroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 10);
    result.is_mobile_responsive = !hasHScroll;

    // Reset viewport
    await page.setViewport({ width: 1440, height: 900 });
    await page.waitForTimeout(500);

    const checks = await page.evaluate(() => {
      const body = document.body;
      const cs = getComputedStyle(body);

      // System fonts check
      const fonts = cs.fontFamily.toLowerCase();
      const systemFonts = ['arial', 'times new roman', 'georgia', 'verdana', 'helvetica', 'courier', 'comic sans', 'impact', 'tahoma'];
      const usesSystem = systemFonts.some(f => fonts.includes(f)) && !fonts.includes('custom') && document.fonts.size < 3;

      // Table layout check
      const tables = document.querySelectorAll('table');
      let layoutTables = 0;
      tables.forEach(t => {
        const rows = t.querySelectorAll('tr');
        if (rows.length > 1) {
          const cells = rows[0].querySelectorAll('td, th');
          if (cells.length >= 2) layoutTables++;
        }
      });

      // Meta tags check
      const hasOgImage = !!document.querySelector('meta[property="og:image"]');
      const hasDescription = !!document.querySelector('meta[name="description"]');
      const missingMeta = !hasOgImage || !hasDescription;

      // Color count (unique background colors)
      const colors = new Set<string>();
      document.querySelectorAll('*').forEach(el => {
        try {
          const bg = getComputedStyle(el).backgroundColor;
          if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') colors.add(bg);
        } catch {}
      });

      return {
        usesSystem,
        layoutTables: layoutTables > 2,
        missingMeta,
        colorCount: colors.size,
      };
    });

    result.uses_system_fonts = checks.usesSystem;
    result.has_table_layout = checks.layoutTables;
    result.missing_meta = checks.missingMeta;
    result.color_count = checks.colorCount;
  } catch (err: any) {
    logger.debug(`Heuristics failed for ${url}: ${err.message?.slice(0, 60)}`);
  } finally {
    await page.close().catch(() => {});
  }

  return result;
}
```

- [ ] **Step 5: Create score orchestrator**

Write to `/opt/lead-machine/src/scorer/score.ts`:
```typescript
import { getPageSpeedScores } from './pagespeed.js';
import { runHeuristics, type HeuristicResult } from './heuristics.js';
import { logger } from '../utils/logger.js';
import type { ScoreResult } from '../types.js';

interface ScoreInput {
  pagespeed_mobile: number;
  pagespeed_desktop: number;
  is_mobile_responsive: boolean;
  uses_system_fonts: boolean;
  has_table_layout: boolean;
  no_https: boolean;
  missing_meta: boolean;
  color_count: number;
}

export function computeBadScore(input: ScoreInput): ScoreResult {
  const breakdown: Record<string, number> = {};

  // PageSpeed (0-25 points): lower PageSpeed = higher bad score
  breakdown.pagespeed = Math.round(25 * (1 - (input.pagespeed_mobile / 100)));

  // Mobile responsive (0-15 points)
  breakdown.mobile = input.is_mobile_responsive ? 0 : 15;

  // System fonts (0-10 points)
  breakdown.fonts = input.uses_system_fonts ? 10 : 0;

  // Table layout (0-10 points)
  breakdown.tables = input.has_table_layout ? 10 : 0;

  // No HTTPS (0-10 points)
  breakdown.https = input.no_https ? 10 : 0;

  // Missing meta (0-10 points)
  breakdown.meta = input.missing_meta ? 10 : 0;

  // Excessive colors (0-10 points): >20 unique colors = dated design
  breakdown.colors = input.color_count > 20 ? 10 : input.color_count > 12 ? 5 : 0;

  // Image quality placeholder (0-10 points) — can be expanded later
  breakdown.images = 0;

  const bad_score = Math.min(100, Object.values(breakdown).reduce((a, b) => a + b, 0));

  return {
    bad_score,
    pagespeed_mobile: input.pagespeed_mobile,
    pagespeed_desktop: input.pagespeed_desktop,
    is_mobile_responsive: input.is_mobile_responsive,
    uses_system_fonts: input.uses_system_fonts,
    has_table_layout: input.has_table_layout,
    no_https: input.no_https,
    missing_meta: input.missing_meta,
    color_count: input.color_count,
    breakdown,
  };
}

export async function scoreSite(url: string): Promise<ScoreResult> {
  logger.info(`Scoring: ${url}`);

  const [pagespeed, heuristics] = await Promise.all([
    getPageSpeedScores(url),
    runHeuristics(url),
  ]);

  return computeBadScore({
    pagespeed_mobile: pagespeed.mobile,
    pagespeed_desktop: pagespeed.desktop,
    ...heuristics,
  });
}
```

- [ ] **Step 6: Run test to verify it passes**

```bash
ssh root@178.104.47.126 "cd /opt/lead-machine && npx tsx --test tests/scorer.test.ts 2>&1"
```
Expected: PASS — both tests green.

- [ ] **Step 7: Commit**

```bash
ssh root@178.104.47.126 "cd /opt/lead-machine && git add -A && git commit -m 'task 6: bad website scorer — pagespeed + 7 heuristics + tests'"
```

---

### Task 7: Scrape Cron Orchestrator

**Files:**
- Create: `/opt/lead-machine/src/scheduler/scrape.cron.ts`

- [ ] **Step 1: Create the daily orchestrator**

Write to `/opt/lead-machine/src/scheduler/scrape.cron.ts`:
```typescript
import { GoogleMapsScraper } from '../scrapers/google-maps.scraper.js';
import { extractContactInfo } from '../extractors/contact.extractor.js';
import { scoreSite } from '../scorer/score.js';
import { bulkInsertLeads, getLeadsByStatus, updateLeadScore } from '../database/leads.repo.js';
import { closeBrowser } from '../utils/browser.js';
import { logger } from '../utils/logger.js';
import { US_CITIES, SEGMENTS } from '../config.js';
import type { LeadData } from '../types.js';

function pickRandom<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

async function deduplicateLeads(leads: LeadData[]): Promise<LeadData[]> {
  const seen = new Map<string, LeadData>();
  for (const lead of leads) {
    const key = lead.website || `${lead.phone}:${lead.city}` || lead.name;
    if (!seen.has(key)) {
      seen.set(key, lead);
    } else {
      // Merge missing fields
      const existing = seen.get(key)!;
      if (!existing.email && lead.email) existing.email = lead.email;
      if (!existing.phone && lead.phone) existing.phone = lead.phone;
      if (!existing.website && lead.website) existing.website = lead.website;
    }
  }
  return [...seen.values()];
}

export async function runScrapeCron() {
  const startTime = Date.now();
  logger.info('═══ Lead Machine — Scrape Cycle Start ═══');

  const scraper = new GoogleMapsScraper();
  const allLeads: LeadData[] = [];
  const allErrors: string[] = [];

  // Pick 5 random cities per run (cycle through over multiple days)
  const cities = pickRandom(Object.keys(US_CITIES), 5);
  const segments = Object.keys(SEGMENTS);

  for (const city of cities) {
    const cityData = US_CITIES[city];
    logger.info(`City: ${city}, ${cityData.state}`);

    for (const segment of segments) {
      const queries = SEGMENTS[segment];
      const selected = pickRandom(queries, 2);

      for (const query of selected) {
        const result = await scraper.scrape(query, city, cityData.state);
        result.leads.forEach(l => { l.segment = segment; });
        allLeads.push(...result.leads);
        allErrors.push(...result.errors);
        await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
      }
    }

    await scraper.close();
  }

  // Deduplicate
  const deduped = await deduplicateLeads(allLeads);
  logger.info(`Scraped ${allLeads.length} raw → ${deduped.length} unique leads`);

  // Enrich: extract contact info for leads with website but no email
  let enriched = 0;
  for (const lead of deduped) {
    if (lead.website && !lead.email) {
      try {
        const contact = await extractContactInfo(lead.website);
        if (contact.email) { lead.email = contact.email; enriched++; }
        if (contact.phone && !lead.phone) lead.phone = contact.phone;
        if (contact.linkedin_url) lead.linkedin_url = contact.linkedin_url;
        if (contact.facebook_url) lead.facebook_url = contact.facebook_url;
        if (contact.instagram_url) lead.instagram_url = contact.instagram_url;
        await new Promise(r => setTimeout(r, 500));
      } catch {}
    }
  }
  logger.info(`Enriched ${enriched} leads with contact info`);

  // Insert to database
  const { inserted, duplicates } = await bulkInsertLeads(deduped);
  logger.info(`Inserted ${inserted}, skipped ${duplicates} duplicates`);

  // Score bad websites for newly inserted leads
  const newLeads = await getLeadsByStatus('scraped', 100);
  let scored = 0;
  for (const lead of newLeads) {
    if (!lead.website) continue;
    try {
      const scoreResult = await scoreSite(lead.website);
      await updateLeadScore(lead.id!, scoreResult.bad_score, scoreResult);
      scored++;
      logger.info(`  ${lead.name}: bad_score=${scoreResult.bad_score} (${lead.website})`);
    } catch (err: any) {
      logger.error(`  Score failed for ${lead.name}: ${err.message?.slice(0, 60)}`);
    }
  }

  await closeBrowser();

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  logger.info(`═══ Scrape Cycle Done ═══`);
  logger.info(`  Duration: ${elapsed}m`);
  logger.info(`  Leads: ${deduped.length} scraped, ${inserted} new, ${duplicates} dupe, ${enriched} enriched, ${scored} scored`);
  logger.info(`  Errors: ${allErrors.length}`);
  if (allErrors.length > 0) logger.info(`  First errors: ${allErrors.slice(0, 3).join(' | ')}`);
}

// Run if called directly
runScrapeCron().catch(err => {
  logger.error(`Cron failed: ${err.message}`);
  process.exit(1);
});
```

- [ ] **Step 2: Commit**

```bash
ssh root@178.104.47.126 "cd /opt/lead-machine && git add -A && git commit -m 'task 7: daily scrape cron — 5 cities x 4 segments x 2 queries + enrich + score'"
```

---

### Task 8: Integration Test + First Run

**Files:**
- Create: `/opt/lead-machine/tests/scraper.test.ts`

- [ ] **Step 1: Write a minimal integration test**

Write to `/opt/lead-machine/tests/scraper.test.ts`:
```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { GoogleMapsScraper } from '../src/scrapers/google-maps.scraper.js';

describe('GoogleMapsScraper', () => {
  it('finds leads for a US query', async () => {
    const scraper = new GoogleMapsScraper();
    const result = await scraper.scrape('dentist', 'Houston', 'TX');
    await scraper.close();
    console.log(`Found ${result.leads.length} leads, ${result.errors.length} errors`);
    assert.ok(result.leads.length > 0, 'Should find at least 1 lead');
    assert.ok(result.leads[0].name, 'Lead should have a name');
    assert.equal(result.leads[0].country, 'US');
    assert.equal(result.leads[0].city, 'Houston');
  });
});
```

- [ ] **Step 2: Run the integration test**

```bash
ssh root@178.104.47.126 "cd /opt/lead-machine && npx tsx --test tests/scraper.test.ts 2>&1 | tail -10"
```
Expected: PASS — finds leads for "dentist in Houston TX".

- [ ] **Step 3: Test the scorer on a real site**

```bash
ssh root@178.104.47.126 "cd /opt/lead-machine && npx tsx -e \"
import { scoreSite } from './src/scorer/score.js';
const r = await scoreSite('http://some-old-looking-site.com');
console.log(JSON.stringify(r, null, 2));
\"" 2>&1
```

- [ ] **Step 4: Commit**

```bash
ssh root@178.104.47.126 "cd /opt/lead-machine && git add -A && git commit -m 'task 8: integration tests for scraper + scorer'"
```

---

### Task 9: Cron Setup + Telegram Notification

**Files:**
- Modify: server crontab

- [ ] **Step 1: Add cron job for daily scraping**

```bash
ssh root@178.104.47.126 "(crontab -l 2>/dev/null; echo '0 2 * * * cd /opt/lead-machine && npx tsx src/scheduler/scrape.cron.ts >> /var/log/lead-machine/scrape.log 2>&1') | crontab -"
```

- [ ] **Step 2: Add Telegram notification to end of scrape.cron.ts**

Append to the end of `runScrapeCron()`, before the final catch:
```typescript
// Telegram notification
try {
  const msg = `🔍 Lead Machine Scrape Done\nLeads: ${inserted} new, ${scored} scored\nDuration: ${elapsed}m`;
  await fetch(`https://api.telegram.org/bot8615176967:AAE66n6dJm58UfmofUyEllBgcmHLzlPOo-A/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: '6414673343', text: msg }),
  });
} catch {}
```

- [ ] **Step 3: Commit**

```bash
ssh root@178.104.47.126 "cd /opt/lead-machine && git add -A && git commit -m 'task 9: cron setup + telegram notification'"
```

---

## Verification

After all 9 tasks, the system should:

1. `npx tsx --test tests/scorer.test.ts` — PASS
2. `npx tsx --test tests/scraper.test.ts` — PASS (finds real US leads)
3. `npx tsx src/scheduler/scrape.cron.ts` — runs full cycle: scrapes 5 cities x 4 segments, enriches, scores, inserts to Supabase
4. Supabase `leads` table has rows with `status='scored'` and `bad_score` values
5. Telegram notification received on completion
6. Cron scheduled for 2:00 AM UTC daily

This is the foundation. Plan 2 (Template Finder + Library) and Plan 3 (Brand Extractor) build on top of this data.
