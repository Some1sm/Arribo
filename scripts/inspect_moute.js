const fs = require('fs');

async function inspectMoute() {
  console.log('Fetching https://mou-te.gencat.cat ...');
  const res = await fetch('https://mou-te.gencat.cat/');
  const html = await res.text();
  console.log('HTML preview:', html.substring(0, 500));

  const scripts = html.match(/src="([^"]+)"/g) || [];
  console.log('Scripts:', scripts);

  for (const s of scripts) {
    const src = s.replace('src="', '').replace('"', '');
    const scriptUrl = src.startsWith('http') ? src : `https://mou-te.gencat.cat/${src.replace(/^\//, '')}`;
    console.log('Fetching script:', scriptUrl);
    try {
      const sRes = await fetch(scriptUrl);
      const sText = await sRes.text();
      // find API endpoints or URLs in script
      const matches = sText.match(/https?:\/\/[a-zA-Z0-9.\-_/:]+|\/ws\/[a-zA-Z0-9.\-_/:]+|\/api\/[a-zA-Z0-9.\-_/:]+/g) || [];
      console.log(`Found ${matches.length} matches in ${src}`);
      const unique = [...new Set(matches)].filter(m => !m.endsWith('.js') && !m.endsWith('.css') && !m.endsWith('.png') && !m.endsWith('.svg') && !m.endsWith('.woff') && !m.endsWith('.woff2'));
      console.log('Sample endpoints:', unique.slice(0, 40));
    } catch (e) {
      console.error('Error fetching script', scriptUrl, e.message);
    }
  }
}

inspectMoute().catch(console.error);
