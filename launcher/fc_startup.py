# -*- coding: utf-8 -*-
"""
FlatCraft — обработка отложенного запроса сборки при старте 3ds Max.

Браузер, не найдя живой мост, пишет bridge/launch_request.txt (slug проекта)
и открывает flatcraft:// — Windows запускает Max с FC_Startup.ms, который
вызывает этот скрипт. Здесь: прочитать запрос, собрать проект в его сцене,
записать результат туда же, куда пишет обычная веб-сборка.
"""
import os
import sys
import time
import traceback


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    req = os.path.join(root, "bridge", "launch_request.txt")
    if not os.path.exists(req):
        return

    fresh = time.time() - os.path.getmtime(req) < 600  # не старше 10 минут
    try:
        with open(req, encoding="utf-8-sig") as f:
            slug = f.read().strip().splitlines()[0].strip()
    finally:
        try:
            os.remove(req)
        except OSError:
            pass
    if not fresh or not slug:
        return

    out = os.path.join(root, "bridge", "outbox", "web_build_result.txt")
    try:
        bdir = os.path.join(root, "builder")
        if bdir not in sys.path:
            sys.path.insert(0, bdir)
        import fc_scene
        res = fc_scene.build_project(slug)
        with open(out, "w", encoding="utf-8") as f:
            if res[0] == "ok":
                f.write("OK %d" % res[1])
            else:
                # ручные правки в сцене: браузер спросит пользователя
                # и пришлёт повторную команду с force=True через мост
                f.write("CONFIRM\n" + res[1])
    except Exception:
        with open(out, "w", encoding="utf-8") as f:
            f.write("ERROR\n" + traceback.format_exc())


main()
