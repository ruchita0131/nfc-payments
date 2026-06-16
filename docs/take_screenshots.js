const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

async function shot(page, name) {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, fullPage: false });
  console.log('Saved:', file);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  // Register alice (Tier 2)
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle0' });
  await sleep(1000);
  await page.click('#tab-register');
  await sleep(400);
  await page.select('#auth-kyc', '2');
  await page.type('#auth-username', 'alice');
  await page.type('#auth-password', 'password123');
  await page.click('#auth-submit');
  await sleep(2500);

  // Wallet page - load
  await page.click('[data-view="wallet"]');
  await sleep(800);
  await page.$eval('#load-amount', el => { el.value = ''; });
  await page.type('#load-amount', '2000');
  // Submit via form submit event
  await page.evaluate(() => document.querySelector('#load-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await sleep(3500);
  await shot(page, 'web_05_wallet_loaded.png');

  // Register bob (need second user for tap)
  await page.click('#logout-btn');
  await sleep(600);
  await page.click('#tab-register');
  await sleep(400);
  await page.select('#auth-kyc', '0');
  await page.type('#auth-username', 'bob');
  await page.type('#auth-password', 'password123');
  await page.click('#auth-submit');
  await sleep(2500);
  // Load bob's wallet
  await page.click('[data-view="wallet"]');
  await sleep(600);
  await page.$eval('#load-amount', el => { el.value = ''; });
  await page.type('#load-amount', '500');
  await page.evaluate(() => document.querySelector('#load-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await sleep(3000);

  // Log back in as alice
  await page.click('#logout-btn');
  await sleep(600);
  await page.type('#auth-username', 'alice');
  await page.type('#auth-password', 'password123');
  await page.click('#auth-submit');
  await sleep(2500);

  // NFC Tap page
  await page.click('[data-view="tap"]');
  await sleep(1000);
  await shot(page, 'web_06_tap.png');

  // Fill in tap simulation
  await page.$eval('#tap-payer', el => { el.value = ''; });
  await page.type('#tap-payer', 'alice');
  try {
    await page.$eval('#tap-receiver', el => { el.value = ''; });
    await page.type('#tap-receiver', 'bob');
  } catch(e) {}
  await page.$eval('#tap-amount', el => { el.value = ''; });
  await page.type('#tap-amount', '50');
  await page.click('#start-tap-btn');
  await sleep(7000);
  await shot(page, 'web_07_tap_result.png');

  // Transactions history
  const txnViews = ['transactions', 'history', 'txn'];
  for (const v of txnViews) {
    try { await page.click(`[data-view="${v}"]`); await sleep(800); break; } catch(e) {}
  }
  await shot(page, 'web_08_transactions.png');

  // Architecture / security page
  const archViews = ['architecture', 'security', 'how-it-works'];
  for (const v of archViews) {
    try { await page.click(`[data-view="${v}"]`); await sleep(800); break; } catch(e) {}
  }
  await shot(page, 'web_09_architecture.png');

  await browser.close();
  console.log('\nAll remaining screenshots done!');
})().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
