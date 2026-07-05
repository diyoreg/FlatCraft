# -*- coding: utf-8 -*-
"""
FlatCraft — управление сценами: у каждого проекта свой .max файл.

build_project(slug) делает сборку проекта в ЕГО собственной сцене
projects/<slug>/<slug>.max, чтобы параллельные кухни не затирали друг друга:

1. Если сейчас открыта сцена другого проекта FlatCraft — она сохраняется
   (ручные правки, вставленная техника и т.п. не теряются).
2. Если открыта посторонняя сцена с несохранёнными изменениями и в ней есть
   не-FC_ объекты — сборка прерывается с понятной ошибкой (ничего не трогаем).
3. Открывается (или создаётся) сцена проекта, выполняется сборка,
   сцена сохраняется. Заголовок 3ds Max = имя проекта.
"""
import os

from pymxs import runtime as rt

import fc_builder


def _root():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _scene_path(root, slug):
    return os.path.join(root, "projects", slug, slug + ".max")


def _current_file():
    name = str(rt.maxFileName or "")
    if not name:
        return ""
    return os.path.join(str(rt.maxFilePath or ""), name)


def _only_fc_objects():
    """True, если в сцене нет ничего, кроме объектов сборщика (FC_*)."""
    for o in rt.objects:
        if not str(o.name).startswith(fc_builder.PREFIX):
            return False
    return True


def build_project(slug):
    root = _root()
    target = _scene_path(root, slug)
    project_json = os.path.join(root, "projects", slug, "project.json")
    if not os.path.exists(project_json):
        raise RuntimeError("не найден " + project_json)

    cur = _current_file()
    projects_prefix = os.path.normcase(os.path.join(root, "projects")) + os.sep

    if os.path.normcase(cur) != os.path.normcase(target):
        if cur and os.path.normcase(cur).startswith(projects_prefix):
            # открыт другой проект FlatCraft — сохранить его состояние
            rt.saveMaxFile(cur)
        elif rt.getSaveRequired() and not _only_fc_objects():
            raise RuntimeError(
                "в 3ds Max открыта несохранённая посторонняя сцена — "
                "сохраните или закройте её и повторите сборку")
        if os.path.exists(target):
            if not rt.loadMaxFile(target, quiet=True):
                raise RuntimeError("не удалось открыть сцену " + target)
        else:
            rt.resetMaxFile(rt.Name("noPrompt"))

    n = fc_builder.build_from_file(project_json)

    if not rt.saveMaxFile(target):
        raise RuntimeError("не удалось сохранить сцену " + target)
    return n
