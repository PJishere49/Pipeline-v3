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

async function isSMBWithLLM(url, title) {
  const prompt = `Analyze this business: "${title}" at ${url}. Is this a local small-to-medium business (SMB) like a family-owned contractor, or is it a large national enterprise, franchise, or directory? Answer with only one word: SMB or ENTERPRISE.`;
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1
      })
    });
    const data = await res.json();
    return data.choices[0].message.content.trim().toUpperCase().includes('SMB');
  } catch (e) {
    return false; 
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
  const limit = 20;
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
      
      // 1. WAF CHECK
      if (status >= 400 || pageText.includes('Access Denied') || pageText.includes('Cloudflare')) {
        const isSMB = await isSMBWithLLM(prospect.url, prospect.title);
        if (isSMB) {
          reviewManually.push({ url: prospect.url, title: prospect.title, reason: 'WAF Blocked but LLM says SMB' });
        } else {
          results.push({ url: prospect.url, title: prospect.title, status: 'disqualified', reason: 'Enterprise WAF' });
        }
        await page.close();
        continue;
      }

      // 2. RUN RUBRIC CHECKS
      const pageData = await page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        const html = document.documentElement.innerHTML.toLowerCase();
        const hasTel = !!document.querySelector('a[href^="tel:"]');
        const hasMailto = !!document.querySelector('a[href^="mailto:"]');
        const hasForm = !!document.querySelector('form');
        const hasViewport = !!document.querySelector('meta[name="viewport"]');
        const hasHorizontalScroll = document.documentElement.scrollWidth > window.innerWidth;
        const hasAnalytics = html.includes('gtag(') || html.includes('googletagmanager');
        const hasTrust = text.includes('review') || text.includes('testimonial') || text.includes('guarantee');
        const yearMatch = text.match(/©\s*(20\d\d)/);
        const copyrightYear = yearMatch ? parseInt(yearMatch[1], 10) : null;
        
        // Broken Link Check (Scan first 10 internal links)
        const links = Array.from(document.querySelectorAll('a')).slice(0, 10).map(a => a.href);
        
        return { hasTel, hasMailto, hasForm, hasViewport, hasHorizontalScroll, hasAnalytics, hasTrust, copyrightYear, links };
      });

      // SSL Check
      const securityDetails = response ? response.securityDetails() : null;
      if (!securityDetails || !prospect.url.startsWith('https://')) {
        findings.push({ check_id: '11.1', issue: 'Missing/Invalid SSL', grade: 'A' });
      }

      // Mobile Checks
      if (!pageData.hasViewport) findings.push({ check_id: '3.1', issue: 'No mobile viewport tag', grade: 'A' });
      if (pageData.hasHorizontalScroll) findings.push({ check_id: '3.1', issue: 'Horizontal scroll on mobile', grade: 'A' });

      // Path Integrity (J1 Journey Test)
      // Try to find and click a primary CTA
      try {
        const ctaButton = page.locator('a, button').filter({ hasText: /contact|quote|schedule|estimate|get started/i }).first();
        if (await ctaButton.count() > 0 && await ctaButton.isVisible()) {
          await ctaButton.click({ timeout: 3000 });
          await page.waitForTimeout(2000);
        } else {
          findings.push({ check_id: '1.2', issue: 'No visible primary CTA above fold', grade: 'B' });
        }
      } catch (e) {
        findings.push({ check_id: '2.1', issue: 'Primary CTA is broken or leads to a dead end', grade: 'A' });
      }

      // Conversion & Forms
      if (!pageData.hasForm && !pageData.hasTel && !pageData.hasMailto) {
         findings.push({ check_id: '2.4', issue: 'No conversion mechanism', grade: 'A' });
      } else if (!pageData.hasForm) {
         findings.push({ check_id: '5.3', issue: 'No contact form', grade: 'B' });
      }

      // Trust & Analytics
      if (!pageData.hasAnalytics) findings.push({ check_id: '9.1', issue: 'No Google Analytics', grade: 'B' });
      if (!pageData.hasTrust) findings.push({ check_id: '6.1', issue: 'No trust signals', grade: 'B' });
      if (pageData.copyrightYear && pageData.copyrightYear < 2025) findings.push({ check_id: '11.6', issue: `Stale copyright (${pageData.copyrightYear})`, grade: 'C' });

      const priorityScore = calculatePriority(findings);
      const screenshot = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 60 });
      
      const caption = `Audit: ${prospect.title || prospect.url}\nScore: ${priorityScore}/100\nFindings: ${findings.length}`;
      await sendTelegram(screenshot, caption);
      
      results.push({ 
        url: prospect.url, title: prospect.title, priorityScore, findings, status: 'scored'
      });

    } catch (error) {
      const isSMB = await isSMBWithLLM(prospect.url, prospect.title);
      if (isSMB) reviewManually.push({ url: prospect.url, title: prospect.title, reason: 'Timeout but LLM says SMB' });
      else results.push({ url: prospect.url, title: prospect.title, status: 'error', error: error.message });
    } finally {
      await page.close();
    }
  }
  await browser.close();
  fs.writeFileSync('scored_results.json', JSON.stringify(results, null, 2));
  fs.writeFileSync('review_manually.json', JSON.stringify(reviewManually, null, 2));
}
runCrawler();
