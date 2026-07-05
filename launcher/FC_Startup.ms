/* FlatCraft startup script.
   Passed to 3ds Max on launch:  3dsmax.exe -U MAXScript FC_Startup.ms
   - starts the file bridge (unless another Max instance already runs it)
   - performs a pending web build request, if any (bridge/launch_request.txt)
   ASCII only in this file. */
(
    local thisDir = getFilenamePath (getSourceFileName())          -- ...\launcher\
    local root = pathConfig.removePathLeaf (trimRight thisDir "\\/")
    local alivePath = root + "\\bridge\\alive.txt"

    -- if a fresh heartbeat exists, another Max instance is already serving
    local aliveFresh = false
    local ioFile = dotNetClass "System.IO.File"
    if ioFile.Exists alivePath then (
        local t = ioFile.GetLastWriteTime alivePath
        local now = (dotNetClass "System.DateTime").Now
        if (now.Subtract t).TotalSeconds < 5.0 then aliveFresh = true
    )
    if aliveFresh then (
        format "FlatCraft: bridge is already running in another 3ds Max instance - skipping.\n"
    ) else (
        fileIn (root + "\\bridge\\FC_Bridge.ms")
        python.ExecuteFile (thisDir + "fc_startup.py")
    )
)
