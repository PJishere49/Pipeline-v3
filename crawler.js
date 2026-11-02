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
  const prompt = `
  You are a conversion rate optimization expert. Analyze this website content.
  Business: "${title}"
  Main Headline (H1): "${h1}"
  Page Text: "${bodyText.substring(0, 1000)}"

  Answer these two questions with ONLY a JSON object:
  1. "clarity_score": Rate the headline 1-5 on how clear it is. (1 = Vague, 5 = Perfectly clear what they do and who it's for).
  2. "trust_signals": Do they have clear guarantees, specific reviews, or credentials? (true or false).
  `;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        response_format: { type: "json_object" }
      })
    });
    const data = await res.json();
    return JSON.parse(data.choices[0].message.content);
  } catch (e) {
    return { clarity_score: 3, trust_signals: false }; // Default if LLM fails
  }
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
  const limit = 5; // Kept at 5 to avoid rate limits while testing LLM
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
        const isSMB = true; // Default to saving it for manual review if blocked
        reviewManually.push({ url: prospect.url, title: prospect.title, reason: 'WAF Blocked' });
        await page.close();
        continue;
      }

      // --- BRAND EXTRACTION & DOM CHECKS ---
      const pageData = await page.evaluate(() => {
        const getStyle = (el) => window.getComputedStyle(el);
        
        // 1. Extract Colors & Fonts
        const primaryBtn = document.querySelector('button, a[class*="btn" i], a[class*="button" i]') || document.body;
        const h1El = document.querySelector('h1') || document.body;
        const bodyText = document.body.innerText.toLowerCase();
        
        // 2. Extract Logo & Images
        const logoEl = document.querySelector('img[class*="logo" i], img[id*="logo" i], img[src*="logo" i]');
        const logoUrl = logoEl ? logoEl.src : null;
        const heroImage = document.querySelector('img');
        
        // 3. Contact Info
        const phoneLink = document.querySelector('a[href^="tel:"]');
        const emailLink = document.querySelector('a[href^="mailto:"]');

        return {
          brand: {
            primaryColor: getStyle(primaryBtn).backgroundColor,
            textColor: getStyle(bodyText ? document.body : h1El).color,
            headingFont: getStyle(h1El).fontFamily,
            bodyFont: getStyle(document.body).fontFamily,
            logoUrl: logoUrl,
            heroImageUrl: heroImage ? heroImage.src : null,
            phone: phoneLink ? phoneLink.href.replace('tel:', '') : null,
            email: emailLink ? emailLink.href.replace('mailto:', '') : null
          },
          domChecks: {
            hasTel: !!document.querySelector('a[href^="tel:"]'),
            hasMailto: !!document.querySelector('a[href^="mailto:"]'),
            hasForm: !!document.querySelector('form'),
            hasViewport: !!document.querySelector('meta[name="viewport"]'),
            hasHorizontalScroll: document.documentElement.scrollWidth > window.innerWidth,
            hasAnalytics: document.documentElement.innerHTML.toLowerCase().includes('gtag(') || document.documentElement.innerHTML.toLowerCase().includes('googletagmanager'),
            h1: h1El.innerText.substring(0, 100),
            bodyText: bodyText.substring(0, 1500)
          }
        };
      });

      // --- LLM SEMANTIC CHECK ---
      const semantics = await analyzeSemantics(prospect.title, pageData.domChecks.h1, pageData.domChecks.bodyText);

      // --- APPLY RUBRIC GRADES ---
      const isHttps = prospect.url.startsWith('https://') && response.securityDetails();
      if (!isHttps) findings.push({ check_id: '11.1', issue: 'Missing/Invalid SSL', grade: 'A' });
      if (!pageData.domChecks.hasViewport) findings.push({ check_id: '3.1', issue: 'No mobile viewport tag', grade: 'A' });
      if (pageData.domChecks.hasHorizontalScroll) findings.push({ check_id: '3.1', issue: 'Horizontal scroll on mobile', grade: 'A' });
      if (!pageData.domChecks.hasAnalytics) findings.push({ check_id: '9.1', issue: 'No Google Analytics', grade: 'B' });
      
      // LLM Grades
      if (semantics.clarity_score <= 2) findings.push({ check_id: '1.1', issue: `Vague headline: "${pageData.domChecks.h1}"`, grade: 'B' });
      if (!semantics.trust_signals) findings.push({ check_id: '6.1', issue: 'No clear trust signals or guarantees', grade: 'B' });
      
      if (!pageData.domChecks.hasForm && !pageData.domChecks.hasTel && !pageData.domChecks.hasMailto) {
         findings.push({ check_id: '2.4', issue: 'No conversion mechanism', grade: 'A' });
      } else if (!pageData.domChecks.hasForm) {
         findings.push({ check_id: '5.3', issue: 'No contact form', grade: 'B' });
      }

      // Try clicking CTA
      try {
        const ctaButton = page.locator('a, button').filter({ hasText: /contact|quote|schedule|estimate|get started/i }).first();
        if (await ctaButton.count() > 0 && await ctaButton.isVisible()) {
          await ctaButton.click({ timeout: 3000 });
          await page.waitForTimeout(2000);
        } else {
          findings.push({ check_id: '1.2', issue: 'No visible primary CTA above fold', grade: 'B' });
        }
      } catch (e) { findings.push({ check_id: '2.1', issue: 'Primary CTA is broken', grade: 'A' }); }

      const priorityScore = calculatePriority(findings);
      const screenshot = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 60 });
      
      const caption = `Audit: ${prospect.title}\nScore: ${priorityScore}/100\nBrand: ${pageData.brand.primaryColor}`;
      await sendTelegram(screenshot, caption);
      
      // SAVE EVERYTHING TO RESULTS
      results.push({ 
        url: prospect.url, 
        title: prospect.title, 
        priorityScore, 
        findings, 
        status: 'scored',
        brand_data: pageData.brand,
        semantic_scores: semantics
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
