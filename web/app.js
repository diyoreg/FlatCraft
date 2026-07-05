/* FlatCraft app — UI редактора: рендер, drag&drop, база проектов, мост с Max */
/* global FCCore */
"use strict";

(() => {

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TESTMODE = new URLSearchParams(location.search).has("selftest");
const DBNAME = TESTMODE ? "flatcraft_test" : "flatcraft";

/* ============================= хранилище проектов =============================
   Основной бэкенд — IndexedDB. Если она недоступна или не отвечает
   (например, file:// в некоторых окружениях) — прозрачный фолбэк
   на localStorage. Несериализуемые настройки (дескриптор папки)
   в фолбэке живут только в памяти сессии. */
const DB = (() => {
  let db = null;
  let backend = "idb";                 // "idb" | "ls"
  let lsPrefix = "fc_";
  const mem = new Map();               // настройки, которые нельзя сериализовать

  const wrap = rq => new Promise((res, rej) => {
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
  const store = (name, mode = "readonly") => db.transaction(name, mode).objectStore(name);
  const timeout = (p, ms) => Promise.race([p, new Promise((_, rej) =>
    setTimeout(() => rej(new Error("idb timeout")), ms))]);

  const lsRead = () => { try { return JSON.parse(localStorage.getItem(lsPrefix + "projects")) || []; } catch (_) { return []; } };
  const lsWrite = arr => localStorage.setItem(lsPrefix + "projects", JSON.stringify(arr));
  const lsSettings = () => { try { return JSON.parse(localStorage.getItem(lsPrefix + "settings")) || {}; } catch (_) { return {}; } };

  return {
    backend: () => backend,
    open: async name => {
      lsPrefix = name + "_";
      try {
        await timeout(new Promise((res, rej) => {
          const rq = indexedDB.open(name, 1);
          rq.onupgradeneeded = e => {
            const d = e.target.result;
            d.createObjectStore("projects", { keyPath: "id", autoIncrement: true });
            d.createObjectStore("settings", { keyPath: "k" });
          };
          rq.onsuccess = e => { db = e.target.result; res(); };
          rq.onerror = () => rej(rq.error);
        }), 1500);
        backend = "idb";
      } catch (_) {
        backend = "ls";
      }
    },
    wipe: async name => {
      lsPrefix = name + "_";
      localStorage.removeItem(lsPrefix + "projects");
      localStorage.removeItem(lsPrefix + "settings");
      localStorage.removeItem(lsPrefix + "seq");
      try {
        await timeout(new Promise(res => {
          const rq = indexedDB.deleteDatabase(name);
          rq.onsuccess = rq.onerror = rq.onblocked = () => res();
        }), 1500);
      } catch (_) {}
    },
    list: () => backend === "idb" ? wrap(store("projects").getAll()) : Promise.resolve(lsRead()),
    get: id => backend === "idb" ? wrap(store("projects").get(id))
      : Promise.resolve(lsRead().find(r => r.id === id) || null),
    put: async rec => {
      if (backend === "idb") return wrap(store("projects", "readwrite").put(rec));
      const arr = lsRead();
      if (rec.id == null) {
        const seq = (+localStorage.getItem(lsPrefix + "seq") || 0) + 1;
        localStorage.setItem(lsPrefix + "seq", String(seq));
        rec.id = seq;
      }
      const i = arr.findIndex(r => r.id === rec.id);
      if (i >= 0) arr[i] = rec; else arr.push(rec);
      lsWrite(arr);
      return rec.id;
    },
    del: async id => {
      if (backend === "idb") return wrap(store("projects", "readwrite").delete(id));
      lsWrite(lsRead().filter(r => r.id !== id));
    },
    getSetting: async k => {
      if (mem.has(k)) return mem.get(k);
      if (backend === "idb") return wrap(store("settings").get(k)).then(r => (r ? r.v : null));
      const v = lsSettings()[k];
      return v === undefined ? null : v;
    },
    setSetting: async (k, v) => {
      mem.set(k, v);
      if (backend === "idb") return wrap(store("settings", "readwrite").put({ k, v })).catch(() => {});
      try {
        const s = lsSettings();
        s[k] = v;
        localStorage.setItem(lsPrefix + "settings", JSON.stringify(s));
      } catch (_) { /* несериализуемое — остаётся только в памяти */ }
    },
  };
})();

/* ============================= состояние ============================= */
let P = FCCore.defaultProject();
let dbId = null;
let sel = null;                    // {side, row, idx}
let activeSide = "south";          // стена, показанная на виде спереди
let ia = null;                     // взаимодействие на виде спереди
let palDrag = null;                // перетаскивание из палитры
let spaceHeld = false;
let dirHandle = null;              // FileSystemDirectoryHandle папки FlatCraft
let building = false;
const undoMgr = new FCCore.Undo(100);
const view = { zoom: 1, panX: 0, panY: 0 };
let fx = { s: 1, ox: 0, oyFloor: 0, box: null, fit: 1 };
let saveTimer = null;
let cursorMm = null;

const D = () => ({ ...FCCore.DIMS, ...P.kitchen.dims });
const C = () => ({ ...FCCore.COLORS, ...P.kitchen.colors });
const sideCfg = side => P.kitchen.sides[side];
const blocksOf = (side, row) => sideCfg(side)[row].blocks;
const rowX0 = (side, row) => (+sideCfg(side).offsetX || 0) +
  (row === "upper" ? (+sideCfg(side).upper.offsetX || 0) : 0);
const placedOf = (side, row) => FCCore.layout(blocksOf(side, row), D().gap, rowX0(side, row));
const selBlock = () => (sel && sideCfg(sel.side) ? blocksOf(sel.side, sel.row)[sel.idx] : null);

function clampSel() {
  if (!sideCfg(activeSide)) activeSide = FCCore.sidesOf(P)[0];
  if (sel && (!sideCfg(sel.side) || !blocksOf(sel.side, sel.row)[sel.idx])) sel = null;
}

/* ============================= svg helpers ============================= */
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const R = (x, y, w, h, fill, extra = "") =>
  `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(w, .5).toFixed(1)}" height="${Math.max(h, .5).toFixed(1)}" fill="${fill}" ${extra}/>`;
const T = (x, y, t, extra = "") =>
  `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="10" fill="#7a8089" ${extra}>${esc(t)}</text>`;
const L = (x1, y1, x2, y2, stroke = "#3a4048", extra = "") =>
  `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${stroke}" ${extra}/>`;

const isSel = (side, row, i) => sel && sel.side === side && sel.row === row && sel.idx === i;
const isDragged = (side, row, i) =>
  ia && ia.kind === "move" && side === activeSide && ia.row === row && ia.idx === i;

/* ============================= вид спереди ============================= */
function computeFx() {
  const svg = $("#svgFront"), box = svg.getBoundingClientRect();
  const m = 48;
  const wl = FCCore.wallLength(P, activeSide);
  const fit = Math.min((box.width - 2 * m) / wl, (box.height - 2 * m) / P.room.height);
  const s = fit * view.zoom;
  fx = { s, ox: m + view.panX, oyFloor: box.height - m + view.panY, box, fit, m, wl };
}
const X = mm => fx.ox + mm * fx.s;
const Yz = mm => fx.oyFloor - mm * fx.s;
const pxToMmX = px => (px - fx.box.left - fx.ox) / fx.s;
const pxToMmZ = py => (fx.oyFloor - (py - fx.box.top)) / fx.s;

function blockFrontRect(row, b, x, w) {
  const d = D(), z = FCCore.zLevels(d);
  if (row === "upper") return { x, z: z.zUpper, w, h: d.upperHeight };
  if (b.type === "tall") return { x, z: z.zLower, w, h: z.zUpperTop - z.zLower };
  if (b.type === "gap") return { x, z: 0, w, h: b.tall ? z.zUpperTop : z.zLowerTop };
  return { x, z: z.zLower, w, h: d.lowerHeight };
}

function drawBlock(g, row, i, b, x, w) {
  const d = D(), c = C(), z = FCCore.zLevels(d);
  const r = blockFrontRect(row, b, x, w);
  const id = `data-row="${row}" data-idx="${i}"`;
  const dragged = isDragged(activeSide, row, i);
  const strokeSel = isSel(activeSide, row, i) && !dragged
    ? `stroke="#5b9dff" stroke-width="2"` : `stroke="#0e0f12" stroke-width="0.5"`;

  if (dragged) {           // блок в ряду на время перетаскивания — контур
    g.push(`<g ${id}>` + R(X(r.x), Yz(r.z + r.h), r.w * fx.s, r.h * fx.s, "none",
      `stroke="#5b9dff66" stroke-width="1.5" stroke-dasharray="6 5"`) + `</g>`);
    return;
  }
  if (b.type === "gap") {
    const on = isSel(activeSide, row, i);
    g.push(`<g ${id} class="blk">` +
      R(X(r.x), Yz(r.z + r.h), r.w * fx.s, r.h * fx.s, "#ffffff06",
        `stroke="${on ? "#5b9dff" : "#565e6a"}" stroke-width="${on ? 2 : 1}" stroke-dasharray="5 4"`) +
      T(X(r.x + r.w / 2), Yz(r.z + r.h / 2), b.label || "проём", `text-anchor="middle" fill="#8a919c"`) +
      `</g>`);
  } else if (b.type === "drawers") {
    const n = Math.max(1, +b.drawers || 3), dh = (d.lowerHeight - (n - 1) * d.gap) / n;
    let inner = "";
    for (let j = 0; j < n; j++)
      inner += R(X(x), Yz(z.zLower + (j + 1) * dh + j * d.gap), w * fx.s, dh * fx.s, c.lower, strokeSel);
    g.push(`<g ${id} class="blk">${inner}</g>`);
  } else {
    const fill = row === "upper" ? c.upper : c.lower;
    g.push(`<g ${id} class="blk">` + R(X(r.x), Yz(r.z + r.h), r.w * fx.s, r.h * fx.s, fill, strokeSel) + `</g>`);
  }
}

function renderFront() {
  computeFx();
  const svg = $("#svgFront");
  const room = P.room, d = D(), c = C(), z = FCCore.zLevels(d);
  const g = [];

  // комната (при «Убрать стены и пол» — только контур-ориентир)
  const wl = fx.wl;
  g.push(R(X(0), Yz(room.height), wl * fx.s, room.height * fx.s,
    room.noShell ? "none" : c.walls + "12",
    `stroke="#31363f" stroke-width="1" ${room.noShell ? 'stroke-dasharray="6 5"' : ""}`));
  g.push(L(X(0), Yz(0), X(wl), Yz(0), "#4a505a", `stroke-width="1.5"`));

  const upperEnabled = sideCfg(activeSide).upper.enabled;
  const lower = placedOf(activeSide, "lower");
  const upper = upperEnabled ? placedOf(activeSide, "upper") : [];

  // цоколь / фартук / столешница
  for (const [x1, x2] of FCCore.runs(lower, FCCore.hasPlinth))
    g.push(R(X(x1), Yz(d.plinthHeight), (x2 - x1) * fx.s, d.plinthHeight * fx.s, c.plinth));
  for (const [x1, x2] of FCCore.runs(lower, FCCore.underCT)) {
    g.push(R(X(x1), Yz(z.zUpper), (x2 - x1) * fx.s, d.backsplashGap * fx.s, c.backsplash + "44"));
    g.push(R(X(x1) - 3, Yz(z.zCtTop), (x2 - x1) * fx.s + 6, d.countertopThickness * fx.s, c.countertop,
      `stroke="#000" stroke-width="0.5"`));
  }

  // блоки
  for (let i = 0; i < lower.length; i++) drawBlock(g, "lower", i, lower[i].b, lower[i].x, lower[i].w);
  for (let i = 0; i < upper.length; i++) drawBlock(g, "upper", i, upper[i].b, upper[i].x, upper[i].w);

  if (upperEnabled && sideCfg(activeSide).upper.antresol && upper.length) {
    const e = FCCore.rowExtent(upper);
    g.push(R(X(e.start), Yz(z.zUpperTop + d.gap + d.antresolHeight),
      (e.end - e.start) * fx.s, d.antresolHeight * fx.s, c.upper + "cc"));
  }

  // размерные подписи (кликабельные)
  for (const row of ["lower", "upper"]) {
    if (row === "upper" && !upperEnabled) continue;
    const placed = row === "lower" ? lower : upper;
    const yLab = row === "lower" ? fx.oyFloor + 16 : Yz(z.zUpperTop) - 6;
    for (let i = 0; i < placed.length; i++) {
      const { x, w } = placed[i];
      if (w * fx.s > 26)
        g.push(T(X(x + w / 2), yLab, placed[i].w,
          `text-anchor="middle" data-wlabel="${row}:${i}" class="wlab"`));
    }
    if (row === "lower")
      for (const { x, w } of placed)
        g.push(L(X(x), fx.oyFloor + 3, X(x), fx.oyFloor + 7), L(X(x + w), fx.oyFloor + 3, X(x + w), fx.oyFloor + 7));
  }

  // отметки высот
  for (const zz of [z.zCtTop, z.zUpper, z.zUpperTop])
    g.push(L(fx.ox - 6, Yz(zz), fx.ox, Yz(zz)), T(fx.ox - 9, Yz(zz) + 3, zz, `text-anchor="end"`));

  // ---- ручка ресайза у выделенного блока ----
  if (sel && !ia && !palDrag) {
    const placed = sel.row === "lower" ? lower : upper;
    const it = placed[sel.idx];
    if (it) {
      const r = blockFrontRect(sel.row, it.b, it.x, it.w);
      g.push(R(X(r.x + r.w) - 4, Yz(r.z + r.h), 8, r.h * fx.s, "#5b9dff33",
        `data-handle="r" data-row="${sel.row}" data-idx="${sel.idx}" style="cursor:ew-resize" stroke="#5b9dff" stroke-width="1"`));
    }
  }

  // ---- оверлеи перетаскивания ----
  if (ia && ia.kind === "resize" && ia.guideX != null)
    g.push(L(X(ia.guideX), Yz(z.zUpperTop + 200), X(ia.guideX), fx.oyFloor + 10, "#5b9dff",
      `stroke-dasharray="4 4" stroke-width="1.5"`));
  if (ia && ia.kind === "resize")
    g.push(`<text x="${X(ia.tipX)}" y="${Yz(ia.tipZ) - 8}" font-size="12" fill="#5b9dff" text-anchor="middle" font-weight="600">${ia.tipText}</text>`);

  if (palDrag && palDrag.valid) {
    const placed = palDrag.row === "lower" ? lower : upper;
    const xIns = palDrag.insertIdx < placed.length
      ? placed[palDrag.insertIdx].x - d.gap / 2
      : (placed.length ? FCCore.rowExtent(placed).end + d.gap / 2 : rowX0(activeSide, palDrag.row));
    const band = palDrag.row === "lower" ? [0, z.zLowerTop] : [z.zUpper, z.zUpperTop];
    g.push(L(X(xIns), Yz(band[1] + 60), X(xIns), Yz(band[0]) + 8, "#5b9dff", `stroke-width="2.5"`));
  }

  if (ia && ia.kind === "move") {
    const arr = blocksOf(activeSide, ia.row), b = arr[ia.idx];
    const r = blockFrontRect(ia.row, b, ia.mm - ia.grabDx, +b.width || 600);
    const fill = ia.outside ? "#ff6b6b88" : (ia.row === "upper" ? C().upper : C().lower) + "99";
    g.push(R(X(r.x), Yz(r.z + r.h), r.w * fx.s, r.h * fx.s, fill,
      `stroke="${ia.outside ? "#ff6b6b" : "#5b9dff"}" stroke-width="1.5" pointer-events="none"`));
    if (ia.outside)
      g.push(`<text x="${X(r.x + r.w / 2)}" y="${Yz(r.z + r.h) - 8}" font-size="11" fill="#ff6b6b" text-anchor="middle">отпустите — удалить</text>`);
  }

  svg.innerHTML = g.join("");
}

/* ============================= вид сверху =============================
   Рисует все стороны кухни — здесь видна форма раскладки («Г», «П»).
   Клик по блоку выделяет его и переключает активную стену. */
function renderTop() {
  const svg = $("#svgTop"), box = svg.getBoundingClientRect();
  const room = P.room, d = D(), c = C();
  const m = 22;
  const s = Math.min((box.width - 2 * m) / room.length, (box.height - 2 * m) / room.width);
  const Xt = mm => m + mm * s, Yt = mm => m + mm * s;
  const MR = (side, x, y, w, dd) => FCCore.mapRect(side, room, x, y, w, dd);
  const rr = (r, fill, extra = "") => R(Xt(r.x), Yt(r.y), r.w * s, r.d * s, fill, extra);
  const g = [];

  g.push(R(Xt(0), Yt(0), room.length * s, room.width * s,
    room.noShell ? "none" : c.floor + "20",
    `stroke="#31363f" ${room.noShell ? 'stroke-dasharray="6 5"' : ""}`));

  for (const side of FCCore.sidesOf(P)) {
    const cfg = sideCfg(side);
    if (!cfg) continue;
    const lower = placedOf(side, "lower");
    const activeMark = side === activeSide && FCCore.sidesOf(P).length > 1;

    for (const [x1, x2] of FCCore.runs(lower, FCCore.underCT))
      g.push(rr(MR(side, x1, 0, x2 - x1, d.lowerDepth + d.countertopOverhang), c.countertop + "77"));

    for (let i = 0; i < lower.length; i++) {
      const { b, x, w } = lower[i];
      const attrs = `data-side="${side}" data-row="lower" data-idx="${i}"`;
      const on = isSel(side, "lower", i);
      const r = MR(side, x, 0, w, d.lowerDepth);
      if (b.type === "gap")
        g.push(`<g ${attrs}>` + rr(r, "#ffffff06",
          `stroke="${on ? "#5b9dff" : "#565e6a"}" stroke-dasharray="5 4"${on ? ' stroke-width="2"' : ""}`) + `</g>`);
      else
        g.push(`<g ${attrs}>` + rr(r, c.lower,
          on ? `stroke="#5b9dff" stroke-width="2"` : `stroke="#0e0f12" stroke-width="0.5"`) + `</g>`);
    }
    if (cfg.upper.enabled) {
      const upper = placedOf(side, "upper");
      for (let i = 0; i < upper.length; i++) {
        const { b, x, w } = upper[i];
        if (b.type === "gap") continue;
        g.push(`<g data-side="${side}" data-row="upper" data-idx="${i}">` +
          rr(MR(side, x, 0, w, d.upperDepth), c.upper + "55",
            isSel(side, "upper", i) ? `stroke="#5b9dff" stroke-width="2"` : "") + `</g>`);
      }
    }
    // подсветка активной стены
    if (activeMark) {
      const wlen = FCCore.wallLength(P, side);
      const band = MR(side, 0, 0, wlen, 8);
      g.push(rr(band, "#5b9dff88"));
    }
  }
  svg.innerHTML = g.join("");
}

/* ============================= вид сбоку ============================= */
function renderSide() {
  const svg = $("#svgSide"), box = svg.getBoundingClientRect();
  const room = P.room, d = D(), c = C(), z = FCCore.zLevels(d);
  const m = 34;
  const s = Math.min((box.width - 2 * m) / (room.width * 0.75), (box.height - 2 * m) / room.height);
  const Xs = mm => m + mm * s, Ys = mm => box.height - m - mm * s;
  const g = [];
  const blk = sel && sel.row === "lower" ? selBlock() : null;
  const t = blk ? blk.type : "cabinet";
  const shortGap = blk && t === "gap" && !blk.tall;
  const tallGap = blk && t === "gap" && blk.tall;

  g.push(L(Xs(0), Ys(0), Xs(0), Ys(room.height), "#4a505a", `stroke-width="2"`));
  g.push(L(Xs(0), Ys(0), box.width - 8, Ys(0), "#4a505a", `stroke-width="1.5"`));

  if (!tallGap) {
    if (!shortGap && t !== "gap") {
      g.push(R(Xs(0), Ys(d.plinthHeight), (d.lowerDepth - d.plinthRecess) * s, d.plinthHeight * s, c.plinth));
      const h = t === "tall" ? z.zUpperTop - z.zLower : d.lowerHeight;
      g.push(R(Xs(0), Ys(z.zLower + h), d.lowerDepth * s, h * s, c.lower));
      if (t === "drawers") {
        const n = Math.max(1, +(blk ? blk.drawers : 3) || 3), dh = (d.lowerHeight - (n - 1) * d.gap) / n;
        for (let j = 1; j < n; j++) {
          const zz = z.zLower + j * (dh + d.gap) - d.gap / 2;
          g.push(L(Xs(0), Ys(zz), Xs(d.lowerDepth), Ys(zz), "#0e0f12", `stroke-width="2"`));
        }
      }
    }
    if (shortGap) {
      g.push(R(Xs(0), Ys(d.plinthHeight), (d.lowerDepth - d.plinthRecess) * s, d.plinthHeight * s, c.plinth));
      g.push(R(Xs(0), Ys(z.zLowerTop), d.lowerDepth * s, d.lowerHeight * s, "none",
        `stroke="#565e6a" stroke-dasharray="5 4"`));
    }
    if (t !== "tall") {
      g.push(R(Xs(0), Ys(z.zCtTop), (d.lowerDepth + d.countertopOverhang) * s, d.countertopThickness * s, c.countertop));
      g.push(R(Xs(0), Ys(z.zUpper), d.backsplashThickness * s, d.backsplashGap * s, c.backsplash));
      const su = sideCfg(sel ? sel.side : activeSide).upper;
      if (su.enabled) {
        g.push(R(Xs(0), Ys(z.zUpperTop), d.upperDepth * s, d.upperHeight * s, c.upper));
        if (su.antresol)
          g.push(R(Xs(0), Ys(z.zUpperTop + d.gap + d.antresolHeight), d.upperDepth * s, d.antresolHeight * s, c.upper + "cc"));
      }
    }
  } else {
    g.push(R(Xs(0), Ys(z.zUpperTop), d.lowerDepth * s, z.zUpperTop * s, "none",
      `stroke="#565e6a" stroke-dasharray="5 4"`));
    g.push(T(Xs(d.lowerDepth / 2), Ys(z.zUpperTop / 2), blk.label || "техника", `text-anchor="middle"`));
  }

  for (const zz of [d.plinthHeight, z.zCtTop, z.zUpper, z.zUpperTop])
    g.push(L(Xs(0) - 5, Ys(zz), Xs(0), Ys(zz)), T(Xs(0) - 8, Ys(zz) + 3, zz, `text-anchor="end"`));
  svg.innerHTML = g.join("");
}

/* ============================= инспектор / статус ============================= */
function renderInspector() {
  const b = selBlock();
  $("#inspEmpty").style.display = b ? "none" : "";
  $("#inspector").style.display = b ? "" : "none";
  if (!b) return;
  const sideTag = FCCore.sidesOf(P).length > 1 ? " · " + FCCore.SIDE_RU[sel.side] : "";
  $("#iType").textContent = FCCore.TYPE_RU[b.type] + (sel.row === "upper" ? " · верх" : " · низ") + sideTag;
  $("#iWidth").value = b.width;
  $("#rDrawers").style.display = b.type === "drawers" ? "" : "none";
  $("#iDrawers").value = b.drawers || 3;
  $("#rTall").style.display = (b.type === "gap" && sel.row === "lower") ? "" : "none";
  $("#iTall").checked = !!b.tall;
  $("#rLabel").style.display = (b.type === "gap" || b.type === "tall") ? "" : "none";
  $("#iLabel").value = b.label || "";
}

function renderStatus() {
  const lower = FCCore.rowExtent(placedOf(activeSide, "lower"));
  const upper = sideCfg(activeSide).upper.enabled ? FCCore.rowExtent(placedOf(activeSide, "upper")) : null;
  const tag = FCCore.sidesOf(P).length > 1 ? FCCore.SIDE_RU[activeSide] + ": " : "";
  $("#sbSums").textContent =
    tag + `низ ${lower.end} / ${FCCore.wallLength(P, activeSide)} мм` + (upper ? ` · верх ${upper.end} мм` : "");
  const warns = FCCore.validate(P);
  const w = $("#sbWarn");
  w.textContent = warns[0] || "";
  w.title = warns.join("\n");
  $("#sbZoom").textContent = Math.round(view.zoom * 100) + "%";
  $("#sbCursor").textContent = cursorMm ? `x ${Math.round(cursorMm.x)} · z ${Math.round(cursorMm.z)}` : "";
}

function renderHeader() {
  $("#projName").value = P.name;
  $("#btnUndo").disabled = !undoMgr.canUndo();
  $("#btnRedo").disabled = !undoMgr.canRedo();
  $("#btnFolder").classList.toggle("connected", !!dirHandle);
  $("#btnFolder").textContent = dirHandle ? "✓ Папка" : "Папка…";
  $("#btnFolder").title = dirHandle
    ? "Папка FlatCraft подключена — сохранение и сборка идут напрямую"
    : "Подключить папку FlatCraft (D:\\FlatCraft) для сохранения и сборки в 3D";
  const bb = $("#btnBuild");
  bb.disabled = !dirHandle || building;
  bb.textContent = building ? "Сборка…" : "Собрать в 3D";
  bb.title = dirHandle ? "Сохранить проект и собрать сцену в 3ds Max (нужен запущенный мост)"
    : "Сначала подключите папку FlatCraft (кнопка «Папка…»)";
}

function renderTabs() {
  const host = $("#wallTabs");
  const sides = FCCore.sidesOf(P);
  if (sides.length < 2) { host.innerHTML = ""; host.style.display = "none"; return; }
  host.style.display = "flex";
  host.innerHTML = sides.map(s =>
    `<button data-tab="${s}" class="${s === activeSide ? "active" : ""}">${FCCore.SIDE_RU[s]}</button>`).join("");
}
$("#wallTabs").addEventListener("click", e => {
  const b = e.target.closest("[data-tab]");
  if (!b || b.dataset.tab === activeSide) return;
  activeSide = b.dataset.tab;
  sel = null; ia = null;
  view.zoom = 1; view.panX = 0; view.panY = 0;
  syncPanelInputs();
  renderAll();
});

function renderAll() {
  clampSel();
  renderTabs();
  renderFront(); renderTop(); renderSide(); renderInspector(); renderStatus(); renderHeader();
}

/* ============================= сохранение в БД ============================= */
async function persistNow() {
  const rec = { name: P.name, data: JSON.parse(JSON.stringify(P)), updatedAt: Date.now() };
  if (dbId != null) rec.id = dbId;
  dbId = await DB.put(rec);
  await DB.setSetting("lastId", dbId);
  const el = $("#saved");
  el.textContent = "✓ сохранено";
  el.classList.add("on");
  clearTimeout(persistNow._t);
  persistNow._t = setTimeout(() => el.classList.remove("on"), 1500);
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => persistNow().catch(console.error), 400);
}

/* commit: фиксация изменения — undo-точка + автосохранение + рендер */
function commit() {
  undoMgr.push(P);
  scheduleSave();
  renderAll();
}

function doUndo() {
  const st = undoMgr.undo();
  if (!st) return;
  P = FCCore.migrate(st); clampSel(); syncPanelInputs(); scheduleSave(); renderAll();
}
function doRedo() {
  const st = undoMgr.redo();
  if (!st) return;
  P = FCCore.migrate(st); clampSel(); syncPanelInputs(); scheduleSave(); renderAll();
}

/* ============================= взаимодействие: вид спереди ============================= */
const svgFront = $("#svgFront");

function edgesForResize(row) {
  const other = row === "lower" ? "upper" : "lower";
  const edges = [];
  if (other !== "upper" || sideCfg(activeSide).upper.enabled)
    for (const { x, w } of placedOf(activeSide, other)) edges.push(x, x + w);
  edges.push(FCCore.wallLength(P, activeSide));
  return edges;
}

svgFront.addEventListener("pointerdown", e => {
  if (palDrag) return;
  const handle = e.target.closest("[data-handle]");
  const blockEl = e.target.closest("[data-row]");
  try { svgFront.setPointerCapture(e.pointerId); } catch (_) {}

  if (e.button === 1 || spaceHeld || (e.button === 0 && !handle && !blockEl)) {
    ia = { kind: "pan", sx: e.clientX, sy: e.clientY, px: view.panX, py: view.panY, moved: false };
    if (!handle && !blockEl && e.button === 0) ia.deselect = true;
    return;
  }
  if (e.button !== 0) return;

  if (handle) {
    const row = handle.dataset.row, idx = +handle.dataset.idx;
    sel = { side: activeSide, row, idx };
    const placed = placedOf(activeSide, row)[idx];
    const fr = blockFrontRect(row, placed.b, placed.x, placed.w);
    ia = { kind: "resize", row, idx, blockX: placed.x, startW: placed.w,
           guideX: null, tipX: placed.x + placed.w, tipZ: fr.z + fr.h, tipText: String(placed.w) };
    renderAll();
    return;
  }
  if (blockEl) {
    const row = blockEl.dataset.row, idx = +blockEl.dataset.idx;
    const placed = placedOf(activeSide, row)[idx];
    ia = { kind: "maybe", row, idx, sx: e.clientX, sy: e.clientY,
           grabDx: pxToMmX(e.clientX) - placed.x };
  }
});

svgFront.addEventListener("pointermove", e => {
  cursorMm = { x: pxToMmX(e.clientX), z: pxToMmZ(e.clientY) };
  if (!ia) { renderStatus(); return; }

  if (ia.kind === "pan") {
    const dx = e.clientX - ia.sx, dy = e.clientY - ia.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) ia.moved = true;
    view.panX = ia.px + dx; view.panY = ia.py + dy;
    renderFront(); renderStatus();
    return;
  }
  if (ia.kind === "maybe") {
    if (Math.abs(e.clientX - ia.sx) + Math.abs(e.clientY - ia.sy) < 5) return;
    sel = { side: activeSide, row: ia.row, idx: ia.idx };
    ia = { kind: "move", row: ia.row, idx: ia.idx, grabDx: ia.grabDx, mm: pxToMmX(e.clientX), outside: false };
  }
  if (ia.kind === "move") {
    ia.mm = pxToMmX(e.clientX);
    const b = fx.box;
    ia.outside = e.clientY < b.top - 4 || e.clientY > b.bottom + 4 || e.clientX < b.left - 4 || e.clientX > b.right + 4;
    const arr = blocksOf(activeSide, ia.row);
    const ni = FCCore.insertIndexAt(arr, D().gap, rowX0(activeSide, ia.row), ia.mm, ia.idx);
    if (ni !== ia.idx) {
      const [blk] = arr.splice(ia.idx, 1);
      arr.splice(ni, 0, blk);
      ia.idx = ni; sel = { side: activeSide, row: ia.row, idx: ni };
    }
    renderFront(); renderStatus();
    return;
  }
  if (ia.kind === "resize") {
    const b = blocksOf(activeSide, ia.row)[ia.idx];
    const rawW = pxToMmX(e.clientX) - ia.blockX;
    const res = FCCore.snapWidth(rawW, ia.blockX, edgesForResize(ia.row), 10 / fx.s * 1.6, 10);
    b.width = res.w;
    ia.guideX = res.guideX;
    ia.tipX = ia.blockX + res.w;
    ia.tipText = String(res.w) + (res.why === "edge" ? " ⇥" : "");
    renderFront(); renderStatus();
  }
});

svgFront.addEventListener("pointerup", e => {
  if (!ia) return;
  const k = ia;
  if (k.kind === "pan") {
    if (!k.moved && k.deselect) { sel = null; renderAll(); }
    ia = null; renderFront();
    return;
  }
  if (k.kind === "maybe") {
    sel = { side: activeSide, row: k.row, idx: k.idx };
    ia = null; renderAll();
    return;
  }
  if (k.kind === "move") {
    ia = null;
    if (k.outside) {
      blocksOf(activeSide, k.row).splice(k.idx, 1);
      sel = null;
      toast("Блок удалён", "ok");
    }
    commit();
    return;
  }
  if (k.kind === "resize") { ia = null; commit(); }
});

svgFront.addEventListener("wheel", e => {
  e.preventDefault();
  const mmx = pxToMmX(e.clientX), mmz = pxToMmZ(e.clientY);
  const f = Math.exp(-e.deltaY * 0.0012);
  view.zoom = Math.min(5, Math.max(0.25, view.zoom * f));
  computeFx();
  view.panX += (e.clientX - fx.box.left) - (fx.ox + mmx * fx.s) ;
  view.panY += (e.clientY - fx.box.top) - (fx.oyFloor - mmz * fx.s);
  renderFront(); renderStatus();
}, { passive: false });

function zoomFit() { view.zoom = 1; view.panX = 0; view.panY = 0; renderFront(); renderStatus(); }

/* двойной клик / клик по подписи — точный ввод ширины */
svgFront.addEventListener("dblclick", e => {
  const el = e.target.closest("[data-row]");
  if (el) inlineWidthEdit(el.dataset.row, +el.dataset.idx);
});
svgFront.addEventListener("click", e => {
  const lab = e.target.closest("[data-wlabel]");
  if (lab) {
    const [row, i] = lab.dataset.wlabel.split(":");
    sel = { side: activeSide, row, idx: +i }; renderAll();
    inlineWidthEdit(row, +i);
  }
});

function inlineWidthEdit(row, idx) {
  const placed = placedOf(activeSide, row)[idx];
  if (!placed) return;
  const r = blockFrontRect(row, placed.b, placed.x, placed.w);
  const host = $("#viewFront");
  const inp = document.createElement("input");
  inp.type = "number"; inp.value = placed.w; inp.className = "inline-edit";
  const hostBox = host.getBoundingClientRect();
  inp.style.left = (X(r.x + r.w / 2) - 38 + fx.box.left - hostBox.left) + "px";
  inp.style.top = (Yz(r.z + r.h / 2) - 14 + fx.box.top - hostBox.top) + "px";
  host.appendChild(inp);
  inp.focus(); inp.select();
  let done = false;
  const finish = ok => {
    if (done) return; done = true;
    if (ok) {
      const v = Math.max(FCCore.MIN_WIDTH, Math.round(+inp.value || placed.w));
      blocksOf(activeSide, row)[idx].width = v;
      commit();
    }
    inp.remove();
  };
  inp.addEventListener("keydown", ev => {
    if (ev.key === "Enter") finish(true);
    if (ev.key === "Escape") finish(false);
    ev.stopPropagation();
  });
  inp.addEventListener("blur", () => finish(true));
}

/* клик по виду сверху — выделение (и переключение активной стены) */
$("#svgTop").addEventListener("pointerdown", e => {
  const el = e.target.closest("[data-row]");
  if (el) {
    const side = el.dataset.side || activeSide;
    if (side !== activeSide) { activeSide = side; view.zoom = 1; view.panX = 0; view.panY = 0; }
    sel = { side, row: el.dataset.row, idx: +el.dataset.idx };
    syncPanelInputs();
  } else sel = null;
  renderAll();
});

/* ============================= контекстное меню ============================= */
const menu = $("#ctxmenu");
svgFront.addEventListener("contextmenu", e => {
  e.preventDefault();
  const el = e.target.closest("[data-row]");
  if (!el) { menu.style.display = "none"; return; }
  sel = { side: activeSide, row: el.dataset.row, idx: +el.dataset.idx };
  renderAll();
  menu.style.display = "block";
  menu.style.left = Math.min(e.clientX, innerWidth - 180) + "px";
  menu.style.top = Math.min(e.clientY, innerHeight - 120) + "px";
});
document.addEventListener("pointerdown", e => {
  if (!e.target.closest("#ctxmenu")) menu.style.display = "none";
});
$("#cmDup").addEventListener("click", () => { menu.style.display = "none"; duplicateSel(); });
$("#cmDel").addEventListener("click", () => { menu.style.display = "none"; deleteSel(); });

function duplicateSel() {
  if (!sel) return;
  const arr = blocksOf(sel.side, sel.row);
  arr.splice(sel.idx + 1, 0, JSON.parse(JSON.stringify(arr[sel.idx])));
  sel = { side: sel.side, row: sel.row, idx: sel.idx + 1 };
  commit();
}
function deleteSel() {
  if (!sel) return;
  blocksOf(sel.side, sel.row).splice(sel.idx, 1);
  sel = null;
  commit();
}

/* ============================= палитра: клик и drag&drop ============================= */
$$(".pal button").forEach(btn => {
  btn.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    const [row, type] = btn.dataset.add.split(":");
    palDrag = { row, type, sx: e.clientX, sy: e.clientY, moved: false, valid: false, insertIdx: 0 };
    const ghost = document.createElement("div");
    ghost.className = "pal-ghost";
    ghost.textContent = FCCore.TYPE_RU[type];
    ghost.style.display = "none";
    document.body.appendChild(ghost);
    palDrag.ghost = ghost;
    e.preventDefault();
  });
});

