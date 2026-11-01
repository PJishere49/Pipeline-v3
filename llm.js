const fs = require('fs');
const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!GROQ_API_KEY) { console.error("Missing GROQ_API_KEY"); process.exit(1); }

async function generatePitch() {
  // 1. Read the results from the crawler
  const results = JSON.parse(fs.readFileSync('scored_results.json', 'utf8'));
  
  // 2. Only pitch the bad ones (Score < 85) and skip errors
  const leads = results.filter(r => r.status === 'scored' && r.priorityScore < 85);
  
  if (leads.length === 0) {
    console.log("No bad leads found in this batch. Run the crawler again to get more.");
    return;
  }

  console.log(`Found ${leads.length} leads to pitch. Generating briefs...`);

  // 3. Loop through each lead and ask Groq to write the pitch
  for (const lead of leads) {
    const findingsText = lead.findings.map(f => `- ${f.issue} (Severity: ${f.grade})`).join('\n');
    
    const prompt = `
    You are an expert web design consultant. I audited a website and found technical issues that are losing them money. 
    Write a short, professional email to the business owner (maximum 120 words) explaining these issues and how a redesign fixes them. 

    Website: ${lead.title}
    URL: ${lead.url}
    Issues Found:
    ${findingsText}

    Tone: Helpful, urgent, and focused on lost revenue. Do not use technical jargon like 'DOM' or 'HTTP'. 
    Explain the business impact of the issues listed.
    `;

    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.7
        })
      });

      const data = await response.json();
      const pitch = data.choices[0].message.content;

      // 4. Save the pitch to a file
      lead.sales_pitch = pitch;
      console.log(`\n--- PITCH GENERATED FOR: ${lead.title} ---`);
      console.log(pitch);
      
      await new Promise(r => setTimeout(r, 2000)); // Respect rate limits

    } catch (err) {
      console.error(`Failed to generate pitch for ${lead.url}: ${err.message}`);
    }
  }

  // 5. Save the final file
  fs.writeFileSync('scored_results.json', JSON.stringify(results, null, 2));
  console.log("\nSuccess! All pitches generated and saved to scored_results.json");
}

generatePitch();
