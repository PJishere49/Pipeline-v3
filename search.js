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

const negatives = '-site:yelp.com -site:facebook.com -site:bbb.org -site:indeed.com -site:threebestrated.com -site:angi.com -site:gaf.com -site:homeadvisor.com -site:porch.com -site:houzz.com -site:nexdoor.com -site:mapquest.com -site:*.gov -jobs -careers -directory -"baker roofing" -"jaeofamerica"';

async function runSearch() {
  const prospects = [];
  let queriesThisRun = 0;

  for (const city of cities) {
    for (const vertical of verticals) {
      if (usage.count + queriesThisRun >= 800) break;
      
      const query = `"${vertical}" "${city}, FL" ${negatives}`;
      console.log(`Searching: ${query}`);
      
      try {
        const response = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=20&extra_snippets=true`, {
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
        
        // 1. Top-Level Data (siblings to 'web')
        const infobox = data.infobox || null;
        const mixed = data.mixed || null;
        const locations = data.locations || [];

        // 2. Web Results
        const results = data.web?.results || [];
        for (const res of results) {
          prospects.push({ 
            url: res.url, 
            title: res.title, 
            description: res.description,
            page_age: res.page_age,
            page_fetched: res.page_fetched,
            profile: res.profile,
            is_source_local: res.is_source_local,
            is_source_both: res.is_source_both,
            meta_url: res.meta_url,
            age: res.age,
            location: res.location,
            rating: res.rating,
            organization: res.organization,
            schemas: res.schemas,
            content_type: res.content_type,
            extra_snippets: res.extra_snippets,
            infobox: infobox,
            mixed: mixed,
            vertical: vertical, 
            city: city,
            source: 'web_result'
          });
        }

        // 3. Locations Data (The Gold Mine - Businesses with no website)
        for (const loc of locations) {
          prospects.push({
            // If no URL exists, give it a placeholder so deduplication doesn't crash
            url: loc.url || `no_website://${encodeURIComponent(loc.title)}`, 
            title: loc.title,
            description: loc.description,
            location: loc,
            vertical: vertical,
            city: city,
            source: 'location_result'
          });
        }

        queriesThisRun++;
        await new Promise(r => setTimeout(r, 2000)); 
        
      } catch (err) { 
        console.error(`Failed: ${err.message}`); 
      }
    }
  }

  // Update usage
  usage.count += queriesThisRun;
  fs.writeFileSync(usageFile, JSON.stringify(usage, null, 2));

  // Deduplicate by URL
  const uniqueProspects = Array.from(new Map(prospects.map(p => [p.url, p])).values());
  
  fs.writeFileSync('prospects.json', JSON.stringify(uniqueProspects, null, 2));
  console.log(`Saved ${uniqueProspects.length} unique prospects to prospects.json`);
}

runSearch();
