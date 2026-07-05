/* FlatCraft core — чистая логика без DOM (используется приложением и тестами) */
"use strict";

const FCCore = (() => {

  const DIMS = {
    plinthHeight: 100, plinthRecess: 10, lowerHeight: 720, lowerDepth: 600,
    gap: 4, shadowGap: 4, countertopThickness: 40, countertopOverhang: 40,
    backsplashGap: 600, backsplashThickness: 12, upperHeight: 720,
    upperDepth: 350, antresolHeight: 360,
  };
  const COLORS = {
    walls: "#EDEDED", floor: "#B9975B", lower: "#3A3F45", upper: "#E9E4DA",
    countertop: "#23262B", plinth: "#1C1E22", backsplash: "#CFC8BB",
  };
  const TYPE_RU = { cabinet: "Шкаф", drawers: "Ящики", tall: "Пенал", gap: "Проём" };
  const STD_WIDTHS = [150, 200, 300, 400, 450, 500, 600, 700, 800, 900, 1000, 1200];
  const MIN_WIDTH = 100;

  /* Раскладки: какие стороны есть у кухни. Вид сверху (южная стена сверху,
     западная слева, восточная справа) повторяет форму буквы: Г, П. */
  const LAYOUT_SIDES = {
    linear: ["south"],
    L: ["south", "west"],
    U: ["west", "south", "east"],
  };
  const LAYOUT_RU = { linear: "Обычная (прямая)", L: "Г-образная", U: "П-образная" };
  const SIDE_RU = { south: "Главная", west: "Левая", east: "Правая" };

  /* Отступ бокового крыла от угла: столешница главной стены (глубина + вылет)
     + зазор, чтобы столешницы стыковались без пересечений. */
  const legOffset = d => d.lowerDepth + d.countertopOverhang + d.gap;          // 644
  const legUpperOffset = d => (d.upperDepth + d.gap) - legOffset(d);           // -290

  function emptySide(offsetX = 0) {
    return {
      offsetX,
      lower: { blocks: [] },
      upper: { enabled: true, offsetX: 0, antresol: false, blocks: [] },
    };
  }

  function defaultProject(name, layout = "linear") {
    if (!LAYOUT_SIDES[layout]) layout = "linear";
    const d = { ...DIMS };
    const lo = legOffset(d), uo = legUpperOffset(d);

    const southMain = {
      offsetX: 0,
      lower: { blocks: [
        { type: "drawers", width: 600, drawers: 3 },
        { type: "cabinet", width: 600 },
        { type: "gap", width: 600, tall: false, label: "плита" },
        { type: "cabinet", width: 600 },
      ]},
      upper: { enabled: true, offsetX: 0, antresol: false, blocks: [
        { type: "cabinet", width: 600 },
        { type: "cabinet", width: 600 },
        { type: "gap", width: 600, label: "вытяжка" },
        { type: "cabinet", width: 600 },
      ]},
    };

    const sides = {};
    if (layout === "linear") {
      sides.south = JSON.parse(JSON.stringify(southMain));
      sides.south.lower.blocks.push(
        { type: "tall", width: 600, label: "пенал" },
        { type: "gap", width: 700, tall: true, label: "холодильник" });
    } else if (layout === "L") {
      sides.south = JSON.parse(JSON.stringify(southMain));
      sides.south.lower.blocks.push(
        { type: "tall", width: 600, label: "пенал" },
        { type: "gap", width: 700, tall: true, label: "холодильник" });
      sides.west = {
        offsetX: lo,
        lower: { blocks: [
          { type: "cabinet", width: 600, label: "" },
          { type: "gap", width: 600, tall: false, label: "посудомойка" },
          { type: "cabinet", width: 600 },
        ]},
        upper: { enabled: true, offsetX: uo, antresol: false, blocks: [
          { type: "cabinet", width: 600 },
          { type: "cabinet", width: 600 },
        ]},
      };
    } else { // U
      sides.west = {
        offsetX: lo,
        lower: { blocks: [
          { type: "gap", width: 700, tall: true, label: "холодильник" },
          { type: "tall", width: 600, label: "пенал" },
          { type: "cabinet", width: 600 },
        ]},
        upper: { enabled: true, offsetX: 700 + d.gap + 600 + d.gap, antresol: false, blocks: [
          { type: "cabinet", width: 600 },
        ]},
      };
      sides.south = JSON.parse(JSON.stringify(southMain));
      sides.east = {
        offsetX: lo,
        lower: { blocks: [
          { type: "cabinet", width: 600 },
          { type: "gap", width: 600, tall: false, label: "посудомойка" },
          { type: "drawers", width: 600, drawers: 3 },
        ]},
        upper: { enabled: true, offsetX: uo, antresol: false, blocks: [
          { type: "cabinet", width: 600 },
          { type: "cabinet", width: 600 },
        ]},
      };
    }

    return {
      formatVersion: 2,
      name: name || "Новая кухня",
      units: "mm",
      room: { length: 4200, width: 3000, height: 2700, wallThickness: 400, ceiling: false, noShell: false },
      kitchen: {
        layoutType: layout,
        wall: "south",
        dims: { ...DIMS },
        sides,
        colors: { ...COLORS },
      },
    };
  }

  /* Заполнить недостающие поля; старый формат (lower/upper в корне kitchen)
     превращается в sides.south, layoutType = linear. */
  function migrate(p) {
    if (!p || typeof p !== "object") return defaultProject();
    const d = defaultProject();
    const out = { ...d, ...p };
    out.room = { ...d.room, ...(p.room || {}) };
    const k = p.kitchen || {};
    out.kitchen = {
      layoutType: LAYOUT_SIDES[k.layoutType] ? k.layoutType : "linear",
      wall: "south",
      dims: { ...DIMS, ...(k.dims || {}) },
      colors: { ...COLORS, ...(k.colors || {}) },
      sides: {},
    };
    const srcSides = k.sides || (k.lower || k.upper
      ? { south: { offsetX: k.offsetX || 0, lower: k.lower, upper: k.upper } }
      : {});
    if (!LAYOUT_SIDES[k.layoutType] && k.sides) {
      // раскладка не указана, но стороны есть — определить по ним
      const have = Object.keys(k.sides);
      out.kitchen.layoutType = have.length >= 3 ? "U" : (have.length === 2 ? "L" : "linear");
    }
    for (const side of LAYOUT_SIDES[out.kitchen.layoutType]) {
      const s = srcSides[side] || {};
      const norm = emptySide(+s.offsetX || 0);
      norm.lower.blocks = (((s.lower) || {}).blocks || []).map(b => ({ ...b }));
      norm.upper = { enabled: true, offsetX: 0, antresol: false, ...(s.upper || {}) };
      norm.upper.blocks = (((s.upper) || {}).blocks || []).map(b => ({ ...b }));
      out.kitchen.sides[side] = norm;
    }
    out.formatVersion = 2;
    return out;
  }

  const sidesOf = p => LAYOUT_SIDES[p.kitchen.layoutType] || ["south"];
  const wallLength = (p, side) => side === "south" ? +p.room.length : +p.room.width;

  /* Локальные координаты стороны (x вдоль стены от угла, y — глубина от стены)
     -> мировые (вид сверху, южная стена у y=0). */
  function mapRect(side, room, x, y, w, d) {
    if (side === "west") return { x: y, y: x, w: d, d: w };
    if (side === "east") return { x: room.length - y - d, y: x, w: d, d: w };
    return { x, y, w, d };
  }

  /* ---------- раскладка ряда (зеркало fc_builder.py) ---------- */
  function layout(blocks, gap, x0) {
    const out = []; let x = +x0 || 0;
    for (const b of blocks) {
      const w = Math.max(1, +b.width || 600);
      out.push({ b, x, w });
      x += w + gap;
    }
    return out;
  }

  function runs(placed, pred) {
    const rs = []; let s = null, e = null;
    for (const { b, x, w } of placed) {
      if (pred(b)) { if (s === null) s = x; e = x + w; }
      else if (s !== null) { rs.push([s, e]); s = null; }
    }
    if (s !== null) rs.push([s, e]);
    return rs;
  }

  const underCT = b => b.type === "cabinet" || b.type === "drawers" || (b.type === "gap" && !b.tall);
  const hasPlinth = b => !(b.type === "gap" && b.tall);

  function zLevels(dims) {
    const d = { ...DIMS, ...dims };
    const zLower = d.plinthHeight, zLowerTop = zLower + d.lowerHeight;
    const zCt = zLowerTop + d.shadowGap, zCtTop = zCt + d.countertopThickness;
    const zUpper = zCtTop + d.backsplashGap, zUpperTop = zUpper + d.upperHeight;
    return { zLower, zLowerTop, zCt, zCtTop, zUpper, zUpperTop };
  }

  function rowExtent(placed) {
    if (!placed.length) return { start: 0, end: 0 };
    const last = placed[placed.length - 1];
    return { start: placed[0].x, end: last.x + last.w };
  }

  function insertIndexAt(blocks, gap, x0, mm, excludeIdx = -1) {
    const placed = layout(blocks, gap, x0);
    let idx = 0;
    for (let i = 0; i < placed.length; i++)
      if (i !== excludeIdx && mm > placed[i].x + placed[i].w / 2) idx++;
    return idx;
  }

  function snapWidth(rawW, blockX, edges, tolMm, step = 10) {
    let best = null;
    for (const e of edges || []) {
      const w = e - blockX;
      if (w < MIN_WIDTH) continue;
      const dist = Math.abs(rawW - w);
      if (dist <= tolMm && (!best || dist < best.dist))
        best = { w: Math.round(w), guideX: e, why: "edge", dist };
    }
    for (const sw of STD_WIDTHS) {
      const dist = Math.abs(rawW - sw);
      if (dist <= tolMm && (!best || dist < best.dist))
        best = { w: sw, guideX: null, why: "std", dist };
    }
    if (best) return best;
    return { w: Math.max(MIN_WIDTH, Math.round(rawW / step) * step), guideX: null, why: "step", dist: 0 };
  }

  function validate(p) {
    const warn = [];
    const d = { ...DIMS, ...p.kitchen.dims };
    for (const side of sidesOf(p)) {
      const s = p.kitchen.sides[side];
      if (!s) continue;
      const lim = wallLength(p, side);
      const label = SIDE_RU[side];
      const le = rowExtent(layout(s.lower.blocks, d.gap, +s.offsetX || 0));
      if (le.end > lim)
        warn.push(`${label}: нижний ряд ${le.end} мм не влезает в стену ${lim} мм`);
      if (s.upper.enabled) {
        const ue = rowExtent(layout(s.upper.blocks, d.gap, (+s.offsetX || 0) + (+s.upper.offsetX || 0)));
        if (ue.end > lim)
          warn.push(`${label}: верхний ряд ${ue.end} мм не влезает в стену ${lim} мм`);
      }
      for (const row of ["lower", "upper"])
        for (const b of s[row].blocks)
          if (!(+b.width >= MIN_WIDTH))
            warn.push(`${label}: блок «${TYPE_RU[b.type] || b.type}» уже ${MIN_WIDTH} мм`);
    }
    return warn;
  }

  /* ---------- undo / redo ---------- */
  class Undo {
    constructor(limit = 100) { this.limit = limit; this.stack = []; this.pos = -1; }
    reset(state) { this.stack = [JSON.stringify(state)]; this.pos = 0; }
    push(state) {
      const s = JSON.stringify(state);
      if (this.stack[this.pos] === s) return;
      this.stack = this.stack.slice(0, this.pos + 1);
      this.stack.push(s);
      if (this.stack.length > this.limit) this.stack.shift();
      this.pos = this.stack.length - 1;
    }
    canUndo() { return this.pos > 0; }
    canRedo() { return this.pos < this.stack.length - 1; }
    undo() { if (!this.canUndo()) return null; return JSON.parse(this.stack[--this.pos]); }
    redo() { if (!this.canRedo()) return null; return JSON.parse(this.stack[++this.pos]); }
  }

  function newBlock(row, type) {
    const b = { type, width: 600 };
    if (type === "drawers") b.drawers = 3;
    if (type === "gap") { b.label = row === "upper" ? "вытяжка" : "техника"; if (row === "lower") b.tall = false; }
    if (type === "tall") b.label = "пенал";
    return b;
  }

  const slug = name => (name || "проект").trim().replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60) || "проект";

  return {
    DIMS, COLORS, TYPE_RU, STD_WIDTHS, MIN_WIDTH,
    LAYOUT_SIDES, LAYOUT_RU, SIDE_RU, legOffset, legUpperOffset,
    defaultProject, migrate, sidesOf, wallLength, mapRect,
    layout, runs, underCT, hasPlinth, zLevels,
    rowExtent, insertIndexAt, snapWidth, validate, Undo, newBlock, slug,
  };
})();

if (typeof module !== "undefined") module.exports = FCCore;
