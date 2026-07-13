// End-to-end smoke test against the built app (vite preview on :4173).
import { chromium } from "playwright";

const results = [];
const check = (label, ok, detail = "") => {
  results.push([label, ok, detail]);
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label} ${detail}`);
};

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });

const consoleLogs = [];
page.on("console", (m) => consoleLogs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => consoleLogs.push(`[pageerror] ${e.message}`));

await page.goto("http://localhost:4173/", { waitUntil: "domcontentloaded" });

check("crossOriginIsolated", await page.evaluate(() => crossOriginIsolated));

// wait for the sim to finish loading (loading overlay disappears)
try {
  await page.waitForSelector("text=Preparing the robot lab", { timeout: 5000 });
} catch { /* may load too fast */ }
const loaded = await page
  .waitForFunction(
    () => !document.body.innerText.includes("Preparing the robot lab") &&
      !document.body.innerText.includes("Failed to load"),
    null,
    { timeout: 120000 },
  )
  .then(() => true)
  .catch(() => false);
check("robot loads", loaded);
if (!loaded) {
  console.log(consoleLogs.slice(-40).join("\n"));
  await browser.close();
  process.exit(1);
}

await page.waitForTimeout(1500);
check("console shows joints", (await page.textContent("body")).includes("joints"));

// robot should be standing (not fallen) after a couple seconds of policy control
await page.waitForTimeout(3000);
const fallenEarly = (await page.textContent("body")).includes("The robot fell");
check("stands under policy (3s)", !fallenEarly);

// screenshot for the record
await page.screenshot({ path: "docs/screenshots/shot_loaded.png" });

// --- run the default program (walks 2m, turns, walks 1m) at 2x speed -----
await page.click("button:has-text('2×')");
await page.click("button:has-text('Run')");
await page.waitForTimeout(1000);
check("program starts", (await page.textContent("body")).includes("Running JavaScript"));

const finished = await page
  .waitForFunction(() => document.body.innerText.includes("Program finished."), null, { timeout: 120000 })
  .then(() => true)
  .catch(() => false);
const bodyText = await page.textContent("body");
check("default program finishes", finished, finished ? "" : bodyText.slice(-400));
check("no fall during walk", !bodyText.includes("The robot fell"));
check("print output shown", bodyText.includes("Done! Position:"));
await page.screenshot({ path: "docs/screenshots/shot_after_walk.png" });

// --- inspector: select a joint from the Inspect tab ----------------------
await page.click("button:has-text('inspect')");
await page.click("button:has-text('left_knee')");
await page.waitForTimeout(400);
const inspectorText = await page.textContent("body");
check("inspector shows joint props", inspectorText.includes("live angle") && inspectorText.includes("balance policy"));

// --- error with line number ----------------------------------------------
await page.click("button:has-text('Reset')");
await page.waitForTimeout(500);
// replace editor content via the store (faster than typing into Monaco)
await page.evaluate(() => {
  // dispatch through Monaco's model if present
  const w = window;
  if (w.monaco?.editor) {
    const model = w.monaco.editor.getModels()[0];
    model.setValue("print('a');\nrobot.nonsense();\n");
  }
});
await page.waitForTimeout(300);
await page.click("button:has-text('Run')");
const errored = await page
  .waitForFunction(() => document.body.innerText.includes("not a function"), null, { timeout: 15000 })
  .then(() => true)
  .catch(() => false);
const errText = await page.textContent("body");
check("runtime error surfaces", errored);
check("error has line number", /line 2/.test(errText));

// --- hand guard on Basic ---------------------------------------------------
await page.evaluate(() => {
  const model = window.monaco.editor.getModels()[0];
  model.setValue("await robot.grasp('right');\n");
});
await page.click("button:has-text('Run')");
const guarded = await page
  .waitForFunction(() => document.body.innerText.includes("fixed, non-articulated hands"), null, { timeout: 15000 })
  .then(() => true)
  .catch(() => false);
check("Basic hand guard error", guarded);

// --- switch to EDU U6 and grasp -------------------------------------------
await page.click("button:has-text('G1 Basic')");
await page.click("text=G1 EDU U6");
const eduLoaded = await page
  .waitForFunction(
    () => document.body.innerText.includes("Robot loaded — 53 joints") ||
      document.body.innerText.match(/Robot loaded — \d+ joints/),
    null,
    { timeout: 120000 },
  )
  .then(() => true)
  .catch(() => false);
check("EDU U6 loads", eduLoaded);
await page.waitForTimeout(2500);

await page.evaluate(() => {
  const model = window.monaco.editor.getModels()[0];
  model.setValue(
    "await robot.grasp('right');\nprint('index force', await robot.getFingerForce('right','index'));\nawait robot.release('right');\nprint('grasp cycle ok');",
  );
});
await page.click("button:has-text('Run')");
const grasped = await page
  .waitForFunction(() => document.body.innerText.includes("grasp cycle ok"), null, { timeout: 30000 })
  .then(() => true)
  .catch(() => false);
check("EDU grasp/release cycle", grasped);
await page.screenshot({ path: "docs/screenshots/shot_edu.png" });

// --- blocks mode ------------------------------------------------------------
await page.click("[role=tab]:has-text('Blocks')");
const blocklyVisible = await page
  .waitForSelector("svg.blocklySvg, .blocklyToolboxDiv", { timeout: 20000, state: "attached" })
  .then(() => true)
  .catch(() => false);
await page.waitForTimeout(800);
check("Blockly workspace renders", blocklyVisible);
const hasHandsCategory = (await page.textContent("body")).includes("Hands");
check("EDU hand blocks category present", hasHandsCategory);

// --- share URL round trip ----------------------------------------------------
await page.click("[role=tab]:has-text('JavaScript')");
await page.evaluate(() => {
  const model = window.monaco.editor.getModels()[0];
  model.setValue("print('shared program!');");
});
await page.click("button:has-text('Share')");
await page.waitForTimeout(400);
const shareUrl = await page.inputValue("input[readonly]").catch(() => "");
check("share URL produced", shareUrl.includes("#p="), shareUrl.slice(0, 60) + "…");

const page2 = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page2.goto(shareUrl, { waitUntil: "domcontentloaded" });
const sharedLoaded = await page2
  .waitForFunction(() => document.body.innerText.includes("Opened shared project"), null, { timeout: 60000 })
  .then(() => true)
  .catch(() => false);
check("share URL hydrates project", sharedLoaded);
const sharedHasCode = await page2
  .waitForFunction(
    () => window.monaco?.editor.getModels().some((m) => m.getValue().includes("shared program!")),
    null,
    { timeout: 60000 },
  )
  .then(() => true)
  .catch(() => false);
check("shared code visible in editor", sharedHasCode);
if (!sharedHasCode) await page2.screenshot({ path: "docs/screenshots/shot_share_fail.png" });
await page2.close();
await page.keyboard.press("Escape"); // close the share dialog

// --- fall test: shove via squat snippet --------------------------------------
await page.click("button:has-text('Reset')");
await page.evaluate(() => {
  const model = window.monaco.editor.getModels()[0];
  model.setValue(
    "robot.setJoint('left_knee_joint', 120);\nrobot.setJoint('right_hip_pitch_joint', -120);\nawait robot.wait(4);",
  );
});
await page.click("button:has-text('Run')");
const fell = await page
  .waitForFunction(() => document.body.innerText.includes("The robot fell"), null, { timeout: 30000 })
  .then(() => true)
  .catch(() => false);
check("robot can fall (leg override)", fell);
await page.screenshot({ path: "docs/screenshots/shot_fallen.png" });

console.log("\nBrowser console (last 25):");
console.log(consoleLogs.slice(-25).join("\n"));

await browser.close();
const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `\n${failed.length} FAILURES` : "\nALL PASS");
process.exit(failed.length ? 1 : 0);
