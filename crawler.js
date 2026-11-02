const fs = require('fs');
const { chromium } = require('playwright');
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

async function sendTelegram(photoBuffer, caption) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`;
  const formData = new FormData();
  formData.append('chat_id', TELEGRAM_CHAT_ID);
  formData.append('photo', new Blob([photoBuffer]), 'screenshot.jpg');
  formData.append('caption', caption);
  await fetch(url, { method: 'POST', body: formData });
}

async function analyzeSemantics(title, h1, bodyText) {
  const prompt = `You are a CRO expert. Business: "${title}". H1: "${h1}". Text: "${bodyText.substring(0, 800)}". Answer ONLY with a JSON object: 1. "clarity_score": 1-5 (1=vague, 5=perfect). 2. "trust_signals": true/false (are there real reviews, guarantees, or credentials?).`;
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], temperature: 0.1, response_format: { type: "json_object" } })
    });
    const data = await res.json();
    return JSON.parse(data.choices[0].message.content);
  } catch (e) { return { clarity_score: 3, trust_signals: false }; }
}

function calculatePriority(findings) {
  let score = 100;
  for (const f of findings) {
    if (f.grade === 'A') score -= 30;
    if (f.grade === 'B') score -= 15;
    if (f.grade === 'C') score -= 10;
  }
  return Math.max(0, score);
}

async function runCrawler() {
  const prospects = JSON.parse(fs.readFileSync('prospects.json', 'utf8'));
  const results = [];
  const reviewManually = [];
  const limit = 5; // Kept at 5 as requested
  const subset = prospects.slice(0, limit);
  
  const browser = await chromium.launch({ args: ['--disable-http2'] });
  const context = await browser.newContext({ 
    viewport: { width: 390, height: 844 }, 
    userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' 
  });

  for (const prospect of subset) {
    const page = await context.newPage();
    const findings = [];
    try {
      const response = await page.goto(prospect.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);
      const status = response ? response.status() : 500;
      const pageText = await page.content();
      
      if (status >= 400 || pageText.includes('Access Denied') || pageText.includes('Cloudflare')) {
        reviewManually.push({ url: prospect.url, title: prospect.title, reason: 'WAF Blocked' });
        await page.close();
        continue;
      }

      // --- 100% RUBRIC DOM & PERFORMANCE EXTRACTION ---
      const pageData = await page.evaluate(() => {
        const getStyle = (el) => window.getComputedStyle(el);
        const primaryBtn = document.querySelector('button, a[class*="btn" i], a[class*="button" i]') || document.body;
        const h1El = document.querySelector('h1') || document.body;
        
        // 1. Page Map
        const links = Array.from(document.querySelectorAll('a')).map(a => a.href);
        const internalPages = [...new Set(links.filter(l => l.startsWith(window.location.origin) && !l.includes('#') && !l.includes('mailto') && !l.includes('tel')))];

        // 2. Tap Targets & Font Size (Mobile)
        const interactiveEls = Array.from(document.querySelectorAll('a, button, input, select, textarea'));
        const smallTapTargets = interactiveEls.filter(el => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && (rect.width < 48 || rect.height < 48);
        }).length;
        const textEls = Array.from(document.querySelectorAll('p, span, li'));
        const smallFonts = textEls.filter(el => parseFloat(getStyle(el).fontSize) < 16).length;

        // 3. Forms & Friction
        const form = document.querySelector('form');
        const formFields = form ? form.querySelectorAll('input, select, textarea').length : 0;

        // 4. Schema Markup & NAP
        const schemaScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
        const hasLocalSchema = schemaScripts.some(s => s.textContent.includes('LocalBusiness') || s.textContent.includes('RoofingContractor') || s.textContent.includes('Dentist') || s.textContent.includes('HVACBusiness'));
        
        // 5. Performance Metrics (Lab Data)
        const paintEntries = performance.getEntriesByType('paint');
        const fcp = paintEntries.find(e => e.name === 'first-contentful-paint')?.startTime || 0;
        const loadTime = performance.timing ? (performance.timing.loadEventEnd - performance.timing.navigationStart) : 0;

        return {
          brand: {
            primaryColor: getStyle(primaryBtn).backgroundColor,
            headingFont: getStyle(h1El).fontFamily,
            bodyFont: getStyle(document.body).fontFamily,
            logoUrl: document.querySelector('img[class*="logo" i], img[id*="logo" i]')?.src || null,
            phone: document.querySelector('a[href^="tel:"]')?.href.replace('tel:', '') || null,
            email: document.querySelector('a[href^="mailto:"]')?.href.replace('mailto:', '') || null
          },
          domChecks: {
            hasForm: !!form,
            formFields: formFields,
            hasViewport: !!document.querySelector('meta[name="viewport"]'),
            hasHorizontalScroll: document.documentElement.scrollWidth > window.innerWidth,
            hasAnalytics: document.documentElement.innerHTML.toLowerCase().includes('gtag(') || document.documentElement.innerHTML.toLowerCase().includes('googletagmanager'),
            hasLocalSchema: hasLocalSchema,
            smallTapTargets: smallTapTargets,
            smallFonts: smallFonts,
            h1: h1El.innerText.substring(0, 100),
            bodyText: document.body.innerText.toLowerCase().substring(0, 1500),
            internalPages: internalPages.slice(0, 15),
            fcp: Math.round(fcp),
            loadTime: Math.round(loadTime)
          }
        };
      });

      // --- LLM SEMANTIC CHECK ---
      const semantics = await analyzeSemantics(prospect.title, pageData.domChecks.h1, pageData.domChecks.bodyText);

      // --- APPLY 100% RUBRIC GRADES ---
      const isHttps = prospect.url.startsWith('https://') && response.securityDetails();
      if (!isHttps) findings.push({ check_id: '11.1', issue: 'Missing/Invalid SSL', grade: 'A' });
      if (!pageData.domChecks.hasViewport) findings.push({ check_id: '3.1', issue: 'No mobile viewport tag', grade: 'A' });
      if (pageData.domChecks.hasHorizontalScroll) findings.push({ check_id: '3.1', issue: 'Horizontal scroll on mobile', grade: 'A' });
      if (pageData.domChecks.smallTapTargets > 3) findings.push({ check_id: '3.2', issue: `Too many small tap targets (${pageData.domChecks.smallTapTargets} < 48px)`, grade: 'B' });
      if (pageData.domChecks.smallFonts > 5) findings.push({ check_id: '3.2', issue: `Small text on mobile (${pageData.domChecks.smallFonts} elements < 16px)`, grade: 'B' });
      
      if (!pageData.domChecks.hasAnalytics) findings.push({ check_id: '9.1', issue: 'No Google Analytics', grade: 'B' });
      if (!pageData.domChecks.hasLocalSchema) findings.push({ check_id: '8.1', issue: 'No LocalBusiness Schema Markup', grade: 'C' });
      
      // LLM Grades
      if (semantics.clarity_score <= 2) findings.push({ check_id: '1.1', issue: `Vague headline: "${pageData.domChecks.h1}"`, grade: 'B' });
      if (!semantics.trust_signals) findings.push({ check_id: '6.1', issue: 'No clear trust signals or guarantees', grade: 'B' });
      
      // Forms & Friction
      if (!pageData.domChecks.hasForm && !pageData.brand.phone) {
         findings.push({ check_id: '2.4', issue: 'No conversion mechanism (form/phone)', grade: 'A' });
      } else if (!pageData.domChecks.hasForm) {
         findings.push({ check_id: '5.3', issue: 'No contact form', grade: 'B' });
      } else if (pageData.domChecks.formFields > 5) {
         findings.push({ check_id: '5.1', issue: `High form friction (${pageData.domChecks.formFields} fields)`, grade: 'B' });
      }

      // Performance (Basic Lab Check)
      if (pageData.domChecks.fcp > 2500) findings.push({ check_id: '4.1', issue: `Slow First Contentful Paint (${pageData.domChecks.fcp}ms)`, grade: 'B' });

      // CTA Check
      try {
        const ctaButton = page.locator('a, button').filter({ hasText: /contact|quote|schedule|estimate|get started|call/i }).first();
        if (await ctaButton.count() > 0 && await ctaButton.isVisible()) {
          await ctaButton.click({ timeout: 3000 });
        } else {
          findings.push({ check_id: '1.2', issue: 'No visible primary CTA', grade: 'B' });
        }
      } catch (e) { findings.push({ check_id: '2.1', issue: 'Primary CTA is broken', grade: 'A' }); }

      const priorityScore = calculatePriority(findings);
      const screenshot = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 60 });
      
      const caption = `Audit: ${prospect.title}\nScore: ${priorityScore}/100\nFindings: ${findings.length}`;
      await sendTelegram(screenshot, caption);
      
      results.push({ 
        url: prospect.url, 
        title: prospect.title, 
        priorityScore, 
        findings, 
        status: 'scored',
        brand_data: pageData.brand,
        existing_pages: pageData.domChecks.internalPages,
        semantic_scores: semantics,
        technical_metrics: {
          fcp: pageData.domChecks.fcp,
          loadTime: pageData.domChecks.loadTime,
          formFields: pageData.domChecks.formFields,
          hasSchema: pageData.domChecks.hasLocalSchema
        }
      });

    } catch (error) {
      reviewManually.push({ url: prospect.url, title: prospect.title, reason: error.message });
    } finally { await page.close(); }
  }
  await browser.close();
  fs.writeFileSync('scored_results.json', JSON.stringify(results, null, 2));
  fs.writeFileSync('review_manually.json', JSON.stringify(reviewManually, null, 2));
}
runCrawler();
