const fs = require('fs');

const BRAVE_KEY = process.env.BRAVE_API_KEY;
if (!BRAVE_KEY) {
  console.error("Missing BRAVE_API_KEY");
  process.exit(1);
}

// Budget Tracker Logic
const usageFile = 'usage.json';
const currentMonth = new Date().toISOString().slice(0, 7); // e.g. "2026-10"
let usage = { month: currentMonth, count: 0 };

if (fs.existsSync(usageFile)) {
  usage = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
  if (usage.month !== currentMonth) {
    usage = { month: currentMonth, count: 0 }; // Reset on new month
  }
}

if (usage.count >= 800) {
  console.error("HALD CAP: Brave query limit for this month has been reached (800/900 reserved). Aborting to prevent any charges.");
  process.exit(0);
}

const verticals = ['roofing', 'hvac', 'dental', 'injury lawyer'];
const cities = ['Tampa', 'St. Petersburg', 'Clearwater', 'Brandon', 'Sarasota'];
const negatives = '-site:yelp.com -site:facebook.com -site:bbb.org -site:indeed.com -site:threebestrated.com -jobs -directory';

async function runSearch() {
  const prospects = [];
  let queriesThisRun = 0;

  for (const city of cities) {
    for (const vertical of verticals) {
      if (usage.count + queriesThisRun >= 800) {
        console.log("Reached monthly safety cap of 800 queries. Stopping.");
        break;
      }
      
      const query = `"${vertical}" "${city}, FL" ${negatives}`;
      console.log(`Searching: ${query}`);
      
      try {
        const response = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=20`, {
          headers: {
            'Accept': 'application/json',
            'X-Subscription-Token': BRAVE_KEY
          }
        });

        if (!response.ok) {
          console.error(`Brave API error: ${response.status}`);
          continue;
        }

        const data = await response.json();
        const results = data.web?.results || [];
        
        for (const res of results) {
          prospects.push({
            url: res.url,
            title: res.title,
            vertical: vertical,
            city: city
          });
        }
        
        queriesThisRun++;
        await new Promise(r => setTimeout(r, 2000)); // 2s delay to avoid rate limits
        
      } catch (err) {
        console.error(`Failed query: ${err.message}`);
      }
    }
  }

  usage.count += queriesThisRun;
  fs.writeFileSync(usageFile, JSON.stringify(usage, null, 2));
  console.log(`Total queries used this month: ${usage.count}/5000`);

  // Deduplicate by URL
  const uniqueProspects = Array.from(new Map(prospects.map(p => [p.url, p])).values());
  
  fs.writeFileSync('prospects.json', JSON.stringify(uniqueProspects, null, 2));
  console.log(`Saved ${uniqueProspects.length} unique prospects to prospects.json`);
}

runSearch();
