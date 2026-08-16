const fs = require('fs');

const dex = fs.readFileSync('scripts/apk_extracted/classes.dex').toString('latin1');

const xmlTemplates = dex.match(/<soap[^>]*>[\s\S]*?<\/soap[^>]*>/gi) || [];
console.log('SOAP XML Templates count:', xmlTemplates.length);

xmlTemplates.forEach((t, i) => {
  console.log(`\n================ TEMPLATE #${i} ================\n`);
  console.log(t.replace(/[^\x20-\x7E\n]/g, ' '));
});

// Also search for any xml strings containing siri
const siriXmls = dex.match(/<[^>]+xmlns=[^>]+siri[^>]*>[\s\S]*?<\/[^>]+>/gi) || [];
console.log('SIRI XML snippets count:', siriXmls.length);
siriXmls.forEach((t, i) => {
  console.log(`\n--- SIRI XML #${i} ---\n`);
  console.log(t.replace(/[^\x20-\x7E\n]/g, ' '));
});
