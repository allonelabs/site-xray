# Lead Machine — Full System Design Spec

**Project:** Clonica — automated web redesign lead generation
**Date:** 2026-04-02
**Status:** Design approved, ready for implementation planning

---

## 1. What It Does

Finds US businesses with bad websites, clones the best site in their industry (from Awwwards/CSS Awards), swaps in their brand (logo, images, text, colors, contacts), scores quality (code + Claude deep review), gets human approval, deploys a live demo, and sends a personalized cold email with the demo link. Demos auto-delete after 5 days if no response.

**Brand:** Clonica (white-label identity for outreach)
**Domain:** clonica.com (or similar, TBD)

---

## 2. Numbers

| Metric | Target |
|--------|--------|
| Leads scraped per day | 100 |
| Emails sent per day | 100 |
| Demos deployed per day | 10 (quality-gated) |
| Demo lifespan | 5 days |
| Max active demos | ~50 (10/day x 5 days) |
| Starting segments | 4 (law, dental, real estate, construction) |

---

## 3. Three-Layer Architecture

### Layer 1: Sub-Automations (self-improving)

| System | Status | Evolution |
|--------|--------|-----------|
| X-Ray Cloner (v13+) | Running on server, evolves every 6h | Existing |
| Site Swapper (v4+) | Needs universal rewrite from v3 | New, same evolution pattern as X-Ray |

Both improve autonomously. Better clones feed better swaps. Better swaps feed better demos. Compound improvement.

### Layer 2: Main Pipeline

```
SCRAPE → SCORE BAD → EXTRACT BRAND → MATCH TEMPLATE → SWAP → QUALITY GATE → APPROVE → DEPLOY → EMAIL → TRACK → CLEANUP
```

14 steps, daily automated cycle with human approval gate.

### Layer 3: Dashboard

