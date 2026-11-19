const fs = require('fs');

function generateBlueprints() {
    const results = JSON.parse(fs.readFileSync('scored_results.json', 'utf8'));
    
    // Filter for valid leads that actually have brand data
    const leads = results.filter(r => r.status === 'scored' && r.priorityScore < 85 && r.brand_data);
    
    if (leads.length === 0) { 
        console.log("No valid leads with brand data found in this batch."); 
        return; 
    }
    
    console.log(`Found ${leads.length} leads. Generating deterministic blueprints...`);

    for (const lead of leads) {
        // Deduplicate technical fixes
        const fixes = [...new Set(
            lead.findings
                .filter(f => f.status === 'fail')
                .map(f => f.recommended_fix)
        )];

        // Deduplicate conversion strategies based on the new Section 10 findings
        const strategy = [...new Set(
            lead.findings
                .filter(f => f.status === 'fail' && f.check_id.startsWith('10'))
                .map(f => f.customer_impact)
        )];

        lead.redesign_blueprint = {
            url: lead.url,
            title: lead.title,
            priority_score: lead.priorityScore,
            brand_assets: {
                logo: lead.brand_data?.logoUrl || "Extract from site",
                fonts: [
                    lead.brand_data?.headingFont || "System Sans",
                    lead.brand_data?.bodyFont || "System Sans"
                ],
                primary_color: lead.brand_data?.primaryColor || "#000000",
                phone: lead.brand_data?.phone || "Add phone",
                email: lead.brand_data?.email || "Add email"
            },
            site_architecture: {
                pages_to_keep: lead.existing_pages || [],
                new_pages_to_add: ["Contact (Dedicated Page)", "Services (Hub Page)"] // Standard high-converting additions
            },
            technical_fixes: fixes,
            conversion_strategy: strategy
        };
        
        console.log(`✅ Blueprint generated for: ${lead.title}`);
    }
    
    fs.writeFileSync('scored_results.json', JSON.stringify(results, null, 2));
    console.log("Finished generating blueprints.");
}

generateBlueprints();
