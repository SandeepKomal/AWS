// Checks that site/problems.html and site/sitemap.xml match the troubleshooting
// data (rebuild them with: node tools/build-problems.js), and that every
// problem and scenario has a stable link.
// Run with: node tests/check_problems.js
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { build, sitemap, load, scenarioTitles } = require("../tools/build-problems.js");

const root = path.resolve(__dirname, "..");
const Q = load();
const html = fs.readFileSync(path.join(root, "site/problems.html"), "utf8");
assert.strictEqual(html, build(Q, scenarioTitles()), "site/problems.html is stale: run node tools/build-problems.js");
assert.strictEqual(fs.readFileSync(path.join(root, "site/sitemap.xml"), "utf8"), sitemap(Q), "site/sitemap.xml is stale: run node tools/build-problems.js");
for (const d of Q.doctor) {
  assert.match(html, new RegExp(`<section class="card problem" id="${d.id}">`), `${d.id}: its own section`);
  assert.ok(html.includes(`index.html#fix/${d.id}`), `${d.id}: links to the interactive entry`);
}
assert.doesNotMatch(html, /<script/, "problems.html works without JavaScript");
const app = fs.readFileSync(path.join(root, "site/app.js"), "utf8");
assert.match(app, /want === "fix"/, "#fix/<id> opens a problem");
assert.match(app, /want === "play"/, "#play/<id> opens a scenario");
console.log(`problems ok: ${Q.doctor.length} sections in problems.html, sitemap current`);
