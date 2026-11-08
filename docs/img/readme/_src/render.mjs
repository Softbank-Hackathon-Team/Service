import { chromium } from 'playwright';
const [, , html, png, width = '1800'] = process.argv;
const b = await chromium.launch(); const p = await b.newPage({ viewport:{width:Number(width),height:1200}, deviceScaleFactor:2 });
await p.goto('file://'+html); await p.evaluate(()=>document.fonts.ready);
await p.locator('#canvas').screenshot({path:png}); await b.close();
