const https = require('https');

https.get('https://www.ambmobilitat.cat/Principales/TiraLineas.aspx?linea=C10', { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log(data);
  });
});
