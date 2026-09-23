const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const excluded = {
  'e2e_test.js': 'Legacy C-10 HTTP contract; requires an external server',
  'm3_smoke_test.js': 'Retired multi-provider HTTP contract',
  'challenger_m5_adversarial_stress_test.js': 'Manual legacy load/fault-injection diagnostic',
  'challenger_m5_concurrency_ipc_test.js': 'Manual legacy database/fault-injection diagnostic'
};
const performanceTests = new Set(['startup_benchmark.js', 'stop_cache_benchmark_test.js']);
const args = process.argv.slice(2);
if (args.some(arg => !['--full', '--list'].includes(arg))) {
  throw new Error('Usage: node test/run.js [--full] [--list]');
}
const files = fs.readdirSync(__dirname).filter(file => file.endsWith('.js') && file !== 'run.js').sort();
let failures = 0;
let passed = 0;
for (const file of files) {
  const reason = excluded[file] || (!args.includes('--full') && performanceTests.has(file) ? 'Performance suite: use --full' : null);
  if (reason) {
    console.log(`SKIP ${file}: ${reason}`);
    continue;
  }
  if (args.includes('--list')) {
    console.log(`TEST ${file}`);
    continue;
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arribo-suite-'));
  console.log(`\nRUN ${file}`);
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, file)], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, DATA_DIR: scratch, DB_PATH: path.join(scratch, 'history.db'), REPORTS_DIR: path.join(scratch, 'reports') },
      stdio: 'inherit',
      timeout: 180000
    });
    if (result.status === 0 && !result.error) {
      passed++;
    } else {
      failures++;
      console.error(`FAIL ${file}: ${result.error?.message || `exit ${result.status}, signal ${result.signal}`}`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
}
if (!args.includes('--list')) console.log(`\nRESULT: ${passed} passed, ${failures} failed (exclusions listed above)`);
process.exitCode = failures ? 1 : 0;
