/* FlatCraft selftest — запускается на index.html?selftest=1 (изолированная БД flatcraft_test).
   Результаты пишутся в #testlog и в document.title (TESTS OK / TESTS FAIL). */
"use strict";

(() => {
const log = [];
let pass = 0, fail = 0;
const out = document.getElementById("testlog");
out.style.display = "block";

function report(ok, name, detail) {
  if (ok) pass++; else fail++;
  const line = (ok ? "PASS " : "FAIL ") + name + (detail && !ok ? " — " + detail : "");
  log.push(line);
  out.textContent = log.join("\n");
  if (!ok) out.style.color = "#f99";
}
const eq = (a, b, name) => report(JSON.stringify(a) === JSON.stringify(b), name,
  `получено ${JSON.stringify(a)}, ожидалось ${JSON.stringify(b)}`);
const ok = (v, name, detail) => report(!!v, name, detail || "значение ложно");
const sleep = ms => new Promise(r => setTimeout(r, ms));

const svg = document.getElementById("svgFront");

function ptEv(type, target, x, y, extra = {}) {
  target.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 7, isPrimary: true,
    clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1, ...extra,
  }));
}
const at = (x, y) => document.elementFromPoint(x, y) || svg;

function mmToClient(mmX, mmZ) {
  const fx = FC.fx();
  return [fx.box.left + fx.ox + mmX * fx.s, fx.box.top + fx.oyFloor - mmZ * fx.s];
}
async function dragFront(x1, y1, x2, y2, steps = 6) {
  ptEv("pointerdown", at(x1, y1), x1, y1);
  for (let i = 1; i <= steps; i++)
    ptEv("pointermove", svg, x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps);
  ptEv("pointerup", svg, x2, y2);
  await sleep(30);
}
const P = () => FC.getP();
const lowerBlocks = () => P().kitchen.lower.blocks;
const placedLower = () => FC.core.layout(lowerBlocks(), P().kitchen.dims.gap || 4, +P().kitchen.offsetX || 0);

