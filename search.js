const fs = require('fs');
const BRAVE_KEY = process.env.BRAVE_API_KEY;
if (!BRAVE_KEY) { console.error("Missing BRAVE_API_KEY"); process.exit(1); }

const usageFile = 'usage.json';
const currentMonth = new Date().toISOString().slice(0, 7);
let usage = { month: currentMonth, count: 0 };
if (fs.existsSync(usageFile)) {
  usage = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
  if (usage.month !== currentMonth) usage = { month: currentMonth, count: 0 };
}
if (usage.count >= 800) { 
  console.error("HARD CAP: Usage limit reached."); 
  process.exit(0); 
}

const verticals = ['roofing', 'hvac', 'dental', 'injury lawyer'];
const cities = ['Tampa', 'St. Petersburg', 'Clearwater', 'Brandon', 'Sarasota'];


const verticals = ['roofing', 'hvac', 'dental', 'injury lawyer'];
const cities = ['Tampa', 'St. Petersburg', 'Clearwater', 'Brandon', 'Sarasota'];

const negatives = '-site:yelp.com -site:facebook.com -site:bbb.org -site:indeed.com -site:threebestrated.com -site:angi.com -site:gaf.com -site:homeadvisor.com -site:porch.com -site:houzz.com -site:nexdoor.com -site:mapquest.com -site:*.gov -jobs -careers -directory -"baker roofing" -"jaeofamerica"';


async function runSearch() {
  


async function runSearch() {
  const prospects = [];
  let queriesThisRun = 0;

  for (const city of cities) {
    for (const vertical of verticals) {
      if (usage.count + queriesThisRun >= 800) break;
      const query = `"${vertical}" "${city}, FL" ${negatives}`;
      console.log(`Searching: ${query}`);
      try {
        const response = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=20`, {
          headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_KEY }
        });
        if (!response.ok) continue;
        const data = await response.json();
        const results = data.web?.results || [];
        
          for (const res of results) {
  prospects.push({ 
    url: res.url, 
    title: res.title, 
    description: res.description,
    page_age: res.page_age, 
    has_thumbnail: !!res.thumbnail,
    vertical, 
    city 
  });
}
        
        }
        queriesThisRun++;
        await new Promise(r => setTimeout(r, 2000));
      } catch (err) { console.error(`Failed: ${err.message}`); }
    }
  }
  usage.count += queriesThisRun;
  fs.writeFileSync(usageFile, JSON.stringify(usage, null, 2));
  const uniqueProspects = Array.from(new Map(prospects.map(p => [p.url, p])).values());
  fs.writeFileSync('prospects.json', JSON.stringify(uniqueProspects, null, 2));
  console.log(`Saved ${uniqueProspects.length} prospects.`);
}

runSearch();
