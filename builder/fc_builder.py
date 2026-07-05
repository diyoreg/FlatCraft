# -*- coding: utf-8 -*-
"""
FlatCraft v2 — сборщик кухни из project.json.

Строит комнату и кухню из простых блоков (полные корпуса шкафов),
без 3D-моделей техники: места под неё резервируются блоками type="gap".

Запуск в 3ds Max:
  - builder/FC_Build.ms — диалог выбора JSON и сборка;
  - или из Python: fc_builder.build_from_file(r"D:\FlatCraft\projects\sample\project.json")

Все размеры в миллиметрах (системные единицы сцены должны быть мм).
Все созданные объекты получают префикс "FC_" и складываются в слой "FlatCraft";
при повторной сборке старые FC_-объекты удаляются.
"""
import json

from pymxs import runtime as rt

PREFIX = "FC_"
LAYER_NAME = "FlatCraft"

DEFAULT_DIMS = {
    "plinthHeight": 100.0,        # высота цоколя
    "plinthRecess": 10.0,         # отступ цоколя от фронта (= толщина будущих фасадов)
    "lowerHeight": 720.0,         # высота нижних корпусов
    "lowerDepth": 600.0,          # глубина нижних корпусов
    "gap": 4.0,                   # зазор между блоками
    "shadowGap": 4.0,             # теневой зазор (пустота под столешницей)
    "countertopThickness": 40.0,
    "countertopOverhang": 40.0,   # вылет столешницы вперёд
    "backsplashGap": 600.0,       # высота фартука (столешница -> верхние)
    "backsplashThickness": 12.0,
    "upperHeight": 720.0,
    "upperDepth": 350.0,
    "antresolHeight": 360.0,
    "floorThickness": 100.0,
}

DEFAULT_COLORS = {
    "walls": "#EDEDED",
    "floor": "#B9975B",
    "lower": "#3A3F45",
    "upper": "#E9E4DA",
    "countertop": "#23262B",
    "plinth": "#1C1E22",
    "backsplash": "#CFC8BB",
}


