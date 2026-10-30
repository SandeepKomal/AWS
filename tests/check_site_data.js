// Checks the site's data: levels are complete and point at files that exist,
// every quiz question is well formed, the references hang together, every
// cheat sheet Try runs in the playground, and the page keeps its security rules.
// Run with: node tests/check_site_data.js
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const root = path.resolve(__dirname, "..");
global.window = {};
require(path.join(root, "site/data.js"));
require(path.join(root, "site/quiz-bank.js"));
require(path.join(root, "site/playground.js"));
const Q = window.QUEST;
const quiz = window.QUEST_QUIZ;
const { SCENARIOS, Account, shell, fillBlanks } = window.AQSim;
const scenarioIds = new Set(SCENARIOS.map((s) => s.id));
const ticks = (text, where) => assert.strictEqual((String(text).match(/`/g) || []).length % 2, 0, `${where}: unbalanced backticks in "${text}"`);

Q.levels.forEach((lv, i) => {
  assert.strictEqual(lv.id, String(i).padStart(2, "0"), `level ids run in order: ${lv.id}`);
  assert.ok(lv.title && lv.topic && lv.stage, `level ${lv.id}: title, topic, stage`);
  assert.ok(lv.learn.length >= 3 && lv.lab.length >= 2, `level ${lv.id}: what you learn and a lab`);
  for (const d of lv.docs) assert.ok(fs.existsSync(path.join(root, d)), `level ${lv.id}: ${d} exists in the repository`);
  for (const id of lv.practise) assert.ok(scenarioIds.has(id), `level ${lv.id}: scenario ${id} exists`);
  lv.learn.forEach((t) => ticks(t, `level ${lv.id}`));
});
for (const s of new Set(Q.levels.map((l) => l.stage))) {
  const ids = Q.levels.map((l, i) => (l.stage === s ? i : -1)).filter((i) => i >= 0);
  assert.strictEqual(ids[ids.length - 1] - ids[0] + 1, ids.length, `stage "${s}" levels are contiguous`);
}
for (const s of SCENARIOS) assert.ok(Q.levels.some((l) => l.id === s.level), `scenario ${s.id}: level ${s.level} exists`);
for (const id of scenarioIds) assert.ok(Q.levels.some((l) => l.practise.includes(id)), `scenario ${id} is practised by some level`);

let total = 0;
assert.deepStrictEqual(Object.keys(quiz).sort(), Q.levels.map((l) => l.id), "a quiz for every level and no other");
for (const lv of Q.levels) {
  const items = quiz[lv.id];
  assert.ok(items.length >= 4, `level ${lv.id} needs at least 4 quiz questions, has ${items.length}`);
  const seen = new Set();
  for (const item of items) {
    total++;
    const where = `level ${lv.id}: "${item.q}"`;
    assert.ok(typeof item.q === "string" && item.q.length > 10 && !seen.has(item.q), `${where}: question text, unique`);
    seen.add(item.q);
    assert.strictEqual(item.options.length, 4, `${where}: needs 4 options`);
    assert.strictEqual(new Set(item.options).size, 4, `${where}: options must differ`);
    assert.ok(Number.isInteger(item.answer) && item.answer >= 0 && item.answer < 4, `${where}: answer index`);
    assert.ok(typeof item.why === "string" && item.why.length > 40, `${where}: explanation`);
    for (const text of [item.q, item.why, ...item.options]) ticks(text, where);
  }
}

// Troubleshooting: reference answers with stable ids.
assert.ok(Q.doctor.length >= 30, "at least 30 troubleshooting entries");
const ids = Q.doctor.map((d) => d.id);
assert.strictEqual(new Set(ids).size, ids.length, "troubleshooting ids are unique");
for (const d of Q.doctor) {
  assert.match(d.id, /^[a-z0-9-]+$/, `doctor ${d.id}: id usable in a link`);
  for (const k of ["title", "meaning"]) assert.ok(d[k], `doctor ${d.id}: ${k}`);
  for (const k of ["errors", "causes", "confirm", "fix", "prevent"]) assert.ok(Array.isArray(d[k]) && d[k].length, `doctor ${d.id}: ${k}`);
  assert.ok(Q.levels.some((l) => l.id === d.level), `doctor ${d.id}: level ${d.level} exists`);
  for (const s of d.scenarios) assert.ok(scenarioIds.has(s), `doctor ${d.id}: scenario ${s} exists`);
  [...d.causes, ...d.fix, ...d.prevent, d.meaning].forEach((t) => ticks(t, `doctor ${d.id}`));
}
assert.deepStrictEqual(Q.doctorGroups.flatMap(([, g]) => g).sort(), [...ids].sort(), "every troubleshooting entry belongs to exactly one group");
// The errors the scenarios print are findable in the reference.
for (const code of ["ExpiredToken", "InvalidClientTokenId", "SignatureDoesNotMatch", "AccessDenied", "UnauthorizedOperation", "iam:PassRole", "AssumeRole", "AssumeRoleWithWebIdentity",
  "service control policy", "AccessDeniedException", "InsufficientInstanceCapacity", "VcpuLimitExceeded", "NoSuchBucket", "BucketAlreadyExists", "IllegalLocationConstraintException",
  "502 Bad Gateway", "503 Service Temporarily Unavailable", "504 Gateway Time-out", "SERVFAIL", "ETIMEDOUT", "Task timed out", "TooManyRequestsException", "ThrottlingException", "TargetNotConnected", "Connection refused"]) {
  assert.ok(Q.doctor.some((d) => d.errors.some((e) => e.includes(code))), `troubleshooting covers ${code}`);
}

for (const c of Q.architecture.components) {
  assert.ok(c.id && c.name && c.short && c.where && c.role && c.does.length && c.breaks && c.look.length, `architecture ${c.id}: complete`);
  for (const p of c.practise) assert.ok(scenarioIds.has(p), `architecture ${c.id}: scenario ${p} exists`);
  ticks(c.breaks, `architecture ${c.id}`);
}
for (const [key, g] of Object.entries(Q.guides)) assert.ok(g.what && g.steps.length && g.uses.length && g.tips.length, `guide ${key}: complete`);

// Cheat sheet: Try runs in its scenario without "not modelled"; Lab rows need a real account.
let tries = 0;
for (const row of Q.cheats) {
  assert.ok(row.length === 3 || row.length === 4, `cheat "${row[0]}": [command, what, group, where?]`);
  const [cmd, what, group, where] = row;
  assert.ok(cmd && what && group, `cheat "${cmd}": filled in`);
  if (!where) continue;
  tries++;
  assert.ok(where === "any" || scenarioIds.has(where), `cheat "${cmd}": scenario ${where} exists`);
  for (const s of where === "any" ? SCENARIOS.filter((x) => !["expired", "rootkeys"].includes(x.id)).slice(0, 6) : [SCENARIOS.find((x) => x.id === where)]) {
    const a = new Account(s);
    const full = fillBlanks(a, cmd);
    assert.doesNotMatch(full, /<[a-z-]+>/, `cheat "${cmd}": every blank fills in scenario ${s.id}`);
    const out = shell(a, full).map(([t]) => t).join("\n");
    assert.doesNotMatch(out, /Found invalid choice|could not run that command|command not found|the following arguments are required|Bad value|Unable to load paramfile|NotFound|cannot be found|is not a valid/, `cheat "${cmd}" in ${s.id}: ${out.slice(0, 300)}`);
  }
}
assert.strictEqual(new Set(Q.cheats.map((r) => r[0])).size, Q.cheats.length, "cheat sheet commands are unique");

// The pages: the CSP, no inline styles or handlers, the footer lines, search metadata.
for (const page of ["index.html", "problems.html"]) {
  const html = fs.readFileSync(path.join(root, "site", page), "utf8");
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'">/, `${page}: CSP`);
  assert.doesNotMatch(html, /\sstyle=|\son[a-z]+=|<script>(?!<\/script>)/i, `${page}: no inline styles, handlers or scripts`);
  for (const src of html.match(/(?:src|href)="(?!https?:|#|index\.html#|mailto:)[^"]+"/g) || []) assert.ok(fs.existsSync(path.join(root, "site", src.replace(/^\w+="|"$/g, "").split("#")[0])), `${page}: ${src} exists`);
  for (const ext of html.match(/(?:src|href)="https?:[^"]+"/g) || []) assert.match(ext, /^href="https:\/\/(github\.com\/SandeepKomal|sandeepkomal\.github\.io\/AWS\/|aws\.amazon\.com\/pricing\/|calculator\.aws\/)/, `${page}: only plain links leave the site: ${ext}`);
  assert.doesNotMatch(html, /<script[^>]+src="https?:|<link[^>]+href="https?:[^"]+"[^>]*rel="stylesheet"/, `${page}: nothing loaded from other sites`);
  assert.match(html, /<meta name="description" content="[^"]{80,}">/, `${page}: description`);
  assert.match(html, /<meta property="og:title"/, `${page}: Open Graph`);
  assert.match(html, /Amazon Web Services, AWS and related marks are trademarks of Amazon\.com, Inc\. or its affiliates\. This project is independent and not affiliated with or endorsed by Amazon Web Services\./, `${page}: trademark line`);
  assert.match(html, /© 2024–2026 Sandeep Komal Pothu and contributors\./, `${page}: copyright`);
}
const index = fs.readFileSync(path.join(root, "site/index.html"), "utf8");
assert.match(index, /<title>AWS Quest<\/title>/);
assert.match(index, /The playground is a simulation: it never connects to AWS or touches a real account\./);
assert.match(index, /illustrative us-east-1 list prices as of June 2026/);
assert.match(index, /<button type="button" class="link-btn" id="forget">Clear it<\/button>/);
assert.ok(index.includes(`as of ${window.AQSim.PRICES.asOf}`), "the footer's price date matches the simulator's");
for (const f of fs.readdirSync(path.join(root, "site")).filter((x) => x.endsWith(".js"))) {
  const src = fs.readFileSync(path.join(root, "site", f), "utf8");
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|fetch\(|XMLHttpRequest|WebSocket|sendBeacon/, `${f}: no HTML injection or network calls`);
  assert.doesNotMatch(src, /localStorage\.(get|set|remove)Item\("(?!dq-aws:)/, `${f}: storage keys use the dq-aws: prefix`);
}
assert.match(fs.readFileSync(path.join(root, "site/robots.txt"), "utf8"), /Sitemap: https:\/\/sandeepkomal\.github\.io\/AWS\/sitemap\.xml/);

console.log(`site data ok: ${Q.levels.length} levels, ${total} quiz questions, ${Q.doctor.length} troubleshooting entries, ${Q.cheats.length} cheat sheet commands (${tries} Try), ${Q.architecture.components.length} components`);