document.addEventListener("pointermove", e => {
  if (!palDrag) return;
  if (!palDrag.moved && Math.abs(e.clientX - palDrag.sx) + Math.abs(e.clientY - palDrag.sy) > 6)
    palDrag.moved = true;
  if (!palDrag.moved) return;
  palDrag.ghost.style.display = "block";
  palDrag.ghost.style.left = (e.clientX + 12) + "px";
  palDrag.ghost.style.top = (e.clientY + 10) + "px";

  const b = fx.box;
  const inSvg = b && e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom;
  let valid = false;
  if (inSvg) {
    const z = FCCore.zLevels(D());
    const mmZ = pxToMmZ(e.clientY);
    const band = palDrag.row === "lower"
      ? mmZ > -300 && mmZ < z.zCt + 200
      : mmZ > z.zCtTop && mmZ < z.zUpperTop + 400;
    if (band && (palDrag.row === "lower" || sideCfg(activeSide).upper.enabled)) {
      valid = true;
      palDrag.insertIdx = FCCore.insertIndexAt(
        blocksOf(activeSide, palDrag.row), D().gap, rowX0(activeSide, palDrag.row), pxToMmX(e.clientX));
    }
  }
  palDrag.valid = valid;
  palDrag.ghost.classList.toggle("invalid", !valid);
  renderFront();
});

