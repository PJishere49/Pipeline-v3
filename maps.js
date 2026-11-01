const fs = require('fs');
const { chromium } = require('playwright');

async function scrapeMaps() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  // Change these to your target cities and verticals
  const queries = ['Roofing company in Tampa FL', 'Dentist in Clearwater FL'];
  const goldMine = [];

  for (const query of queries) {
    console.log(`Searching Google Maps for: ${query}`);
    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000); // Wait for maps to load

    // Scroll the sidebar to load more results
    const sidebar = page.locator('div[role="feed"]');
    if (await sidebar.count() > 0) {
      for (let i = 0; i < 3; i++) {
        await sidebar.evaluate(e => e.scrollTop = e.scrollHeight);
        await page.waitForTimeout(2000);
      }
    }

    // Extract the businesses
    const listings = page.locator('div[role="feed"] > div > div > a');
    const count = await listings.count();
    console.log(`Found ${count} listings for ${query}`);

    for (let i = 0; i < count; i++) {
      const listing = listings.nth(i);
      try {
        const text = await listing.innerText();
        const lines = text.split('\n');
        const name = lines[0];
        
        // Check if a website link is present in this listing
        const hasWebsite = await listing.locator('a[data-value="Website"]').count() > 0;
        
        if (!hasWebsite && name.length > 0) {
          // Try to extract a phone number from the text (basic regex)
          const phoneMatch = text.match(/\(\d{3}\)\s*\d{3}-\d{4}|\d{3}-\d{3}-\d{4}/);
          const phone = phoneMatch ? phoneMatch[0] : 'No phone found';
          
          goldMine.push({ name, phone, query });
          console.log(`🔥 GOLD MINE (No Website): ${name} - ${phone}`);
        }
      } catch (e) {
        // Ignore errors for individual listings
      }
    }
  }

  await browser.close();
  
  // Save the gold mine
  fs.writeFileSync('gold_mine.json', JSON.stringify(goldMine, null, 2));
  console.log(`Saved ${goldMine.length} businesses with no website to gold_mine.json`);
}

scrapeMaps();
