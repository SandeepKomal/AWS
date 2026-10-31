// The AWS architecture tab: a Region, a VPC and the services around it. Every
// component can be pointed at, tapped or reached with Tab to read what it does
// and how it fails; "Follow a request" plays one request through it.
"use strict";

(function () {
  const { h, rich, practiseRow } = window.AQUI;
  const parts = Object.fromEntries(window.TRACK.architecture.components.map((c) => [c.id, c]));
  const root = document.getElementById("arch");
  const NS = "http://www.w3.org/2000/svg";
  const s = (tag, attrs, ...kids) => {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    el.append(...kids);
    return el;
  };

  // Boxes are [x, y, width, height]; an id after @ repeats a component.
  const NARROW = (() => {
    const order = [["internet", "r53"], ["igw", "nat"], ["alb", "sg"], ["asg", "nacl"], ["ec2@a", "rt"], ["rds", "lambda"], ["s3", "kms"], ["cw", "iam"], ["region", "sts"], ["vpc", "az"]];
    const boxes = {};
    order.forEach((row, r) => row.forEach((id, c) => { boxes[id] = [10 + c * 175, 10 + r * 64, 165, 48]; }));
    return { size: [360, 650], font: [12, 10.5], panels: [], boxes,
      edges: [["internet", "igw"], ["igw", "alb"], ["alb", "asg"], ["asg", "ec2@a"], ["ec2@a", "rds"], ["internet", "r53"], ["igw", "nat"], ["lambda", "rds"], ["s3", "kms"], ["iam", "sts"]].map(([a, b]) => {
        const [x1, y1, w1, h1] = boxes[a], [x2, y2, , h2] = boxes[b];
        return [a, b, x1 === x2 ? [[x1 + w1 / 2, y1 + h1], [x2 + w1 / 2, y2]] : [[x1 + w1, y1 + h1 / 2], [x2, y2 + h2 / 2]]];
      }) };
  })();
  const LAYOUTS = {
    wide: {
      size: [1040, 540], font: [13, 11],
      panels: [["Global services", 20, 120, 180, 400, "outside"], ["", 220, 20, 800, 500, "region"], ["", 236, 84, 600, 420, "vpc"]],
      boxes: {
        internet: [30, 40, 160, 52], r53: [30, 150, 160, 52], iam: [30, 330, 160, 52], sts: [30, 430, 160, 52],
        region: [236, 32, 170, 36], vpc: [252, 96, 140, 36], igw: [412, 96, 160, 36],
        alb: [252, 150, 388, 52], asg: [252, 226, 388, 36], "ec2@a": [252, 290, 186, 52], "ec2@b": [454, 290, 186, 52], az: [252, 360, 388, 34],
        rds: [252, 420, 186, 52], lambda: [454, 420, 186, 52],
        nat: [660, 150, 164, 48], rt: [660, 214, 164, 44], nacl: [660, 272, 164, 44], sg: [660, 330, 164, 44],
        s3: [860, 150, 144, 48], kms: [860, 240, 144, 48], cw: [860, 330, 144, 48]
      },
      edges: [
        ["internet", "r53", [[110, 92], [110, 150]]],
        ["internet", "igw", [[190, 66], [492, 66], [492, 96]]],
        ["igw", "alb", [[492, 132], [492, 150]]],
        ["alb", "ec2@a", [[345, 202], [345, 290]]],
        ["alb", "ec2@b", [[547, 202], [547, 290]]],
        ["ec2@a", "rds", [[345, 342], [345, 420]]],
        ["lambda", "rds", [[454, 446], [438, 446]]],
        ["ec2@b", "nat", [[640, 304], [650, 304], [650, 174], [660, 174]]],
        ["nat", "igw", [[742, 150], [742, 114], [572, 114]]],
        ["ec2@a", "sts", [[252, 316], [210, 316], [210, 456], [190, 456]]],
        ["iam", "sts", [[110, 382], [110, 430]]],
        ["s3", "kms", [[932, 198], [932, 240]]],
        ["lambda", "cw", [[640, 446], [848, 446], [848, 354], [860, 354]]]
      ]
    },
    narrow: NARROW
  };
  const idOf = (key) => key.split("@")[0];

  const TOUR = [
    [[["internet", "r53"]], "A customer opens shop.example.com. Route 53 answers with the load balancer's addresses, through an alias record."],
    [[["internet", "igw"], ["igw", "alb"]], "The request enters the VPC through the internet gateway and reaches the load balancer in the public subnets. Its security group allows port 80."],
    [[["alb", "ec2@a"]], "The load balancer picks a healthy instance from the target group. The instance's security group allows the app port only from the load balancer's group."],
    [[["ec2@a", "rds"]], "The app queries the database in a private subnet. db-sg allows 5432 only from the web servers' security group."],
    [[["ec2@a", "sts"], ["iam", "sts"]], "For AWS calls the app uses its instance role: short-lived credentials from STS, fetched through the metadata service (IMDSv2)."],
    [[["ec2@b", "nat"], ["nat", "igw"]], "Outbound calls from the private subnets leave through the NAT gateway, which is billed per hour and per GB."],
    [[["lambda", "cw"]], "Everything sends metrics and logs to CloudWatch, where alarms watch them and page someone when they cross a line."]
  ];

  const figure = h("div.arch-figure");
  const tip = h("div.arch-tip", { "aria-hidden": "true" });
  const detail = h("div.arch-detail", { hidden: true, "aria-live": "polite" });
  const play = h("button.pill.small-pill", { type: "button", onclick: () => (touring ? stopTour() : tour()) }, "Follow a request");
  const caption = h("p.arch-caption", { "aria-live": "polite" }, "Point at any component to see what it does and how it fails.");
  const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  let svg = null, dot = null, pinned = null, touring = 0, entered = false;

  function draw() {
    const L = LAYOUTS[matchMedia("(max-width: 720px)").matches ? "narrow" : "wide"];
    const [w, ht] = L.size;
    const arrow = (id) => s("marker", { id, viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" }, s("path", { d: "M0 0 8 4 0 8z" }));
    svg = s("svg", { viewBox: `0 0 ${w} ${ht}`, class: "arch-svg", role: "group", "aria-label": "AWS architecture" }, s("defs", null, arrow("arch-arrow"), arrow("arch-arrow-on")));
    for (const [label, x, y, pw, ph, kind] of L.panels) {
      svg.append(s("rect", { x, y, width: pw, height: ph, rx: 16, class: `arch-panel arch-${kind}` }));
      if (label) svg.append(s("text", { x: x + 14, y: y + 22, class: "arch-panel-label" }, label));
    }
    for (const [from, to, pts] of L.edges) svg.append(s("polyline", { points: pts.join(" "), class: "arch-edge", "data-from": from, "data-to": to, "marker-end": "url(#arch-arrow)" }));
    Object.entries(L.boxes).forEach(([key, [x, y, bw, bh]], i) => {
      const c = parts[idOf(key)];
      const small = bh < 44;
      const g = s("g", { class: `arch-box arch-${["AWS", "Global", "Internet"].includes(c.where) ? "outside" : "inside"}`, "data-id": c.id, "data-key": key },
        s("rect", { x, y, width: bw, height: bh, rx: 10 }),
        s("text", { x: x + bw / 2, y: small ? y + bh / 2 + 4 : y + bh / 2 - 3, class: "arch-name", "font-size": L.font[0] }, c.name),
        small ? "" : s("text", { x: x + bw / 2, y: y + bh / 2 + L.font[1] + 2, class: "arch-short", "font-size": L.font[1] }, c.short));
      g.style.animationDelay = `${120 + i * 24}ms`;
      if (!svg.querySelector(`[data-id="${c.id}"]`)) {
        g.setAttribute("tabindex", "0");
        g.setAttribute("role", "button");
        g.setAttribute("aria-label", `${c.name}: ${c.short}`);
      }
      g.addEventListener("mouseenter", () => touring || select(c.id));
      g.addEventListener("focus", () => touring || select(c.id));
      g.addEventListener("click", () => { stopTour(); pinned = c.id; select(c.id); open(c.id); });
      g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); g.dispatchEvent(new Event("click")); } });
      svg.append(g);
    });
    dot = s("circle", { r: 6, class: "arch-dot" });
    svg.append(dot);
    svg.addEventListener("mouseleave", () => touring || select(pinned));
    figure.replaceChildren(svg, tip, h("div.arch-tour", null, play, caption));
    stopTour();
    select(pinned);
  }

  function light(ids, edges) {
    svg.classList.toggle("has-focus", ids.length > 0);
    const near = new Set(ids);
    svg.querySelectorAll(".arch-edge").forEach((e) => {
      const ends = [idOf(e.dataset.from), idOf(e.dataset.to)];
      const on = edges ? edges.includes(e) : ends.some((x) => ids.includes(x));
      if (on) ends.forEach((x) => near.add(x));
      e.classList.toggle("is-on", on);
      e.setAttribute("marker-end", `url(#arch-arrow${on ? "-on" : ""})`);
    });
    svg.querySelectorAll(".arch-box").forEach((g) => {
      g.classList.toggle("is-on", ids.includes(g.dataset.id));
      g.classList.toggle("is-near", !ids.includes(g.dataset.id) && near.has(g.dataset.id));
    });
  }
  function select(id) { light(id ? [id] : []); place(id); }

  function open(id) {
    const c = parts[id];
    detail.replaceChildren(h("div.card", null, h("p.arch-where", null, c.where), h("h3", null, c.name), h("p", null, c.role),
      h("h4", null, "What it does"), h("ul", null, c.does.map((d) => h("li", null, rich(d)))),
      h("h4", null, "When it breaks"), h("p", null, rich(c.breaks)),
      h("h4", null, "Look at it"), h("pre", null, h("code", null, c.look.join("\n"))),
      practiseRow(c.practise, "Practise in the playground:")));
    detail.hidden = false;
    detail.scrollIntoView({ block: "nearest", behavior: still() ? "auto" : "smooth" });
  }
  function place(id) {
    const showTip = id && figure.offsetParent && !matchMedia("(max-width: 720px), (hover: none)").matches;
    tip.classList.toggle("is-shown", Boolean(showTip));
    if (!showTip) return;
    const c = parts[id];
    tip.replaceChildren(h("p.arch-where", null, c.where), h("h3", null, c.name), h("p", null, c.role), h("p", null, h("strong", null, "When it breaks: "), rich(c.breaks)), h("p.muted.small", null, "Click for commands and practice"));
    const box = svg.querySelector(`[data-id="${id}"] rect`).getBoundingClientRect();
    const frame = figure.getBoundingClientRect();
    const right = box.right - frame.left + 12;
    const left = right + tip.offsetWidth <= frame.width ? right : Math.max(0, box.left - frame.left - tip.offsetWidth - 12);
    const top = Math.min(Math.max(0, box.top - frame.top - 8), Math.max(0, frame.height - tip.offsetHeight - 60));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  // Move the dot along an edge, in either direction; edges the layout lacks are just lit.
  function travel(from, to, run) {
    const e = [...svg.querySelectorAll(".arch-edge")].find((x) => (x.dataset.from === from && x.dataset.to === to) || (x.dataset.from === to && x.dataset.to === from));
    if (!e) return { edge: null, done: Promise.resolve() };
    let pts = e.getAttribute("points").split(" ").map((p) => p.split(",").map(Number));
    if (e.dataset.from !== from) pts = pts.reverse();
    const segs = pts.slice(1).map((p, i) => [pts[i], p, Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1])]);
    const total = segs.reduce((n, sg) => n + sg[2], 0);
    const at = (d) => { for (const [a, b, len] of segs) { if (d <= len) return [a[0] + (b[0] - a[0]) * d / len, a[1] + (b[1] - a[1]) * d / len]; d -= len; } return pts[pts.length - 1]; };
    dot.classList.add("is-on");
    return { edge: e, done: new Promise((resolve) => {
      if (still()) { [dot.cx.baseVal.value, dot.cy.baseVal.value] = pts[pts.length - 1]; return resolve(); }
      const ms = Math.max(450, total * 2.2), start = performance.now();
      const frame = (now) => {
        if (run !== touring) return resolve();
        const t = Math.min(1, (now - start) / ms), ease = t < .5 ? 2 * t * t : 1 - (2 - 2 * t) ** 2 / 2;
        [dot.cx.baseVal.value, dot.cy.baseVal.value] = at(total * ease);
        if (t < 1) requestAnimationFrame(frame); else resolve();
      };
      requestAnimationFrame(frame);
    }) };
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function tour() {
    const run = ++touring;
    pinned = null;
    place(null);
    play.textContent = "Stop";
    for (const [n, [hops, text]] of TOUR.entries()) {
      caption.replaceChildren(h("span.arch-step", null, `${n + 1} of ${TOUR.length}`), text);
      const edges = [];
      for (const [from, to] of hops) {
        const leg = travel(from, to, run);
        if (leg.edge) edges.push(leg.edge);
        light([...new Set(hops.flat().map(idOf))], edges);
        await leg.done;
        if (run !== touring) return;
      }
      await wait(still() ? 3200 : 1700);
      if (run !== touring) return;
    }
    stopTour("Played. Point at any component to read more, or play it again.");
  }
  function stopTour(text) {
    touring = 0;
    if (dot) dot.classList.remove("is-on");
    play.textContent = "Follow a request";
    if (text) caption.textContent = text;
    if (svg) light([]);
  }
  function enter() {
    if (entered || location.hash !== "#arch" || still()) return;
    entered = true;
    svg.classList.add("is-entering");
    setTimeout(() => svg.classList.remove("is-entering"), 1400);
  }

  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && (pinned || touring)) { pinned = null; stopTour(); select(null); } });
  matchMedia("(max-width: 720px)").addEventListener("change", draw);
  window.addEventListener("hashchange", () => { if (location.hash !== "#arch") stopTour(); enter(); });
  window.addEventListener("DOMContentLoaded", () => { draw(); root.replaceChildren(figure, detail); enter(); });
})();