document.addEventListener("pointerup", e => {
  if (!palDrag) return;
  const pd = palDrag;
  palDrag = null;
  pd.ghost.remove();
  if (!pd.moved) {           // обычный клик — добавить после выделенного / в конец
    const arr = blocksOf(activeSide, pd.row);
    const at = sel && sel.side === activeSide && sel.row === pd.row ? sel.idx + 1 : arr.length;
    arr.splice(at, 0, FCCore.newBlock(pd.row, pd.type));
    sel = { side: activeSide, row: pd.row, idx: at };
    commit();
    return;
  }
  if (pd.valid) {
    const arr = blocksOf(activeSide, pd.row);
    arr.splice(pd.insertIdx, 0, FCCore.newBlock(pd.row, pd.type));
    sel = { side: activeSide, row: pd.row, idx: pd.insertIdx };
    commit();
    toast("Блок добавлен", "ok");
  } else renderFront();
});

/* ============================= инспектор: поля ============================= */
$("#iWidth").addEventListener("change", e => {
  const b = selBlock(); if (!b) return;
  b.width = Math.max(FCCore.MIN_WIDTH, +e.target.value || 600); commit();
});
$("#iDrawers").addEventListener("change", e => {
  const b = selBlock(); if (!b) return;
  b.drawers = Math.min(6, Math.max(1, +e.target.value || 3)); commit();
});
$("#iTall").addEventListener("change", e => {
  const b = selBlock(); if (!b) return;
  b.tall = e.target.checked; commit();
});
$("#iLabel").addEventListener("change", e => {
  const b = selBlock(); if (!b) return;
  b.label = e.target.value; commit();
});
$("#iDel").addEventListener("click", deleteSel);
$("#iDup").addEventListener("click", duplicateSel);
$("#iLeft").addEventListener("click", () => moveSel(-1));
$("#iRight").addEventListener("click", () => moveSel(1));
function moveSel(dir) {
  if (!sel) return;
  const arr = blocksOf(sel.side, sel.row), j = sel.idx + dir;
  if (j < 0 || j >= arr.length) return;
  [arr[sel.idx], arr[j]] = [arr[j], arr[sel.idx]];
  sel = { side: sel.side, row: sel.row, idx: j };
  commit();
}