Extends existing X-Ray dashboard (http://178.104.47.126:3847). Adds:
- Pipeline status view
- Approval queue with side-by-side comparison
- Email analytics
- Conversion tracking

---

## 4. Pipeline Steps — Detailed

### Step 1: SCRAPE (100% Code)

Adapted from existing Georgian scraper at `/Users/macintoshi/projects/allone-perf/scraper/`.

**Changes from Georgian version:**
- Cities: 30-50 major US cities (New York, LA, Chicago, Houston, Phoenix, etc.)
- Phone format: +1 (XXX) XXX-XXXX
- Sources: Google Maps only (Yell.ge and 2GIS removed)
- Language: English queries only
- Segments: law, dental, real estate, construction (expandable)

**Per-lead data collected:**
- company_name, website, phone, email, address, city, state
- industry, segment
- source_url (Google Maps listing)

**Tech:** Puppeteer + stealth plugin, Supabase insert, deduplication on website+phone.

### Step 2: SCORE BAD SITE (Hybrid: Code primary, Groq edge cases)

**Code heuristics (run on every lead, free, fast):**

| Check | Method | Points |
|-------|--------|--------|
| PageSpeed Mobile | Google PageSpeed API | 0-25 |
| Mobile responsive | Playwright: render at 375px, check reflow | 0-15 |
| Uses system fonts | Detect font-family: Arial/Times/Georgia | 0-10 |
| Table-based layout | Count `<table>` used for layout (not data) | 0-10 |
| No HTTPS | URL starts with http:// | 0-10 |
| Missing meta tags | No og:image, no description | 0-10 |
| Image quality | Check for low-res/pixelated images | 0-10 |
| Color palette | Count unique colors (>20 = dated) | 0-10 |

**Score 0-100. Higher = worse site (better lead for us).**

- Score 60+: Definitely bad, proceed
- Score 40-60: Ambiguous, send screenshot to Groq for classification
- Score <40: Site is decent, skip this lead

**Groq edge case prompt:** "Rate this website screenshot 1-10 for modern design quality. Consider: layout, typography, whitespace, visual hierarchy. Reply with just the number."

### Step 3: EXTRACT BRAND (Hybrid: Code primary, Groq for unstructured text)

**Code extracts (from lead's bad website via Playwright):**
- Company name: `<title>`, `og:title`, `<h1>`, schema.org `name`
- Logo: `<img>` near `<header>`, favicon, `og:image`, apple-touch-icon
- Colors: CSS custom properties, computed styles of body/header/buttons → extract primary, secondary, accent
- Phone: regex patterns for US phone numbers
- Email: regex patterns, `mailto:` links, contact page scan
- Address: schema.org `address`, Google Maps link parsing, footer text
- Social links: href patterns for linkedin, facebook, instagram, twitter
- Services: navigation items (filter out generic: Home, About, Contact)
- Images: hero images, team photos, portfolio images

**Groq assists with (unstructured content only):**
- "Summarize what this company does in 2 sentences" (from messy about page)
- "List the services this company offers" (when nav is unclear)
- "Write a tagline for this company based on their website" (when none exists)

**Output:** `lead.brand` object with all assets downloaded to `data/brands/{lead-id}/`

### Step 4: MATCH TEMPLATE (100% Code)

Lookup in template library by industry. Each industry has 3-5 pre-cloned award-winning templates.

**Template Library structure:**
```json
{
  "law": [
    { "id": "t-law-01", "url": "https://awwwards-winner.com", "clone_dir": "/opt/lead-machine/templates/clones/t-law-01", "score": 94 },
    { "id": "t-law-02", ... }
  ],
  "dental": [...],
  "realestate": [...],
  "construction": [...]
}
```

**Selection logic:** Pick highest-scoring template in lead's industry. Round-robin if multiple templates have similar scores (avoids sending same design to competing businesses in same city).

### Step 5: CLONE (100% Code — X-Ray)

If template isn't already cloned (or X-Ray version improved since last clone):
```bash
node /opt/site-xray/v{latest}-stable.js {template-url} {clone-dir} 5
```

Most templates are pre-cloned. This step only runs for new templates or re-clones after X-Ray improves.

### Step 6: SWAP (100% Code for HTML manipulation, Groq for text rewriting)

**Universal Swapper v4 architecture:**

Phase A — Template Map (one-time per template, Claude):
Claude reads template HTML and generates a JSON content map:
```json
{
  "hero_title": { "selector": ".hero h1", "type": "text" },
  "hero_subtitle": { "selector": ".hero p.subtitle", "type": "text" },
  "hero_image": { "selector": ".hero img, .hero [style*=background]", "type": "image" },
  "logo": { "selector": "header img, .logo img", "type": "image" },
  "nav_items": { "selector": "nav a", "type": "nav" },
  "services": { "selector": ".services .card, .practice-areas li", "type": "repeating", "fields": ["title", "description", "icon"] },
  "about_text": { "selector": ".about p, #about p", "type": "text" },
  "phone": { "selector": "a[href^='tel:'], .phone", "type": "contact" },
  "email": { "selector": "a[href^='mailto:'], .email", "type": "contact" },
  "address": { "selector": ".address, [itemprop='address']", "type": "contact" },
  "footer_name": { "selector": "footer .company-name, footer .copyright", "type": "text" },
  "social_links": { "selector": "a[href*='linkedin'], a[href*='facebook']", "type": "social" },
  "team_members": { "selector": ".team .member, .people .card", "type": "repeating", "fields": ["name", "title", "image"] },
  "testimonials": { "selector": ".testimonial, .review", "type": "repeating", "fields": ["quote", "author"] }
}
```
Cached at `templates/maps/{template-id}.json`. Never regenerated unless template changes.

Phase B — Content Generation (Groq, per lead):
For each text field in the map, Groq rewrites content:
- Hero title: "Write a hero headline for {company_name}, a {industry} in {city}"
- About: "Rewrite this about section for {company_name}: {lead.brand.about}"
- Services: "Write 50-word descriptions for each: {lead.brand.services}"

Phase C — HTML Swap (Code, per lead):
```javascript
// For each field in template map:
document.querySelector(map.hero_title.selector).textContent = generatedContent.hero_title;
document.querySelector(map.logo.selector).src = lead.brand.logo_local;
// CSS color override:
html = html.replace(/--primary:\s*#[0-9a-f]+/gi, `--primary: ${lead.brand.colors.primary}`);
// Replace all instances of template company name:
html = html.replaceAll(templateCompanyName, lead.brand.name);
// Replace phone, email, address, social links...
```

Phase D — Asset Injection (Code):
- Copy lead's logo to clone `/images/brand/`
- Copy lead's images to clone `/images/`
- Replace all template image references
- Strip analytics/tracking
- Add Clonica watermark/banner

### Step 7: CODE PRE-SCREENING (100% Code)

Run existing test suite metrics on the swapped clone:

| Check | Pass threshold |
|-------|---------------|
| All images render (naturalWidth > 0) | 100% |
| Zero console JS errors | 0 errors |
| No references to template domain | 0 matches |
| No references to template company name | 0 matches |
| Brand colors applied in CSS | Colors match lead.brand.colors |
| Logo file exists and referenced | File exists + src points to it |
| Lead's phone appears in HTML | grep finds it |
| Lead's company name appears 3+ times | grep count >= 3 |
| Page has >500 chars visible text | innerText.length > 500 |
| Links don't 404 | Internal link check |

**Score 0-100. Must score 80+ to proceed to Claude review.**

~30-40 of 100 swaps should pass this gate daily.

### Step 8: CLAUDE QUALITY GATE (Claude — deep code review)

For each swap that passes code screening, Claude does a thorough review:

**What Claude reads:**
1. The swapped HTML source (full file)
2. The original template HTML (for comparison)
3. The lead's brand data JSON (what should be in the swap)
4. Screenshot of the swapped site (visual check)
5. Pixel diff image (template vs swapped — highlights unexpected changes)
6. The template content map (which selectors should have which content)

**What Claude evaluates:**
1. **Brand Coverage** — Is every piece of brand data placed?
   - Company name appears in: title, hero, footer, meta tags (count occurrences)
   - Phone appears in: header, footer, contact section
   - Email appears in: contact section, footer
   - Address appears somewhere
   - All services listed
   - Logo rendered correctly
2. **Content Coherence** — Does the text make sense?
   - Hero headline relates to the company's actual business
   - About section describes the actual company
   - Services match what the company actually offers
   - No template placeholder text remaining ("Lorem ipsum", "Your Company Name Here")
3. **Visual Integrity** — Does it look professional?
   - Read screenshot: layout not broken, colors harmonious, text readable
   - Read pixel diff: changes are in expected content areas, not structural breakage
   - No broken image placeholders visible
4. **Industry Match** — Template fits the lead's industry
   - Law firm template used for law firm (not dental content in law template)
5. **No Leaks** — Zero traces of original template identity
   - grep for template company name, domain, phone, email

**Claude outputs:**
```json
{
  "score": 87,
  "pass": true,
  "brand_coverage": {
    "name": { "expected": 12, "found": 11, "missing_in": ["footer copyright"] },
    "phone": { "expected": 3, "found": 3 },
    "services": { "expected": 7, "found": 7 },
    "logo": "rendered correctly"
  },
  "issues": [
    "Footer copyright still says 'Template Firm LLP' — needs swap",
    "Team section has placeholder headshots — acceptable (lead has no team photos)"
  ],
  "recommendation": "APPROVE with minor footer fix"
}
```

**Pass threshold:** score >= 75 AND no critical issues (template name leak, wrong industry)

~10-15 of ~30 should pass Claude review daily.

### Step 9: APPROVAL QUEUE (Human — via Dashboard)

Dashboard page shows each Claude-approved swap:
- Side-by-side: original template screenshot vs swapped screenshot
- Claude's score + issues list
- Lead info card (company, website, phone, location)
- Brand data summary
- Two buttons: **APPROVE** / **REJECT**
- Optional: text field for rejection reason (feeds back to swapper knowledge base)

Human approves top 10. Rejected ones get feedback stored for swapper improvement.

**Telegram notification:** "15 demos ready for review. Top scored: 92, 89, 87... Review at http://178.104.47.126:3847/approve"

### Step 10: DEPLOY (100% Code)

On approval, auto-deploy:
```bash
# Copy clone to demos directory
cp -r /opt/lead-machine/swapper/output/{lead-id}/ /var/www/demos/{slug}/

# Nginx config (wildcard subdomain)
# *.demos.clonica.com → /var/www/demos/{subdomain}/
```

**DNS setup:** `*.demos.clonica.com` → `178.104.47.126`
**Nginx:** wildcard server block serves matching subdomain directory

**URL format:** `https://fisher-stone.demos.clonica.com`

**Set expiry:** `deployed_at = now()`, `expires_at = now() + 5 days`

### Step 11: EMAIL (Hybrid: Code template + Groq personalization)

**From:** `hello@clonica.com` (new Resend domain)
**Subject line:** Groq generates personalized subject
**Body:** HTML template with:
- Personalized opening (Groq)
- "We noticed your website at {lead.website} could be much better"
- Screenshot comparison: their current site vs the demo
- CTA button: "See Your New Website" → demo URL
- Only 10/day have demo links. Other 90 get: "We can build something like this for you" with a portfolio link

**Warm-up schedule:**
- Week 1: 10 emails/day
- Week 2: 25/day
- Week 3: 50/day
- Week 4: 100/day

**CAN-SPAM compliance:**
- Physical address in footer
- Unsubscribe link
- Honest subject line
- Company identification

### Step 12: TRACK (100% Code)

Track via Resend webhooks or email pixel:
- `email_sent_at`
- `email_opened_at` (tracking pixel)
- `email_clicked_at` (link click tracking)
- `demo_visited_at` (nginx access log for demo subdomain)
- `contacted_at` (manual update when lead responds)

### Step 13: CLEANUP (100% Code)

Daily cron:
```bash
# Find demos older than 5 days with no contact
# Delete directory + remove from nginx
# Update lead status to "expired"
```

### Step 14: REPORT (100% Code + Telegram)

Daily Telegram summary:
```
Clonica Daily Report
---
Scraped: 100 leads
Bad sites found: 72
Brands extracted: 68
Swaps created: 65
Code screening passed: 32
Claude approved: 14
You approved: 10
Deployed: 10
Emails sent: 100 (10 with demos)
---
Demo clicks: 3 (yesterday's batch)
Responses: 1
Active demos: 47
Expiring today: 8
```

---

## 5. Self-Improving Sub-Systems

### X-Ray Evolution (existing)
- Runs every 6 hours on server
- Improves cloning quality across all site types
- When X-Ray improves, templates can be re-cloned for better quality
- Dashboard: http://178.104.47.126:3847

### Swapper Evolution (new — same architecture)

Mirrors X-Ray's self-improvement cycle:

**Test sites:** 8 template+brand combinations (manually curated gold standard)
**Scoring:** Same 9 metrics as X-Ray + brand coverage metrics
**Cycle:**
1. Test current swapper on 8 test cases
2. Score each (code metrics + brand coverage)
3. Claude analyzes failures, implements fixes
4. Re-test, accept if improved, reject if regressed
5. Knowledge base tracks what works/fails

**Evolution frequency:** Every 12 hours

**Key difference from X-Ray:** Swapper evolution tests BOTH visual fidelity AND content accuracy. A perfect swap means the site looks identical to the template except all content is the lead's.

---

## 6. Infrastructure

| Component | Location | Purpose |
|-----------|----------|---------|
| Hetzner server | 178.104.47.126 | Scraping, cloning, swapping, scoring, demo hosting |
| Supabase | Cloud | Lead database, pipeline state, email logs |
| Resend | Cloud | Email delivery (clonica.com domain) |
| Groq | Cloud (free) | Text rewriting, email personalization |
| Claude Code | Server (subscription) | Quality gate, template mapping, evolution cycles |
| Telegram | @xrayevolve_bot (or new) | Notifications |
| Nginx | Hetzner | Demo hosting via wildcard subdomains |

### Server directory structure
```
/opt/
├── site-xray/                  # EXISTING — cloner + evolution
│   ├── v13-stable.js
│   ├── test/
│   ├── improve/
│   └── dashboard/
│
├── lead-machine/               # NEW — main automation
│   ├── scraper/                # US lead scraper
│   │   ├── src/
│   │   └── package.json
│   ├── scorer/                 # Bad website scorer
│   │   └── score.js
│   ├── extractor/              # Brand content extractor
│   │   └── extract.js
│   ├── templates/              # Template library
│   │   ├── finder.js           # Awwwards scraper
│   │   ├── library.json        # Template index
│   │   ├── maps/               # Claude-generated content maps
│   │   └── clones/             # Pre-cloned template files
│   ├── swapper/                # Universal content swapper
│   │   ├── v4-stable.js
│   │   ├── test/               # Swapper test suite
│   │   └── improve/            # Swapper evolution cycle
│   ├── quality/                # Quality scoring
│   │   ├── code-screen.js      # Automated code checks
│   │   └── claude-review.js    # Claude deep review prompt
│   ├── deployer/               # Vercel deploy + cleanup
│   │   ├── deploy.js
│   │   └── cleanup.js
│   ├── email/                  # Campaign system
│   │   ├── templates/          # HTML email templates
│   │   ├── send.js
│   │   └── track.js
│   ├── pipeline.js             # Main orchestrator
│   ├── cron.js                 # Scheduled jobs
│   └── dashboard/              # Master dashboard (extends existing)
│
└── /var/www/demos/             # Deployed demo sites
    ├── fisher-stone/
    ├── smith-dental/
    └── ...
```

---

## 7. Database Schema (Supabase)

### leads table
All fields from Step 1-12 data model. Key columns:
- `id`, `company_name`, `website`, `phone`, `email`, `address`, `city`, `state`
- `industry`, `segment`, `bad_score`
- `brand` (JSONB — full brand extraction)
- `template_id`, `swap_version`, `swap_score`
- `status` (enum: scraped → scored → brand_extracted → template_matched → swapped → quality_scored → pending_approval → approved → rejected → deployed → emailed → clicked → contacted → expired → converted)
- `deploy_url`, `deployed_at`, `expires_at`
- `email_sent_at`, `email_opened_at`, `email_clicked_at`
- `claude_review` (JSONB — full Claude quality gate output)

### templates table
- `id`, `url`, `industry`, `source` (awwwards/cssawards)
- `clone_dir`, `clone_version`, `clone_score`
- `content_map` (JSONB — Claude-generated selector map)
- `swap_count`, `response_rate`
- `is_ready`, `created_at`

### email_campaigns table
- `id`, `name`, `from_email`, `template_id`
- `target_segment`, `daily_limit`
- `is_active`, `warmup_stage`

### email_logs table
- `id`, `lead_id`, `campaign_id`
- `to_email`, `subject`, `status`
- `sent_at`, `opened_at`, `clicked_at`

---

## 8. AI Usage Summary

| Task | Model | Frequency | Cost |
|------|-------|-----------|------|
| Template content mapping | Claude (subscription) | ~50 total (one-time per template) | Minimal |
| Quality gate review | Claude (subscription) | ~30/day (code-screened candidates) | Moderate |
| X-Ray evolution | Claude (subscription) | 4 cycles/day, 50 turns each | Existing |
| Swapper evolution | Claude (subscription) | 2 cycles/day, 50 turns each | Moderate |
| Text rewriting | Groq (free) | 100/day | Free |
| Email personalization | Groq (free) | 100/day | Free |
| Bad site edge cases | Groq (free) | ~30/day | Free |

**Total Claude usage:** ~30 quality reviews/day + 6 evolution cycles/day. Fits within subscription.
**Total Groq usage:** ~230 calls/day. Within free tier (10K/month).

---

## 9. Daily Schedule (Server Cron)

| Time (UTC) | Job | Duration |
|------------|-----|----------|
| 00:00 | X-Ray evolution cycle | ~30 min |
| 02:00 | Lead scraper (100 US leads) | ~60 min |
| 03:00 | Bad website scorer | ~30 min |
| 04:00 | Brand extractor | ~60 min |
| 05:00 | Template matcher + swapper | ~45 min |
| 06:00 | Code pre-screening | ~15 min |
| 06:00 | X-Ray evolution cycle | ~30 min |
| 07:00 | Claude quality reviews (~30) | ~30 min |
| 08:00 | Telegram: "N demos ready for review" | Instant |
| MANUAL | Human reviews + approves | Variable |
| ON APPROVE | Deploy + email | ~5 min per demo |
| 12:00 | X-Ray evolution cycle | ~30 min |
| 14:00 | Swapper evolution cycle | ~30 min |
| 18:00 | X-Ray evolution cycle | ~30 min |
| 20:00 | Demo cleanup (5-day expiry) | ~2 min |
| 21:00 | Daily report (Telegram) | Instant |

---

## 10. Build Phases

### Phase 1: Foundation (supply chains)
- [ ] Adapt lead scraper for US market
- [ ] Build bad website scorer
- [ ] Build Awwwards/CSS Awards template finder
- [ ] Clone initial template library (3-5 per segment, 4 segments = 15-20 templates)
- [ ] Set up Supabase schema

### Phase 2: Core Engine
- [ ] Build brand extractor (upgrade from existing deep-extract.js)
- [ ] Build universal swapper v4 (Claude template mapping + code swap)
- [ ] Build code pre-screening
- [ ] Build Claude quality gate
- [ ] Build approval queue UI (dashboard page)

### Phase 3: Output Pipeline
- [ ] Set up clonica.com domain + DNS
- [ ] Nginx wildcard subdomain config
- [ ] Auto-deployer
- [ ] Email system (Resend + Groq personalization)
- [ ] 5-day cleanup cron
- [ ] Telegram notifications

### Phase 4: Intelligence
- [ ] Swapper self-evolution (test suite + improvement cycle)
- [ ] Template re-cloning when X-Ray improves
- [ ] Segment ROI tracking
- [ ] Template performance ranking

### Phase 5: Polish
- [ ] Master dashboard (unified pipeline view)
- [ ] Clonica white-label website
- [ ] Email analytics page
- [ ] Conversion funnel visualization

---

## 11. Success Metrics

| Metric | Week 1 | Month 1 | Month 3 |
|--------|--------|---------|---------|
| Leads/day | 20 (warmup) | 100 | 100 |
| Emails/day | 10 (warmup) | 100 | 100 |
| Demos/day | 2-3 | 10 | 10 |
| Demo click rate | ? | 15-25% | 20-30% |
| Response rate | ? | 3-5% | 5-8% |
| Conversions/month | 0 | 5-10 | 15-25 |

At $2-5K per web redesign project, 10 conversions/month = $20-50K revenue from a fully automated system.
