const https = require('https');

async function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

(async () => {
  console.log('Searching for N80, N81, N82, N83 routes...');
  for (let id = 1; id <= 700; id++) {
    try {
      const html = await get(`https://www.sagales.com/termometre/${id}/0`);
      if (html.length > 500 && !html.includes('404')) {
        const titleMatch = html.match(/<h4 class=["']modal-title["'][^>]*>([\s\S]*?)<\/h4>/);
        if (titleMatch) {
          const title = titleMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
          if (title.toLowerCase().includes('n8') || title.toLowerCase().includes('n7') || title.toLowerCase().includes('matar') || title.toLowerCase().includes('nocturn')) {
            console.log(`Route ID ${id}: ${title}`);
          }
        }
      }
    } catch(e) {}
  }
})();
