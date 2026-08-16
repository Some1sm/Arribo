const https = require('https');

function getUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function run() {
  const html = await getUrl('https://mataro.avanzagrupo.com/');
  console.log('HTML length:', html.length);

  // Find all script tags
  const scriptRegex = /<script[^>]+src=["']([^"']+)["']/g;
  let match;
  const scripts = [];
  while ((match = scriptRegex.exec(html)) !== null) {
    scripts.push(match[1]);
  }
  console.log('Scripts found:', scripts);

  // Find links to lines / routes
  const linkRegex = /href=["']([^"']*(?:linea|linia|route|parada|horari)[^"']*)["']/gi;
  const links = [];
  while ((match = linkRegex.exec(html)) !== null) {
    links.push(match[1]);
  }
  console.log('Relevant links found:', links);

  // Search for any embedded JSON or API configs in HTML
  const apiMatch = html.match(/(https?:\/\/[^\s"']+(?:api|ws|rest|service)[^\s"']*)/gi);
  console.log('Possible API URLs in HTML:', apiMatch);
}

run().catch(console.error);