/* ============================= левая панель ============================= */
function getPath(o, p) { return p.split(".").reduce((a, k) => a[k], o); }
function setPath(o, p, v) { const ks = p.split("."), l = ks.pop(); ks.reduce((a, k) => a[k], o)[l] = v; }

function syncPanelInputs() {
  $$("[data-k]").forEach(inp => {
    if (inp.type === "checkbox") inp.checked = !!getPath(P, inp.dataset.k);
    else inp.value = getPath(P, inp.dataset.k);
  });
  $$("[data-s]").forEach(inp => {   // параметры активной стены
    const v = getPath(sideCfg(activeSide), inp.dataset.s);
    if (inp.type === "checkbox") inp.checked = !!v;
    else inp.value = v;
  });
  $$("[data-d]").forEach(inp => { inp.value = D()[inp.dataset.d]; });
  $$("[data-c]").forEach(inp => { inp.value = C()[inp.dataset.c]; });
  $("#layoutLabel").textContent = FCCore.LAYOUT_RU[P.kitchen.layoutType] || "";
  $("#projName").value = P.name;
}
$$("[data-k]").forEach(inp => inp.addEventListener("change", () => {
  setPath(P, inp.dataset.k, inp.type === "checkbox" ? inp.checked : +inp.value || 0);
  commit();
}));
$$("[data-s]").forEach(inp => inp.addEventListener("change", () => {
  setPath(sideCfg(activeSide), inp.dataset.s, inp.type === "checkbox" ? inp.checked : +inp.value || 0);
  commit();
}));
$$("[data-d]").forEach(inp => inp.addEventListener("change", () => {
  P.kitchen.dims[inp.dataset.d] = +inp.value || 0; commit();
}));
$$("[data-c]").forEach(inp => inp.addEventListener("input", () => {
  P.kitchen.colors[inp.dataset.c] = inp.value; commit();
}));
$("#projName").addEventListener("change", e => { P.name = e.target.value; commit(); });

