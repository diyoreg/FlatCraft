/* FlatCraft Bridge - file-based command bridge for driving 3ds Max
   from outside (Claude Code / web editor).

   How it works:
     - polls   bridge/inbox/   for *.ms and *.py files every 400 ms
     - a file is executed only when its size is UNCHANGED between two
       consecutive ticks (protects against reading half-written files)
     - executes the file, writes result to bridge/outbox/<name>.txt
     - deletes the inbox file after execution
     - heartbeat: bridge/alive.txt is refreshed every ~2 seconds

   Start:  Scripting > Run Script > FC_Bridge.ms  (or drag into viewport)
   Stop:   run  FC_BridgeStop()  in the MAXScript Listener.
   ASCII only in this file. */

global FC_BridgeDir
global FC_BridgeTimer
global FC_BridgeTickCount = 0
global FC_BridgePrev = #()   -- #(#(path, size), ...) seen on previous tick
global FC_BridgeStop
global FC_BridgeWriteText
global FC_BridgeProcess
global FC_BridgeTick

try (FC_BridgeTimer.Stop()) catch()

FC_BridgeDir = getFilenamePath (getSourceFileName())
makeDir (FC_BridgeDir + "inbox") all:true
makeDir (FC_BridgeDir + "outbox") all:true

fn FC_BridgeWriteText fname txt = (
    try (
        local ss = createFile fname
        format "%" txt to:ss
        close ss
    ) catch()
)

fn FC_BridgeProcess = (
    local files = (getFiles (FC_BridgeDir + "inbox\\*.ms")) + (getFiles (FC_BridgeDir + "inbox\\*.py"))
    local ready = #()
    local nextPrev = #()
    for f in files do (
        local sz = -1
        try (sz = getFileSize f) catch()
        local prevSz = undefined
        for pr in FC_BridgePrev where pr[1] == f do prevSz = pr[2]
        if prevSz != undefined and prevSz == sz and sz > 0 then append ready f
        else append nextPrev #(f, sz)   -- first sighting or still growing
    )
    FC_BridgePrev = nextPrev
    for f in ready do (
        local res = ""
        try (
            if (toLower (getFilenameType f)) == ".py" then (
                python.ExecuteFile f
                res = "OK\n(python file executed; its own prints go to the Listener)"
            ) else (
                local r = fileIn f
                res = "OK\n" + (r as string)
            )
        ) catch (
            res = "ERROR\n" + (getCurrentException())
        )
        FC_BridgeWriteText (FC_BridgeDir + "outbox\\" + (getFilenameFile f) + ".txt") res
        try (deleteFile f) catch()
    )
)

fn FC_BridgeTick s e = (
    FC_BridgeTickCount += 1
    FC_BridgeProcess()
    if (mod FC_BridgeTickCount 5) == 0 do
        FC_BridgeWriteText (FC_BridgeDir + "alive.txt") (localTime as string)
)

fn FC_BridgeStop = (
    try (FC_BridgeTimer.Stop()) catch()
    format "FlatCraft Bridge stopped.\n"
)

FC_BridgeTimer = dotNetObject "System.Windows.Forms.Timer"
FC_BridgeTimer.Interval = 400
dotNet.addEventHandler FC_BridgeTimer "Tick" FC_BridgeTick
FC_BridgeTimer.Start()
format "FlatCraft Bridge is running. Inbox: %inbox\\  Stop: FC_BridgeStop()\n" FC_BridgeDir
