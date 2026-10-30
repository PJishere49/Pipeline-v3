const fs = require('fs');
const { chromium } = require('playwright');
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(photoBuffer, caption) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`;
  const formData = new FormData();
  formData.append('chat_id', TELEGRAM_CHAT_ID);
  formData.append('photo', new Blob([photoBuffer]), 'screenshot.jpg');
  formData.append('caption', caption);
  await fetch(url, { method: 'POST', body: formData });
}

function calculatePriority(findings, isCorporate) {
  if (isCorporate) return 100; // Disqualify corporate sites
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
  const limit = 5;
  const subset = prospects.slice(0, limit);
  const browser = await chromium.launch();
  const context = await browser.newContext({ 
    viewport: { width: 390, height: 844 }, 
    userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' 
  });

  for (const prospect of subset) {
    const page = await context.newPage();
    const findings = [];
    try {
      const response = await page.goto(prospect.url, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(3000);

      const status = response ? response.status() : 500;
      const pageText = await page.content();
      if (status >= 400 || pageText.includes('Access Denied') || pageText.includes('Cloudflare')) {
        results.push({ url: prospect.url, title: prospect.title, status: 'inconclusive', reason: 'WAF/Access Denied' });
        await page.close();
        continue;
      }

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
        const isCorporate = text.includes('franchise') || text.includes('locations') || text.includes('careers');
        const yearMatch = text.match(/©\s*(20\d\d)/);
        const copyrightYear = yearMatch ? parseInt(yearMatch[1], 10) : null;
        return { hasTel, hasMailto, hasForm, hasViewport, hasHorizontalScroll, hasAnalytics, hasTrust, isCorporate, copyrightYear };
      });

      const isHttps = prospect.url.startsWith('https://');
      if (!isHttps) findings.push({ check_id: '11.1', issue: 'Missing/Invalid SSL' });
      if (!pageData.hasViewport) findings.push({ check_id: '3.1', issue: 'No mobile viewport tag (pinch-to-zoom)' });
      if (pageData.hasHorizontalScroll) findings.push({ check_id: '3.1', issue: 'Horizontal scroll on mobile' });
      if (!pageData.hasAnalytics) findings.push({ check_id: '9.1', issue: 'No Google Analytics tracking' });
      if (!pageData.hasTrust) findings.push({ check_id: '6.1', issue: 'No trust signals (reviews/testimonials)' });
      if (pageData.copyrightYear && pageData.copyrightYear < 2025) findings.push({ check_id: '11.6', issue: `Stale copyright (${pageData.copyrightYear})` });
      
      if (!pageData.hasForm && !pageData.hasTel && !pageData.hasMailto) {
         findings.push({ check_id: '2.4', issue: 'No conversion mechanism (form/tel/mailto)' });
      } else if (!pageData.hasForm) {
         findings.push({ check_id: '5.3', issue: 'No contact form on page' });
      }

      // Convert to Grades
      findings.forEach(f => {
        if (f.check_id === '11.1' || f.issue.includes('viewport') || f.issue.includes('Horizontal')) f.grade = 'A';
        else if (f.issue.includes('Analytics') || f.issue.includes('trust') || f.issue.includes('form')) f.grade = 'B';
        else f.grade = 'C';
      });

      const priorityScore = calculatePriority(findings, pageData.isCorporate);
      const screenshot = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 60 });
      
      const caption = `Audit: ${prospect.title || prospect.url}\nScore: ${priorityScore}/100\nFindings: ${findings.length}\nCorporate: ${pageData.isCorporate ? 'Yes' : 'No'}`;
      await sendTelegram(screenshot, caption);
      results.push({ url: prospect.url, title: prospect.title, priorityScore, findings, status: 'scored' });
    } catch (error) {
      results.push({ url: prospect.url, title: prospect.title, status: 'error', error: error.message });
    } finally {
      await page.close();
    }
  }
  await browser.close();
  fs.writeFileSync('scored_results.json', JSON.stringify(results, null, 2));
}
runCrawler();
