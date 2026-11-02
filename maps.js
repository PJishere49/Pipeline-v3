const fs = require('fs');
const { chromium } = require('playwright');

async function scrapeMaps() {
  // We need to run this "headed" (visible) in some environments to avoid bot detection, 
  // but in GitHub Actions we run headless.
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ 
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' 
  });
  const page = await context.newPage();
  
  const queries = ['Roofing company in Tampa FL', 'Dentist in Clearwater FL'];
  const goldMine = [];

  for (const query of queries) {
    console.log(`Searching Maps for: ${query}`);
    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    
    // Scroll the sidebar to load more results
    const sidebar = page.locator('div[role="feed"]');
    if (await sidebar.count() > 0) {
      for (let i = 0; i < 2; i++) { 
        await sidebar.evaluate(e => e.scrollTop = e.scrollHeight); 
        await page.waitForTimeout(2000); 
      }
    }

    // Get all the business cards in the sidebar
    const listings = page.locator('div[role="feed"] > div > div > a');
    const count = await listings.count();
    console.log(`Found ${count} listings. Clicking into each to check for websites...`);

    for (let i = 0; i < count; i++) {
      try {
        // Click the card to open the details panel
        await listings.nth(i).click();
        await page.waitForTimeout(2500); // Wait for the right panel to load

        // Check if the "Website" button exists in the detail panel
        const websiteButton = page.locator('a[data-item-id="authority"]');
        const hasWebsite = await websiteButton.count() > 0;

        if (!hasWebsite) {
          // Extract the name
          const name = await page.locator('h1').first().innerText();
          
          // Extract the phone number
          const phoneLocator = page.locator('button[data-item-id^="phone:tel:"]');
          let phone = 'No phone found';
          if (await phoneLocator.count() > 0) {
            phone = await phoneLocator.innerText();
          }

          goldMine.push({ name, phone, query });
          console.log(`🔥 GOLD MINE: ${name} | ${phone}`);
        }
      } catch (e) {
        // If a card fails to click or load, just skip it and move on
      }
    }
  }

  await browser.close();
  fs.writeFileSync('gold_mine.json', JSON.stringify(goldMine, null, 2));
  console.log(`Finished. Saved ${goldMine.length} businesses to gold_mine.json`);
}

scrapeMaps();