def hex_to_color(hex_str):
    h = str(hex_str).lstrip("#")
    return rt.Color(int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def make_material(name, hex_str):
    """CoronaPhysicalMtl, если Corona установлена, иначе PhysicalMaterial."""
    color = hex_to_color(hex_str)
    try:
        mtl = rt.CoronaPhysicalMtl()
        mtl.baseColor = color
    except Exception:
        mtl = rt.PhysicalMaterial()
        mtl.base_color = color
    mtl.name = PREFIX + name
    return mtl


def _get_layer():
    layer = rt.LayerManager.getLayerFromName(LAYER_NAME)
    if layer is None:
        layer = rt.LayerManager.newLayerFromName(LAYER_NAME)
    return layer


def cleanup():
    """Удалить все объекты предыдущей сборки (по префиксу FC_)."""
    old = [o for o in rt.objects if str(o.name).startswith(PREFIX)]
    for o in old:
        rt.delete(o)
    return len(old)


class Builder(object):
    def __init__(self, project):
        self.p = project
        k = project.get("kitchen", {})
        self.dims = dict(DEFAULT_DIMS)
        self.dims.update(k.get("dims", {}))
        colors = dict(DEFAULT_COLORS)
        colors.update(k.get("colors", {}))
        self.mats = {key: make_material(key, val) for key, val in colors.items()}
        self.layer = _get_layer()
        self.count = 0

    def box(self, name, w, d, h, x, y, z, mat_key):
        """Бокс по мин-углу (x, y, z): ширина по X, глубина по Y, высота по Z."""
        b = rt.Box(width=float(w), length=float(d), height=float(h))
        b.name = "{}{}".format(PREFIX, name)
        b.position = rt.Point3(float(x) + w / 2.0, float(y) + d / 2.0, float(z))
        b.material = self.mats[mat_key]
        b.wirecolor = hex_to_color(dict(DEFAULT_COLORS, **self.p.get("kitchen", {}).get("colors", {})).get(mat_key, "#808080"))
        self.layer.addNode(b)
        self.count += 1
        return b

    # ------------------------------------------------------------------ room
    def build_room(self):
        room = self.p.get("room", {})
        if room.get("noShell"):
            return  # «Убрать стены и пол»: коробка комнаты не строится совсем
        L = float(room.get("length", 4000))
        W = float(room.get("width", 3000))
        H = float(room.get("height", 2700))
        t = float(room.get("wallThickness", 400))
        ft = self.dims["floorThickness"]

        self.box("Пол", L, W, ft, 0, 0, -ft, "floor")
        self.box("Стена_Юг", L + 2 * t, t, H, -t, -t, 0, "walls")
        self.box("Стена_Север", L + 2 * t, t, H, -t, W, 0, "walls")
        self.box("Стена_Запад", t, W, H, -t, 0, 0, "walls")
        self.box("Стена_Восток", t, W, H, L, 0, 0, "walls")
        if room.get("ceiling", False):
            self.box("Потолок", L, W, ft, 0, 0, H, "walls")

    # --------------------------------------------------------------- kitchen
    @staticmethod
    def _layout(blocks, gap, x0):
        """Раскладка блоков слева направо: [(block, x, width), ...]."""
        placed = []
        x = float(x0)
        for b in blocks:
            w = float(b.get("width", 600))
            placed.append((b, x, w))
            x += w + gap
        return placed

    @staticmethod
    def _runs(placed, pred):
        """Непрерывные отрезки (x1, x2) по подряд идущим блокам, где pred=True."""
        runs, start, end = [], None, None
        for b, x, w in placed:
            if pred(b):
                if start is None:
                    start = x
                end = x + w
            elif start is not None:
                runs.append((start, end))
                start = None
        if start is not None:
            runs.append((start, end))
        return runs

    SIDE_RU = {"south": "Юг", "west": "Запад", "east": "Восток"}

    def _sides(self):
        """Нормализация: и новый формат (kitchen.sides), и старый (lower/upper в корне)."""
        k = self.p.get("kitchen", {})
        sides = k.get("sides")
        if not sides:
            sides = {"south": {
                "offsetX": k.get("offsetX", 0),
                "lower": k.get("lower", {}),
                "upper": k.get("upper", {}),
            }}
        return sides

    def _map(self, side, x, y, w, d):
        """Локальные координаты стороны (x вдоль стены от угла, y — глубина
        от стены) -> мировой мин-угол и габариты по X/Y."""
        L = float(self.p.get("room", {}).get("length", 4000))
        if side == "west":
            return (y, x, d, w)
        if side == "east":
            return (L - y - d, x, d, w)
        return (x, y, w, d)

    def mbox(self, name, side, x, y, w, dd, h, z, mat_key):
        wx, wy, ww, wd = self._map(side, x, y, w, dd)
        self.box(name, ww, wd, h, wx, wy, z, mat_key)

    def build_kitchen(self):
        d = self.dims
        gap = d["gap"]

        z_lower = d["plinthHeight"]
        z_lower_top = z_lower + d["lowerHeight"]
        z_ct = z_lower_top + d["shadowGap"]          # теневой зазор = пустота
        z_ct_top = z_ct + d["countertopThickness"]
        z_upper = z_ct_top + d["backsplashGap"]
        z_upper_top = z_upper + d["upperHeight"]

        for side, cfg in self._sides().items():
            tag = self.SIDE_RU.get(side, side)
            offset = float(cfg.get("offsetX", 0))

            # --- нижний ряд ---------------------------------------------
            lower = self._layout(cfg.get("lower", {}).get("blocks", []), gap, offset)
            for i, (b, x, w) in enumerate(lower, 1):
                btype = b.get("type", "cabinet")
                if btype == "cabinet":
                    self.mbox("Низ_{}_{}_шкаф".format(tag, i), side, x, 0, w, d["lowerDepth"],
                              d["lowerHeight"], z_lower, "lower")
                elif btype == "drawers":
                    n = max(1, int(b.get("drawers", 3)))
                    dh = (d["lowerHeight"] - (n - 1) * gap) / n
                    for j in range(n):
                        self.mbox("Низ_{}_{}_ящик{}".format(tag, i, j + 1), side, x, 0, w,
                                  d["lowerDepth"], dh, z_lower + j * (dh + gap), "lower")
                elif btype == "tall":
                    self.mbox("Низ_{}_{}_пенал".format(tag, i), side, x, 0, w, d["lowerDepth"],
                              z_upper_top - z_lower, z_lower, "lower")
                elif btype == "gap":
                    pass  # проём под технику — пустое место
                else:
                    print("FlatCraft: неизвестный тип блока '{}' — пропущен".format(btype))

            # столешница и фартук: разрыв на пеналах и высоких проёмах
            def under_countertop(b):
                return b.get("type") in ("cabinet", "drawers") or (
                    b.get("type") == "gap" and not b.get("tall", False))

            for j, (x1, x2) in enumerate(self._runs(lower, under_countertop), 1):
                self.mbox("Столешница_{}_{}".format(tag, j), side, x1, 0, x2 - x1,
                          d["lowerDepth"] + d["countertopOverhang"],
                          d["countertopThickness"], z_ct, "countertop")
                self.mbox("Фартук_{}_{}".format(tag, j), side, x1, 0, x2 - x1,
                          d["backsplashThickness"], d["backsplashGap"], z_ct_top, "backsplash")

            # цоколь: разрыв только на высоких проёмах
            def has_plinth(b):
                return not (b.get("type") == "gap" and b.get("tall", False))

            for j, (x1, x2) in enumerate(self._runs(lower, has_plinth), 1):
                self.mbox("Цоколь_{}_{}".format(tag, j), side, x1, 0, x2 - x1,
                          d["lowerDepth"] - d["plinthRecess"], d["plinthHeight"], 0, "plinth")

            # --- верхний ряд ----------------------------------------------
            upper_cfg = cfg.get("upper", {})
            if upper_cfg.get("enabled", True) and upper_cfg.get("blocks"):
                upper = self._layout(upper_cfg["blocks"], gap, offset + float(upper_cfg.get("offsetX", 0)))
                for i, (b, x, w) in enumerate(upper, 1):
                    if b.get("type", "cabinet") == "cabinet":
                        self.mbox("Верх_{}_{}_шкаф".format(tag, i), side, x, 0, w,
                                  d["upperDepth"], d["upperHeight"], z_upper, "upper")
                    # type="gap" (напр. слот вытяжки) — пустое место

                if upper_cfg.get("antresol", False):
                    x1 = upper[0][1]
                    x2 = upper[-1][1] + upper[-1][2]
                    self.mbox("Антресоль_{}".format(tag), side, x1, 0, x2 - x1,
                              d["upperDepth"], d["antresolHeight"], z_upper_top + gap, "upper")


def _check_units():
    try:
        st = str(rt.units.SystemType)
        if "millimeter" not in st.lower():
            print("FlatCraft ВНИМАНИЕ: системные единицы сцены не миллиметры ({}). "
                  "Customize > Units Setup > System Unit Setup = 1 mm".format(st))
    except Exception:
        pass


def build(project):
    _check_units()
    removed = cleanup()
    b = Builder(project)
    b.build_room()
    b.build_kitchen()
    rt.redrawViews()
    print("FlatCraft: сборка '{}' готова — {} объектов создано, {} старых удалено".format(
        project.get("name", "без имени"), b.count, removed))
    return b.count


def build_from_file(path):
    with open(path, "r", encoding="utf-8-sig") as f:
        project = json.load(f)
    return build(project)


def main():
    path = rt.getOpenFileName(
        caption="FlatCraft: выберите файл проекта",
        types="Проект FlatCraft (*.json)|*.json|",
    )
    if path:
        build_from_file(path)