/* ============================= клавиатура ============================= */
document.addEventListener("keydown", e => {
  const editing = ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName);
  if (e.code === "Space" && !editing) { spaceHeld = true; $("#viewFront").classList.add("panning"); }
  if (editing) return;
  if (e.key === "Delete" || e.key === "Backspace") { if (sel) { e.preventDefault(); deleteSel(); } }
  else if (e.ctrlKey && e.code === "KeyZ" && !e.shiftKey) { e.preventDefault(); doUndo(); }
  else if ((e.ctrlKey && e.code === "KeyY") || (e.ctrlKey && e.shiftKey && e.code === "KeyZ")) { e.preventDefault(); doRedo(); }
  else if (e.ctrlKey && e.code === "KeyD") { e.preventDefault(); duplicateSel(); }
  else if (e.ctrlKey && e.code === "KeyS") { e.preventDefault(); exportProject(); }
  else if (e.key === "Escape") {
    if (ia) { const st = JSON.parse(undoMgr.stack[undoMgr.pos]); P = FCCore.migrate(st); ia = null; renderAll(); }
    else if (sel) { sel = null; renderAll(); }
    else closeModal();
  }
  else if (e.key === "ArrowLeft" && sel) { e.preventDefault(); e.altKey ? moveSel(-1) : shiftSel(-1); }
  else if (e.key === "ArrowRight" && sel) { e.preventDefault(); e.altKey ? moveSel(1) : shiftSel(1); }
});
document.addEventListener("keyup", e => {
  if (e.code === "Space") { spaceHeld = false; $("#viewFront").classList.remove("panning"); }
});
function shiftSel(dir) {
  const arr = blocksOf(sel.side, sel.row);
  const j = Math.min(arr.length - 1, Math.max(0, sel.idx + dir));
  sel = { side: sel.side, row: sel.row, idx: j };
  renderAll();
}

