import { chromium } from 'playwright'
import fs from 'node:fs'
const OUT = '/tmp/ux-site'
fs.mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.HOME + '/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
await page.goto('https://jsjm1986.github.io/CoHarness/', { waitUntil: 'networkidle', timeout: 60000 }).catch(()=>{})
await page.waitForTimeout(3000)
await page.screenshot({ path: OUT + '/01-hero.png' })
// admin section
const admin = await page.$('#admin') || await page.$('a[name="admin"]')
if (admin) { await admin.scrollIntoViewIfNeeded(); await page.waitForTimeout(1200); await page.screenshot({ path: OUT + '/02-admin.png' }) }
// capture section nav links for orientation
const nav = await page.evaluate(() => [...document.querySelectorAll('a[href^="#"]')].map(a => a.getAttribute('href') + '|' + a.textContent.trim()).slice(0, 30))
fs.writeFileSync(OUT + '/nav.txt', nav.join('\n'))
// a few more sections down the page
const secs = ['#runtime', '#collaboration', '#features', '#scenarios', '#interface', '#mobile', '#quickstart']
let i = 3
for (const s of secs) { const el = await page.$(s); if (el) { await el.scrollIntoViewIfNeeded(); await page.waitForTimeout(800); await page.screenshot({ path: `${OUT}/0${i}-${s.slice(1)}.png` }); i++ } }
await browser.close()
console.log('done', i - 3, 'sections')
