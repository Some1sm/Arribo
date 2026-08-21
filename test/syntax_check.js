const fs = require('fs');
const path = require('path');
const vm = require('vm');

let fileCount = 0;
let errorCount = 0;

function checkJsFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '.agents' && entry.name !== '.git') {
        checkJsFiles(fullPath);
      }
    } else if (entry.name.endsWith('.js')) {
      fileCount++;
      const code = fs.readFileSync(fullPath, 'utf8');
      try {
        new vm.Script(code, { filename: fullPath });
        console.log('✓ Syntax OK:', path.relative(process.cwd(), fullPath));
      } catch (err) {
        console.error('✗ Syntax Error in', fullPath, ':', err.message);
        errorCount++;
      }
    }
  }
}

checkJsFiles(process.cwd());
console.log(`\nSyntax Check Summary: ${fileCount} files scanned, ${errorCount} errors.`);
if (errorCount > 0) process.exit(1);
