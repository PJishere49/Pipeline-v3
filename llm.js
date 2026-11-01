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
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], temperature: 0.7 })
      });
      const data = await response.json();
      lead.sales_pitch = data.choices[0].message.content;
      console.log(`Pitch generated for: ${lead.title}`);
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) { console.error(`Failed for ${lead.url}: ${err.message}`); }
  }
  fs.writeFileSync('scored_results.json', JSON.stringify(results, null, 2));
}
generatePitch();
