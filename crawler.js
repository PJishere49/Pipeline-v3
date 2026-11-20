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

async function sendTelegramMessage(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    await fetch(url, { 
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' }, 
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: text }) 
    });
  } catch (e) {
    console.error("Telegram message failed:", e.message);
  }
}

function createFinding(check_id, status, grade, observation, impact, fix, test_method = 'Playwright 390x844') {
  const randomSuffix = Math.random().toString(36).substring(2, 7);
  return {
    finding_id: `hash_${check_id}_${Date.now()}_${randomSuffix}`,
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
    blocked_action: 'User cannot convert',
    recommended_fix: fix,
    verification_method: 'Re-run audit',
    financial_tier: 'none'
  };
}

async function analyzeSemantics(title, h1, bodyText) {
  const prompt = `You are a CRO expert. Business: "${title}". H1: "${h1}". Text: "${bodyText.substring(0, 1500)}". Answer ONLY with a JSON object: 1. "clarity_score": 1-5 (1=vague, 5=perfect). 2. "trust_signals": true/false.`;
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: prompt }], temperature: 0.1, response_format: { type: "json_object" } })
    });
    if (!res.ok) {
      console.log("Groq API Error:", await res.text());
      return { clarity_score: null, trust_signals: null };
    }
    const data = await res.json();
    return JSON.parse(data.choices[0].message.content);
  } catch (e) { 
    console.error("Groq Fetch Exception:", e.message);
    return { clarity_score: null, trust_signals: null }; 
  }
}

function calculatePriority(findings) {
  let score = 100;
  const seenFindings = new Set();
  for (const f of findings) {
    if (f.status === 'fail' && !seenFindings.has(f.finding_id)) {
      seenFindings.add(f.finding_id);
      if (f.evidence_grade === 'A') score -= 30;
      if (f.evidence_grade === 'B') score -= 15;
      if (f.evidence_grade === 'C') score -= 10;
    }
  }
  return Math.max(0, score);
}

