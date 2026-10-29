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
  const response = await fetch(url, { method: 'POST', body: formData });
  const json = await response.json();
  if (!json.ok) console.error("Telegram Error:", json.description);
}

async function runCrawler() {
  const prospects = JSON.parse(fs.readFileSync('prospects.json', 'utf8'));
  const results = [];
  const limit = 5; // Test run cap
  const subset = prospects.slice(0, limit);

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Revvl 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
  });

  for (const prospect of subset) {
    const page = await context.newPage();
    try {
      console.log(`Crawling: ${prospect.url}`);
      await page.goto(prospect.url, { waitUntil: 'networkidle', timeout: 30000 });
      
      // WAIT 3 SECONDS fOR THE PAGE TO PAINT
      await page.waitForTimeout(3000);

      const screenshot = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 60 });
      
      const isHttps = prospect.url.startsWith('https://');
      await sendTelegram(screenshot, `Audit: ${prospect.title || prospect.url}\nSSL: ${isHttps ? 'Yes' : 'No'}`);
      
      results.push({ url: prospect.url, title: prospect.title, isHttps, status: 'success' });
    } catch (error) {
      console.error(`Failed: ${prospect.url} - ${error.message}`);
      results.push({ url: prospect.url, title: prospect.title, status: 'error', error: error.message });
    } finally {
      await page.close();
    }
  }

  await browser.close();
  fs.writeFileSync('audit_results.json', JSON.stringify(results, null, 2));
  console.log(`Run complete. Crawled ${results.length} sites.`);
}

runCrawler();
