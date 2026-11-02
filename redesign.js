const fs = require('fs');

async function generateBlueprints() {
  const results = JSON.parse(fs.readFileSync('scored_results.json', 'utf8'));
  const leads = results.filter(r => r.status === 'scored' && r.priorityScore < 85);
  
  if (leads.length === 0) { console.log("No bad leads found to redesign."); return; }
  console.log(`Found ${leads.length} leads. Generating deterministic blueprints...`);

  for (const lead of leads) {
    const blueprint = {
      url: lead.url,
      title: lead.title,
      priority_score: lead.priorityScore,
      brand_assets: {
        logo: lead.brand_data.logoUrl || "Extract from site",
        fonts: [lead.brand_data.headingFont, lead.brand_data.bodyFont],
        // If the color is white/transparent, tell the user to grab it from the logo
        primary_color: (lead.brand_data.primaryColor === 'rgb(255, 255, 255)' || lead.brand_data.primaryColor === 'rgba(0, 0, 0, 0)') 
          ? "Use Color Picker on Logo" 
          : lead.brand_data.primaryColor,
        phone: lead.brand_data.phone,
        email: lead.brand_data.email
      },
      site_architecture: {
        pages_to_keep: [],
        new_pages_to_add: []
      },
      technical_fixes: [],
      conversion_strategy: []
    };

    // 1. Map Existing Pages
    lead.existing_pages.forEach(url => {
      const path = url.replace(lead.url.split('/')[0] + '//' + lead.url.split('/')[2], '');
      if (path === '' || path === '/') blueprint.site_architecture.pages_to_keep.push('Home');
      else {
        const pageName = path.replace(/\//g, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        if (pageName.length > 0) blueprint.site_architecture.pages_to_keep.push(pageName);
      }
    });

    // 2. Analyze Failures and Build Rules
    lead.findings.forEach(f => {
      if (f.status === 'fail') {
        switch(f.check_id) {
          case '1.2':
            blueprint.conversion_strategy.push(`Add a high-contrast, prominent primary CTA button in the Hero section (e.g., "Get a Free Estimate").`);
            break;
          case '1.3':
            blueprint.conversion_strategy.push(`Fix broken CTA links. Ensure all primary buttons route to a working contact form or booking page.`);
            break;
          case '2.1':
            blueprint.conversion_strategy.push(`Add a dedicated contact form. Do not rely solely on the phone number.`);
            break;
          case '2.2':
            blueprint.conversion_strategy.push(`Reduce form fields to 3-5 (Name, Phone, Email). Remove all unnecessary friction.`);
            break;
          case '3.1':
            blueprint.technical_fixes.push(`Fix mobile responsiveness. Add <meta name="viewport"> and CSS "overflow-x: hidden;" to stop horizontal scrolling.`);
            break;
          case '3.2':
            blueprint.technical_fixes.push(`Increase font sizes to minimum 16px. Increase tap targets (buttons/links) to minimum 48x48px.`);
            break;
          case '4.1':
            blueprint.technical_fixes.push(`Optimize page speed. Compress images, defer JavaScript, and ensure FCP is under 2.5s.`);
            break;
          case '5.1':
            blueprint.conversion_strategy.push(`Add trust signals immediately below the Hero section: Google Reviews, "Licensed & Insured" badges, and "Family Owned" text.`);
            break;
          case '5.2':
            blueprint.technical_fixes.push(`Inject LocalBusiness JSON-LD Schema into the <head> (include Name, Address, Phone, and Services).`);
            break;
          case '6.1':
            blueprint.technical_fixes.push(`Install Google Tag Manager and Google Analytics 4 to track form submissions and click-to-calls.`);
            break;
        }
      }
    });

    // 3. Add Missing Core Pages (Rule-based)
    const hasContact = blueprint.site_architecture.pages_to_keep.some(p => p.toLowerCase().includes('contact'));
    if (!hasContact) blueprint.site_architecture.new_pages_to_add.push('Contact (Dedicated Page)');
    
    const hasService = blueprint.site_architecture.pages_to_keep.some(p => p.toLowerCase().includes('service') || p.toLowerCase().includes('roof') || p.toLowerCase().includes('repair'));
    if (!hasService) blueprint.site_architecture.new_pages_to_add.push('Services (Hub Page)');

    // Attach blueprint to lead
    lead.redesign_blueprint = blueprint;
    console.log(`✅ Blueprint generated for: ${lead.title}`);
  }
  
  fs.writeFileSync('scored_results.json', JSON.stringify(results, null, 2));
  console.log("Finished generating Blueprints. Check scored_results.json.");
}
generateBlueprints();
