const fs = require('fs');
const BRAVE_KEY = process.env.BRAVE_API_KEY;

// THE FIX: If we already have a list, don't waste Brave credits.
if (fs.existsSync('prospects.json')) {
  const existing = JSON.parse(fs.readFileSync('prospects.json', 'utf8'));
  if (existing.length > 0) {
    console.log("prospects.json already exists. Skipping Brave search to save credits.");
    process.exit(0);
  }
}

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
const negatives = '-site:yelp.com -site:facebook.com -site:bbb.org -site:indeed.com -site:threebestrated.com -site:angi.com -site:gaf.com -site:homeadvisor.com -site:porch.com -site:houzz.com -site:nexdoor.com -site:mapquest.com -site:*.gov -site:jaeofamerica.com -site:bakerroofing.com -jobs -careers -directory';

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
          headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_KEY }
        });
        
        if (!response.ok) { console.error(`Brave API error: ${response.status}`); continue; }
        
        const data = await response.json();
        const results = data.web?.results || [];
        
        for (const res of results) {
          prospects.push({ 
            url: res.url, 
            title: res.title, 
            description: res.description,
            page_age: res.page_age,
            page_fetched: res.page_fetched,
            is_source_local: res.is_source_local || false,
            is_source_both: res.is_source_both || false,
            age: res.age,
            favicon: res.profile?.img || null,
            location: res.location ? `${res.location.city || ''}, ${res.location.state || ''}`.trim() : null,
            rating: res.rating?.ratingValue || null,
            review_count: res.rating?.reviewCount || null,
            organization: res.organization?.name || null,
            schema_types: res.schemas?.map(s => s.type).join(', ') || null,
            content_type: res.content_type,
            extra_snippet_1: res.extra_snippets?.[0] || null,
            vertical: vertical, 
            city: city,
            source: 'web_result'
          });
        }

        const locations = data.locations || [];
        for (const loc of locations) {
          prospects.push({
            url: loc.url || `no_website://${encodeURIComponent(loc.title)}`, 
            title: loc.title,
            description: loc.description,
            location: loc.address || null,
            rating: loc.rating?.ratingValue || null,
            review_count: loc.rating?.reviewCount || null,
            phone: loc.phone || null,
            vertical: vertical,
            city: city,
            source: 'location_result'
          });
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
  console.log(`Saved ${uniqueProspects.length} unique prospects to prospects.json`);
}

runSearch();
