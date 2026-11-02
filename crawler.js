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
    if (!res.ok) return { clarity_score: null, trust_signals: null }; // Inconclusive
    const data = await res.json();
    return JSON.parse(data.choices[0].message.content);
  } catch (e) { return { clarity_score: null, trust_signals: null }; }
}

function calculatePriority(findings) {
  let score = 100;
  // Group by check_id to prevent double deductions for the same root cause
  const uniqueFindings = [];
  const seenChecks = new Set();
  for (const f of findings) {
    if (!seenChecks.has(f.check_id)) {
      seenChecks.add(f.check_id);
      uniqueFindings.push(f);
    }
  }

  for (const f of uniqueFindings) {
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
  const limit = 5; 
  const subset = prospects.slice(0, limit);
  
  // Explicitly handle SSL errors so the script doesn't crash
  const browser = await chromium.launch({ args: ['--disable-http2'] });
  const context = await browser.newContext({ 
    viewport: { width: 390, height: 844 }, 
    userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    ignoreHTTPSErrors: false 
  });

  for (const prospect of subset) {
    const page = await context.newPage();
    const findings = [];
    let crawlDiagnostics = { http_status: 200, waf_blocked: false, ssl_error: false };
    let pageData = null;

    try {
      let response;
      try {
        response = await page.goto(prospect.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (err) {
        if (err.message.includes('ERR_CERT_')) {
          crawlDiagnostics.ssl_error = true;
          crawlDiagnostics.http_status = 0;
          findings.push({ check_id: '7.1', issue: 'Invalid or Expired SSL Certificate', grade: 'A', status: 'fail' });
        } else {
          throw err; // Re-throw other errors (timeouts, DNS)
        }
      }

      if (response) {
        crawlDiagnostics.http_status = response.status();
        const pageText = await page.content();
        
        // WAF / Bot Block check
        if (response.status() >= 400 || pageText.includes('Access Denied') || pageText.includes('Cloudflare') || pageText.includes('Just a moment')) {
          crawlDiagnostics.waf_blocked = true;
          reviewManually.push({ url: prospect.url, title: prospect.title, reason: 'WAF / Bot Blocked', diagnostics: crawlDiagnostics });
          await page.close();
          continue;
        }
      }

      await page.waitForTimeout(3000);

      // --- DOM EVALUATION ---
      pageData = await page.evaluate(() => {
        const getStyle = (el) => window.getComputedStyle(el);
        const h1El = document.querySelector('h1') || document.body;
        
        // 1. Primary CTA & J1 Journey Test Preparation
        const primaryBtns = Array.from(document.querySelectorAll('button, a[class*="btn" i], a[class*="button" i], a[class*="cta" i]'));
        let primaryCta = primaryBtns.find(b => /contact|quote|schedule|estimate|get started|call/i.test(b.innerText));
        let ctaStatus = 'none';
        if (primaryCta) {
          if (primaryCta.tagName === 'A') {
            const href = primaryCta.getAttribute('href');
            if (!href || href === '#' || href === 'javascript:void(0)') ctaStatus = 'broken';
            else ctaStatus = 'valid';
          } else {
            ctaStatus = 'valid'; // It's a button, presumably triggers JS/modal
          }
        }

        // 2. Form Friction (Visible fields only)
        const form = document.querySelector('form');
        let visibleFields = 0;
        if (form) {
          const inputs = Array.from(form.querySelectorAll('input, select, textarea'));
          visibleFields = inputs.filter(el => {
            const type = el.getAttribute('type');
            const rect = el.getBoundingClientRect();
            return type !== 'hidden' && type !== 'submit' && type !== 'button' && type !== 'checkbox' && rect.width > 0 && rect.height > 0;
          }).length;
        }

        // 3. Page Map (Fixed Tel Bug)
        const links = Array.from(document.querySelectorAll('a')).map(a => a.href);
        const internalPages = [...new Set(links.filter(l => {
          return l.startsWith(window.location.origin) && 
                 !l.match(/^tel:/i) && 
                 !l.match(/^mailto:/i) && 
                 !l.includes('#');
        }))];

        // 4. Mobile (Tap Targets & Fonts)
        const interactiveEls = Array.from(document.querySelectorAll('a, button, input[type="submit"], input[type="button"]'));
        const smallTapTargets = interactiveEls.filter(el => {
          const rect = el.getBoundingClientRect();
          // Ignore inline text links (wide and short)
          if (rect.width > 100 && rect.height < 25) return false;
          return rect.width > 0 && rect.height > 0 && (rect.width < 48 || rect.height < 48);
        }).length;

        const textEls = Array.from(document.querySelectorAll('p, span, li'));
        const smallFonts = textEls.filter(el => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && parseFloat(getStyle(el).fontSize) < 16;
        }).length;

        // 5. Schema & Analytics
        const schemaScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
        const hasLocalSchema = schemaScripts.some(s => {
          try {
            const parsed = JSON.parse(s.textContent);
            const type = parsed['@type'] || (parsed['@graph'] && parsed['@graph'][0]['@type']);
            return type && (type.includes('LocalBusiness') || type.includes('RoofingContractor') || type.includes('Dentist') || type.includes('HVAC'));
          } catch (e) { return false; }
        });

        const htmlLower = document.documentElement.innerHTML.toLowerCase();
        const hasAnalytics = htmlLower.includes('gtag(') || htmlLower.includes('googletagmanager') || htmlLower.includes('fbq(') || htmlLower.includes('plausible') || htmlLower.includes('clarity');

        // 6. Brand Extraction
        let primaryColor = 'transparent';
        for (const btn of primaryBtns) {
          const bg = getStyle(btn).backgroundColor;
          if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' && !bg.includes('239, 239, 239')) {
            primaryColor = bg;
            break;
          }
        }

        const logoEl = document.querySelector('img[class*="logo" i], img[id*="logo" i], img[src*="logo" i]');
        const phoneEl = document.querySelector('a[href^="tel:"]');
        const emailEl = document.querySelector('a[href^="mailto:"]');

        return {
          brand: {
            primaryColor: primaryColor,
            headingFont: getStyle(h1El).fontFamily,
            bodyFont: getStyle(document.body).fontFamily,
            logoUrl: logoEl ? logoEl.src : null,
            phone: phoneEl ? phoneEl.href.replace('tel:', '') : null,
            email: emailEl ? emailEl.href.replace('mailto:', '') : null
          },
          domChecks: {
            hasForm: !!form,
            visibleFields: visibleFields,
            hasViewport: !!document.querySelector('meta[name="viewport"]'),
            hasHorizontalScroll: document.documentElement.scrollWidth > window.innerWidth,
            hasAnalytics: hasAnalytics,
            hasLocalSchema: hasLocalSchema,
            smallTapTargets: smallTapTargets,
            smallFonts: smallFonts,
            h1: h1El.innerText.substring(0, 100),
            bodyText: document.body.innerText.toLowerCase().substring(0, 1500),
            internalPages: internalPages.slice(0, 15),
            fcp: Math.round(performance.getEntriesByType('paint').find(e => e.name === 'first-contentful-paint')?.startTime || 0),
            ctaStatus: ctaStatus
          }
        };
      });

      // --- LLM SEMANTIC CHECK ---
      const semantics = await analyzeSemantics(prospect.title, pageData.domChecks.h1, pageData.domChecks.bodyText);

      // --- APPLY RUBRIC GRADES (EXACT ID ALIGNMENT) ---
      
      // Section 1: Conversion Surface
      if (semantics.clarity_score !== null) {
        if (semantics.clarity_score <= 2) findings.push({ check_id: '1.1', issue: `Vague headline: "${pageData.domChecks.h1}"`, grade: 'B', status: 'fail' });
      }
      if (pageData.domChecks.ctaStatus === 'none') findings.push({ check_id: '1.2', issue: 'No visible primary CTA above fold', grade: 'B', status: 'fail' });
      if (pageData.domChecks.ctaStatus === 'broken') findings.push({ check_id: '1.3', issue: 'Primary CTA is a dead link', grade: 'A', status: 'fail' });

      // Section 2: Conversion Path & Forms
      if (!pageData.domChecks.hasForm && !pageData.brand.phone) {
         findings.push({ check_id: '2.1', issue: 'No conversion mechanism (form/phone)', grade: 'A', status: 'fail' });
      } else if (!pageData.domChecks.hasForm) {
         findings.push({ check_id: '2.1', issue: 'No contact form on page', grade: 'B', status: 'fail' });
      } else if (pageData.domChecks.visibleFields > 5) {
         findings.push({ check_id: '2.2', issue: `High form friction (${pageData.domChecks.visibleFields} fields)`, grade: 'B', status: 'fail' });
      }

      // Section 3: Mobile Experience
      if (!pageData.domChecks.hasViewport || pageData.domChecks.hasHorizontalScroll) {
        findings.push({ check_id: '3.1', issue: 'Mobile layout broken (missing viewport or horizontal scroll)', grade: 'A', status: 'fail' });
      }
      if (pageData.domChecks.smallTapTargets > 3) {
        findings.push({ check_id: '3.2', issue: `Too many small tap targets (${pageData.domChecks.smallTapTargets} < 48px)`, grade: 'B', status: 'fail' });
      }
      if (pageData.domChecks.smallFonts > 5) {
        findings.push({ check_id: '3.2', issue: `Small text on mobile (${pageData.domChecks.smallFonts} elements < 16px)`, grade: 'B', status: 'fail' });
      }

      // Section 4: Performance
      if (pageData.domChecks.fcp > 2500) {
        findings.push({ check_id: '4.1', issue: `Slow First Contentful Paint (${pageData.domChecks.fcp}ms)`, grade: 'B', status: 'fail' });
      }

      // Section 5: Trust & Credibility
      if (semantics.trust_signals === false) {
        findings.push({ check_id: '5.1', issue: 'No clear trust signals or guarantees', grade: 'B', status: 'fail' });
      }
      if (!pageData.domChecks.hasLocalSchema) {
        findings.push({ check_id: '5.2', issue: 'No LocalBusiness Schema Markup', grade: 'C', status: 'fail' });
      }

      // Section 6: Tracking
      if (!pageData.domChecks.hasAnalytics) {
        findings.push({ check_id: '6.1', issue: 'No tracking pixels found (GA4, GTM, Meta, etc.)', grade: 'B', status: 'fail' });
      }

      // Section 7: SSL (Handled in the catch block above, but here's the fallback)
      if (!crawlDiagnostics.ssl_error && (!prospect.url.startsWith('https://') || (response && !response.securityDetails()))) {
        findings.push({ check_id: '7.1', issue: 'Missing SSL Certificate', grade: 'A', status: 'fail' });
      }

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
        crawl_diagnostics: crawlDiagnostics,
        brand_data: pageData.brand,
        existing_pages: pageData.domChecks.internalPages,
        semantic_scores: semantics
      });

    } catch (error) {
      reviewManually.push({ url: prospect.url, title: prospect.title, reason: error.message, diagnostics: crawlDiagnostics });
    } finally { await page.close(); }
  }
  await browser.close();
  fs.writeFileSync('scored_results.json', JSON.stringify(results, null, 2));
  fs.writeFileSync('review_manually.json', JSON.stringify(reviewManually, null, 2));
}
runCrawler();