/* ============================= менеджер проектов ============================= */
/* миниатюра — план сверху: видна форма раскладки (прямая / Г / П) */
function thumbSvg(p, W = 240, H = 120) {
  p = FCCore.migrate(p);
  const d = { ...FCCore.DIMS, ...p.kitchen.dims }, c = { ...FCCore.COLORS, ...p.kitchen.colors };
  const m = 8;
  const s = Math.min((W - 2 * m) / p.room.length, (H - 2 * m) / p.room.width);
  const g = [`<rect width="${W}" height="${H}" fill="#1a1d23"/>`];
  const room = p.room;
  g.push(R(m, m, room.length * s, room.width * s, c.floor + "18", `stroke="#31363f" stroke-width="0.5"`));
  for (const side of FCCore.sidesOf(p)) {
    const cfg = p.kitchen.sides[side];
    if (!cfg) continue;
    const lower = FCCore.layout(cfg.lower.blocks, d.gap, +cfg.offsetX || 0);
    for (const [x1, x2] of FCCore.runs(lower, FCCore.underCT)) {
      const r = FCCore.mapRect(side, room, x1, 0, x2 - x1, d.lowerDepth + d.countertopOverhang);
      g.push(R(m + r.x * s, m + r.y * s, r.w * s, r.d * s, c.countertop));
    }
    for (const { b, x, w } of lower) {
      if (b.type === "gap") continue;
      const r = FCCore.mapRect(side, room, x, 0, w, d.lowerDepth);
      g.push(R(m + r.x * s, m + r.y * s, r.w * s, r.d * s, c.lower));
    }
  }
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${g.join("")}</svg>`;
}

/* проекты на диске (папки projects/<имя>/project.json), которых нет в базе браузера */
async function scanDiskProjects(existing) {
  const out = [];
  if (!dirHandle) return out;
  try {
    if (await dirHandle.queryPermission({ mode: "readwrite" }) !== "granted" &&
        await dirHandle.requestPermission({ mode: "readwrite" }) !== "granted") return out;
    const projRoot = await dirHandle.getDirectoryHandle("projects").catch(() => null);
    if (!projRoot) return out;
    for await (const [folder, h] of projRoot.entries()) {
      if (h.kind !== "directory") continue;
      const fh = await h.getFileHandle("project.json").catch(() => null);
      if (!fh) continue;
      let data, file;
      try {
        file = await fh.getFile();
        data = JSON.parse(await file.text());
      } catch (_) { continue; }
      if (!data || !data.kitchen) continue;
      const pname = data.name || folder;
      const known = existing.some(r => r.name === pname || FCCore.slug(r.name) === folder);
      if (!known) out.push({ folder, name: pname, data, mtime: file.lastModified });
    }
  } catch (_) {}
  return out.sort((a, b) => b.mtime - a.mtime);
}

async function openModal() {
  const list = (await DB.list()).sort((a, b) => b.updatedAt - a.updatedAt);
  const host = $("#modalCards");
  host.innerHTML = "";
  for (const rec of list) {
    const card = document.createElement("div");
    card.className = "card" + (rec.id === dbId ? " current" : "");
    card.innerHTML = `
      <div class="card-thumb">${thumbSvg(rec.data)}</div>
      <div class="card-name">${esc(rec.name)}</div>
      <div class="card-date">${new Date(rec.updatedAt).toLocaleString("ru")}</div>
      <div class="card-btns">
        <button data-a="dup" title="Дублировать">⧉</button>
        <button data-a="ren" title="Переименовать">✎</button>
        <button data-a="exp" title="Экспорт JSON">⬇</button>
        <button data-a="del" title="Удалить" class="danger">✕</button>
      </div>`;
    card.addEventListener("click", async e => {
      const a = e.target.dataset && e.target.dataset.a;
      if (!a) { await loadRec(rec.id); closeModal(); return; }
      e.stopPropagation();
      if (a === "dup") {
        await DB.put({ name: rec.name + " (копия)", data: rec.data, updatedAt: Date.now() });
        openModal();
      } else if (a === "ren") {
        const name = prompt("Новое имя проекта:", rec.name);
        if (name) { rec.name = name; rec.data.name = name; await DB.put(rec); if (rec.id === dbId) { P.name = name; renderHeader(); } openModal(); }
      } else if (a === "exp") {
        downloadJson(JSON.stringify(rec.data, null, 2), FCCore.slug(rec.name) + ".json");
      } else if (a === "del") {
        if (!confirm(`Удалить проект «${rec.name}» из списка?`)) return;
        await DB.del(rec.id);
        if (rec.id === dbId) { dbId = null; }
        // если у проекта есть папка на диске — предложить удалить и её,
        // иначе он снова появится в списке как «на диске»
        if (dirHandle) {
          try {
            const projRoot = await dirHandle.getDirectoryHandle("projects");
            const folder = FCCore.slug(rec.name);
            await projRoot.getDirectoryHandle(folder);
            if (confirm(`Удалить также папку projects/${folder}/ с диска?\nВ ней project.json и сцена 3ds Max (.max).`)) {
              await projRoot.removeEntry(folder, { recursive: true });
              toast(`Папка projects/${folder}/ удалена с диска`, "ok");
            }
          } catch (_) {}
        }
        openModal();
      }
    });
    host.appendChild(card);
  }

  // проекты, найденные только на диске — импорт одним кликом
  const disk = await scanDiskProjects(list);
  for (const dp of disk) {
    const card = document.createElement("div");
    card.className = "card disk";
    card.title = "Проект найден в папке projects/, но его нет в списке — кликните, чтобы импортировать";
    card.innerHTML = `
      <div class="card-thumb">${thumbSvg(dp.data)}</div>
      <div class="card-name">${esc(dp.name)}</div>
      <div class="card-date">на диске: projects/${esc(dp.folder)}/ · ${new Date(dp.mtime).toLocaleString("ru")}</div>
      <div class="card-btns">
        <button data-a="imp">Импортировать</button>
        <button data-a="del" class="danger" title="Удалить папку с диска">✕</button>
      </div>`;
    card.addEventListener("click", async e => {
      const a = e.target.dataset && e.target.dataset.a;
      if (a === "del") {
        e.stopPropagation();
        if (!confirm(`Удалить с диска папку projects/${dp.folder}/?\nВ ней project.json и сцена 3ds Max (.max). Действие необратимо.`)) return;
        try {
          const projRoot = await dirHandle.getDirectoryHandle("projects");
          await projRoot.removeEntry(dp.folder, { recursive: true });
          toast(`Удалено с диска: projects/${dp.folder}/`, "ok");
        } catch (err) { toast("Не удалось удалить: " + err.message, "err"); }
        openModal();
        return;
      }
      P = FCCore.migrate(dp.data);
      P.name = dp.name;
      dbId = null; sel = null;
      activeSide = FCCore.sidesOf(P)[0];
      await persistNow();
      undoMgr.reset(P);
      syncPanelInputs(); renderAll(); closeModal();
      toast(`Импортирован с диска: ${dp.name}`, "ok");
    });
    host.appendChild(card);
  }
  $("#modalHint").textContent = dirHandle
    ? (disk.length ? "" : "Все проекты из папки projects/ уже в списке.")
    : "Подключите папку FlatCraft (кнопка «Папка…»), чтобы видеть проекты с диска.";

  $("#modal").style.display = "flex";
}
function closeModal() { $("#modal").style.display = "none"; }
$("#btnProjects").addEventListener("click", openModal);
$("#modalClose").addEventListener("click", closeModal);
$("#modal").addEventListener("pointerdown", e => { if (e.target.id === "modal") closeModal(); });
/* новый проект: сначала выбор раскладки (изменить её потом нельзя) */
$("#modalNew").addEventListener("click", () => { $("#layoutPick").style.display = "flex"; });
$("#layoutPick").addEventListener("pointerdown", e => {
  if (e.target.id === "layoutPick") $("#layoutPick").style.display = "none";
});
$("#layoutCancel").addEventListener("click", () => { $("#layoutPick").style.display = "none"; });
$$("#layoutPick [data-layout]").forEach(btn => btn.addEventListener("click", async () => {
  $("#layoutPick").style.display = "none";
  P = FCCore.defaultProject("Кухня " + new Date().toLocaleDateString("ru"), btn.dataset.layout);
  dbId = null; sel = null; activeSide = FCCore.sidesOf(P)[0];
  await persistNow();
  undoMgr.reset(P);
  syncPanelInputs(); renderAll(); closeModal();
  toast(`Создан проект: ${FCCore.LAYOUT_RU[P.kitchen.layoutType]}`, "ok");
}));
$("#modalImport").addEventListener("click", () => $("#fileInput").click());

async function loadRec(id) {
  const rec = await DB.get(id);
  if (!rec) return;
  P = FCCore.migrate(rec.data);
  dbId = rec.id; sel = null; ia = null;
  activeSide = FCCore.sidesOf(P)[0];
  await DB.setSetting("lastId", dbId);
  undoMgr.reset(P);
  syncPanelInputs(); renderAll();
}

/* ============================= импорт / экспорт ============================= */
function downloadJson(data, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type: "application/json" }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

$("#fileInput").addEventListener("change", async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const raw = JSON.parse(await f.text());
    if (!raw.kitchen || !raw.room) throw new Error("это не проект FlatCraft");
    P = FCCore.migrate(raw);
    if (!P.name) P.name = f.name.replace(/\.json$/i, "");
    dbId = null; sel = null;
    activeSide = FCCore.sidesOf(P)[0];
    await persistNow();
    undoMgr.reset(P);
    syncPanelInputs(); renderAll(); closeModal();
    toast("Проект импортирован", "ok");
  } catch (err) { toast("Не удалось открыть: " + err.message, "err"); }
  e.target.value = "";
});
$("#btnImport").addEventListener("click", () => $("#fileInput").click());

async function ensurePermission(handle) {
  if (!handle) return false;
  const q = await handle.queryPermission({ mode: "readwrite" });
  if (q === "granted") return true;
  return (await handle.requestPermission({ mode: "readwrite" })) === "granted";
}

async function getDirPath(root, parts, create) {
  let h = root;
  for (const part of parts) h = await h.getDirectoryHandle(part, { create });
  return h;
}
async function writeFile(dir, name, content) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(content);
  await w.close();
}

async function exportProject() {
  const data = JSON.stringify(P, null, 2);
  if (dirHandle && await ensurePermission(dirHandle).catch(() => false)) {
    try {
      const dir = await getDirPath(dirHandle, ["projects", FCCore.slug(P.name)], true);
      await writeFile(dir, "project.json", data);
      toast(`Сохранено: projects/${FCCore.slug(P.name)}/project.json`, "ok");
      return;
    } catch (err) { toast("Ошибка записи в папку: " + err.message, "err"); }
  }
  if (window.showSaveFilePicker) {
    try {
      const h = await showSaveFilePicker({
        suggestedName: "project.json",
        types: [{ description: "Проект FlatCraft", accept: { "application/json": [".json"] } }],
      });
      const w = await h.createWritable(); await w.write(data); await w.close();
      toast("Проект сохранён", "ok");
      return;
    } catch (e) { if (e.name === "AbortError") return; }
  }
  downloadJson(data, "project.json");
}
$("#btnExport").addEventListener("click", exportProject);

/* ============================= папка FlatCraft + сборка ============================= */
$("#btnFolder").addEventListener("click", async () => {
  if (!window.showDirectoryPicker) { toast("Нужен Chrome или Edge", "err"); return; }
  try {
    const h = await showDirectoryPicker({ id: "flatcraft", mode: "readwrite" });
    try { await h.getDirectoryHandle("bridge"); }
    catch (_) {
      if (!confirm("В выбранной папке нет подпапки bridge — это точно папка FlatCraft?")) return;
    }
    dirHandle = h;
    await DB.setSetting("dirHandle", h).catch(() => {});
    renderHeader();
    toast("Папка подключена", "ok");
  } catch (e) { if (e.name !== "AbortError") toast(e.message, "err"); }
});

function buildScript(slugName, force) {
  return [
    "# -*- coding: utf-8 -*-",
    "import os, sys, traceback",
    "from pymxs import runtime as rt",
    "bridge = str(rt.FC_BridgeDir).rstrip('\\\\/')",
    "root = os.path.dirname(bridge)",
    "out = os.path.join(root, 'bridge', 'outbox', 'web_build_result.txt')",
    "try:",
    "    bdir = os.path.join(root, 'builder')",
    "    if bdir not in sys.path:",
    "        sys.path.insert(0, bdir)",
    "    import importlib, fc_builder, fc_scene",
    "    importlib.reload(fc_builder)",
    "    importlib.reload(fc_scene)",
    "    res = fc_scene.build_project(" + JSON.stringify(slugName) + ", force=" + (force ? "True" : "False") + ")",
    "    if res[0] == 'ok':",
    "        open(out, 'w', encoding='utf-8').write('OK %d' % res[1])",
    "    else:",
    "        open(out, 'w', encoding='utf-8').write('CONFIRM\\n' + res[1])",
    "except Exception:",
    "    open(out, 'w', encoding='utf-8').write('ERROR\\n' + traceback.format_exc())",
    "",
  ].join("\n");
}

/* диалог подтверждения пересборки */
function askConfirm(text) {
  return new Promise(resolve => {
    $("#confirmText").textContent = text;
    $("#confirm").style.display = "flex";
    const done = v => {
      $("#confirm").style.display = "none";
      $("#confirmYes").onclick = $("#confirmNo").onclick = null;
      resolve(v);
    };
    $("#confirmYes").onclick = () => done(true);
    $("#confirmNo").onclick = () => done(false);
  });
}

async function bridgeAlive(bridge) {
  try {
    const f = await (await bridge.getFileHandle("alive.txt")).getFile();
    return Date.now() - f.lastModified < 10000;
  } catch (_) { return false; }
}

$("#btnBuild").addEventListener("click", async () => {
  if (!dirHandle || building) return;
  building = true; renderHeader();
  try {
    if (!await ensurePermission(dirHandle)) throw new Error("нет доступа к папке");
    const bridge = await dirHandle.getDirectoryHandle("bridge", { create: true });

    // сохранить проект (каждый проект живёт в своей папке и своей .max-сцене)
    const slugName = FCCore.slug(P.name);
    const projDir = await getDirPath(dirHandle, ["projects", slugName], true);
    await writeFile(projDir, "project.json", JSON.stringify(P, null, 2));

    const outbox = await bridge.getDirectoryHandle("outbox", { create: true });
    await outbox.removeEntry("web_build_result.txt").catch(() => {});

    const waitResult = async (waitMs, sawAliveInit) => {
      let result = null, sawAlive = sawAliveInit;
      const t0 = Date.now();
      while (!result && Date.now() - t0 < waitMs) {
        await sleep(700);
        try {
          const f = await (await outbox.getFileHandle("web_build_result.txt")).getFile();
          result = await f.text();
        } catch (_) {}
        if (!result && !sawAlive && await bridgeAlive(bridge)) {
          sawAlive = true;
          toast("3ds Max запущен, идёт сборка…", "ok");
        }
        if (!result && !sawAlive && Date.now() - t0 > 90000)
          throw new Error("3ds Max не запустился за 90 секунд.\n" +
            "Один раз выполните launcher\\setup.cmd (двойной клик) и повторите.");
      }
      if (!result) throw new Error("Max не ответил — проверьте мост (bridge/FC_Bridge.ms)");
      return result;
    };

    const alive = await bridgeAlive(bridge);
    let waitMs;
    if (alive) {
      // мост работает — обычная быстрая сборка
      const inbox = await bridge.getDirectoryHandle("inbox", { create: true });
      await writeFile(inbox, "web_build.py", buildScript(slugName, false));
      toast(`Сборка «${P.name}» отправлена в 3ds Max…`, "ok");
      waitMs = 30000;
    } else {
      // Max не запущен — холодный старт через протокол flatcraft://
      await writeFile(bridge, "launch_request.txt", slugName);
      location.href = "flatcraft://launch";
      toast("Запускаю 3ds Max…\nЕсли браузер спросит — разрешите открыть FlatCraft.", "ok", 9000);
      waitMs = 300000; // старт Max небыстрый
    }

    let result = await waitResult(waitMs, alive);

    // защита: сцену меняли вручную в Max — спросить пользователя
    if (result.startsWith("CONFIRM")) {
      const detail = result.split("\n").slice(1).join(" ").trim();
      const ok = await askConfirm(
        `Сцена «${P.name}» изменялась вручную в 3ds Max` +
        (detail ? ` (${detail})` : "") + ".\n\n" +
        "Пересобрать кухню? Объекты FlatCraft будут перестроены по проекту " +
        "(ваши правки над ними сбросятся), добавленные вами объекты останутся в сцене.");
      if (!ok) {
        toast("Сборка отменена — сцена в Max не тронута", "ok");
        return;
      }
      await outbox.removeEntry("web_build_result.txt").catch(() => {});
      const inbox = await bridge.getDirectoryHandle("inbox", { create: true });
      await writeFile(inbox, "web_build.py", buildScript(slugName, true));
      result = await waitResult(30000, true);
    }

    if (result.startsWith("OK"))
      toast(`Готово: «${P.name}» собрана в своей сцене (${result.replace("OK ", "")} объектов).\n` +
        `Файл: projects/${slugName}/${slugName}.max`, "ok", 6000);
    else throw new Error(result.slice(0, 400));
  } catch (err) {
    toast("Сборка: " + err.message, "err", 9000);
  } finally {
    building = false; renderHeader();
  }
});

/* индикатор моста в шапке: серый — Max не запущен, зелёный — на связи */
setInterval(async () => {
  const el = $("#maxStatus");
  if (!dirHandle) { el.textContent = ""; return; }
  try {
    const bridge = await dirHandle.getDirectoryHandle("bridge");
    const on = await bridgeAlive(bridge);
    el.textContent = on ? "● Max на связи" : "○ Max не запущен";
    el.className = on ? "on" : "off";
  } catch (_) { el.textContent = ""; }
}, 5000);

/* ============================= прочее UI ============================= */
function toast(text, kind = "ok", ms = 4000) {
  const host = $("#toasts");
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = text;
  host.appendChild(el);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 300); }, ms);
}

$("#btnUndo").addEventListener("click", doUndo);
$("#btnRedo").addEventListener("click", doRedo);
$("#btnFit").addEventListener("click", zoomFit);
$("#btnZoomIn").addEventListener("click", () => { view.zoom = Math.min(5, view.zoom * 1.25); renderFront(); renderStatus(); });
$("#btnZoomOut").addEventListener("click", () => { view.zoom = Math.max(0.25, view.zoom / 1.25); renderFront(); renderStatus(); });

window.addEventListener("resize", renderAll);
window.addEventListener("error", e => {
  const bar = $("#errbar");
  bar.style.display = "block";
  bar.textContent = "Ошибка: " + e.message + " @" + e.lineno;
});

/* ============================= запуск ============================= */
async function boot() {
  if (TESTMODE) document.title = "BOOT wipe";
  if (TESTMODE) await DB.wipe(DBNAME);
  if (TESTMODE) document.title = "BOOT open";
  await DB.open(DBNAME);
  if (TESTMODE) document.title = "BOOT db-ok";
  const lastId = await DB.getSetting("lastId");
  let rec = lastId != null ? await DB.get(lastId) : null;
  if (!rec) {
    const list = await DB.list();
    rec = list.sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
  }
  if (rec) { P = FCCore.migrate(rec.data); dbId = rec.id; }
  else { P = FCCore.defaultProject(); await persistNow(); }
  // ?demo=L|U — показать шаблонный проект без сохранения (для тестов/скриншотов)
  const demo = new URLSearchParams(location.search).get("demo");
  if (demo && FCCore.LAYOUT_SIDES[demo]) {
    P = FCCore.defaultProject("Демо " + FCCore.LAYOUT_RU[demo], demo);
    dbId = null;
  }
  activeSide = FCCore.sidesOf(P)[0];
  dirHandle = await DB.getSetting("dirHandle").catch(() => null);
  undoMgr.reset(P);
  syncPanelInputs();
  renderAll();
  window.FCReady = true;
  document.dispatchEvent(new Event("fc-ready"));
}

/* API для тестов и отладки */
window.FC = {
  core: FCCore, DB,
  getP: () => P,
  getSel: () => sel,
  setSel: s => { sel = s; renderAll(); },
  getSide: () => activeSide,
  setSide: s => { activeSide = s; sel = null; syncPanelInputs(); renderAll(); },
  fx: () => fx,
  undo: doUndo, redo: doRedo,
  commit, renderAll,
  serialize: () => JSON.stringify(P, null, 2),
  ready: () => !!window.FCReady,
};

boot().catch(err => {
  const bar = $("#errbar");
  bar.style.display = "block";
  bar.textContent = "Ошибка запуска: " + err.message;
});

})();
