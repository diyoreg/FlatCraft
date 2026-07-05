# -*- coding: utf-8 -*-
"""
FlatCraft — управление сценами: у каждого проекта свой .max файл
+ защита от случайной пересборки поверх ручных правок.

build_project(slug, force=False) -> ("ok", n) | ("confirm", описание)

Сцены: projects/<slug>/<slug>.max. При переключении текущая сцена-проект
автосохраняется; посторонняя несохранённая сцена прерывает сборку.

Защита: после каждой сборки в projects/<slug>/scene_state.json сохраняется
отпечаток сцены (имя, класс и трансформация каждого объекта). Перед следующей
сборкой отпечаток сравнивается с текущей сценой:
  - совпадает (в Max ничего не меняли)   -> сборка идёт молча;
  - отличается (ручные правки в Max)     -> возвращается ("confirm", детали),
    вызывающая сторона должна спросить пользователя и повторить с force=True.
"""
import hashlib
import json
import os

from pymxs import runtime as rt

import fc_builder

STATE_NAME = "scene_state.json"


def _root():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _scene_path(root, slug):
    return os.path.join(root, "projects", slug, slug + ".max")


def _state_path(root, slug):
    return os.path.join(root, "projects", slug, STATE_NAME)


def _current_file():
    name = str(rt.maxFileName or "")
    if not name:
        return ""
    return os.path.join(str(rt.maxFilePath or ""), name)


def _only_fc_objects():
    for o in rt.objects:
        if not str(o.name).startswith(fc_builder.PREFIX):
            return False
    return True


def _fingerprint_lines():
    """Отпечаток сцены: по строке на объект (имя | класс | трансформация)."""
    lines = []
    for o in rt.objects:
        try:
            lines.append("%s|%s|%s" % (o.name, rt.classOf(o), o.transform))
        except Exception:
            lines.append(str(o.name))
    lines.sort()
    return lines


def _load_state(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _save_state(path, lines):
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"lines": lines}, f, ensure_ascii=False)


def _diff_summary(old_lines, new_lines):
    """Человекочитаемое описание отличий сцены от последней сборки."""
    so, sn = set(old_lines), set(new_lines)
    name = lambda l: l.split("|")[0]
    added_names = set(name(l) for l in new_lines if l not in so)
    removed_names = set(name(l) for l in old_lines if l not in sn)
    moved = added_names & removed_names
    parts = []
    if added_names - moved:
        parts.append("добавлено объектов: %d" % len(added_names - moved))
    if removed_names - moved:
        parts.append("удалено объектов: %d" % len(removed_names - moved))
    if moved:
        parts.append("перемещено/изменено: %d" % len(moved))
    return ", ".join(parts) if parts else "изменения в сцене"


def build_project(slug, force=False):
    root = _root()
    target = _scene_path(root, slug)
    project_json = os.path.join(root, "projects", slug, "project.json")
    if not os.path.exists(project_json):
        raise RuntimeError("не найден " + project_json)

    cur = _current_file()
    projects_prefix = os.path.normcase(os.path.join(root, "projects")) + os.sep

    if os.path.normcase(cur) != os.path.normcase(target):
        if cur and os.path.normcase(cur).startswith(projects_prefix):
            rt.saveMaxFile(cur)  # другой проект FlatCraft — сохранить его состояние
        elif rt.getSaveRequired() and not _only_fc_objects():
            raise RuntimeError(
                "в 3ds Max открыта несохранённая посторонняя сцена — "
                "сохраните или закройте её и повторите сборку")
        if os.path.exists(target):
            if not rt.loadMaxFile(target, quiet=True):
                raise RuntimeError("не удалось открыть сцену " + target)
        else:
            rt.resetMaxFile(rt.Name("noPrompt"))

    # ---- защита от пересборки поверх ручных правок ----
    state_file = _state_path(root, slug)
    if not force:
        current = _fingerprint_lines()
        state = _load_state(state_file)
        if state is not None and isinstance(state.get("lines"), list):
            if state["lines"] != current:
                return ("confirm", _diff_summary(state["lines"], current))
        elif current and not _only_fc_objects():
            # отпечатка нет (сцена из старых версий), а ручные объекты есть
            return ("confirm", "нет данных о последней сборке, в сцене есть ручные объекты")

    n = fc_builder.build_from_file(project_json)

    if not rt.saveMaxFile(target):
        raise RuntimeError("не удалось сохранить сцену " + target)
    _save_state(state_file, _fingerprint_lines())
    return ("ok", n)
