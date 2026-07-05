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
let sel = null;                    // {row, idx}
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
const rowX0 = row => (+P.kitchen.offsetX || 0) +
  (row === "upper" ? (+P.kitchen.upper.offsetX || 0) : 0);
const placedOf = row => FCCore.layout(P.kitchen[row].blocks, D().gap, rowX0(row));
const selBlock = () => (sel ? P.kitchen[sel.row].blocks[sel.idx] : null);

function clampSel() {
  if (sel && !P.kitchen[sel.row].blocks[sel.idx]) sel = null;
}

/* ============================= svg helpers ============================= */
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const R = (x, y, w, h, fill, extra = "") =>
  `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(w, .5).toFixed(1)}" height="${Math.max(h, .5).toFixed(1)}" fill="${fill}" ${extra}/>`;
const T = (x, y, t, extra = "") =>
  `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="10" fill="#7a8089" ${extra}>${esc(t)}</text>`;
const L = (x1, y1, x2, y2, stroke = "#3a4048", extra = "") =>
  `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${stroke}" ${extra}/>`;

const isSel = (row, i) => sel && sel.row === row && sel.idx === i;
const isDragged = (row, i) => ia && ia.kind === "move" && ia.row === row && ia.idx === i;

/* ============================= вид спереди ============================= */
function computeFx() {
  const svg = $("#svgFront"), box = svg.getBoundingClientRect();
  const m = 48;
  const fit = Math.min((box.width - 2 * m) / P.room.length, (box.height - 2 * m) / P.room.height);
  const s = fit * view.zoom;
  fx = { s, ox: m + view.panX, oyFloor: box.height - m + view.panY, box, fit, m };
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
  const dragged = isDragged(row, i);
  const strokeSel = isSel(row, i) && !dragged
    ? `stroke="#5b9dff" stroke-width="2"` : `stroke="#0e0f12" stroke-width="0.5"`;

  if (dragged) {           // блок в ряду на время перетаскивания — контур
    g.push(`<g ${id}>` + R(X(r.x), Yz(r.z + r.h), r.w * fx.s, r.h * fx.s, "none",
      `stroke="#5b9dff66" stroke-width="1.5" stroke-dasharray="6 5"`) + `</g>`);
    return;
  }
  if (b.type === "gap") {
    const on = isSel(row, i);
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

  // комната
  g.push(R(X(0), Yz(room.height), room.length * fx.s, room.height * fx.s, c.walls + "12",
    `stroke="#31363f" stroke-width="1"`));
  g.push(L(X(0), Yz(0), X(room.length), Yz(0), "#4a505a", `stroke-width="1.5"`));

  const lower = placedOf("lower");
  const upper = P.kitchen.upper.enabled ? placedOf("upper") : [];

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

  if (P.kitchen.upper.enabled && P.kitchen.upper.antresol && upper.length) {
    const e = FCCore.rowExtent(upper);
    g.push(R(X(e.start), Yz(z.zUpperTop + d.gap + d.antresolHeight),
      (e.end - e.start) * fx.s, d.antresolHeight * fx.s, c.upper + "cc"));
  }

  // размерные подписи (кликабельные)
  for (const row of ["lower", "upper"]) {
    if (row === "upper" && !P.kitchen.upper.enabled) continue;
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
      : (placed.length ? FCCore.rowExtent(placed).end + d.gap / 2 : rowX0(palDrag.row));
    const band = palDrag.row === "lower" ? [0, z.zLowerTop] : [z.zUpper, z.zUpperTop];
    g.push(L(X(xIns), Yz(band[1] + 60), X(xIns), Yz(band[0]) + 8, "#5b9dff", `stroke-width="2.5"`));
  }

  if (ia && ia.kind === "move") {
    const arr = P.kitchen[ia.row].blocks, b = arr[ia.idx];
    const r = blockFrontRect(ia.row, b, ia.mm - ia.grabDx, +b.width || 600);
    const fill = ia.outside ? "#ff6b6b88" : (ia.row === "upper" ? C().upper : C().lower) + "99";
    g.push(R(X(r.x), Yz(r.z + r.h), r.w * fx.s, r.h * fx.s, fill,
      `stroke="${ia.outside ? "#ff6b6b" : "#5b9dff"}" stroke-width="1.5" pointer-events="none"`));
    if (ia.outside)
      g.push(`<text x="${X(r.x + r.w / 2)}" y="${Yz(r.z + r.h) - 8}" font-size="11" fill="#ff6b6b" text-anchor="middle">отпустите — удалить</text>`);
  }

  svg.innerHTML = g.join("");
}

/* ============================= вид сверху ============================= */
function renderTop() {
  const svg = $("#svgTop"), box = svg.getBoundingClientRect();
  const room = P.room, d = D(), c = C();
  const m = 22;
  const s = Math.min((box.width - 2 * m) / room.length, (box.height - 2 * m) / room.width);
  const Xt = mm => m + mm * s, Yt = mm => m + mm * s;
  const g = [];
  g.push(R(Xt(0), Yt(0), room.length * s, room.width * s, c.floor + "20", `stroke="#31363f"`));
  const lower = placedOf("lower");
  for (const [x1, x2] of FCCore.runs(lower, FCCore.underCT))
    g.push(R(Xt(x1) - 2, Yt(0), (x2 - x1) * s + 4, (d.lowerDepth + d.countertopOverhang) * s, c.countertop + "77"));
  for (let i = 0; i < lower.length; i++) {
    const { b, x, w } = lower[i];
    const st = isSel("lower", i) ? `stroke="#5b9dff" stroke-width="2"` : `stroke="#0e0f12" stroke-width="0.5"`;
    if (b.type === "gap")
      g.push(`<g data-row="lower" data-idx="${i}">` + R(Xt(x), Yt(0), w * s, d.lowerDepth * s, "#ffffff06",
        `stroke="${isSel("lower", i) ? "#5b9dff" : "#565e6a"}" stroke-dasharray="5 4"`) + `</g>`);
    else
      g.push(`<g data-row="lower" data-idx="${i}">` + R(Xt(x), Yt(0), w * s, d.lowerDepth * s, c.lower, st) + `</g>`);
  }
  if (P.kitchen.upper.enabled)
    for (let i = 0; i < placedOf("upper").length; i++) {
      const { b, x, w } = placedOf("upper")[i];
      if (b.type !== "gap")
        g.push(`<g data-row="upper" data-idx="${i}">` +
          R(Xt(x), Yt(0), w * s, d.upperDepth * s, c.upper + "55",
            isSel("upper", i) ? `stroke="#5b9dff" stroke-width="2"` : "") + `</g>`);
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
      if (P.kitchen.upper.enabled) {
        g.push(R(Xs(0), Ys(z.zUpperTop), d.upperDepth * s, d.upperHeight * s, c.upper));
        if (P.kitchen.upper.antresol)
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
  $("#iType").textContent = FCCore.TYPE_RU[b.type] + (sel.row === "upper" ? " · верх" : " · низ");
  $("#iWidth").value = b.width;
  $("#rDrawers").style.display = b.type === "drawers" ? "" : "none";
  $("#iDrawers").value = b.drawers || 3;
  $("#rTall").style.display = (b.type === "gap" && sel.row === "lower") ? "" : "none";
  $("#iTall").checked = !!b.tall;
  $("#rLabel").style.display = (b.type === "gap" || b.type === "tall") ? "" : "none";
  $("#iLabel").value = b.label || "";
}

function renderStatus() {
  const lower = FCCore.rowExtent(placedOf("lower"));
  const upper = P.kitchen.upper.enabled ? FCCore.rowExtent(placedOf("upper")) : null;
  $("#sbSums").textContent =
    `низ ${lower.end} / ${P.room.length} мм` + (upper ? ` · верх ${upper.end} мм` : "");
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

function renderAll() {
  clampSel();
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
  if (other !== "upper" || P.kitchen.upper.enabled)
    for (const { x, w } of placedOf(other)) edges.push(x, x + w);
  edges.push(P.room.length);
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
    sel = { row, idx };
    const placed = placedOf(row)[idx];
    ia = { kind: "resize", row, idx, blockX: placed.x, startW: placed.w,
           guideX: null, tipX: placed.x + placed.w, tipZ: blockFrontRect(row, placed.b, placed.x, placed.w).z +
           blockFrontRect(row, placed.b, placed.x, placed.w).h, tipText: String(placed.w) };
    renderAll();
    return;
  }
  if (blockEl) {
    const row = blockEl.dataset.row, idx = +blockEl.dataset.idx;
    const placed = placedOf(row)[idx];
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
    sel = { row: ia.row, idx: ia.idx };
    ia = { kind: "move", row: ia.row, idx: ia.idx, grabDx: ia.grabDx, mm: pxToMmX(e.clientX), outside: false };
  }
  if (ia.kind === "move") {
    ia.mm = pxToMmX(e.clientX);
    const b = fx.box;
    ia.outside = e.clientY < b.top - 4 || e.clientY > b.bottom + 4 || e.clientX < b.left - 4 || e.clientX > b.right + 4;
    const arr = P.kitchen[ia.row].blocks;
    const ni = FCCore.insertIndexAt(arr, D().gap, rowX0(ia.row), ia.mm, ia.idx);
    if (ni !== ia.idx) {
      const [blk] = arr.splice(ia.idx, 1);
      arr.splice(ni, 0, blk);
      ia.idx = ni; sel = { row: ia.row, idx: ni };
    }
    renderFront(); renderStatus();
    return;
  }
  if (ia.kind === "resize") {
    const b = P.kitchen[ia.row].blocks[ia.idx];
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
    sel = { row: k.row, idx: k.idx };
    ia = null; renderAll();
    return;
  }
  if (k.kind === "move") {
    ia = null;
    if (k.outside) {
      P.kitchen[k.row].blocks.splice(k.idx, 1);
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
    sel = { row, idx: +i }; renderAll();
    inlineWidthEdit(row, +i);
  }
});

function inlineWidthEdit(row, idx) {
  const placed = placedOf(row)[idx];
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
      P.kitchen[row].blocks[idx].width = v;
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

/* клик по виду сверху — выделение */
$("#svgTop").addEventListener("pointerdown", e => {
  const el = e.target.closest("[data-row]");
  sel = el ? { row: el.dataset.row, idx: +el.dataset.idx } : null;
  renderAll();
});

/* ============================= контекстное меню ============================= */
const menu = $("#ctxmenu");
svgFront.addEventListener("contextmenu", e => {
  e.preventDefault();
  const el = e.target.closest("[data-row]");
  if (!el) { menu.style.display = "none"; return; }
  sel = { row: el.dataset.row, idx: +el.dataset.idx };
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
  const arr = P.kitchen[sel.row].blocks;
  arr.splice(sel.idx + 1, 0, JSON.parse(JSON.stringify(arr[sel.idx])));
  sel = { row: sel.row, idx: sel.idx + 1 };
  commit();
}
function deleteSel() {
  if (!sel) return;
  P.kitchen[sel.row].blocks.splice(sel.idx, 1);
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
    if (band && (palDrag.row === "lower" || P.kitchen.upper.enabled)) {
      valid = true;
      palDrag.insertIdx = FCCore.insertIndexAt(
        P.kitchen[palDrag.row].blocks, D().gap, rowX0(palDrag.row), pxToMmX(e.clientX));
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
    const arr = P.kitchen[pd.row].blocks;
    const at = sel && sel.row === pd.row ? sel.idx + 1 : arr.length;
    arr.splice(at, 0, FCCore.newBlock(pd.row, pd.type));
    sel = { row: pd.row, idx: at };
    commit();
    return;
  }
  if (pd.valid) {
    const arr = P.kitchen[pd.row].blocks;
    arr.splice(pd.insertIdx, 0, FCCore.newBlock(pd.row, pd.type));
    sel = { row: pd.row, idx: pd.insertIdx };
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
  const arr = P.kitchen[sel.row].blocks, j = sel.idx + dir;
  if (j < 0 || j >= arr.length) return;
  [arr[sel.idx], arr[j]] = [arr[j], arr[sel.idx]];
  sel = { row: sel.row, idx: j };
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
  $$("[data-d]").forEach(inp => { inp.value = D()[inp.dataset.d]; });
  $$("[data-c]").forEach(inp => { inp.value = C()[inp.dataset.c]; });
  $("#projName").value = P.name;
}
$$("[data-k]").forEach(inp => inp.addEventListener("change", () => {
  setPath(P, inp.dataset.k, inp.type === "checkbox" ? inp.checked : +inp.value || 0);
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
  const arr = P.kitchen[sel.row].blocks;
  const j = Math.min(arr.length - 1, Math.max(0, sel.idx + dir));
  sel = { row: sel.row, idx: j };
  renderAll();
}

/* ============================= менеджер проектов ============================= */
function thumbSvg(p, W = 240, H = 120) {
  p = FCCore.migrate(p);
  const d = { ...FCCore.DIMS, ...p.kitchen.dims }, c = { ...FCCore.COLORS, ...p.kitchen.colors };
  const z = FCCore.zLevels(d);
  const m = 8;
  const s = Math.min((W - 2 * m) / p.room.length, (H - 2 * m) / p.room.height);
  const Xs = mm => m + mm * s, Ys = mm => H - m - mm * s;
  const g = [`<rect width="${W}" height="${H}" fill="#1a1d23"/>`];
  const lower = FCCore.layout(p.kitchen.lower.blocks, d.gap, +p.kitchen.offsetX || 0);
  for (const [x1, x2] of FCCore.runs(lower, FCCore.underCT))
    g.push(R(Xs(x1), Ys(z.zCtTop), (x2 - x1) * s, d.countertopThickness * s, c.countertop));
  for (const { b, x, w } of lower) {
    if (b.type === "gap") continue;
    const h = b.type === "tall" ? z.zUpperTop - z.zLower : d.lowerHeight;
    g.push(R(Xs(x), Ys(z.zLower + h), w * s, h * s, c.lower));
  }
  if (p.kitchen.upper.enabled)
    for (const { b, x, w } of FCCore.layout(p.kitchen.upper.blocks, d.gap,
      (+p.kitchen.offsetX || 0) + (+p.kitchen.upper.offsetX || 0))) {
      if (b.type === "gap") continue;
      g.push(R(Xs(x), Ys(z.zUpperTop), w * s, d.upperHeight * s, c.upper));
    }
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${g.join("")}</svg>`;
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
        if (!confirm(`Удалить проект «${rec.name}»?`)) return;
        await DB.del(rec.id);
        if (rec.id === dbId) { dbId = null; }
        openModal();
      }
    });
    host.appendChild(card);
  }
  $("#modal").style.display = "flex";
}
function closeModal() { $("#modal").style.display = "none"; }
$("#btnProjects").addEventListener("click", openModal);
$("#modalClose").addEventListener("click", closeModal);
$("#modal").addEventListener("pointerdown", e => { if (e.target.id === "modal") closeModal(); });
$("#modalNew").addEventListener("click", async () => {
  P = FCCore.defaultProject("Кухня " + new Date().toLocaleDateString("ru"));
  dbId = null; sel = null;
  await persistNow();
  undoMgr.reset(P);
  syncPanelInputs(); renderAll(); closeModal();
});
$("#modalImport").addEventListener("click", () => $("#fileInput").click());

async function loadRec(id) {
  const rec = await DB.get(id);
  if (!rec) return;
  P = FCCore.migrate(rec.data);
  dbId = rec.id; sel = null; ia = null;
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

function buildScript(slugName) {
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
    "    import importlib, fc_builder",
    "    importlib.reload(fc_builder)",
    "    n = fc_builder.build_from_file(os.path.join(root, 'projects', " + JSON.stringify(slugName) + ", 'project.json'))",
    "    open(out, 'w', encoding='utf-8').write('OK %d' % n)",
    "except Exception:",
    "    open(out, 'w', encoding='utf-8').write('ERROR\\n' + traceback.format_exc())",
    "",
  ].join("\n");
}

$("#btnBuild").addEventListener("click", async () => {
  if (!dirHandle || building) return;
  building = true; renderHeader();
  try {
    if (!await ensurePermission(dirHandle)) throw new Error("нет доступа к папке");
    const bridge = await dirHandle.getDirectoryHandle("bridge");

    // жив ли мост: alive.txt должен обновляться каждые ~2 c
    let alive = false;
    try {
      const f = await (await bridge.getFileHandle("alive.txt")).getFile();
      alive = Date.now() - f.lastModified < 10000;
    } catch (_) {}
    if (!alive) throw new Error("мост не запущен — выполните в 3ds Max скрипт bridge/FC_Bridge.ms");

    // сохранить проект
    const slugName = FCCore.slug(P.name);
    const projDir = await getDirPath(dirHandle, ["projects", slugName], true);
    await writeFile(projDir, "project.json", JSON.stringify(P, null, 2));

    // убрать старый результат, отправить команду
    const outbox = await bridge.getDirectoryHandle("outbox", { create: true });
    await outbox.removeEntry("web_build_result.txt").catch(() => {});
    const inbox = await bridge.getDirectoryHandle("inbox", { create: true });
    await writeFile(inbox, "web_build.py", buildScript(slugName));
    toast("Команда отправлена в 3ds Max…", "ok");

    // ждать результат
    let result = null;
    for (let i = 0; i < 40 && !result; i++) {
      await sleep(500);
      try {
        const f = await (await outbox.getFileHandle("web_build_result.txt")).getFile();
        result = await f.text();
      } catch (_) {}
    }
    if (!result) throw new Error("Max не ответил за 20 секунд — проверьте мост");
    if (result.startsWith("OK")) toast("Собрано в 3D: " + result.replace("OK", "объектов —"), "ok");
    else throw new Error(result.slice(0, 400));
  } catch (err) {
    toast("Сборка: " + err.message, "err", 8000);
  } finally {
    building = false; renderHeader();
  }
});

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
