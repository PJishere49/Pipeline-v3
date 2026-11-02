const fs = require('fs');
const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!GROQ_API_KEY) { console.error("Missing GROQ_API_KEY"); process.exit(1); }

async function generatePitch() {
  const results = JSON.parse(fs.readFileSync('scored_results.json', 'utf8'));
  const leads = results.filter(r => r.status === 'scored' && r.priorityScore < 85);
  
  if (leads.length === 0) { console.log("No bad leads found in this batch."); return; }
  console.log(`Found ${leads.length} leads to pitch. Generating briefs...`);

  for (const lead of leads) {
    const findingsText = lead.findings.map(f => `- ${f.issue} (Severity: ${f.grade})`).join('\n');
    const prompt = `You are an expert web design consultant. Write a short, professional email to the business owner (max 120 words) explaining these issues and how a redesign fixes them. Website: ${lead.title}. Issues: ${findingsText}. Tone: Helpful, urgent, focused on lost revenue. No technical jargon.`;

    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        // CHANGED MODEL HERE
        body: JSON.stringify({ model: 'llama3-70b-8192', messages: [{ role: 'user', content: prompt }], temperature: 0.7 })
      });

      const data = await response.json();

      if (!response.ok) {
        console.error(`❌ Groq API Error for ${lead.title}:`, data.error?.message || data);
        continue; 
      }

      if (!data.choices || data.choices.length === 0) {
        console.error(`❌ Groq returned no choices for ${lead.title}:`, data);
        continue;
      }

      lead.sales_pitch = data.choices[0].message.content;
      console.log(`✅ Pitch generated for: ${lead.title}`);
      await new Promise(r => setTimeout(r, 2000));
      
    } catch (err) { 
      console.error(`❌ Fetch failed for ${lead.title}: ${err.message}`); 
    }
  }
  
  fs.writeFileSync('scored_results.json', JSON.stringify(results, null, 2));
  console.log("Finished generating pitches.");
}
generatePitch();
