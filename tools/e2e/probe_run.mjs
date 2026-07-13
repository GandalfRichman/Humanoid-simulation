import { chromium } from "playwright";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
const page = await browser.newPage();
page.on("console", m => console.log("[console]", m.text()));
await page.goto("http://localhost:4173/probe.html");
await page.waitForTimeout(15000);
console.log("--- page log ---");
console.log(await page.textContent("#log"));
await browser.close();
