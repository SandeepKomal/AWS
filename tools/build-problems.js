// Builds site/problems.html and site/sitemap.xml from the troubleshooting data:
// one plain section per problem, readable without JavaScript.
// Run with: node tools/build-problems.js   (tests/check_problems.js fails if they are stale)
"use strict";
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
function load() {
  const ctx = { window: {} };
  new Function("window", fs.readFileSync(path.join(root, "site/data.js"), "utf8"))(ctx.window);
  return ctx.window.QUEST;
}
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const rich = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
const list = (items) => `<ul>${items.map((t) => `<li>${rich(t)}</li>`).join("")}</ul>`;

function build(Q, titles) {
  const byId = Object.fromEntries(Q.doctor.map((d) => [d.id, d]));
  const index = Q.doctorGroups.map(([name, ids]) => `<h2>${esc(name)}</h2>\n<ul>${ids.map((id) => `<li><a href="#${id}">${esc(byId[id].title)}</a></li>`).join("")}</ul>`).join("\n");
  const sections = Q.doctorGroups.flatMap(([, ids]) => ids).map((id) => {
    const d = byId[id];
    const lv = Q.levels.find((l) => l.id === d.level);
    const practise = d.scenarios.filter((s) => titles[s]).map((s) => `<a href="index.html#play/${s}">${esc(titles[s])}</a>`).join(" · ");
    return `<section class="card problem" id="${id}">
<h3>${esc(d.title)}</h3>
<h4>Error text</h4>
<pre class="error-text"><code>${d.errors.map(esc).join("\n")}</code></pre>
<h4>Why it happens</h4>
<p>${rich(d.meaning)}</p>
<h4>Likely causes</h4>
${list(d.causes)}
<h4>Confirm</h4>
<pre><code>${d.confirm.map(esc).join("\n")}</code></pre>
<h4>Fix</h4>
${list(d.fix)}
<h4>Prevent it</h4>
${list(d.prevent)}
<p class="note"><strong>Now learn it:</strong> ${practise ? `break and fix it yourself in ${practise}, then take` : "take"} <a href="index.html#level-${lv.id}">Level ${lv.id} · ${esc(lv.title)}</a>. <a href="index.html#fix/${id}">Open in the site</a></p>
</section>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'">
  <title>Common AWS errors and how to fix them · AWS Quest</title>
  <meta name="description" content="What common AWS errors mean and how to fix them: AccessDenied, ExpiredToken, UnauthorizedOperation, iam:PassRole, connection timeouts, ALB 502/503/504, NoSuchBucket, KMS AccessDeniedException, Lambda timeouts and more.">
  <meta property="og:type" content="article">
  <meta property="og:title" content="Common AWS errors and how to fix them">
  <meta property="og:description" content="Each AWS error with its exact text, cause, how to confirm, the fix and how to prevent it.">
  <meta property="og:url" content="${Q.site}problems.html">
  <link rel="canonical" href="${Q.site}problems.html">
  <link rel="stylesheet" href="style.css">
  <link rel="icon" href="logo.svg" type="image/svg+xml">
</head>
<body>
<main class="wrap problems">
<p class="eyebrow"><a href="index.html">AWS Quest</a></p>
<h1>Common AWS errors and how to fix them</h1>
<p class="lede">${Q.doctor.length} problems, each with the exact error text, why it happens, the likely causes, how to confirm, the fix and how to prevent it. Then learn it for good: break and fix each one yourself in the <a href="index.html#pg-title">browser playground</a>. To search by pasting an error, use the <a href="index.html#doctor">interactive version</a>.</p>
<nav class="card problems-index" aria-label="Problems">
${index}
</nav>
${sections}
</main>
<footer class="foot">
<div class="wrap foot-base">
<p>© 2024–2026 Sandeep Komal Pothu and contributors. Open source under the MIT License.</p>
<p class="foot-tm">Amazon Web Services, AWS and related marks are trademarks of Amazon.com, Inc. or its affiliates. This project is independent and not affiliated with or endorsed by Amazon Web Services.</p>
</div>
</footer>
</body>
</html>
`;
}
function sitemap(Q) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${Q.site}</loc></url>
  <url><loc>${Q.site}problems.html</loc></url>
</urlset>
`;
}
function scenarioTitles() {
  require(path.join(root, "site/playground.js"));
  return Object.fromEntries(globalThis.AQSim.SCENARIOS.map((s) => [s.id, s.title]));
}

if (require.main === module) {
  const Q = load();
  fs.writeFileSync(path.join(root, "site/problems.html"), build(Q, scenarioTitles()));
  fs.writeFileSync(path.join(root, "site/sitemap.xml"), sitemap(Q));
  console.log(`wrote site/problems.html (${Q.doctor.length} problems) and site/sitemap.xml`);
}
module.exports = { build, sitemap, load, scenarioTitles };
