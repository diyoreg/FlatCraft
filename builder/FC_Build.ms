/* FlatCraft v2 - run kitchen build from a project JSON file.
   Opens a file dialog, then builds the scene via builder/fc_builder.py.
   Requires 3ds Max 2021+ (Python 3). All sizes in millimeters.
   ASCII only in this file (no BOM issues). */
(
    local thisDir = getFilenamePath (getSourceFileName())
    local pyFile = thisDir + "fc_builder.py"
    if not (doesFileExist pyFile) then (
        messageBox ("fc_builder.py not found in:\n" + thisDir) title:"FlatCraft"
    ) else (
        local dirNoSlash = trimRight thisDir "\\/"
        python.Execute ("import sys\np = r'" + dirNoSlash + "'\nif p not in sys.path:\n    sys.path.insert(0, p)")
        python.Execute ("import importlib, fc_builder\nimportlib.reload(fc_builder)\nfc_builder.main()")
    )
)