async function fetchSitemapUrls(context, url) {
  try {
    const res = await context.request.get(url);
    if (!res.ok()) return [];
    const xml = await res.text();
    
    if (xml.includes('<sitemapindex')) {
      let allUrls = [];
      const sitemaps = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]);
      for (const subMap of sitemaps) {
        const subRes = await context.request.get(subMap);
        if (subRes.ok()) {
          const subXml = await subRes.text();
          allUrls.push(...[...subXml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]));
        }
      }
      return allUrls;
    } else {
      return [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]);
    }
  } catch (e) { return []; }
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
      }).observe({ type: 'largest-contentful-paint', buffered: true });
      
      new PerformanceObserver((entryList) => {
        for (const entry of entryList.getEntries()) {
          if (!entry.hadRecentInput) window.cls += entry.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    });

    try {
      await page.goto(url, { waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(1000);
      const metrics = await page.evaluate(() => {
        const fcpValue = performance.getEntriesByType('paint').find(e => e.name === 'first-contentful-paint')?.startTime || 0;
        const lcpValue = window.lcp || 0;
        return { lcp: lcpValue > 0 ? lcpValue : fcpValue, cls: window.cls || 0, fcp: fcpValue };
      });
      runs.push(metrics);
    } catch (e) { 
      // If it fails to load, record it as a catastrophic failure (9999ms)
      runs.push({ lcp: 9999, cls: 0, fcp: 9999 }); 
    }
    
    await page.close();
    await context.close();
  }

  runs.sort((a, b) => a.lcp - b.lcp);
  return runs[Math.floor(runs.length / 2)];
}

async function runCrawler() {
  const prospects = JSON.parse(fs.readFileSync('prospects.json', 'utf8'));
  let results = [];
  let reviewManually = [];
  
  // Directory Filter
  const directoryBlocklist = ['yahoo', 'reddit', 'yelp', 'angi', 'bbb.org', 'homeadvisor', 'thumbtack', 'facebook.com'];
  const validProspects = prospects.filter(p => !directoryBlocklist.some(b => p.url.toLowerCase().includes(b)));
  
  const limit = 50; 
  const subset = validProspects.slice(0, limit);
  
  const browser = await chromium.launch({ args: ['--disable-http2'] });
  
  for (const prospect of subset) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (Linux; Android 15)', ignoreHTTPSErrors: false });
    const page = await context.newPage();
    const findings = [];
    let crawlDiagnostics = { http_status: 200, waf_blocked: false, ssl_error: false, dead_site: false };
    let pageData = null;
    let siteMap = [];
    let analyticsDetected = false;
    let siteManagementStatus = 'unknown';
    let totalUrlsFound = 0;

    page.on('request', req => {
      const url = req.url();
      if (url.includes('google-analytics.com') || url.includes('googletagmanager.com') || url.includes('facebook.net')) analyticsDetected = true;
    });

    try {
      try {
        siteMap = await fetchSitemapUrls(context, new URL('/sitemap.xml', prospect.url).href);
        totalUrlsFound = siteMap.length;
        if (totalUrlsFound > 50) siteManagementStatus = 'actively_managed';
        else if (totalUrlsFound < 10 && totalUrlsFound > 0) siteManagementStatus = 'abandoned';
      } catch(e) {}

      let response;
      try {
        response = await page.goto(prospect.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (err) {
        if (err.message.includes('ERR_CERT_') || err.message.includes('ERR_SSL_')) {
          crawlDiagnostics.ssl_error = true;
          reviewManually.push({ url: prospect.url, title: prospect.title, reason: 'Invalid/Expired SSL', action: 'Investigate if business is active' });
          fs.writeFileSync('review_manually.json', JSON.stringify(reviewManually, null, 2));
          await page.close(); await context.close(); continue;
        } else { 
            crawlDiagnostics.dead_site = true;
            reviewManually.push({ url: prospect.url, title: prospect.title, reason: err.message, action: 'Investigate if business is active' });
            fs.writeFileSync('review_manually.json', JSON.stringify(reviewManually, null, 2));
            await page.close(); await context.close(); continue;
        }
      }

      if (response) {
        crawlDiagnostics.http_status = response.status();
        const pageText = await page.content();
        if (response.status() >= 400) {
          crawlDiagnostics.dead_site = true;
          reviewManually.push({ url: prospect.url, title: prospect.title, reason: `Site Down (HTTP ${response.status()})`, action: 'Investigate if business is active' });
          fs.writeFileSync('review_manually.json', JSON.stringify(reviewManually, null, 2));
          await page.close(); await context.close(); continue;
        }
        if (pageText.includes('Access Denied') || pageText.includes('Just a moment')) {
          crawlDiagnostics.waf_blocked = true;
          reviewManually.push({ url: prospect.url, title: prospect.title, reason: 'WAF / Bot Blocked', action: 'Manual check in browser' });
          fs.writeFileSync('review_manually.json', JSON.stringify(reviewManually, null, 2));
          await page.close(); await context.close(); continue;
        }
      }

      await page.waitForTimeout(3000);

      pageData = await page.evaluate(() => {
        const getStyle = (el) => window.getComputedStyle(el);
        const h1El = document.querySelector('h1') || document.body;
        
        const forms = Array.from(document.querySelectorAll('form'));
        let bestForm = null, maxInputs = 0, formAction = '';
        for (const f of forms) {
          const inputs = f.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], textarea').length;
          if (inputs > maxInputs) { maxInputs = inputs; bestForm = f; formAction = f.getAttribute('action') || ''; }
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
        let primaryColor = 'transparent';
        
        if (primaryCta) {
          const ctaStyle = getStyle(primaryCta).backgroundColor;
          if (ctaStyle !== 'rgba(0, 0, 0, 0)' && ctaStyle !== 'transparent' && !ctaStyle.includes('255, 255, 255')) {
             primaryColor = ctaStyle;
          }
          
          if (primaryCta.tagName === 'A') {
            const href = primaryCta.getAttribute('href');
            if (!href || href === '#' || href === 'javascript:void(0)') { ctaStatus = 'broken'; primaryCta.setAttribute('data-audit-fail', 'true'); }
            else { ctaStatus = 'valid'; }
          } else { ctaStatus = 'valid'; }
        }

        // Fallback for primary color (check header, then body)
        if (primaryColor === 'transparent' || primaryColor === 'rgba(0, 0, 0, 0)') {
            const headerBg = getStyle(document.querySelector('header') || document.body).backgroundColor;
            if (headerBg !== 'rgba(0, 0, 0, 0)' && headerBg !== 'transparent' && !headerBg.includes('255, 255, 255')) {
                primaryColor = headerBg;
            }
        }

        // Logo Extraction (Filtering base64 and small pixels)
        let logoUrl = null;
        const imgs = Array.from(document.querySelectorAll('img'));
        const logoImg = imgs.find(img => {
            const src = img.src || '';
            if (src.startsWith('data:') || img.naturalWidth < 50) return false; 
            const cls = img.className || '';
            const id = img.id || '';
            return /logo/i.test(src) || /logo/i.test(cls) || /logo/i.test(id) || (img.closest('header') && img.naturalWidth > 50);
        });
        if (logoImg) logoUrl = logoImg.src;

        // Phone Number Cleaning
        let rawPhone = document.querySelector('a[href^="tel:"]')?.href.replace('tel:', '') || null;
        let phone = null;
        if (rawPhone) {
            let digits = rawPhone.replace(/\D/g, '');
            if (digits.length === 11 && digits.startsWith('1')) digits = digits.substring(1);
            if (digits.length === 10) phone = `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
            else phone = rawPhone;
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

        let phoneVisible = false;
        const telLinks = Array.from(document.querySelectorAll('a[href^="tel:"]'));
        for (const link of telLinks) {
            const rect = link.getBoundingClientRect();
            if (rect.top >= 0 && rect.bottom <= 844 && rect.width > 0 && rect.height > 0) { phoneVisible = true; break; }
        }

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
                hasLocalSchema = true; break;
              }
            }
          } catch(e) {}
        }

        return {
          brand: {
            primaryColor: primaryColor,
            headingFont: getStyle(h1El).fontFamily,
            bodyFont: getStyle(document.body).fontFamily,
            logoUrl: logoUrl,
            phone: phone,
            email: document.querySelector('a[href^="mailto:"]')?.href.replace('mailto:', '') || null
          },
          domChecks: {
            hasForm: !!bestForm, formAction: formAction, visibleFields: visibleFields,
            hasViewport: !!document.querySelector('meta[name="viewport"]'),
            hasHorizontalScroll: document.documentElement.scrollWidth > window.innerWidth,
            hasLocalSchema: hasLocalSchema, smallTapTargets: smallTapTargets, smallFonts: smallFonts,
            phoneVisible: phoneVisible, h1: h1El.innerText.substring(0, 100),
            bodyText: document.body.innerText.toLowerCase().substring(0, 2000), ctaStatus: ctaStatus
          }
        };
      });

      let formTestResult = 'not_applicable';
      if (pageData.domChecks.hasForm) {
        if (pageData.domChecks.formAction.startsWith('mailto:')) {
          findings.push(createFinding('10.5', 'fail', 'A', 'Form uses mailto', 'Fails on mobile.', 'Use a real handler.'));
        } else {
          try {
            await page.route('**/*', route => {
              if (route.request().method() === 'POST') route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
              else route.continue();
            });
            await page.fill('input[type="text"]', 'Audit');
            await page.fill('input[type="tel"]', '555-000-0000');
            await page.fill('input[type="email"]', 'audit@test.com');
            await page.click('button[type="submit"]');
            await page.waitForTimeout(2000);
            const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase());
            if (bodyText.includes('thank') || bodyText.includes('success') || bodyText.includes('received')) formTestResult = 'pass';
            else formTestResult = 'fail_ui';
          } catch (e) { formTestResult = 'inconclusive'; }
        }
      }

      const screenshot = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 60 });

      let costPageScreenshot = null, costPageFound = false, contactPageTrustFound = false;
      const costUrl = siteMap.find(u => /cost|price|financing|estimate/i.test(u));
      if (costUrl) {
        costPageFound = true;
        const costPage = await context.newPage();
        try {
            await costPage.goto(costUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await costPage.waitForTimeout(2000);
            costPageScreenshot = await costPage.screenshot({ fullPage: true, type: 'jpeg', quality: 60 });
        } catch(e) {}
        await costPage.close();
      } else {
        findings.push(createFinding('10.4', 'fail', 'B', 'No cost page', 'Users leave to find pricing.', 'Add a pricing page.'));
      }

      const contactUrl = siteMap.find(u => /contact/i.test(u));
      if (contactUrl) {
        const contactPage = await context.newPage();
        try {
            await contactPage.goto(contactUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await contactPage.waitForTimeout(2000);
            const contactText = await contactPage.evaluate(() => document.body.innerText.toLowerCase());
            if (contactText.includes('license') || contactText.includes('insured') || contactText.includes('guarantee') || contactText.includes('review')) contactPageTrustFound = true;
        } catch(e) {}
        await contactPage.close();
      }
      if (contactUrl && !contactPageTrustFound) findings.push(createFinding('10.8', 'fail', 'B', 'No trust on contact', 'Users hesitate.', 'Add trust signals.'));

      const perf = await measurePerformance(browser, prospect.url);
      const semantics = await analyzeSemantics(prospect.title, pageData.domChecks.h1, pageData.domChecks.bodyText);

      if (semantics.clarity_score !== null && semantics.clarity_score <= 2) findings.push(createFinding('1.1', 'fail', 'B', 'Vague headline', 'Users confused.', 'Rewrite H1.'));
      if (pageData.domChecks.ctaStatus === 'none') findings.push(createFinding('1.2', 'fail', 'B', 'No primary CTA', 'Users do not know what to click.', 'Add CTA.'));
      else if (pageData.domChecks.ctaStatus === 'broken') findings.push(createFinding('1.3', 'fail', 'A', 'Dead CTA link', 'Button does not work.', 'Fix href.'));
      
      if (!pageData.domChecks.hasForm && !pageData.brand.phone) findings.push(createFinding('2.1', 'fail', 'A', 'No contact method', 'No way to contact you.', 'Add phone and form.'));
      else if (!pageData.domChecks.hasForm) findings.push(createFinding('10.1', 'fail', 'A', 'No contact form', 'Lose after-hours leads.', 'Add form.'));
      else if (pageData.domChecks.hasForm && pageData.domChecks.visibleFields > 5) findings.push(createFinding('2.2', 'fail', 'B', 'High form friction', 'Users abandon form.', 'Reduce fields.'));
      
      if (formTestResult === 'fail_ui') findings.push(createFinding('2.1', 'fail', 'A', 'Form UI fails', 'Users think form failed.', 'Fix handler.'));
      if (!pageData.domChecks.hasViewport || pageData.domChecks.hasHorizontalScroll) findings.push(createFinding('3.1', 'fail', 'A', 'Mobile layout broken', 'Requires horizontal scroll.', 'Fix CSS.'));
      if (pageData.domChecks.smallTapTargets > 3) findings.push(createFinding('3.2', 'fail', 'B', 'Small tap targets', 'Hard to tap.', 'Increase padding.'));
      if (pageData.domChecks.smallFonts > 5) findings.push(createFinding('3.2', 'fail', 'B', 'Small fonts', 'Unreadable on phone.', 'Increase to 16px.'));
      
      if (perf.lcp > 2500 || perf.cls > 0.1) findings.push(createFinding('4.1', 'fail', 'B', 'Slow performance', 'Users leave.', 'Optimize assets.'));
      
      if (semantics.trust_signals === false) findings.push(createFinding('5.1', 'fail', 'B', 'No trust signals', 'Users do not trust.', 'Add reviews/license.'));
      if (!pageData.domChecks.hasLocalSchema) findings.push(createFinding('5.2', 'fail', 'C', 'No schema', 'Search engines struggle.', 'Add JSON-LD.'));
      if (!analyticsDetected) findings.push(createFinding('6.1', 'fail', 'B', 'No analytics', 'Flying blind.', 'Install GA4.'));
      
      if (!pageData.brand.phone) findings.push(createFinding('10.3', 'fail', 'A', 'No click-to-call', 'Cannot tap to call.', 'Add tel: link.'));
      else if (!pageData.domChecks.phoneVisible) findings.push(createFinding('10.6', 'fail', 'B', 'Phone hidden', 'Hard to find in emergency.', 'Put in header.'));

      const priorityScore = calculatePriority(findings);
      let caption = `Audit: ${prospect.title}\nScore: ${priorityScore}/100\nLCP: ${Math.round(perf.lcp)}ms | CLS: ${perf.cls.toFixed(2)}\nFindings: ${findings.length}\nStatus: ${siteManagementStatus}`;
      
      await sendTelegram(screenshot, caption + `\n\nHomepage`);
      if (costPageScreenshot) await sendTelegram(costPageScreenshot, `Cost Page: ${costUrl}`);
      else if (costPageFound === false) await sendTelegram(screenshot, `MISSING: No cost page.`);
      
      results.push({ 
        url: prospect.url, title: prospect.title, priorityScore, findings, status: 'scored',
        crawl_diagnostics: crawlDiagnostics, brand_data: pageData.brand,
        site_management_status: siteManagementStatus, total_urls_found: totalUrlsFound,
        existing_pages: siteMap.length > 0 ? siteMap.slice(0, 50) : [], semantic_scores: semantics, technical_metrics: perf
      });

      fs.writeFileSync('scored_results.json', JSON.stringify(results, null, 2));

    } catch (error) {
      reviewManually.push({ url: prospect.url, title: prospect.title, reason: error.message, action: 'Manual check needed' });
      fs.writeFileSync('review_manually.json', JSON.stringify(reviewManually, null, 2));
    } finally { 
      await page.close(); await context.close(); 
    }
  }
  await browser.close();
  
  fs.writeFileSync('scored_results.json', JSON.stringify(results, null, 2));
  fs.writeFileSync('review_manually.json', JSON.stringify(reviewManually, null, 2));

  // Send the final batch report to Telegram
  if (reviewManually.length > 0) {
    let summary = `Batch Complete.\n\n${reviewManually.length} sites need investigation:\n`;
    for (const item of reviewManually) {
      summary += `\n🔴 ${item.title}\nReason: ${item.reason}\nURL: ${item.url}\n`;
    }
    await sendTelegramMessage(summary);
  } else {
    await sendTelegramMessage("Batch Complete. All sites loaded successfully.");
  }
}
runCrawler();