async function run() {
  /* ---------- ядро ---------- */
  const core = FC.core;
  {
    const pl = core.layout([{ type: "cabinet", width: 600 }, { type: "cabinet", width: 400 }], 4, 100);
    eq(pl.map(p => [p.x, p.w]), [[100, 600], [704, 400]], "core.layout: позиции и зазор");
  }
  {
    const blocks = [
      { type: "cabinet", width: 600 }, { type: "gap", width: 600, tall: false },
      { type: "tall", width: 600 }, { type: "gap", width: 700, tall: true },
      { type: "cabinet", width: 500 }];
    const pl = core.layout(blocks, 4, 0);
    eq(core.runs(pl, core.underCT), [[0, 1204], [2516, 3016]], "core.runs: разрыв столешницы на пенале и выс. проёме");
    eq(core.runs(pl, core.hasPlinth), [[0, 1808], [2516, 3016]], "core.runs: цоколь рвётся только на выс. проёме");
  }
  {
    const blocks = [{ type: "cabinet", width: 600 }, { type: "cabinet", width: 600 }];
    eq(core.insertIndexAt(blocks, 4, 0, 50), 0, "insertIndexAt: левее первого центра");
    eq(core.insertIndexAt(blocks, 4, 0, 700), 1, "insertIndexAt: между центрами");
    eq(core.insertIndexAt(blocks, 4, 0, 2000), 2, "insertIndexAt: правее всех");
  }
  {
    eq(core.snapWidth(597, 0, [], 15).w, 600, "snapWidth: притяжка к стандартной 600");
    const r = core.snapWidth(893, 1000, [1900], 15);
    eq([r.w, r.guideX], [900, 1900], "snapWidth: выравнивание по краю соседнего ряда");
    eq(core.snapWidth(437, 0, [], 5).w, 440, "snapWidth: округление шага 10 без притяжки");
    ok(core.snapWidth(20, 0, [], 5).w >= core.MIN_WIDTH, "snapWidth: не уже минимума");
  }
  {
    const m = core.migrate({ name: "x", kitchen: { lower: { blocks: [{ type: "cabinet" }] } } });
    ok(m.room.length === 4200 && m.kitchen.dims.plinthRecess === 10 && m.kitchen.upper.blocks.length === 0,
      "migrate: заполняет значения по умолчанию");
  }
  {
    const u = new core.Undo(10);
    u.reset({ v: 1 }); u.push({ v: 2 }); u.push({ v: 2 }); u.push({ v: 3 });
    eq(u.stack.length, 3, "Undo: дедупликация одинаковых состояний");
    eq(u.undo().v, 2, "Undo: undo");
    eq(u.redo().v, 3, "Undo: redo");
  }

  /* ---------- база ---------- */
  {
    const id = await FC.DB.put({ name: "t1", data: core.defaultProject("t1"), updatedAt: 1 });
    const rec = await FC.DB.get(id);
    eq(rec.name, "t1", "DB: put/get");
    ok((await FC.DB.list()).some(r => r.id === id), "DB: list");
    await FC.DB.del(id);
    ok(!(await FC.DB.get(id)), "DB: delete");
  }

  /* ---------- интерфейс ---------- */
  FC.renderAll();
  await sleep(30);
  const z = FC.core.zLevels(P().kitchen.dims);

  { // клик — выделение блока 1 (нижний шкаф)
    const pl = placedLower();
    const [cx, cy] = mmToClient(pl[1].x + pl[1].w / 2, z.zLower + 300);
    ptEv("pointerdown", at(cx, cy), cx, cy);
    ptEv("pointerup", svg, cx, cy);
    await sleep(30);
    eq(FC.getSel(), { row: "lower", idx: 1 }, "UI: клик выделяет блок");
  }

  { // перетаскивание: блок 0 (ящики) вправо за центр блока 1
    const pl = placedLower();
    const dragged = lowerBlocks()[0];
    const [x1, y1] = mmToClient(pl[0].x + pl[0].w / 2, z.zLower + 300);
    const [x2, y2] = mmToClient(pl[1].x + pl[1].w * 0.9, z.zLower + 300);
    await dragFront(x1, y1, x2, y2);
    eq(lowerBlocks()[1].type, dragged.type, "UI: drag переставляет блок (0 -> 1)");
    // вернуть обратно
    const plb = placedLower();
    const [bx1, by1] = mmToClient(plb[1].x + plb[1].w / 2, z.zLower + 300);
    const [bx2, by2] = mmToClient(plb[0].x + 30, z.zLower + 300);
    await dragFront(bx1, by1, bx2, by2);
    eq(lowerBlocks()[0].type, dragged.type, "UI: drag возвращает блок (1 -> 0)");
  }

  { // ресайз за правую ручку
    FC.setSel({ row: "lower", idx: 1 });
    await sleep(30);
    const handle = svg.querySelector("[data-handle]");
    ok(handle, "UI: у выделенного блока есть ручка ресайза");
    if (handle) {
      const hb = handle.getBoundingClientRect();
      const hx = hb.left + hb.width / 2, hy = hb.top + hb.height / 2;
      ptEv("pointerdown", handle, hx, hy);
      for (let i = 1; i <= 6; i++) ptEv("pointermove", svg, hx + i * 20, hy);
      ptEv("pointerup", svg, hx + 120, hy);
      await sleep(30);
      const w = lowerBlocks()[1].width;
      ok(w !== 600 && w >= FC.core.MIN_WIDTH && w % 1 === 0, "UI: ресайз меняет ширину", "ширина " + w);
      lowerBlocks()[1].width = 600; FC.commit();  // вернуть
    }
  }

  { // перетаскивание из палитры в середину нижнего ряда
    const before = lowerBlocks().length;
    const btn = document.querySelector('[data-add="lower:cabinet"]');
    const bb = btn.getBoundingClientRect();
    const pl = placedLower();
    const [tx, ty] = mmToClient(pl[1].x + 20, z.zLower + 300);
    ptEv("pointerdown", btn, bb.left + 5, bb.top + 5);
    for (let i = 1; i <= 6; i++) {
      const x = bb.left + (tx - bb.left) * i / 6, y = bb.top + (ty - bb.top) * i / 6;
      document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 7, clientX: x, clientY: y, buttons: 1 }));
    }
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 7, clientX: tx, clientY: ty }));
    await sleep(30);
    eq(lowerBlocks().length, before + 1, "UI: dnd из палитры добавляет блок");
    eq(lowerBlocks()[1].type, "cabinet", "UI: dnd из палитры — в нужную позицию");
  }

  { // удаление перетаскиванием за пределы вида
    const before = lowerBlocks().length;
    const pl = placedLower();
    const [x1, y1] = mmToClient(pl[1].x + pl[1].w / 2, z.zLower + 300);
    const box = svg.getBoundingClientRect();
    await dragFront(x1, y1, x1, box.top - 60);
    eq(lowerBlocks().length, before - 1, "UI: drag за пределы удаляет блок");
  }

  { // undo / redo
    const n = lowerBlocks().length;
    FC.undo(); await sleep(30);
    eq(lowerBlocks().length, n + 1, "UI: undo возвращает блок");
    FC.redo(); await sleep(30);
    eq(lowerBlocks().length, n, "UI: redo повторяет удаление");
  }

  { // двойной клик — точный ввод ширины
    const pl = placedLower();
    const [cx, cy] = mmToClient(pl[1].x + pl[1].w / 2, z.zLower + 300);
    at(cx, cy).dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: cx, clientY: cy }));
    await sleep(30);
    const inp = document.querySelector(".inline-edit");
    ok(inp, "UI: dblclick открывает поле ширины");
    if (inp) {
      inp.value = "450";
      inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await sleep(30);
      eq(lowerBlocks()[1].width, 450, "UI: инлайн-ввод применяет ширину");
      FC.undo();
    }
  }

  { // валидация: перелив за комнату виден в статусе
    const before = lowerBlocks()[0].width;
    lowerBlocks()[0].width = 9000; FC.commit(); await sleep(30);
    ok(document.getElementById("sbWarn").textContent.length > 0, "UI: предупреждение о переполнении");
    lowerBlocks()[0].width = before; FC.commit();
  }

  { // чекбокс «Убрать стены и пол»
    const cb = document.querySelector('[data-k="room.noShell"]');
    ok(cb, "UI: чекбокс «Убрать стены и пол» существует");
    cb.checked = true;
    cb.dispatchEvent(new Event("change"));
    await sleep(20);
    ok(P().room.noShell === true, "UI: чекбокс пишет room.noShell в проект");
    ok(FC.serialize().includes('"noShell": true'), "serialize: noShell попадает в project.json");
    cb.checked = false;
    cb.dispatchEvent(new Event("change"));
    await sleep(20);
  }

  { // сериализация формата
    const s = FC.serialize();
    ok(s.includes('"formatVersion": 2') && s.includes('"blocks"'), "serialize: валидный project.json");
  }

  document.title = fail === 0 ? `TESTS OK ${pass}` : `TESTS FAIL ${fail}/${pass + fail}`;
  log.push(`\nИТОГО: ${pass} ок, ${fail} провалено`);
  out.textContent = log.join("\n");
}

const start = () => run().catch(e => {
  report(false, "КРИТИЧЕСКАЯ ОШИБКА", e.stack || e.message);
  document.title = "TESTS FAIL crash";
});
if (window.FC && FC.ready()) start();
else document.addEventListener("fc-ready", start);
})();
