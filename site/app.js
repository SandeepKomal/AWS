// DevOps Nimbus AWS site. No dependencies, no network requests.
"use strict";

(function () {
  const Q = window.TRACK;
  const $ = (sel) => document.querySelector(sel);
  const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const scrollToEl = (el) => el.scrollIntoView({ block: "start", behavior: still() ? "auto" : "smooth" });

  // h("tag.class", {attr: value}, ...children): build DOM from elements and text nodes only.
  function h(spec, attrs, ...kids) {
    const [tag, ...classes] = spec.split(".");
    const el = document.createElement(tag);
    if (classes.length) el.className = classes.join(" ");
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, "");
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  // Text with `code` spans.
  const rich = (text) => String(text).split(/(`[^`]+`)/).map((part) => (part.startsWith("`") ? h("code", null, part.slice(1, -1)) : part));

  const store = {
    get(key, fallback) { try { return JSON.parse(localStorage.getItem("dq-aws:" + key)) ?? fallback; } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem("dq-aws:" + key, JSON.stringify(value)); } catch { /* private mode */ } }
  };
  // Everything the site keeps lives under "dq-aws:" in this browser; one click removes it.
  function forgetEverything() {
    if (!confirm("Clear your progress, quiz scores and saved names from this browser?")) return;
    try { for (const k of Object.keys(localStorage)) if (k.startsWith("dq-aws:")) localStorage.removeItem(k); } catch { /* storage blocked */ }
    location.reload();
  }
  async function copyLink(button, hash) {
    const url = `${location.href.split("#")[0]}#${hash}`;
    try { await navigator.clipboard.writeText(url); button.textContent = "Link copied"; } catch { button.textContent = "Copy failed"; }
    setTimeout(() => { button.textContent = "Copy link"; }, 1400);
  }

  // The first screen needs only data.js, scenarios.js (a small index of the
  // playground's incidents and prices), this file and engage.js. The rest loads
  // in the background after the first paint, or at once when something needs it.
  const LAZY = { quiz: ["quiz-bank.js"], xray: ["policy-xray.js"], play: ["playground.js"], arch: ["architecture.js"] };
  const loading = {};
  function loadScript(src) {
    if (!loading[src]) {
      loading[src] = new Promise((resolve, reject) => {
        const el = document.createElement("script");
        el.src = src;
        el.async = false; // run in the order they were added
        el.onload = resolve;
        el.onerror = () => { delete loading[src]; el.remove(); reject(new Error("Could not load " + src)); };
        document.body.append(el);
      });
    }
    return loading[src];
  }
  const load = (srcs) => Promise.all(srcs.map(loadScript));
  // What to draw once a feature's scripts have run (set further down).
  const ready = {};
  const needed = {};
  const need = (what) => (needed[what] = needed[what] || load(LAZY[what]).then(() => { if (ready[what]) ready[what](); }, (e) => { delete needed[what]; throw e; }));
  const warm = () => Promise.all(Object.keys(LAZY).map(need));

  const SCENARIOS = window.TRACK_SCENARIOS || [];
  const PG = () => window.AQPlayground;
  // Run something in the playground once it has loaded.
  const withPg = (fn) => (PG() ? fn(PG()) : need("play").then(() => fn(PG())));
  const scenarioTitles = () => Object.fromEntries(SCENARIOS.map((x) => [x.id, x.title]));
  function practise(id) { location.hash = "play/" + id; }
  const practiseRow = (ids, label) => {
    const titles = scenarioTitles();
    const known = (ids || []).filter((id) => titles[id]);
    return known.length ? h("div.doctor-practise", null, h("span.muted.small", null, label),
      known.map((id) => h("a.chip", { href: "#play/" + id }, titles[id]))) : null;
  };
  const repoUrl = (p) => `${Q.repo}/${/\.[a-z]+$|S3FullAccess$|\/[^/.]+-\d$|userdata|cft_launch_template/.test(p) ? "blob" : "tree"}/main/${p.split("/").map(encodeURIComponent).join("/")}`;
  document.querySelectorAll("[data-repo]").forEach((a) => { a.href = Q.repo + a.dataset.repo; });

  // --- tabs and deep links -----------------------------------------------------

  const tabs = ["path", "quiz", "xray", "doctor", "cheats", "arch"];
  let current = null;
  function show() {
    const [want, sub] = location.hash.slice(1).split("/");
    const tab = want === "fix" ? "doctor" : want === "play" ? "path" : tabs.includes(want) ? want : "path";
    if (tab !== current) {
      const page = $("#tab-" + tab);
      page.classList.remove("tab-in");
      void page.offsetWidth; // restart the fade
      page.classList.add("tab-in");
    }
    current = tab;
    if (LAZY[tab]) need(tab);
    for (const t of tabs) $("#tab-" + t).hidden = t !== tab;
    const fixTabs = [...document.querySelectorAll(".mode.fix a[data-tab]")].map((a) => a.dataset.tab);
    const mode = fixTabs.includes(tab) ? "fix" : "learn";
    document.documentElement.dataset.mode = mode;
    document.querySelectorAll(".sw").forEach((a) => (a.classList.contains(mode) ? a.setAttribute("aria-current", "true") : a.removeAttribute("aria-current")));
    document.querySelectorAll(".subnav a").forEach((a) => {
      if (a.dataset.tab === tab) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    if (want === "fix" && sub) openProblem(sub);
    if (want === "play" && sub) { if (PG()) PG().load(sub); else need("play").then(() => { if (location.hash === "#play/" + sub) PG().load(sub); }); }
    document.title = want === "fix" && sub && Q.doctor.find((d) => d.id === sub) ? `${Q.doctor.find((d) => d.id === sub).title} · AWS · DevOps Nimbus` : "AWS · DevOps Nimbus";
  }
  window.addEventListener("hashchange", () => {
    const before = current;
    show();
    if (current !== before && !/^#(play|fix)\//.test(location.hash)) window.scrollTo(0, 0);
  });

  // --- hero: the VPC, with and without a NAT gateway ----------------------------

  function renderSignature() {
    const P = window.TRACK_PRICES;
    const natMonth = P.natHour * P.hours;
    const res = (cls, text) => h("span.res" + (cls ? "." + cls : ""), null, text);
    const nat = res("", "NAT gateway");
    const app = res("", "app server");
    const route = h("span", null, "no route out");
    const probe = h("span.bad", null, "times out");
    const meter = h("b.dim", null, "$0.00 / month");
    const toggle = h("button.toggle", { type: "button", "aria-pressed": "false" }, "Add a NAT gateway and a route");
    nat.hidden = true;
    toggle.addEventListener("click", () => {
      const on = toggle.getAttribute("aria-pressed") !== "true";
      toggle.setAttribute("aria-pressed", String(on));
      nat.hidden = !on;
      nat.className = on ? "res cost" : "res";
      app.className = on ? "res live" : "res";
      route.textContent = on ? "0.0.0.0/0 → NAT gateway" : "no route out";
      probe.textContent = on ? "200 OK" : "times out";
      probe.className = on ? "ok" : "bad";
      meter.textContent = on ? `≈ $${Math.round(natMonth)} / month + $${P.natGb} per GB` : "$0.00 / month";
      meter.className = on ? "warn" : "dim";
    });
    $("#stage").replaceChildren(
      h("div.stage-bar", null, h("div", null, h("strong", null, "vpc-kitchen  10.0.0.0/16"), h("div", null, "The private server cannot reach the internet to install updates.")), h("div", null, toggle)),
      h("div.vpc", null,
        h("div.subnet", null, h("h4", null, "public 10.0.1.0/24 · route to internet gateway"), res("live", "load balancer"), nat),
        h("div.subnet", null, h("h4", null, "private 10.0.11.0/24 · ", route), app, res("", "database"))),
      h("div.probe.mono", null, h("span.dim", null, "app server $ curl -m 5 https://api.github.com  "), probe),
      h("div.meter", null, h("span.dim", null, "What it costs"), meter),
      h("p.stage-note", null, `Simulation. Illustrative us-east-1 prices as of ${P.asOf}. `, h("a", { href: "#play/nat" }, "Fix it yourself in the playground")));
    $("#stat-scenarios").textContent = String(SCENARIOS.length);
    $("#stat-levels").textContent = String(Q.levels.length);
    $("#stat-problems").textContent = String(Q.doctor.length);
  }

  // --- path ----------------------------------------------------------------------

  const stageId = (name) => "stage-" + name.toLowerCase().replace(/[^a-z]+/g, "-");
  function renderPath() {
    const done = new Set(store.get("done", []));
    const scores = store.get("quiz", {});
    const box = $("#levels");
    box.replaceChildren();
    let stage = "";
    let list;
    for (const lv of Q.levels) {
      if (lv.stage !== stage) {
        stage = lv.stage;
        list = h("ol.levels");
        box.append(h("h3.stage", { id: stageId(stage) }, stage), list);
      }
      const isDone = done.has(lv.id);
      list.append(h("li.level" + (isDone ? ".done" : ""), { id: "level-" + lv.id },
        h("input", { type: "checkbox", checked: isDone, "aria-label": `Mark level ${lv.id} complete`,
          onchange: (e) => { if (e.target.checked) done.add(lv.id); else done.delete(lv.id); store.set("done", [...done]); if (e.target.checked) window.DQEngage.active(); renderPath(); } }),
        h("span.num", null, lv.id),
        h("details.what", null,
          h("summary", null, h("span.title", null, lv.title), h("span.topic", null, lv.topic)),
          h("div.level-body", null,
            h("div", null, h("h4", null, "What you learn"), h("ul", null, lv.learn.map((t) => h("li", null, ...rich(t))))),
            h("div", null, h("h4", null, "Lab in a sandbox account"), window.DQEngage.order(lv, h("pre", null, h("code", null, lv.lab.join("\n"))))),
            h("p.level-links", null, "Notes in this repository: ", lv.docs.map((d, i) => [i ? " · " : "", h("a", { href: repoUrl(d) }, d)])),
            practiseRow(lv.practise, "Practise in the playground:"))),
        h("span.actions", null, h("a.small", { href: "#quiz", onclick: () => { $("#quiz-level").value = lv.id; renderQuiz(); } }, lv.id in scores ? `Quiz ${scores[lv.id]}%` : "Quiz"))));
    }
    renderStages(done);
    $("#bar-fill").style.width = (done.size / Q.levels.length * 100) + "%";
    $("#bar").setAttribute("aria-valuenow", String(done.size));
    $("#bar").setAttribute("aria-valuemax", String(Q.levels.length));
    $("#bar-text").textContent = `${done.size} of ${Q.levels.length} levels complete`;
  }
  function renderStages(done) {
    const stages = [];
    for (const lv of Q.levels) {
      let st = stages.find((x) => x.name === lv.stage);
      if (!st) stages.push(st = { name: lv.stage, levels: [] });
      st.levels.push(lv);
    }
    $("#stages").replaceChildren(...stages.map((st, i) => {
      const n = st.levels.filter((l) => done.has(l.id)).length;
      const ring = h("span.ring", { "aria-hidden": "true" });
      ring.style.setProperty("--p", Math.round(n / st.levels.length * 100));
      return h("a.stage-card" + (n === st.levels.length ? ".complete" : ""), { role: "listitem", href: "#" + stageId(st.name),
        onclick: (e) => { e.preventDefault(); scrollToEl(document.getElementById(stageId(st.name))); } },
      ring, h("span.stage-num", null, `Stage ${i + 1}`), h("strong", null, st.name), h("span.muted", null, `${n} of ${st.levels.length} levels`));
    }));
  }

  // --- quiz ----------------------------------------------------------------------

  const EXAM_SIZE = 20;
  const questionsFor = (id) => ((window.TRACK_QUIZ || {})[id] || []).map((item) => ({ ...item, level: id }));
  function shuffle(list) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  function renderQuiz() {
    if (!window.TRACK_QUIZ) { need("quiz").then(renderQuiz); return; }
    const mode = $("#quiz-level").value;
    const exam = mode === "exam";
    const items = exam ? shuffle(Q.levels.flatMap((l) => questionsFor(l.id))).slice(0, EXAM_SIZE) : questionsFor(mode);
    const out = $("#quiz-list");
    out.replaceChildren();
    let answered = 0, correct = 0;
    const score = h("div.score", { "aria-live": "polite" });
    const bar = h("span.fill");
    const updateScore = () => {
      score.replaceChildren(h("span", null, h("strong", null, `${correct}`), ` correct of ${answered} answered · ${items.length} questions`),
        h("span.meter", { role: "progressbar", "aria-label": "Answered", "aria-valuemin": "0", "aria-valuemax": String(items.length), "aria-valuenow": String(answered) }, bar));
      bar.style.width = (answered / items.length * 100) + "%";
      if (answered !== items.length) return;
      const pct = Math.round(correct / items.length * 100);
      if (!exam) { const all = store.get("quiz", {}); all[mode] = Math.max(all[mode] || 0, pct); store.set("quiz", all); window.DQEngage.active(); renderPath(); }
      score.append(h("p.result", null, h("strong", null, `${pct}%. `),
        pct === 100 ? "Perfect score." : pct >= 75 ? "Strong. Review the explanations you missed." : "Read the explanations, then practise the level and try again.",
        " ", h("button.linkish", { type: "button", onclick: renderQuiz }, exam ? "New exam" : "Try again")));
    };
    items.forEach((item, qi) => {
      const fb = h("p.feedback", { "aria-live": "polite" });
      const opts = h("div.options", { role: "group", "aria-label": `Question ${qi + 1}` });
      shuffle(item.options.map((text, index) => ({ text, index }))).forEach((opt) => {
        opts.append(h("button.opt", { type: "button", "data-right": opt.index === item.answer ? "1" : null,
          onclick: (e) => {
            const right = opt.index === item.answer;
            opts.querySelectorAll("button").forEach((b) => { b.disabled = true; if (b.dataset.right) b.classList.add("right"); });
            if (!right) e.currentTarget.classList.add("wrong");
            fb.replaceChildren(h("strong", null, right ? "Correct. " : "Not quite. "), ...rich(item.why));
            fb.className = "feedback " + (right ? "ok" : "bad");
            answered++;
            if (right) correct++;
            updateScore();
          } }, ...rich(opt.text)));
      });
      const from = exam ? Q.levels.find((l) => l.id === item.level) : null;
      out.append(h("div.card.question", null, from ? h("p.tag", null, `Level ${from.id} · ${from.topic}`) : null, h("h3", null, `${qi + 1}. `, ...rich(item.q)), opts, fb));
    });
    out.prepend(score);
    updateScore();
  }

  // --- Policy X-ray --------------------------------------------------------------

  const narrow = () => matchMedia("(max-width: 860px)").matches;
  function placeNote(li) {
    const note = $("#xray-note");
    if (li && narrow()) {
      const slot = $("#xray-lines .note-slot") || h("li.note-slot");
      li.after(slot);
      slot.append(note);
    } else if (note.parentElement !== $("#xray-view")) {
      $("#xray-view").append(note);
      const slot = $("#xray-lines .note-slot");
      if (slot) slot.remove();
    }
  }
  let xrayPick = -1;
  let pasted = null;
  function renderXray(index) {
    xrayPick = index;
    document.querySelectorAll("#xray-pick button").forEach((b) => b.setAttribute("aria-selected", String(Number(b.dataset.index) === index)));
    const paste = index < 0;
    if (!paste && !window.AQPolicy) { need("xray").then(() => { if (xrayPick === index) renderXray(index); }); return; }
    const res = paste ? pasted : window.AQPolicy.explain(JSON.stringify(Q.xray[index].text));
    $("#xray-edit").hidden = !paste || Boolean(pasted);
    $("#xray-result").hidden = !res;
    $("#xray-view").hidden = !res;
    $("#xray-actions").hidden = !paste;
    if (!res) return;
    const lines = $("#xray-lines");
    placeNote(null);
    lines.replaceChildren(...res.lines.map(({ line, note, warns }, i) => {
      if (note === null && !warns.length) return h("li", null, h("span.line.blank", null, line));
      return h("li", null, h("button.line" + (warns.length ? ".warn" : ""), { type: "button",
        onclick: (e) => {
          lines.querySelectorAll(".line").forEach((b) => b.classList.remove("on"));
          e.currentTarget.classList.add("on");
          placeNote(e.currentTarget.parentElement);
          $("#xray-note").replaceChildren(h("pre", null, h("code", null, line.trim())), note ? h("p", null, ...rich(note)) : null,
            ...warns.map((w) => h("p.xray-warn", null, ...rich(w))), h("p.muted", null, `Line ${i + 1} of ${res.lines.length}`));
        } }, line));
    }));
    $("#xray-note").replaceChildren(h("p.muted", null, "Select any line to see what it does."));
    const warned = res.lines.filter((r) => r.warns.length).length;
    $("#xray-summary").textContent = [paste ? null : Q.xray[index].name, res.kind, `${res.statements} statement${res.statements === 1 ? "" : "s"}`, warned ? `${warned} line${warned === 1 ? "" : "s"} flagged` : "nothing flagged"].filter(Boolean).join(" · ");
    $("#xray-source").replaceChildren(...(!paste && Q.xray[index].path ? [h("span.muted", null, "From this repository: "), h("a", { href: repoUrl(Q.xray[index].path) }, Q.xray[index].path)] : []));
    $("#xray-review").replaceChildren(...(res.review.length ? [h("details.xray-missing", { open: !narrow() },
      h("summary", null, `${res.review.length} thing${res.review.length === 1 ? "" : "s"} missing or worth a look`),
      h("ul.xray-review", null, res.review.map((n) => h("li", null, ...rich(n)))))] : []));
    const first = $("#xray-lines .line.warn") || $("#xray-lines button.line");
    if (first && !narrow()) first.click();
  }
  function explainPasted() {
    const text = $("#xray-input").value;
    const error = $("#xray-error");
    const fail = (msg) => { error.textContent = msg; error.hidden = false; };
    if (!text.trim()) return fail("Paste a policy first, or choose Load an example.");
    if (!window.AQPolicy) { need("xray").then(explainPasted); return; }
    const res = window.AQPolicy.explain(text);
    if (res.error) return fail(res.error);
    error.hidden = true;
    pasted = res;
    renderXray(-1);
    scrollToEl($("#xray-result"));
  }

  // --- troubleshooting: search over pasted error text ----------------------------

  const haystack = (d) => [d.title, d.id, ...d.errors, d.meaning, ...d.causes, ...d.fix].join(" ").toLowerCase();
  const tokens = (text) => String(text).toLowerCase().replace(/arn:aws:[^\s"]+|\b[0-9a-f-]{20,}\b|\b\d{12}\b|\b(i|sg|subnet|vpc|vol|snap|ami|rtb|nat|acl)-[0-9a-f]+\b/g, " ").split(/[^a-z0-9.:_/-]+/).filter((w) => w.length > 2);
  function rankProblems(text) {
    const words = [...new Set(tokens(text))];
    if (!words.length) return [];
    const code = (/\(([A-Za-z.]+)\)/.exec(text) || [])[1];
    return Q.doctor.map((d) => {
      const hay = haystack(d);
      let score = words.filter((w) => hay.includes(w)).length / Math.max(3, words.length);
      if (code && d.errors.some((e) => e.includes(`(${code})`))) score += 2;
      if (d.errors.some((e) => text.length > 20 && e.toLowerCase().includes(text.trim().toLowerCase().slice(0, 40)))) score += 3;
      return [d, score];
    }).filter(([, s]) => s > 0.34).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([d]) => d);
  }
  function buildDoctorList() {
    const byId = Object.fromEntries(Q.doctor.map((d) => [d.id, d]));
    $("#doctor-list").replaceChildren(...Q.doctorGroups.map(([name, ids]) => h("div.doctor-group", null,
      h("div.doctor-group-name", null, name, h("span.doctor-group-count", null, String(ids.length))),
      h("div.doctor-group-items", null, ids.map((id) => h("a.chip", { href: "#fix/" + id, "data-id": id }, byId[id].title))))));
  }
  function renderDoctorSearch() {
    const text = $("#doctor-q").value;
    const out = $("#doctor-hits");
    if (!text.trim()) { out.replaceChildren(); $("#doctor-list").hidden = false; return; }
    const hits = rankProblems(text);
    $("#doctor-list").hidden = true;
    out.replaceChildren(hits.length ? h("ol.doctor-hits", null, hits.map((d) => h("li", null, h("a", { href: "#fix/" + d.id }, d.title), h("span.muted.small", null, d.meaning))))
      : h("p.muted", null, "No match. Try the error code in brackets (AccessDenied, ExpiredToken), an HTTP status (502) or a word such as timeout."));
  }
  function openProblem(id) {
    const d = Q.doctor.find((x) => x.id === id);
    if (!d) return;
    document.querySelectorAll("#doctor-list .chip").forEach((b) => b.setAttribute("aria-current", String(b.dataset.id === id)));
    const lv = Q.levels.find((l) => l.id === d.level);
    const copy = h("button.pill.small-pill", { type: "button", onclick: (e) => copyLink(e.currentTarget, "fix/" + id) }, "Copy link");
    const list = (items) => h("ul", null, items.map((t) => h("li", null, ...rich(t))));
    $("#doctor-out").replaceChildren(h("article.card.problem", { id: "problem-" + id },
      h("div.problem-head", null, h("h3", null, d.title), copy),
      h("h4", null, "Error text"), h("pre.error-text", null, h("code", null, d.errors.join("\n"))),
      h("h4", null, "Why it happens"), h("p", null, ...rich(d.meaning)),
      h("h4", null, "Likely causes"), list(d.causes),
      h("h4", null, "Confirm"), h("pre", null, h("code", null, d.confirm.join("\n"))),
      h("h4", null, "Fix"), list(d.fix),
      h("h4", null, "Prevent it"), list(d.prevent),
      // Fixing is the way in; the point is to learn it, so every answer ends in practice.
      h("div.learn-it", null,
        h("h4", null, "Now learn it"),
        h("p", null, "Break this yourself on a simulated account and fix it. Doing it once is what makes you recognise it next time."),
        practiseRow(d.scenarios, "Practise:"),
        lv ? h("p.note", null, "Then the level that teaches it: ", h("a", { href: "#level-" + lv.id, onclick: (e) => { e.preventDefault(); location.hash = "path"; setTimeout(() => scrollToEl($("#level-" + lv.id))); } }, `Level ${lv.id} · ${lv.title}`)) : null)));
    setTimeout(() => scrollToEl($("#doctor-out")));
  }

  // --- cheat sheet ----------------------------------------------------------------

  function copyButton(text) {
    return h("button.copy", { type: "button", "aria-label": "Copy command",
      onclick: async (e) => { const b = e.currentTarget; try { await navigator.clipboard.writeText(text); b.textContent = "Copied"; } catch { b.textContent = "Select it"; } setTimeout(() => { b.textContent = "Copy"; }, 1200); } }, "Copy");
  }
  const FILL = [{ key: "bucket", label: "Bucket", example: "my-bucket" }, { key: "instance-id", label: "Instance ID", example: "i-0abc..." },
    { key: "sg-id", label: "Security group", example: "sg-0abc..." }, { key: "profile", label: "Profile", example: "sandbox" }];
  const fills = store.get("fill", {});
  const fillParts = (cmd) => cmd.split(/(<[a-z-]+>)/).filter(Boolean).map((part) => {
    const m = /^<([a-z-]+)>$/.exec(part);
    if (!m) return { text: part };
    const value = fills[m[1]];
    return value ? { text: value, filled: true } : { text: part, hole: true };
  });
  function renderFill() {
    $("#cheat-fill").replaceChildren(...FILL.map((f) => h("label.fill", null, f.label, h("input", { type: "text", value: fills[f.key] || "", placeholder: f.example, spellcheck: "false", autocapitalize: "off",
      oninput: (e) => { const v = e.target.value.trim().replace(/[^\w.:/@-]/g, ""); if (v) fills[f.key] = v; else delete fills[f.key]; store.set("fill", fills); renderCheats(); } }))));
  }
  function renderCheats() {
    const q = $("#cheat-q").value.trim().toLowerCase();
    const out = $("#cheat-out");
    out.replaceChildren();
    const groups = new Map();
    for (const [cmd, what, group, where] of Q.cheats) {
      if (q && !(cmd + " " + what + " " + group).toLowerCase().includes(q)) continue;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push([cmd, what, where]);
    }
    if (!groups.size) { out.append(h("p.muted", null, "No match. Try a service (s3, ec2) or a task (logs, cost).")); return; }
    const titles = scenarioTitles();
    for (const [group, rows] of groups) {
      out.append(h("h3.group", null, group), h("ul.cheats", null, rows.map(([cmd, what, where]) => {
        const parts = fillParts(cmd);
        const full = parts.map((p) => p.text).join("");
        const code = h("code", null, parts.map((p) => (p.filled ? h("span.filled", null, p.text) : p.hole ? h("span.hole", null, p.text) : p.text)));
        const actions = h("div.cheat-actions", null,
          where && (where === "any" || titles[where]) ? h("button.copy", { type: "button", title: where === "any" ? "Run it in the playground" : `Run it in the playground scenario "${titles[where]}"`,
            onclick: () => { if (where !== "any") location.hash = "play/" + where; else location.hash = "path"; withPg((p) => p.prefill(cmd, where)); } }, "Try")
            : h("a.copy.lab", { href: "#level-00", title: "Needs a real AWS account: use a sandbox with a budget alert", onclick: (e) => { e.preventDefault(); location.hash = "path"; setTimeout(() => scrollToEl($("#level-00"))); } }, "Lab"),
          copyButton(full));
        return h("li", null, h("div", null, code, h("span.muted", null, what)), actions);
      })));
    }
  }

  // --- page guides ------------------------------------------------------------------

  const GUIDES_CLOSED_BY_DEFAULT = ["playground", "path", "doctor", "xray"];
  function renderGuides() {
    const state = store.get("guides", {});
    document.querySelectorAll(".guide-slot").forEach((slot) => {
      const key = slot.dataset.guide;
      const g = Q.guides[key];
      const box = h("details.guide", { open: state[key] ?? !GUIDES_CLOSED_BY_DEFAULT.includes(key) }, h("summary", null, "How to use this"),
        h("div.guide-body", null, h("p", null, ...rich(g.what)),
          h("div.guide-cols", null,
            h("div", null, h("h3", null, "How to use it"), h("ol", null, g.steps.map((t) => h("li", null, ...rich(t))))),
            h("div", null, h("h3", null, "What it is for"), h("ul", null, g.uses.map((t) => h("li", null, ...rich(t)))), h("h3", null, "Tips"), h("ul", null, g.tips.map((t) => h("li", null, ...rich(t))))))));
      let shown = box.open;
      box.addEventListener("toggle", () => { if (box.open === shown) return; shown = box.open; store.set("guides", { ...store.get("guides", {}), [key]: shown }); });
      slot.replaceChildren(box);
    });
  }

  // --- command palette (Ctrl+K, Cmd+K or /) ---------------------------------------

  const palette = $("#palette");
  const paletteInput = $("#palette-input");
  const paletteList = $("#palette-list");
  let paletteItems = [];
  let paletteActive = 0;
  const goTab = (tab, then) => { location.hash = tab; show(); if (then) then(); };
  const ACTIONS = [
    { label: "Playground: fix a broken account", kind: "Section", run: () => goTab("path", () => { $("#pg-input").focus(); $(".playground").scrollIntoView(); }) },
    { label: "Your path", kind: "Section", run: () => goTab("path", () => $("#path-title").scrollIntoView()) },
    { label: "Exam: random questions from every level", kind: "Quiz", run: () => goTab("quiz", () => { $("#quiz-level").value = "exam"; renderQuiz(); }) },
    { label: "Policy X-ray", kind: "Section", run: () => goTab("xray") },
    { label: "Fix: troubleshoot an error", kind: "Section", run: () => goTab("doctor", () => $("#doctor-q").focus()) },
    { label: "Cheat sheet", kind: "Section", run: () => goTab("cheats", () => $("#cheat-q").focus()) },
    { label: "AWS architecture: every component explained", kind: "Section", run: () => goTab("arch") },
    ...Q.levels.map((lv) => ({ label: `${lv.id} · ${lv.title}`, hint: lv.topic, kind: "Level", run: () => goTab("path", () => scrollToEl($("#level-" + lv.id))) })),
    ...Q.levels.map((lv) => ({ label: `Quiz: ${lv.id} · ${lv.topic}`, kind: "Quiz", run: () => goTab("quiz", () => { $("#quiz-level").value = lv.id; renderQuiz(); }) })),
    ...Q.doctor.map((d) => ({ label: `Troubleshoot: ${d.title}`, hint: d.errors.join(" "), kind: "Problem", run: () => { location.hash = "fix/" + d.id; } }))
  ];
  function renderPalette() {
    const words = paletteInput.value.toLowerCase().split(/\s+/).filter(Boolean);
    const scenarios = SCENARIOS.map((sc) => ({ label: `Playground: ${sc.title}`, hint: sc.group, kind: "Practice", run: () => { location.hash = "play/" + sc.id; } }));
    paletteItems = [...ACTIONS, ...scenarios].filter((a) => words.every((w) => `${a.label} ${a.hint || ""} ${a.kind}`.toLowerCase().includes(w))).slice(0, 8);
    paletteActive = Math.min(paletteActive, Math.max(0, paletteItems.length - 1));
    paletteList.replaceChildren(...paletteItems.map((a, i) => h("li", { role: "option", id: "pal-" + i, "aria-selected": String(i === paletteActive),
      onclick: () => choose(i), onmousemove: () => { if (paletteActive !== i) { paletteActive = i; renderPalette(); } } }, h("span.pal-label", null, a.label), h("span.pal-kind", null, a.kind))));
    if (!paletteItems.length) paletteList.append(h("li.pal-empty", null, "Nothing matches. Try a service such as S3, or an error such as AccessDenied."));
    paletteInput.setAttribute("aria-activedescendant", paletteItems.length ? "pal-" + paletteActive : "");
  }
  function openPalette() {
    if (palette.open) return;
    warm();
    paletteInput.value = "";
    paletteActive = 0;
    renderPalette();
    palette.showModal();
    paletteInput.focus();
  }
  function choose(i) { const a = paletteItems[i]; if (!a) return; palette.close(); a.run(); }
  paletteInput.addEventListener("input", () => { paletteActive = 0; renderPalette(); });
  paletteInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = paletteItems.length;
      if (n) paletteActive = (paletteActive + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      renderPalette();
      $("#pal-" + paletteActive)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") { e.preventDefault(); choose(paletteActive); }
  });
  palette.addEventListener("click", (e) => { if (e.target === palette) palette.close(); });
  $("#palette-open").addEventListener("click", openPalette);
  if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) $("#palette-key").textContent = "⌘K";
  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
    if ((e.key === "k" || e.key === "K") && (e.ctrlKey || e.metaKey)) { e.preventDefault(); openPalette(); }
    else if (e.key === "/" && !typing) { e.preventDefault(); openPalette(); }
  });

  // --- init -------------------------------------------------------------------------

  $("#quiz-level").append(h("option", { value: "exam" }, `Exam: ${EXAM_SIZE} random questions from every level`));
  const quizLabel = (lv) => `${lv.id} · ${lv.title} (${questionsFor(lv.id).length} questions)`;
  for (const lv of Q.levels) $("#quiz-level").append(h("option", { value: lv.id }, quizLabel(lv)));
  // The counts and questions arrive with the question bank.
  ready.quiz = () => { for (const lv of Q.levels) $(`#quiz-level option[value="${lv.id}"]`).textContent = quizLabel(lv); renderQuiz(); };
  $("#quiz-level").value = "00";
  $("#quiz-level").addEventListener("change", renderQuiz);
  $("#quiz-again").addEventListener("click", () => { renderQuiz(); $("#quiz-list").scrollIntoView({ block: "start" }); });
  $("#xray-pick").append(h("button", { type: "button", role: "tab", "data-index": -1, onclick: () => { renderXray(-1); if (!pasted) $("#xray-input").focus(); } }, "Paste a policy"));
  Q.xray.forEach((x, i) => $("#xray-pick").append(h("button", { type: "button", role: "tab", "data-index": i, onclick: () => renderXray(i) }, x.name)));
  $("#xray-go").addEventListener("click", explainPasted);
  $("#xray-edit-btn").addEventListener("click", () => { pasted = null; renderXray(-1); $("#xray-input").focus(); });
  $("#xray-clear").addEventListener("click", () => { pasted = null; $("#xray-input").value = ""; $("#xray-error").hidden = true; renderXray(-1); $("#xray-input").focus(); });
  $("#xray-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) explainPasted(); });
  $("#xray-example").addEventListener("click", () => { $("#xray-input").value = JSON.stringify(Q.xrayExample, null, 2) + "\n"; explainPasted(); });
  matchMedia("(max-width: 860px)").addEventListener("change", () => renderXray(xrayPick));
  buildDoctorList();
  $("#forget").addEventListener("click", forgetEverything);
  $("#doctor-q").addEventListener("input", renderDoctorSearch);
  // The home page's "Something broken?" box hands the pasted error to Troubleshoot.
  const doorGo = () => { $("#doctor-q").value = $("#door-q").value; goTab("doctor", () => { renderDoctorSearch(); $("#doctor-q").focus(); }); };
  $("#door-go").addEventListener("click", doorGo);
  // preventDefault keeps the Enter out of the Troubleshoot textarea that doorGo focuses.
  $("#door-q").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doorGo(); } });
  $("#cheat-q").addEventListener("input", renderCheats);
  $("#cta-start").addEventListener("click", (e) => { e.preventDefault(); scrollToEl($("#path-title")); });
  renderFill();
  $("#cheat-fill-box").open = matchMedia("(min-width: 721px)").matches || Object.keys(fills).length > 0;

  // Shared with engage.js and architecture.js, which load after this script.
  window.AQUI = { h, rich, practiseRow, need };

  renderGuides();
  renderXray(-1);
  renderCheats();
  // The first screen in one pass, once engage.js has run too, then the heavy
  // features in the background.
  window.addEventListener("DOMContentLoaded", () => {
    renderSignature();
    renderPath();
    window.DQEngage.render();
    show();
    (window.requestIdleCallback || ((fn) => setTimeout(fn, 200)))(() => warm());
  });
})();
