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

  function defaultProject(name) {
    return {
      formatVersion: 2,
      name: name || "Новая кухня",
      units: "mm",
      room: { length: 4200, width: 3000, height: 2700, wallThickness: 400, ceiling: false, noShell: false },
      kitchen: {
        wall: "south", offsetX: 0,
        dims: { ...DIMS },
        lower: { blocks: [
          { type: "drawers", width: 600, drawers: 3 },
          { type: "cabinet", width: 600 },
          { type: "gap", width: 600, tall: false, label: "плита" },
          { type: "cabinet", width: 600 },
          { type: "tall", width: 600, label: "пенал" },
          { type: "gap", width: 700, tall: true, label: "холодильник" },
        ]},
        upper: { enabled: true, offsetX: 0, antresol: false, blocks: [
          { type: "cabinet", width: 600 },
          { type: "cabinet", width: 600 },
          { type: "gap", width: 600, label: "вытяжка" },
          { type: "cabinet", width: 600 },
        ]},
        colors: { ...COLORS },
      },
    };
  }

  /* Заполнить недостающие поля (старые сохранения, импорт) */
  function migrate(p) {
    const d = defaultProject();
    if (!p || typeof p !== "object") return d;
    const out = { ...d, ...p };
    out.room = { ...d.room, ...(p.room || {}) };
    out.kitchen = { ...d.kitchen, ...(p.kitchen || {}) };
    out.kitchen.dims = { ...DIMS, ...((p.kitchen || {}).dims || {}) };
    out.kitchen.colors = { ...COLORS, ...((p.kitchen || {}).colors || {}) };
    out.kitchen.lower = { blocks: (((p.kitchen || {}).lower || {}).blocks || []).map(b => ({ ...b })) };
    // отсутствующий верхний ряд = пустой (как трактует и сборщик), а не ряд по умолчанию
    out.kitchen.upper = { enabled: true, offsetX: 0, antresol: false, ...((p.kitchen || {}).upper || {}) };
    out.kitchen.upper.blocks = (((p.kitchen || {}).upper || {}).blocks || []).map(b => ({ ...b }));
    out.formatVersion = 2;
    return out;
  }

  /* ---------- раскладка (зеркало fc_builder.py) ---------- */
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

  /* Индекс вставки при перетаскивании: сколько центров блоков левее точки.
     excludeIdx — индекс перетаскиваемого блока (не учитывается). */
  function insertIndexAt(blocks, gap, x0, mm, excludeIdx = -1) {
    const placed = layout(blocks, gap, x0);
    let idx = 0;
    for (let i = 0; i < placed.length; i++)
      if (i !== excludeIdx && mm > placed[i].x + placed[i].w / 2) idx++;
    return idx;
  }

  /* Притяжка ширины при ресайзе.
     rawW — сырая ширина по курсору; blockX — левый край блока;
     edges — x-координаты краёв блоков другого ряда (для выравнивания);
     tolMm — радиус притяжки; step — шаг округления без притяжки. */
  function snapWidth(rawW, blockX, edges, tolMm, step = 10) {
    let best = null; // {w, guideX, why, dist}
    // выравнивание по краям соседнего ряда — приоритетно (при равном
    // расстоянии показываем направляющую, а не просто стандартный размер)
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

  /* Проверки проекта: список предупреждений */
  function validate(p) {
    const warn = [];
    const d = { ...DIMS, ...p.kitchen.dims };
    const lp = layout(p.kitchen.lower.blocks, d.gap, +p.kitchen.offsetX || 0);
    const le = rowExtent(lp);
    if (le.end > p.room.length)
      warn.push(`Нижний ряд (${le.end} мм) шире комнаты (${p.room.length} мм)`);
    if (p.kitchen.upper.enabled) {
      const up = layout(p.kitchen.upper.blocks, d.gap,
        (+p.kitchen.offsetX || 0) + (+p.kitchen.upper.offsetX || 0));
      const ue = rowExtent(up);
      if (ue.end > p.room.length)
        warn.push(`Верхний ряд (${ue.end} мм) шире комнаты (${p.room.length} мм)`);
    }
    for (const row of ["lower", "upper"])
      for (const b of p.kitchen[row].blocks)
        if (!(+b.width >= MIN_WIDTH))
          warn.push(`Блок «${TYPE_RU[b.type] || b.type}» уже ${MIN_WIDTH} мм`);
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
    defaultProject, migrate, layout, runs, underCT, hasPlinth, zLevels,
    rowExtent, insertIndexAt, snapWidth, validate, Undo, newBlock, slug,
  };
})();

if (typeof module !== "undefined") module.exports = FCCore;
