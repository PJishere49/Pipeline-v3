const fs = require('fs');
const { chromium } = require('playwright');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

async function sendTelegram(photoBuffer, caption) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`;
    const formData = new FormData();
    formData.append('chat_id', TELEGRAM_CHAT_ID);
    formData.append('photo', new Blob([photoBuffer]), 'screenshot.jpg');
    formData.append('caption', caption);
    await fetch(url, { method: 'POST', body: formData });
  } catch (e) {
    console.error("Telegram send failed:", e.message);
  }
}

function createFinding(check_id, status, grade, observation, impact, fix, test_method = 'Playwright 390x844') {
  return {
    finding_id: `hash_${check_id}_${Date.now()}`,
    check_id,
    status,
    scope: 'page',
    url: '', 
    page_role: 'homepage',
    observation,
    test_method,
    evidence_grade: grade,
    fix_category: 'maintenance',
    effort_hours: 1,
    customer_impact: impact,
    blocked_action: 'User cannot complete conversion goal',
    recommended_fix: fix,
    verification_method: 'Re-run audit',
    financial_tier: 'none'
  };
}

async function analyzeSemantics(title, h1, bodyText) {
  const prompt = `You are a CRO expert. Business: "${title}". H1: "${h1}". Text: "${bodyText.substring(0, 1500)}". Answer ONLY with a JSON object: 1. "clarity_score": 1-5 (1=vague, 5=perfect). 2. "trust_signals": true/false (are there real reviews, guarantees, or credentials?).`;
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], temperature: 0.1, response_format: { type: "json_object" } })
    });
    if (!res.ok) return { clarity_score: null, trust_signals: null };
    const data = await res.json();
    return JSON.parse(data.choices[0].message.content);
  } catch (e) { 
    return { clarity_score: null, trust_signals: null }; 
  }
}

function calculatePriority(findings) {
  let score = 100;
  const seenChecks = new Set();
  for (const f of findings) {
    if (f.status === 'fail' && !seenChecks.has(f.check_id)) {
      seenChecks.add(f.check_id);
      if (f.evidence_grade === 'A') score -= 30;
      if (f.evidence_grade === 'B') score -= 15;
      if (f.evidence_grade === 'C') score -= 10;
    }
  }
  return Math.max(0, score);
}

async function measurePerformance(browser, url) {
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const client = await context.newCDPSession(page);
    
    await client.send('Network.emulateNetworkConditions', {
      offline: false, latency: 150, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8
    });
    await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });

    await page.addInitScript(() => {
      window.lcp = 0;
      window.cls = 0;
      new PerformanceObserver((entryList) => {
        const entries = entryList.getEntries();
        const lastEntry = entries[entries.length - 1];
        window.lcp = lastEntry.startTime;
        window.lcpElement = lastEntry.element;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
      
      new PerformanceObserver((entryList) => {
        for (const entry of entryList.getEntries()) {
          if (!entry.hadRecentInput) window.cls += entry.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    });

    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForTimeout(1000);

      const metrics = await page.evaluate(() => {
        const fcp = performance.getEntriesByType('paint').find(e => e.name === 'first-contentful-paint')?.startTime || 0;
        return { lcp: window.lcp || 0, cls: window.cls || 0, fcp: fcp };
      });
      runs.push(metrics);
    } catch (e) {}
    await context.close();
  }

  if (runs.length === 0) return { lcp: 0, cls: 0, fcp: 0 };
  
  runs.sort((a, b) => a.lcp - b.lcp);
  return runs[Math.floor(runs.length / 2)];
}

async function runCrawler() {
  const prospects = JSON.parse(fs.readFileSync('prospects.json', 'utf8'));
  const results = [];
  const reviewManually = [];
  const limit = 5; 
  const subset = prospects.slice(0, limit);
  
  const browser = await chromium.launch({ args: ['--disable-http2'] });
  
  for (const prospect of subset) {
    const context = await browser.newContext({ 
      viewport: { width: 390, height: 844 }, 
      userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      ignoreHTTPSErrors: false 
    });
    const page = await context.newPage();
    const findings = [];
    let crawlDiagnostics = { http_status: 200, waf_blocked: false, ssl_error: false, dead_site: false };
    let pageData = null;
    let siteMap = [];
    let analyticsDetected = false;

    page.on('request', req => {
      const url = req.url();
      if (url.includes('google-analytics.com') || url.includes('googletagmanager.com') || url.includes('facebook.net')) {
        analyticsDetected = true;
      }
    });

    try {
      // 1. Fetch Sitemap
      try {
        const sitemapRes = await context.request.get(new URL('/sitemap.xml', prospect.url).href);
        if (sitemapRes.ok()) {
          const xml = await sitemapRes.text();
          siteMap = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]);
        }
      } catch(e) {}

      // 2. Go to page
      let response;
      try {
        response = await page.goto(prospect.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (err) {
        if (err.message.includes('ERR_CERT_') || err.message.includes('ERR_SSL_')) {
          findings.push(createFinding('7.1', 'fail', 'A', 'Invalid or Expired SSL Certificate', 'Users are blocked by browser security warnings.', 'Install a valid SSL certificate.'));
          results.push({ url: prospect.url, title: prospect.title, priorityScore: 70, findings, status: 'scored', existing_pages: [] });
          await context.close();
          continue;
        } else {
          throw err; 
        }
      }

      if (response) {
        crawlDiagnostics.http_status = response.status();
        const pageText = await page.content();
        
        if (response.status() >= 400) {
          crawlDiagnostics.dead_site = true;
          findings.push(createFinding('7.1', 'fail', 'A', `Site Down (HTTP ${response.status()})`, 'The site is unreachable.', 'Fix server configuration.'));
          results.push({ url: prospect.url, title: prospect.title, priorityScore: 0, findings, status: 'scored', existing_pages: [] });
          await context.close();
          continue;
        }

        if (pageText.includes('Access Denied') || pageText.includes('Just a moment')) {
          crawlDiagnostics.waf_blocked = true;
          reviewManually.push({ url: prospect.url, title: prospect.title, reason: 'WAF / Bot Blocked', diagnostics: crawlDiagnostics });
          await context.close();
          continue;
        }
      }

      await page.waitForTimeout(3000);

      // 3. DOM Checks and Highlighting
      pageData = await page.evaluate(() => {
        const getStyle = (el) => window.getComputedStyle(el);
        const h1El = document.querySelector('h1') || document.body;
        
        const forms = Array.from(document.querySelectorAll('form'));
        let bestForm = null;
        let maxInputs = 0;
        for (const f of forms) {
          const inputs = f.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], textarea').length;
          if (inputs > maxInputs) { maxInputs = inputs; bestForm = f; }
        }
        
        let visibleFields = 0;
        if (bestForm) {
          const inputs = Array.from(bestForm.querySelectorAll('input, select, textarea'));
          visibleFields = inputs.filter(el => {
            const type = el.getAttribute('type');
            const rect = el.getBoundingClientRect();
            return type !== 'hidden' && type !== 'submit' && type !== 'button' && type !== 'checkbox' && rect.width > 0 && rect.height > 0;
          }).length;
        }

        const primaryBtns = Array.from(document.querySelectorAll('button, a[class*="btn" i], a[class*="button" i], a[class*="cta" i]'));
        let primaryCta = primaryBtns.find(b => /contact|quote|schedule|estimate|get started|call/i.test(b.innerText));
        let ctaStatus = 'none';
        if (primaryCta) {
          if (primaryCta.tagName === 'A') {
            const href = primaryCta.getAttribute('href');
            if (!href || href === '#' || href === 'javascript:void(0)') {
                ctaStatus = 'broken';
                primaryCta.setAttribute('data-audit-fail', 'true');
            } else {
                ctaStatus = 'valid';
            }
          } else {
            ctaStatus = 'valid'; 
          }
        }

        const interactiveEls = Array.from(document.querySelectorAll('a, button, input[type="submit"], input[type="button"]'));
        let smallTapTargets = 0;
        interactiveEls.forEach(el => {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && el.offsetParent !== null) {
            if (rect.width < 48 || rect.height < 48) {
              if (el.tagName === 'A' && getStyle(el).display === 'inline') return;
              smallTapTargets++;
              el.setAttribute('data-audit-fail', 'true');
            }
          }
        });

        const textEls = Array.from(document.querySelectorAll('p, span, li'));
        let smallFonts = 0;
        textEls.forEach(el => {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && el.offsetParent !== null && parseFloat(getStyle(el).fontSize) < 16) {
            smallFonts++;
            el.setAttribute('data-audit-fail', 'true');
          }
        });

        const style = document.createElement('style');
        style.textContent = `[data-audit-fail="true"] { outline: 4px solid red !important; outline-offset: 2px !important; background-color: rgba(255, 0, 0, 0.1) !important; }`;
        document.head.appendChild(style);

        let hasLocalSchema = false;
        const schemaScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
        for (const s of schemaScripts) {
          try {
            const parsed = JSON.parse(s.textContent);
            const nodes = parsed['@graph'] ? parsed['@graph'] : (Array.isArray(parsed) ? parsed : [parsed]);
            for (const node of nodes) {
              const type = node['@type'];
              if (type && (Array.isArray(type) ? type.some(t => t.includes('LocalBusiness') || t.includes('RoofingContractor')) : type.includes('LocalBusiness') || type.includes('RoofingContractor'))) {
                hasLocalSchema = true;
                break;
              }
            }
          } catch(e) {}
        }

        return {
          brand: {
            primaryColor: primaryCta ? getStyle(primaryCta).backgroundColor : 'transparent',
            headingFont: getStyle(h1El).fontFamily,
            bodyFont: getStyle(document.body).fontFamily,
            phone: document.querySelector('a[href^="tel:"]')?.href.replace('tel:', '') || null,
            email: document.querySelector('a[href^="mailto:"]')?.href.replace('mailto:', '') || null
          },
          domChecks: {
            hasForm: !!bestForm,
            visibleFields: visibleFields,
            hasViewport: !!document.querySelector('meta[name="viewport"]'),
            hasHorizontalScroll: document.documentElement.scrollWidth > window.innerWidth,
            hasLocalSchema: hasLocalSchema,
            smallTapTargets: smallTapTargets,
            smallFonts: smallFonts,
            h1: h1El.innerText.substring(0, 100),
            bodyText: document.body.innerText.toLowerCase().substring(0, 2000),
            ctaStatus: ctaStatus
          }
        };
      });

      // 4. Safe Form Test
      let formTestResult = 'not_applicable';
      if (pageData.domChecks.hasForm) {
        try {
          await page.route('**/*', route => {
            if (route.request().method() === 'POST') {
              route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
            } else {
              route.continue();
            }
          });
          
          await page.fill('input[type="text"]', 'Playwright Audit');
          await page.fill('input[type="tel"]', '555-000-0000');
          await page.fill('input[type="email"]', 'audit@example.com');
          await page.click('button[type="submit"]');
          await page.waitForTimeout(2000);
          
          const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase());
          if (bodyText.includes('thank') || bodyText.includes('success') || bodyText.includes('received')) {
            formTestResult = 'pass';
          } else {
            formTestResult = 'fail_ui';
          }
        } catch (e) {
          formTestResult = 'inconclusive';
        }
      }

      // 5. Take Screenshot (with Red Boxes)
      const screenshot = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 60 });

      // 6. Performance Timing Checks (Throttled)
      const perf = await measurePerformance(browser, prospect.url);

      // 7. Semantic Analysis
      const semantics = await analyzeSemantics(prospect.title, pageData.domChecks.h1, pageData.domChecks.bodyText);

      // 8. Build Findings
      if (semantics.clarity_score !== null && semantics.clarity_score <= 2) {
        findings.push(createFinding('1.1', 'fail', 'B', `Vague headline: "${pageData.domChecks.h1}"`, 'Users do not understand what you do.', 'Rewrite the H1 to clearly state service and location.'));
      }
      
      if (pageData.domChecks.ctaStatus === 'none') {
        findings.push(createFinding('1.2', 'fail', 'B', 'No visible primary CTA', 'Users do not know what to click.', 'Add a prominent CTA above the fold.'));
      } else if (pageData.domChecks.ctaStatus === 'broken') {
        findings.push(createFinding('1.3', 'fail', 'A', 'Primary CTA is a dead link', 'The main action button does not work.', 'Fix the href attribute.'));
      }

      if (!pageData.domChecks.hasForm && !pageData.brand.phone) {
        findings.push(createFinding('2.1', 'fail', 'A', 'No conversion mechanism (form/phone)', 'Users have no way to contact you.', 'Add a phone number and contact form.'));
      } else if (pageData.domChecks.hasForm && pageData.domChecks.visibleFields > 5) {
        findings.push(createFinding('2.2', 'fail', 'B', `High form friction (${pageData.domChecks.visibleFields} fields)`, 'Form is too long and users abandon it.', 'Reduce to 3-4 fields.'));
      }

      if (formTestResult === 'fail_ui') {
        findings.push(createFinding('2.1', 'fail', 'A', 'Form does not show success message', 'Users think the form failed and leave.', 'Fix the form submission handler.'));
      }

      if (!pageData.domChecks.hasViewport || pageData.domChecks.hasHorizontalScroll) {
        findings.push(createFinding('3.1', 'fail', 'A', 'Mobile layout broken', 'Site requires horizontal scrolling on phones.', 'Fix responsive CSS.'));
      }
      
      if (pageData.domChecks.smallTapTargets > 3) {
        findings.push(createFinding('3.2', 'fail', 'B', `Too many small tap targets (${pageData.domChecks.smallTapTargets})`, 'Buttons are too small to tap easily.', 'Increase padding and font size.'));
      }
      
      if (pageData.domChecks.smallFonts > 5) {
        findings.push(createFinding('3.2', 'fail', 'B', `Small text on mobile (${pageData.domChecks.smallFonts} elements)`, 'Text is unreadable on phones.', 'Increase base font size to 16px.'));
      }

      if (perf.lcp > 2500 || perf.cls > 0.1) {
        findings.push(createFinding('4.1', 'fail', 'B', `Slow Performance (LCP: ${Math.round(perf.lcp)}ms, CLS: ${perf.cls.toFixed(2)})`, 'Users leave before the page loads.', 'Optimize images, reduce JavaScript, and improve server response.'));
      }

      if (semantics.trust_signals === false) {
        findings.push(createFinding('5.1', 'fail', 'B', 'No clear trust signals or guarantees', 'Users do not trust the business.', 'Add reviews, license numbers, and guarantees.'));
      }
      
      if (!pageData.domChecks.hasLocalSchema) {
        findings.push(createFinding('5.2', 'fail', 'C', 'No LocalBusiness Schema Markup', 'Search engines struggle to index the business.', 'Add JSON-LD schema.'));
      }

      if (!analyticsDetected) {
        findings.push(createFinding('6.1', 'fail', 'B', 'No tracking pixels found (GA4, GTM, Meta)', 'Business is flying blind on conversions.', 'Install Google Analytics.'));
      }

      // 9. Finalize and Save
      const priorityScore = calculatePriority(findings);
      const caption = `Audit: ${prospect.title}\nScore: ${priorityScore}/100\nLCP: ${Math.round(perf.lcp)}ms | CLS: ${perf.cls.toFixed(2)}\nFindings: ${findings.length}\nRed boxes indicate visual failures.`;
      
      await sendTelegram(screenshot, caption);
      
      results.push({ 
        url: prospect.url, 
        title: prospect.title, 
        priorityScore, 
        findings, 
        status: 'scored',
        crawl_diagnostics: crawlDiagnostics,
        brand_data: pageData.brand,
        existing_pages: siteMap.length > 0 ? siteMap : [], 
        semantic_scores: semantics,
        technical_metrics: perf
      });

    } catch (error) {
      reviewManually.push({ url: prospect.url, title: prospect.title, reason: error.message, diagnostics: crawlDiagnostics });
    } finally { 
      await context.close(); 
    }
  }
  await browser.close();
  fs.writeFileSync('scored_results.json', JSON.stringify(results, null, 2));
  fs.writeFileSync('review_manually.json', JSON.stringify(reviewManually, null, 2));
}
runCrawler();
