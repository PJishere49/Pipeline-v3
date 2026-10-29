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

function calculatePriority(findings) {
  let score = 100;
  for (const f of findings) {
    if (f.grade === 'A') score -= 40;
    if (f.grade === 'B') score -= 20;
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
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' });

  for (const prospect of subset) {
    const page = await context.newPage();
    const findings = [];
    try {
      console.log(`Crawling: ${prospect.url}`);
      const response = await page.goto(prospect.url, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(3000);

      const status = response ? response.status() : 500;
      const pageText = await page.content();
      if (status >= 400 || pageText.includes('Access Denied') || pageText.includes('Cloudflare')) {
        console.log(`Skipping WAF block: ${prospect.url}`);
        results.push({ url: prospect.url, title: prospect.title, status: 'inconclusive', reason: 'WAV/Access Denied' });
        await page.close();
        continue;
      }

      const pageData = await page.evaluate(() => {
        const hasTel = !!document.querySelector('a[href^="tel:"]');
        const hasMailto = !!document.querySelector('a[href^="mailto:"]');
        const hasForm = !!document.querySelector('form') || !!document.querySelector('input[type="email"]');
        const text = document.body.innerText;
        const yearMatch = text.match(/©\s*(20\d\d)/);
        const copyrightYear = yearMatch ? parseInt(yearMatch[1], 10) : null;
        return { hasTel, hasMailto, hasForm, copyrightYear };
      });

      const isHttps = prospect.url.startsWith('https://');
      if (!isHttps) findings.push({ check_id: '11.1', status: 'fail', grade: 'A', issue: 'Missing/Invalid SSL' });

      if (!pageData.hasTel && !pageData.hasMailto && !pageData.hasForm) {
        findings.push({ check_id: '2.4', status: 'fail', grade: 'A', issue: 'No working conversion mechanism' });
      } else {
        if (!pageData.hasForm) findings.push({ check_id: '5.3', status: 'fail', grade: 'B', issue: 'No contact form on page' });
        if (!pageData.hasTel && !pageData.hasMailto) findings.push({ check_id: '1.4', status: 'fail', grade: 'B', issue: 'No clickable phone or email link' });
      }
      if (pageData.copyrightYear && pageData.copyrightYear < 2025) findings.push({ check_id: '11.6', status: 'fail', grade: 'C', issue: `Stale copyright year (${pageData.copyrightYear})` });

      const priorityScore = calculatePriority(findings);
      const screenshot = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 60 });
      
      const caption = `Audit: ${prospect.title || prospect.url}\nScore: ${priorityScore}/100\nFindings: ${findings.length}\nSSL: ${isHttps ? 'Yes' : 'No'}`;
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
