/*============================================================================
    FlatCraft v1.0 - Kitchen Auto-Assembly Script for 3ds Max + Corona

    Automated kitchen interior generation from parameters.
    Generates room geometry, cabinet facades, countertops, backsplash,
    appliance placement, and Corona materials.

    Usage: Run this script in 3ds Max (MAXScript > Run Script)
============================================================================*/

-- Cleanup previous instances
try (destroyDialog FC_MainDialog) catch()
try (destroyDialog FC_ProjectDialog) catch()

/*============================================================================
    SECTION 1: STRUCT DEFINITIONS
============================================================================*/

struct FC_Opening (
    openingType = 1,        -- 1=window, 2=door
    wall = 1,               -- 1=south, 2=east, 3=north, 4=west
    posFromLeft = 1000.0,
    openingWidth = 1200.0,
    openingHeight = 1500.0,
    fromFloor = 800.0
)

struct FC_Element (
    elType = 1,             -- 1=facade, 2=drawers, 3=appliance, 4=tall_column
    elWidth = 600.0,
    numDrawers = 3,
    appCategory = "",
    appModel = "",
    -- Tall column niche
    nicheFromFloor = 100.0, -- niche bottom (from floor)
    nicheHeight = 1800.0    -- niche height
)

struct FC_ProjectData (
    projectName = "New Kitchen",
    projectPath = "",

    -- Room
    roomLength = 4000.0,
    roomWidth = 3000.0,
    roomHeight = 2700.0,
    wallThickness = 400.0,
    openings = #(),

    -- Layout
    layoutType = 1,         -- 1=linear, 2=L, 3=U, 4=island
    primaryWall = 1,        -- 1=south, 2=east, 3=north, 4=west

    -- Lower elements sequence
    lowerElements = #(),

    -- Lower cabinet dims
    lowerHeight = 720.0,
    lowerDepth = 600.0,

    -- Upper cabinets
    upperEnabled = true,
    upperHeight = 720.0,
    upperDepth = 350.0,
    upperDoorCount = 5,
    hoodSlot = 2,           -- which upper slot replaced by hood (0=none)

    -- Antresol
    antresolEnabled = false,
    antresolHeight = 360.0,

    -- Open shelves
    shelvesEnabled = false,
    shelvesSide = 1,        -- 1=right, 2=left, 3=both
    shelvesWidth = 300.0,

    -- Dimensions
    backsplashGap = 600.0,
    countertopThickness = 40.0,
    countertopOverhang = 40.0,
    plinthHeight = 100.0,
    plinthRecess = 50.0,
    facadeThickness = 16.0,
    facadeGap = 4.0,
    shadowGapEnabled = true,
    shadowGapHeight = 4.0,

    -- Colors (HEX)
    lowerFacadeColor = "C8B9A6",
    upperFacadeColor = "E8E0D4",
    antresolColor = "8B7D6B",
    countertopColor = "FFFFFF",
    countertopTexture = "",
    backsplashColor = "FFFFFF",
    backsplashTexture = "",
    plinthColor = "1A1A1A",
    shadowGapColor = "1A1A1A",
    shelvesFrameColor = "1A1A1A",
    wallColor = "E8E4DF",
    floorColor = "D4C9B8",
    floorTexture = "",
    ceilingColor = "FFFFFF"
)

/*============================================================================
    SECTION 2: GLOBAL VARIABLES
============================================================================*/

global FC_ScriptDir = "D:\\FlatCraft\\"
global FC_ModelsDir = FC_ScriptDir + "models\\"
global FC_TexturesDir = FC_ScriptDir + "textures\\"
global FC_ProjectsDir = FC_ScriptDir + "projects\\"
global FC_Data = FC_ProjectData()

/*============================================================================
    SECTION 3: UTILITY FUNCTIONS
============================================================================*/

fn FC_HexToColor hexStr = (
    if hexStr == undefined or hexStr == "" do return (color 200 200 200)
    local s = trimLeft hexStr "#"
    if s.count < 6 do return (color 200 200 200)
    local r = bit.hexAsInt (substring s 1 2)
    local g = bit.hexAsInt (substring s 3 2)
    local b = bit.hexAsInt (substring s 5 2)
    color r g b
)

fn FC_ColorToHex c = (
    local rr = bit.intAsHex (c.r as integer)
    local gg = bit.intAsHex (c.g as integer)
    local bb = bit.intAsHex (c.b as integer)
    if rr.count < 2 do rr = "0" + rr
    if gg.count < 2 do gg = "0" + gg
    if bb.count < 2 do bb = "0" + bb
    (toUpper (rr + gg + bb))
)

fn FC_GetModelCategories = (
    local cats = #()
    local dirs = getDirectories (FC_ModelsDir + "*")
    for d in dirs do (
        local parts = filterString d "\\"
        if parts.count > 0 do append cats parts[parts.count]
    )
    sort cats
    cats
)

fn FC_GetModelsInCategory cat = (
    local models = #()
    local catDir = FC_ModelsDir + cat + "\\"
    local dirs = getDirectories (catDir + "*")
    for d in dirs do (
        local parts = filterString d "\\"
        if parts.count > 0 do append models parts[parts.count]
    )
    sort models
    models
)

fn FC_FindMaxFile folderPath = (
    local files = getFiles (folderPath + "\\*.max")
    if files.count > 0 then files[1] else ""
)

fn FC_DeleteGenerated = (
    local toDelete = for o in objects where (matchPattern o.name pattern:"FC_*") collect o
    if toDelete.count > 0 do (
        delete toDelete
        gc()
    )
)

fn FC_WallNames = #("Южная", "Восточная", "Северная", "Западная")

fn FC_ElementLabel el = (
    local t = case el.elType of (
        1: "Фасад"
        2: ("Ящики x" + el.numDrawers as string)
        3: ("Техника: " + el.appCategory)
        4: ("Пенал: " + el.appCategory)
        default: "?"
    )
    t + " [" + (el.elWidth as integer) as string + "мм]"
)

fn FC_OpeningLabel op = (
    local t = if op.openingType == 1 then "Окно" else "Дверь"
    local w = (FC_WallNames())[op.wall]
    t + " | " + w + " | " + (op.openingWidth as integer) as string + "x" + (op.openingHeight as integer) as string + "мм"
)

/*============================================================================
    SECTION 4: PROJECT MANAGEMENT
============================================================================*/

fn FC_EnsureDir path = (
    makeDir path all:true
)

fn FC_GetProjectList = (
    FC_EnsureDir FC_ProjectsDir
    local projects = #()
    local dirs = getDirectories (FC_ProjectsDir + "*")
    for d in dirs do (
        local configFile = d + "config.ini"
        if doesFileExist configFile do (
            local parts = filterString d "\\"
            if parts.count > 0 do append projects parts[parts.count]
        )
    )
    sort projects
    projects
)

fn FC_SaveProject = (
    local projDir = FC_ProjectsDir + FC_Data.projectName + "\\"
    FC_EnsureDir projDir
    local f = projDir + "config.ini"
    local d = FC_Data

    -- Room
    setINISetting f "Room" "length" (d.roomLength as string)
    setINISetting f "Room" "width" (d.roomWidth as string)
    setINISetting f "Room" "height" (d.roomHeight as string)
    setINISetting f "Room" "wallThickness" (d.wallThickness as string)

    -- Layout
    setINISetting f "Layout" "type" (d.layoutType as string)
    setINISetting f "Layout" "primaryWall" (d.primaryWall as string)

    -- Lower
    setINISetting f "Lower" "height" (d.lowerHeight as string)
    setINISetting f "Lower" "depth" (d.lowerDepth as string)

    -- Upper
    setINISetting f "Upper" "enabled" (d.upperEnabled as string)
    setINISetting f "Upper" "height" (d.upperHeight as string)
    setINISetting f "Upper" "depth" (d.upperDepth as string)
    setINISetting f "Upper" "doorCount" (d.upperDoorCount as string)
    setINISetting f "Upper" "hoodSlot" (d.hoodSlot as string)

    -- Antresol
    setINISetting f "Antresol" "enabled" (d.antresolEnabled as string)
    setINISetting f "Antresol" "height" (d.antresolHeight as string)

    -- Shelves
    setINISetting f "Shelves" "enabled" (d.shelvesEnabled as string)
    setINISetting f "Shelves" "side" (d.shelvesSide as string)
    setINISetting f "Shelves" "width" (d.shelvesWidth as string)

    -- Dimensions
    setINISetting f "Dims" "countertopThickness" (d.countertopThickness as string)
    setINISetting f "Dims" "countertopOverhang" (d.countertopOverhang as string)
    setINISetting f "Dims" "plinthHeight" (d.plinthHeight as string)
    setINISetting f "Dims" "plinthRecess" (d.plinthRecess as string)
    setINISetting f "Dims" "facadeThickness" (d.facadeThickness as string)
    setINISetting f "Dims" "facadeGap" (d.facadeGap as string)
    setINISetting f "Dims" "shadowGapEnabled" (d.shadowGapEnabled as string)
    setINISetting f "Dims" "shadowGapHeight" (d.shadowGapHeight as string)

    -- Colors
    setINISetting f "Colors" "lowerFacade" d.lowerFacadeColor
    setINISetting f "Colors" "upperFacade" d.upperFacadeColor
    setINISetting f "Colors" "antresol" d.antresolColor
    setINISetting f "Colors" "countertop" d.countertopColor
    setINISetting f "Colors" "countertopTex" d.countertopTexture
    setINISetting f "Colors" "backsplash" d.backsplashColor
    setINISetting f "Colors" "backsplashTex" d.backsplashTexture
    setINISetting f "Colors" "plinth" d.plinthColor
    setINISetting f "Colors" "shadowGap" d.shadowGapColor
    setINISetting f "Colors" "shelvesFrame" d.shelvesFrameColor
    setINISetting f "Colors" "wall" d.wallColor
    setINISetting f "Colors" "floor" d.floorColor
    setINISetting f "Colors" "floorTex" d.floorTexture
    setINISetting f "Colors" "ceiling" d.ceilingColor

    -- Elements
    setINISetting f "Elements" "count" (d.lowerElements.count as string)
    for i = 1 to d.lowerElements.count do (
        local el = d.lowerElements[i]
        local p = "e" + (i as string) + "_"
        setINISetting f "Elements" (p + "type") (el.elType as string)
        setINISetting f "Elements" (p + "width") (el.elWidth as string)
        setINISetting f "Elements" (p + "drawers") (el.numDrawers as string)
        setINISetting f "Elements" (p + "appCat") el.appCategory
        setINISetting f "Elements" (p + "appModel") el.appModel
        setINISetting f "Elements" (p + "nicheFloor") (el.nicheFromFloor as string)
        setINISetting f "Elements" (p + "nicheH") (el.nicheHeight as string)
    )

    -- Openings
    setINISetting f "Openings" "count" (d.openings.count as string)
    for i = 1 to d.openings.count do (
        local op = d.openings[i]
        local p = "o" + (i as string) + "_"
        setINISetting f "Openings" (p + "type") (op.openingType as string)
        setINISetting f "Openings" (p + "wall") (op.wall as string)
        setINISetting f "Openings" (p + "pos") (op.posFromLeft as string)
        setINISetting f "Openings" (p + "width") (op.openingWidth as string)
        setINISetting f "Openings" (p + "height") (op.openingHeight as string)
        setINISetting f "Openings" (p + "floor") (op.fromFloor as string)
    )

    d.projectPath = projDir
    true
)

-- INI reading helpers
fn FC_rFloat file section key defVal = (
    local v = getINISetting file section key
    if v == "" then defVal else (try (v as float) catch defVal)
)
fn FC_rInt file section key defVal = (
    local v = getINISetting file section key
    if v == "" then defVal else (try (v as integer) catch defVal)
)
fn FC_rBool file section key defVal = (
    local v = getINISetting file section key
    if v == "" then defVal else (v == "true")
)
fn FC_rStr file section key defVal = (
    local v = getINISetting file section key
    if v == "" then defVal else v
)

fn FC_LoadProject projName = (
    local projDir = FC_ProjectsDir + projName + "\\"
    local f = projDir + "config.ini"
    if not (doesFileExist f) do return false

    local d = FC_ProjectData()
    d.projectName = projName
    d.projectPath = projDir

    -- Room
    d.roomLength = FC_rFloat f "Room" "length" 4000.0
    d.roomWidth = FC_rFloat f "Room" "width" 3000.0
    d.roomHeight = FC_rFloat f "Room" "height" 2700.0
    d.wallThickness = FC_rFloat f "Room" "wallThickness" 400.0

    -- Layout
    d.layoutType = FC_rInt f"Layout" "type" 1
    d.primaryWall = FC_rInt f"Layout" "primaryWall" 1

    -- Lower
    d.lowerHeight = FC_rFloat f"Lower" "height" 720.0
    d.lowerDepth = FC_rFloat f"Lower" "depth" 600.0

    -- Upper
    d.upperEnabled = FC_rBool f"Upper" "enabled" true
    d.upperHeight = FC_rFloat f"Upper" "height" 720.0
    d.upperDepth = FC_rFloat f"Upper" "depth" 350.0
    d.upperDoorCount = FC_rInt f"Upper" "doorCount" 5
    d.hoodSlot = FC_rInt f"Upper" "hoodSlot" 2

    -- Antresol
    d.antresolEnabled = FC_rBool f"Antresol" "enabled" false
    d.antresolHeight = FC_rFloat f"Antresol" "height" 360.0

    -- Shelves
    d.shelvesEnabled = FC_rBool f"Shelves" "enabled" false
    d.shelvesSide = FC_rInt f"Shelves" "side" 1
    d.shelvesWidth = FC_rFloat f"Shelves" "width" 300.0

    -- Dimensions
    d.countertopThickness = FC_rFloat f"Dims" "countertopThickness" 40.0
    d.countertopOverhang = FC_rFloat f"Dims" "countertopOverhang" 40.0
    d.plinthHeight = FC_rFloat f"Dims" "plinthHeight" 100.0
    d.plinthRecess = FC_rFloat f"Dims" "plinthRecess" 50.0
    d.facadeThickness = FC_rFloat f"Dims" "facadeThickness" 16.0
    d.facadeGap = FC_rFloat f"Dims" "facadeGap" 4.0
    d.shadowGapEnabled = FC_rBool f"Dims" "shadowGapEnabled" true
    d.shadowGapHeight = FC_rFloat f"Dims" "shadowGapHeight" 4.0

    -- Colors
    d.lowerFacadeColor = FC_rStr f"Colors" "lowerFacade" "C8B9A6"
    d.upperFacadeColor = FC_rStr f"Colors" "upperFacade" "E8E0D4"
    d.antresolColor = FC_rStr f"Colors" "antresol" "8B7D6B"
    d.countertopColor = FC_rStr f"Colors" "countertop" "FFFFFF"
    d.countertopTexture = FC_rStr f"Colors" "countertopTex" ""
    d.backsplashColor = FC_rStr f"Colors" "backsplash" "FFFFFF"
    d.backsplashTexture = FC_rStr f"Colors" "backsplashTex" ""
    d.plinthColor = FC_rStr f"Colors" "plinth" "1A1A1A"
    d.shadowGapColor = FC_rStr f"Colors" "shadowGap" "1A1A1A"
    d.shelvesFrameColor = FC_rStr f"Colors" "shelvesFrame" "1A1A1A"
    d.wallColor = FC_rStr f"Colors" "wall" "E8E4DF"
    d.floorColor = FC_rStr f"Colors" "floor" "D4C9B8"
    d.floorTexture = FC_rStr f"Colors" "floorTex" ""
    d.ceilingColor = FC_rStr f"Colors" "ceiling" "FFFFFF"

    -- Elements
    local elCount = FC_rInt f"Elements" "count" 0
    d.lowerElements = #()
    for i = 1 to elCount do (
        local p = "e" + (i as string) + "_"
        local el = FC_Element()
        el.elType = FC_rInt f"Elements" (p + "type") 1
        el.elWidth = FC_rFloat f"Elements" (p + "width") 600.0
        el.numDrawers = FC_rInt f"Elements" (p + "drawers") 3
        el.appCategory = FC_rStr f"Elements" (p + "appCat") ""
        el.appModel = FC_rStr f"Elements" (p + "appModel") ""
        el.nicheFromFloor = FC_rFloat f"Elements" (p + "nicheFloor") 100.0
        el.nicheHeight = FC_rFloat f"Elements" (p + "nicheH") 1800.0
        append d.lowerElements el
    )

    -- Openings
    local opCount = FC_rInt f"Openings" "count" 0
    d.openings = #()
    for i = 1 to opCount do (
        local p = "o" + (i as string) + "_"
        local op = FC_Opening()
        op.openingType = FC_rInt f"Openings" (p + "type") 1
        op.wall = FC_rInt f"Openings" (p + "wall") 1
        op.posFromLeft = FC_rFloat f"Openings" (p + "pos") 1000.0
        op.openingWidth = FC_rFloat f"Openings" (p + "width") 1200.0
        op.openingHeight = FC_rFloat f"Openings" (p + "height") 1500.0
        op.fromFloor = FC_rFloat f"Openings" (p + "floor") 800.0
        append d.openings op
    )

    FC_Data = d
    true
)

fn FC_DeleteProject projName = (
    local projDir = FC_ProjectsDir + projName + "\\"
    local configFile = projDir + "config.ini"
    if doesFileExist configFile do deleteFile configFile
    -- Try to remove empty directory
    try (DOSCommand ("rmdir \"" + projDir + "\"")) catch()
    true
)

fn FC_DuplicateProject srcName newName = (
    if FC_LoadProject srcName do (
        FC_Data.projectName = newName
        FC_SaveProject()
        true
    )
)

/*============================================================================
    SECTION 5: MATERIAL CREATION
============================================================================*/

fn FC_HasCorona = (
    try (
        local testMat = CoronaPhysicalMtl()
        true
    ) catch (
        false
    )
)

fn FC_CreateMaterial matName hexColor texturePath:"" roughness:0.3 = (
    local clr = FC_HexToColor hexColor

    if FC_HasCorona() then (
        local mat = CoronaPhysicalMtl()
        mat.name = matName
        mat.baseColor = clr
        mat.baseRoughness = roughness

        if texturePath != "" and texturePath != undefined and doesFileExist texturePath do (
            local bmp = Bitmaptexture filename:texturePath
            mat.baseTexmap = bmp
        )
        mat
    ) else (
        local mat = StandardMaterial()
        mat.name = matName
        mat.diffuse = clr
        mat.specularLevel = 30
        mat.glossiness = 40

        if texturePath != "" and texturePath != undefined and doesFileExist texturePath do (
            local bmp = Bitmaptexture filename:texturePath
            mat.diffuseMap = bmp
        )
        mat
    )
)

/*============================================================================
    SECTION 6: ROOM BUILDER
============================================================================*/

fn FC_BuildRoom = (
    local d = FC_Data
    local L = d.roomLength
    local W = d.roomWidth
    local H = d.roomHeight
    local T = d.wallThickness

    -- Collect openings per wall
    local wallOpenings = #(#(), #(), #(), #())
    for op in d.openings do (
        if op.wall >= 1 and op.wall <= 4 do
            append wallOpenings[op.wall] op
    )

    local pieces = #()
    local matWall = FC_CreateMaterial "FC_Mat_Wall" d.wallColor roughness:0.5
    local matFloor = FC_CreateMaterial "FC_Mat_Floor" d.floorColor texturePath:d.floorTexture roughness:0.4
    local matCeiling = FC_CreateMaterial "FC_Mat_Ceiling" d.ceilingColor roughness:0.5

    -- Floor
    local floor = Box width:L length:W height:20.0
    floor.name = "FC_Floor"
    floor.pos = [L/2.0, W/2.0, -20.0]
    floor.material = matFloor
    append pieces floor

    -- Ceiling
    local ceiling = Box width:L length:W height:20.0
    ceiling.name = "FC_Ceiling"
    ceiling.pos = [L/2.0, W/2.0, H]
    ceiling.material = matCeiling
    append pieces ceiling

    -- South wall (Y=0, runs along X)
    local southWall = Box width:L length:T height:H
    southWall.name = "FC_Wall_South"
    southWall.pos = [L/2.0, -T/2.0, 0]
    southWall.material = matWall
    if wallOpenings[1].count > 0 do (
        for op in wallOpenings[1] do (
            local cutter = Box width:op.openingWidth length:(T+20) height:op.openingHeight
            cutter.name = "FC_temp_cut"
            cutter.pos = [op.posFromLeft + op.openingWidth/2.0, -T/2.0, op.fromFloor]
            try (
                southWall = southWall - cutter
                southWall.name = "FC_Wall_South"
                southWall.material = matWall
            ) catch (delete cutter)
        )
    )
    append pieces southWall

    -- North wall (Y=W, runs along X)
    local northWall = Box width:L length:T height:H
    northWall.name = "FC_Wall_North"
    northWall.pos = [L/2.0, W + T/2.0, 0]
    northWall.material = matWall
    if wallOpenings[3].count > 0 do (
        for op in wallOpenings[3] do (
            local cutter = Box width:op.openingWidth length:(T+20) height:op.openingHeight
            cutter.name = "FC_temp_cut"
            cutter.pos = [L - op.posFromLeft - op.openingWidth/2.0, W + T/2.0, op.fromFloor]
            try (
                northWall = northWall - cutter
                northWall.name = "FC_Wall_North"
                northWall.material = matWall
            ) catch (delete cutter)
        )
    )
    append pieces northWall

    -- West wall (X=0, runs along Y)
    local westWall = Box width:T length:W height:H
    westWall.name = "FC_Wall_West"
    westWall.pos = [-T/2.0, W/2.0, 0]
    westWall.material = matWall
    if wallOpenings[4].count > 0 do (
        for op in wallOpenings[4] do (
            local cutter = Box width:(T+20) length:op.openingWidth height:op.openingHeight
            cutter.name = "FC_temp_cut"
            cutter.pos = [-T/2.0, W - op.posFromLeft - op.openingWidth/2.0, op.fromFloor]
            try (
                westWall = westWall - cutter
                westWall.name = "FC_Wall_West"
                westWall.material = matWall
            ) catch (delete cutter)
        )
    )
    append pieces westWall

    -- East wall (X=L, runs along Y)
    local eastWall = Box width:T length:W height:H
    eastWall.name = "FC_Wall_East"
    eastWall.pos = [L + T/2.0, W/2.0, 0]
    eastWall.material = matWall
    if wallOpenings[2].count > 0 do (
        for op in wallOpenings[2] do (
            local cutter = Box width:(T+20) length:op.openingWidth height:op.openingHeight
            cutter.name = "FC_temp_cut"
            cutter.pos = [L + T/2.0, op.posFromLeft + op.openingWidth/2.0, op.fromFloor]
            try (
                eastWall = eastWall - cutter
                eastWall.name = "FC_Wall_East"
                eastWall.material = matWall
            ) catch (delete cutter)
        )
    )
    append pieces eastWall

    pieces
)

/*============================================================================
    SECTION 7: KITCHEN GEOMETRY BUILDER
============================================================================*/

-- Merge a .max model file and return array of new objects
fn FC_MergeModel maxFilePath = (
    if not (doesFileExist maxFilePath) do return #()
    local oldObjs = objects as array
    mergeMAXFile maxFilePath #autoRenameDups #useMergedMtlDups quiet:true
    local newObjs = for o in objects where (findItem oldObjs o) == 0 collect o
    -- Prefix names
    for o in newObjs do o.name = "FC_" + o.name
    newObjs
)

-- Move a group of objects so their bounding box bottom-center is at targetPos
fn FC_PositionObjects objs targetPos = (
    if objs.count == 0 do return()
    local bbMin = objs[1].min
    local bbMax = objs[1].max
    for o in objs do (
        if o.min.x < bbMin.x do bbMin.x = o.min.x
        if o.min.y < bbMin.y do bbMin.y = o.min.y
        if o.min.z < bbMin.z do bbMin.z = o.min.z
        if o.max.x > bbMax.x do bbMax.x = o.max.x
        if o.max.y > bbMax.y do bbMax.y = o.max.y
        if o.max.z > bbMax.z do bbMax.z = o.max.z
    )
    local center = [(bbMin.x + bbMax.x) / 2.0, (bbMin.y + bbMax.y) / 2.0, bbMin.z]
    local offset = targetPos - center
    for o in objs do o.pos += offset
)

-- Main kitchen build function
fn FC_BuildKitchen = (
    local d = FC_Data
    local allPieces = #()

    -- Key heights
    local plH = d.plinthHeight                                      -- 100
    local sgH = if d.shadowGapEnabled then d.shadowGapHeight else 0 -- 4
    local lowTop = plH + d.lowerHeight                              -- 820
    local ctBot = lowTop + sgH                                      -- 824
    local ctTop = ctBot + d.countertopThickness                     -- 864
    local upBot = ctTop + 600.0                                     -- backsplash gap top = upper bottom
    -- Recalculate backsplash gap: it's the space between countertop top and upper bottom
    -- upBot = ctTop + backsplashGap would put upper cabinets where we want them
    -- But standard is: upper bottom = countertop top + backsplash gap
    -- Actually, total from floor to upper bottom should be ~1460
    -- Let's use the backsplash zone: from ctTop to upBot
    -- upBot is calculated so the backsplash height fills the gap
    local backsplashH = upBot - ctTop  -- should match FC_Data.backsplashGap... let me recalculate

    -- Recalculate upBot properly
    upBot = ctTop + d.backsplashGap -- distance from countertop to upper cabs (user-defined, default 600)
    -- Re-derive backsplash height for the geometry
    backsplashH = upBot - ctTop

    local upTop = upBot + d.upperHeight                             -- 2184

    -- Materials
    local matLower = FC_CreateMaterial "FC_Mat_LowerFacade" d.lowerFacadeColor roughness:0.25
    local matUpper = FC_CreateMaterial "FC_Mat_UpperFacade" d.upperFacadeColor roughness:0.25
    local matAntresol = FC_CreateMaterial "FC_Mat_Antresol" d.antresolColor roughness:0.25
    local matCountertop = FC_CreateMaterial "FC_Mat_Countertop" d.countertopColor texturePath:d.countertopTexture roughness:0.15
    local matBacksplash = FC_CreateMaterial "FC_Mat_Backsplash" d.backsplashColor texturePath:d.backsplashTexture roughness:0.15
    local matPlinth = FC_CreateMaterial "FC_Mat_Plinth" d.plinthColor roughness:0.4
    local matShadowGap = FC_CreateMaterial "FC_Mat_ShadowGap" d.shadowGapColor roughness:0.9
    local matShelvesFrame = FC_CreateMaterial "FC_Mat_ShelvesFrame" d.shelvesFrameColor roughness:0.3

    -- Calculate kitchen geometry based on wall
    -- For v1: kitchen always on south wall (Y=0), facing +Y, elements along +X
    -- TODO: add rotation for other walls

    local fT = d.facadeThickness   -- 16
    local fG = d.facadeGap         -- 4
    local lD = d.lowerDepth        -- 600
    local uD = d.upperDepth        -- 350

    -- Determine kitchen X range: separate tall columns from regular elements
    local regularStartX = 0.0    -- X where regular (non-column) cabinets start
    local regularEndX = 0.0      -- X where regular cabinets end
    local currentX = 0.0
    local totalWidth = 0.0

    -- First pass: calculate total width
    for el in d.lowerElements do (
        totalWidth += el.elWidth
        if el != d.lowerElements[d.lowerElements.count] do
            totalWidth += fG
    )

    -- Determine regular zone (where countertop goes) vs tall column zones
    local regularZones = #()  -- #([startX, endX], ...)
    local inRegular = false
    local regStart = 0.0
    currentX = 0.0

    for i = 1 to d.lowerElements.count do (
        local el = d.lowerElements[i]
        if el.elType == 4 then (
            -- Tall column: end current regular zone
            if inRegular do (
                append regularZones #(regStart, currentX - fG)
                inRegular = false
            )
        ) else (
            -- Regular element: start regular zone if not started
            if not inRegular do (
                regStart = currentX
                inRegular = true
            )
        )
        currentX += el.elWidth
        if i < d.lowerElements.count do currentX += fG
    )
    -- Close last regular zone
    if inRegular do append regularZones #(regStart, currentX)

    -- ========================
    -- LOWER ELEMENTS
    -- ========================
    currentX = 0.0
    local elementIdx = 0

    for i = 1 to d.lowerElements.count do (
        local el = d.lowerElements[i]
        elementIdx += 1

        case el.elType of (
            -- FACADE
            1: (
                local fw = el.elWidth
                local fh = d.lowerHeight
                local facade = Box width:fw length:fT height:fh
                facade.name = "FC_LF_" + (elementIdx as string)
                facade.pos = [currentX + fw/2.0, lD - fT/2.0, plH]
                facade.material = matLower
                append allPieces facade
            )

            -- DRAWERS
            2: (
                local dw = el.elWidth
                local numD = el.numDrawers
                local totalGaps = (numD - 1) * fG
                local drawerH = (d.lowerHeight - totalGaps) / numD

                for di = 1 to numD do (
                    local dz = plH + (di - 1) * (drawerH + fG)
                    local drawer = Box width:dw length:fT height:drawerH
                    drawer.name = "FC_LD_" + (elementIdx as string) + "_" + (di as string)
                    drawer.pos = [currentX + dw/2.0, lD - fT/2.0, dz]
                    drawer.material = matLower
                    append allPieces drawer
                )
            )

            -- APPLIANCE
            3: (
                -- Merge appliance model
                if el.appCategory != "" and el.appModel != "" do (
                    local modelDir = FC_ModelsDir + el.appCategory + "\\" + el.appModel + "\\"
                    local maxFile = FC_FindMaxFile modelDir
                    if maxFile != "" do (
                        local mergedObjs = FC_MergeModel maxFile
                        -- Position appliance: center X at element center, Y against wall, Z at floor
                        -- For countertop appliances (gas stove, sink): Z at countertop top
                        -- For under-counter appliances (dishwasher, washing machine, oven): Z at plinth height
                        local appZ = plH  -- default: on plinth level

                        -- Detect if it's a countertop appliance by category
                        local cat = toLower el.appCategory
                        if (findString cat "газ" != undefined) or
                           (findString cat "электро" != undefined) or
                           (findString cat "плит" != undefined) or
                           (findString cat "мойка" != undefined) do (
                            appZ = ctTop  -- place on countertop
                        )

                        -- Hood goes on the wall above countertop
                        if (findString cat "вытяжк" != undefined) do (
                            appZ = upBot - 200  -- approximate: near upper cabinet bottom
                        )

                        FC_PositionObjects mergedObjs [currentX + el.elWidth/2.0, lD/2.0, appZ]
                        for o in mergedObjs do append allPieces o
                    )
                )
            )

            -- TALL COLUMN
            4: (
                local cW = el.elWidth
                local nicheBot = el.nicheFromFloor
                local nicheTop = nicheBot + el.nicheHeight
                local colTop = d.roomHeight - 20  -- near ceiling

                -- Bottom facade (below niche)
                if nicheBot > plH do (
                    local bH = nicheBot - plH
                    local bf = Box width:cW length:fT height:bH
                    bf.name = "FC_TC_Bot_" + (elementIdx as string)
                    bf.pos = [currentX + cW/2.0, lD - fT/2.0, plH]
                    bf.material = matLower
                    append allPieces bf
                )

                -- Top facade (above niche)
                if nicheTop < colTop do (
                    local tH = colTop - nicheTop
                    local tf = Box width:cW length:fT height:tH
                    tf.name = "FC_TC_Top_" + (elementIdx as string)
                    tf.pos = [currentX + cW/2.0, lD - fT/2.0, nicheTop]
                    tf.material = matAntresol
                    append allPieces tf
                )

                -- Side panels
                local sideT = fT
                local sideH = colTop - plH
                local leftSide = Box width:sideT length:lD height:sideH
                leftSide.name = "FC_TC_SL_" + (elementIdx as string)
                leftSide.pos = [currentX + sideT/2.0, lD/2.0, plH]
                leftSide.material = matLower
                append allPieces leftSide

                local rightSide = Box width:sideT length:lD height:sideH
                rightSide.name = "FC_TC_SR_" + (elementIdx as string)
                rightSide.pos = [currentX + cW - sideT/2.0, lD/2.0, plH]
                rightSide.material = matLower
                append allPieces rightSide

                -- Top panel of column
                local topPanel = Box width:cW length:lD height:fT
                topPanel.name = "FC_TC_TP_" + (elementIdx as string)
                topPanel.pos = [currentX + cW/2.0, lD/2.0, colTop]
                topPanel.material = matAntresol
                append allPieces topPanel

                -- Merge appliance into niche
                if el.appCategory != "" and el.appModel != "" do (
                    local modelDir = FC_ModelsDir + el.appCategory + "\\" + el.appModel + "\\"
                    local maxFile = FC_FindMaxFile modelDir
                    if maxFile != "" do (
                        local mergedObjs = FC_MergeModel maxFile
                        FC_PositionObjects mergedObjs [currentX + cW/2.0, lD/2.0, nicheBot]
                        for o in mergedObjs do append allPieces o
                    )
                )
            )
        ) -- end case

        currentX += el.elWidth
        if i < d.lowerElements.count do currentX += fG
    )

    -- ========================
    -- PLINTH, SHADOW GAP, COUNTERTOP, BACKSPLASH
    -- ========================
    -- These span regular zones (non-tall-column areas)

    for zone in regularZones do (
        local zStart = zone[1]
        local zEnd = zone[2]
        local zWidth = zEnd - zStart
        if zWidth <= 0 do continue

        local zCenterX = zStart + zWidth / 2.0

        -- Plinth
        local plinth = Box width:zWidth length:fT height:plH
        plinth.name = "FC_Plinth"
        plinth.pos = [zCenterX, lD - d.plinthRecess - fT/2.0, 0]
        plinth.material = matPlinth
        append allPieces plinth

        -- Shadow gap strip
        if d.shadowGapEnabled and sgH > 0 do (
            local sg = Box width:zWidth length:fT height:sgH
            sg.name = "FC_ShadowGap"
            sg.pos = [zCenterX, lD - fT/2.0, lowTop]
            sg.material = matShadowGap
            append allPieces sg
        )

        -- Countertop
        local ctDepth = lD + d.countertopOverhang
        local ct = Box width:(zWidth + d.countertopOverhang) length:ctDepth height:d.countertopThickness
        ct.name = "FC_Countertop"
        ct.pos = [zCenterX, ctDepth/2.0, ctBot]
        ct.material = matCountertop
        append allPieces ct

        -- Backsplash
        local bs = Box width:zWidth length:10.0 height:backsplashH
        bs.name = "FC_Backsplash"
        bs.pos = [zCenterX, 5.0, ctTop]
        bs.material = matBacksplash
        append allPieces bs
    )

    -- ========================
    -- UPPER CABINETS
    -- ========================
    if d.upperEnabled and regularZones.count > 0 do (
        for zone in regularZones do (
            local zStart = zone[1]
            local zEnd = zone[2]
            local zWidth = zEnd - zStart
            if zWidth <= 0 do continue

            local doorCount = d.upperDoorCount
            if doorCount < 1 do doorCount = 1

            local totalGaps = (doorCount - 1) * fG
            local doorW = (zWidth - totalGaps) / doorCount

            for di = 1 to doorCount do (
                local dx = zStart + (di - 1) * (doorW + fG)

                -- Check if this is the hood slot
                if di == d.hoodSlot then (
                    -- Don't create upper facade here, just merge hood if available
                    -- Hood is placed via the lower elements (appliance type)
                    -- Skip this slot for upper cabinet
                    continue
                )

                local uf = Box width:doorW length:fT height:d.upperHeight
                uf.name = "FC_UF_" + (di as string)
                uf.pos = [dx + doorW/2.0, uD - fT/2.0, upBot]
                uf.material = matUpper
                append allPieces uf
            )
        )
    )

    -- ========================
    -- ANTRESOL (above upper cabinets)
    -- ========================
    if d.antresolEnabled and d.upperEnabled and regularZones.count > 0 do (
        local antBot = upTop + fG
        local antH = d.antresolHeight

        for zone in regularZones do (
            local zStart = zone[1]
            local zEnd = zone[2]
            local zWidth = zEnd - zStart
            if zWidth <= 0 do continue

            -- Antresol as single facade panels (same count as upper or fewer)
            local antDoorCount = d.upperDoorCount
            if antDoorCount < 1 do antDoorCount = 1
            local totalGaps = (antDoorCount - 1) * fG
            local antDoorW = (zWidth - totalGaps) / antDoorCount

            for di = 1 to antDoorCount do (
                local dx = zStart + (di - 1) * (antDoorW + fG)
                local af = Box width:antDoorW length:fT height:antH
                af.name = "FC_AF_" + (di as string)
                af.pos = [dx + antDoorW/2.0, uD - fT/2.0, antBot]
                af.material = matAntresol
                append allPieces af
            )
        )
    )

    -- ========================
    -- OPEN SHELVES
    -- ========================
    if d.shelvesEnabled do (
        local shW = d.shelvesWidth
        local frameT = 20.0        -- frame metal thickness
        local shelfT = fT          -- shelf thickness
        local shDepth = uD          -- same depth as upper cabinets
        local shTotalH = upTop - plH  -- from plinth to upper cabinet top
        if d.antresolEnabled do shTotalH = (upTop + fG + d.antresolHeight) - plH

        -- Calculate shelf count based on height
        local shelfSpacing = 300.0
        local shelfCount = (shTotalH / shelfSpacing) as integer
        if shelfCount < 2 do shelfCount = 2
        local actualSpacing = shTotalH / (shelfCount as float)

        -- Place shelves based on side setting
        local shelfSides = #()
        if d.shelvesSide == 1 or d.shelvesSide == 3 do append shelfSides #(totalWidth, "R")
        if d.shelvesSide == 2 or d.shelvesSide == 3 do append shelfSides #(-shW - fG, "L")

        for shSide in shelfSides do (
            local sStartX = shSide[1]
            local sSide = shSide[2]

            -- Vertical frame pieces
            local vLeft = Box width:frameT length:frameT height:shTotalH
            vLeft.name = "FC_Shelf_VL_" + sSide
            vLeft.pos = [sStartX, shDepth/2.0, plH]
            vLeft.material = matShelvesFrame
            append allPieces vLeft

            local vRight = Box width:frameT length:frameT height:shTotalH
            vRight.name = "FC_Shelf_VR_" + sSide
            vRight.pos = [sStartX + shW, shDepth/2.0, plH]
            vRight.material = matShelvesFrame
            append allPieces vRight

            -- Horizontal shelves
            for si = 0 to shelfCount do (
                local sz = plH + si * actualSpacing
                local shelf = Box width:shW length:shDepth height:shelfT
                shelf.name = "FC_Shelf_H_" + sSide + "_" + (si as string)
                shelf.pos = [sStartX + shW/2.0, shDepth/2.0, sz]
                shelf.material = matLower
                append allPieces shelf
            )

            -- Back frame verticals
            local backLeft = Box width:frameT length:frameT height:shTotalH
            backLeft.name = "FC_Shelf_BL_" + sSide
            backLeft.pos = [sStartX, frameT/2.0, plH]
            backLeft.material = matShelvesFrame
            append allPieces backLeft

            local backRight = Box width:frameT length:frameT height:shTotalH
            backRight.name = "FC_Shelf_BR_" + sSide
            backRight.pos = [sStartX + shW, frameT/2.0, plH]
            backRight.material = matShelvesFrame
            append allPieces backRight
        )
    )

    allPieces
)

/*============================================================================
    SECTION 8: MAIN BUILD FUNCTION
============================================================================*/

fn FC_Build = (
    -- Delete previously generated objects
    FC_DeleteGenerated()

    format "FlatCraft: Building kitchen...\n"

    -- Build room
    local roomPieces = FC_BuildRoom()
    format "  Room: % objects\n" roomPieces.count

    -- Build kitchen
    local kitchenPieces = FC_BuildKitchen()
    format "  Kitchen: % objects\n" kitchenPieces.count

    local totalCount = roomPieces.count + kitchenPieces.count
    format "FlatCraft: Done! Total objects: %\n" totalCount

    -- Zoom extents
    max zoomext sel all

    totalCount
)

/*============================================================================
    SECTION 9: UI ROLLOUTS (displayed inside tabbed main dialog)
============================================================================*/

-- ========================
-- ROLLOUT: PROJECT
-- ========================
rollout rcProject "Проект" width:800 (
    label lblProjName "" align:#left
    button btnSave "Сохранить" width:150 across:2 align:#left
    button btnSaveAs "Сохранить как..." width:150 align:#left

    on rcProject open do (
        lblProjName.text = "Проект: " + FC_Data.projectName
    )

    on btnSave pressed do (
        FC_SaveProject()
        messageBox "Проект сохранён!" title:"FlatCraft"
    )

    on btnSaveAs pressed do (
        local txt = getUserText "Сохранить как" "Название:" FC_Data.projectName
        if txt != undefined and txt != "" do (
            FC_Data.projectName = txt
            FC_SaveProject()
            lblProjName.text = "Проект: " + FC_Data.projectName
        )
    )
)

-- Helper for text input
global FC_InputResult = undefined
global FC_InputDefault = ""
fn getUserText ttl prompt defVal = (
    FC_InputResult = undefined
    FC_InputDefault = defVal
    try (destroyDialog FC_rlInput) catch()

    rollout FC_rlInput ttl width:300 (
        editText edtVal "" width:270
        button btnOK "OK" width:120 across:2
        button btnCancel "Отмена" width:120

        on FC_rlInput open do (
            edtVal.text = FC_InputDefault
        )
        on btnOK pressed do (
            FC_InputResult = edtVal.text
            destroyDialog FC_rlInput
        )
        on btnCancel pressed do (
            destroyDialog FC_rlInput
        )
    )
    createDialog FC_rlInput modal:true
    FC_InputResult
)

-- ========================
-- ROLLOUT: ROOM
-- ========================
rollout rcRoom "Комната" width:800 (
    group "Размеры" (
        spinner spnLength "Длина (мм):" range:[500,30000,4000] type:#integer fieldWidth:70 align:#right
        spinner spnWidth "Ширина (мм):" range:[500,30000,3000] type:#integer fieldWidth:70 align:#right
        spinner spnHeight "Высота (мм):" range:[2000,5000,2700] type:#integer fieldWidth:70 align:#right
        spinner spnWallT "Толщина стен:" range:[50,1000,400] type:#integer fieldWidth:70 align:#right
    )
    group "Проёмы (окна/двери)" (
        listbox lbxOpen "" height:3
        dropdownlist ddlOpType "Тип:" items:#("Окно", "Дверь") width:140 across:2 align:#left
        dropdownlist ddlOpWall "Стена:" items:#("Южная", "Восточная", "Северная", "Западная") width:140 align:#right
        spinner spnOpPos "От левого края (мм):" range:[0,30000,1000] type:#integer fieldWidth:60 align:#right
        spinner spnOpW "Ширина:" range:[100,5000,1200] type:#integer fieldWidth:60 across:2 align:#right
        spinner spnOpH "Высота:" range:[100,5000,1500] type:#integer fieldWidth:60 align:#right
        spinner spnOpFloor "От пола:" range:[0,5000,800] type:#integer fieldWidth:60 align:#right
        button btnOpAdd "Добавить" width:95 across:3
        button btnOpDel "Удалить" width:95
        button btnOpUpd "Обновить" width:95
    )

    fn refreshOpenings = (
        local items = #()
        for op in FC_Data.openings do append items (FC_OpeningLabel op)
        lbxOpen.items = items
    )

    on rcRoom open do (
        spnLength.value = FC_Data.roomLength
        spnWidth.value = FC_Data.roomWidth
        spnHeight.value = FC_Data.roomHeight
        spnWallT.value = FC_Data.wallThickness
        refreshOpenings()
    )

    on spnLength changed val do FC_Data.roomLength = val
    on spnWidth changed val do FC_Data.roomWidth = val
    on spnHeight changed val do FC_Data.roomHeight = val
    on spnWallT changed val do FC_Data.wallThickness = val

    on btnOpAdd pressed do (
        local op = FC_Opening openingType:ddlOpType.selection wall:ddlOpWall.selection \
            posFromLeft:spnOpPos.value openingWidth:spnOpW.value \
            openingHeight:spnOpH.value fromFloor:spnOpFloor.value
        append FC_Data.openings op
        refreshOpenings()
    )

    on btnOpDel pressed do (
        local sel = lbxOpen.selection
        if sel > 0 and sel <= FC_Data.openings.count do (
            deleteItem FC_Data.openings sel
            refreshOpenings()
        )
    )

    on btnOpUpd pressed do (
        local sel = lbxOpen.selection
        if sel > 0 and sel <= FC_Data.openings.count do (
            local op = FC_Data.openings[sel]
            op.openingType = ddlOpType.selection
            op.wall = ddlOpWall.selection
            op.posFromLeft = spnOpPos.value
            op.openingWidth = spnOpW.value
            op.openingHeight = spnOpH.value
            op.fromFloor = spnOpFloor.value
            refreshOpenings()
        )
    )

    on lbxOpen selected sel do (
        if sel > 0 and sel <= FC_Data.openings.count do (
            local op = FC_Data.openings[sel]
            ddlOpType.selection = op.openingType
            ddlOpWall.selection = op.wall
            spnOpPos.value = op.posFromLeft
            spnOpW.value = op.openingWidth
            spnOpH.value = op.openingHeight
            spnOpFloor.value = op.fromFloor
        )
    )
)

-- ========================
-- ROLLOUT: KITCHEN LAYOUT
-- ========================
rollout rcLayout "Раскладка" width:800 (
    dropdownlist ddlLayout "Тип раскладки:" items:#("Линейная", "Г-образная (скоро)", "П-образная (скоро)", "Остров (скоро)") width:300
    dropdownlist ddlWall "Стена кухни:" items:#("Южная (Y=0)", "Восточная (скоро)", "Северная (скоро)", "Западная (скоро)") width:300

    group "Элементы (слева направо)" (
        listbox lbxElem "" height:6
        label lblTotal "Общая ширина: 0 мм" align:#left
        dropdownlist ddlElType "Тип:" items:#("Фасад", "Ящики", "Техника", "Пенал") width:300
        spinner spnElW "Ширина (мм):" range:[100,3000,600] type:#integer fieldWidth:70 align:#right
        spinner spnDrawN "Кол-во ящиков:" range:[2,8,3] type:#integer fieldWidth:70 align:#right enabled:false
        dropdownlist ddlAppCat "Категория техники:" items:#() width:300 enabled:false
        dropdownlist ddlAppModel "Модель:" items:#() width:300 enabled:false
        spinner spnNicheFloor "Ниша от пола:" range:[0,3000,100] type:#integer fieldWidth:70 align:#right enabled:false visible:false
        spinner spnNicheH "Высота ниши:" range:[100,3000,1800] type:#integer fieldWidth:70 align:#right enabled:false visible:false

        button btnElAdd "Добавить" width:80 across:5
        button btnElDel "Удалить" width:80
        button btnElUp "Вверх" width:55
        button btnElDn "Вниз" width:55
        button btnElUpd "Изм." width:55
    )

    local categories = #()

    fn refreshElements = (
        local items = #()
        local total = 0.0
        for el in FC_Data.lowerElements do (
            append items (FC_ElementLabel el)
            total += el.elWidth
        )
        if FC_Data.lowerElements.count > 1 do
            total += (FC_Data.lowerElements.count - 1) * FC_Data.facadeGap
        lbxElem.items = items
        lblTotal.text = "Общая ширина: " + (total as integer) as string + " мм (+ зазоры)"
    )

    fn updateTypeUI = (
        local t = ddlElType.selection
        spnDrawN.enabled = (t == 2)
        ddlAppCat.enabled = (t == 3 or t == 4)
        ddlAppModel.enabled = (t == 3 or t == 4)
        spnNicheFloor.visible = (t == 4)
        spnNicheH.visible = (t == 4)
        spnNicheFloor.enabled = (t == 4)
        spnNicheH.enabled = (t == 4)
    )

    on rcLayout open do (
        ddlLayout.selection = FC_Data.layoutType
        ddlWall.selection = FC_Data.primaryWall
        categories = FC_GetModelCategories()
        ddlAppCat.items = categories
        refreshElements()
        updateTypeUI()
    )

    on ddlLayout selected sel do FC_Data.layoutType = sel
    on ddlWall selected sel do FC_Data.primaryWall = sel

    on ddlElType selected sel do updateTypeUI()

    on ddlAppCat selected sel do (
        if sel > 0 and sel <= categories.count do (
            local models = FC_GetModelsInCategory categories[sel]
            ddlAppModel.items = models
        )
    )

    on btnElAdd pressed do (
        local el = FC_Element()
        el.elType = ddlElType.selection
        el.elWidth = spnElW.value
        el.numDrawers = spnDrawN.value
        if (el.elType == 3 or el.elType == 4) and ddlAppCat.selection > 0 do (
            el.appCategory = categories[ddlAppCat.selection]
            if ddlAppModel.selection > 0 and ddlAppModel.items.count > 0 do
                el.appModel = ddlAppModel.items[ddlAppModel.selection]
        )
        if el.elType == 4 do (
            el.nicheFromFloor = spnNicheFloor.value
            el.nicheHeight = spnNicheH.value
        )
        append FC_Data.lowerElements el
        refreshElements()
    )

    on btnElDel pressed do (
        local sel = lbxElem.selection
        if sel > 0 and sel <= FC_Data.lowerElements.count do (
            deleteItem FC_Data.lowerElements sel
            refreshElements()
        )
    )

    on btnElUp pressed do (
        local sel = lbxElem.selection
        if sel > 1 do (
            local temp = FC_Data.lowerElements[sel]
            FC_Data.lowerElements[sel] = FC_Data.lowerElements[sel-1]
            FC_Data.lowerElements[sel-1] = temp
            refreshElements()
            lbxElem.selection = sel - 1
        )
    )

    on btnElDn pressed do (
        local sel = lbxElem.selection
        if sel > 0 and sel < FC_Data.lowerElements.count do (
            local temp = FC_Data.lowerElements[sel]
            FC_Data.lowerElements[sel] = FC_Data.lowerElements[sel+1]
            FC_Data.lowerElements[sel+1] = temp
            refreshElements()
            lbxElem.selection = sel + 1
        )
    )

    on btnElUpd pressed do (
        local sel = lbxElem.selection
        if sel > 0 and sel <= FC_Data.lowerElements.count do (
            local el = FC_Data.lowerElements[sel]
            el.elType = ddlElType.selection
            el.elWidth = spnElW.value
            el.numDrawers = spnDrawN.value
            if (el.elType == 3 or el.elType == 4) and ddlAppCat.selection > 0 do (
                el.appCategory = categories[ddlAppCat.selection]
                if ddlAppModel.selection > 0 and ddlAppModel.items.count > 0 do
                    el.appModel = ddlAppModel.items[ddlAppModel.selection]
            )
            if el.elType == 4 do (
                el.nicheFromFloor = spnNicheFloor.value
                el.nicheHeight = spnNicheH.value
            )
            refreshElements()
        )
    )

    on lbxElem selected sel do (
        if sel > 0 and sel <= FC_Data.lowerElements.count do (
            local el = FC_Data.lowerElements[sel]
            ddlElType.selection = el.elType
            spnElW.value = el.elWidth
            spnDrawN.value = el.numDrawers
            updateTypeUI()
            if el.appCategory != "" do (
                local catIdx = findItem categories el.appCategory
                if catIdx > 0 do (
                    ddlAppCat.selection = catIdx
                    local models = FC_GetModelsInCategory el.appCategory
                    ddlAppModel.items = models
                    local modIdx = findItem models el.appModel
                    if modIdx > 0 do ddlAppModel.selection = modIdx
                )
            )
            if el.elType == 4 do (
                spnNicheFloor.value = el.nicheFromFloor
                spnNicheH.value = el.nicheHeight
            )
        )
    )
)

-- ========================
-- ROLLOUT: UPPER CABINETS
-- ========================
rollout rcUpper "Верхние шкафы" width:800 (
    checkbox chkUpper "Включить верхние шкафы" checked:true
    spinner spnUpH "Высота (мм):" range:[200,1500,720] type:#integer fieldWidth:70 align:#right
    spinner spnUpD "Глубина (мм):" range:[100,600,350] type:#integer fieldWidth:70 align:#right
    spinner spnUpCount "Кол-во дверей:" range:[1,20,5] type:#integer fieldWidth:70 align:#right
    spinner spnHoodSlot "Слот вытяжки (0=нет):" range:[0,20,2] type:#integer fieldWidth:70 align:#right

    on rcUpper open do (
        chkUpper.checked = FC_Data.upperEnabled
        spnUpH.value = FC_Data.upperHeight
        spnUpD.value = FC_Data.upperDepth
        spnUpCount.value = FC_Data.upperDoorCount
        spnHoodSlot.value = FC_Data.hoodSlot
    )

    on chkUpper changed val do FC_Data.upperEnabled = val
    on spnUpH changed val do FC_Data.upperHeight = val
    on spnUpD changed val do FC_Data.upperDepth = val
    on spnUpCount changed val do FC_Data.upperDoorCount = val
    on spnHoodSlot changed val do FC_Data.hoodSlot = val
)

-- ========================
-- ROLLOUT: OPTIONS
-- ========================
rollout rcOptions "Опции" width:800 (
    group "Антресоль" (
        checkbox chkAnt "Включить антресоль" checked:false
        spinner spnAntH "Высота (мм):" range:[100,800,360] type:#integer fieldWidth:70 align:#right
    )
    group "Открытые полки" (
        checkbox chkShelves "Включить открытые полки" checked:false
        dropdownlist ddlShSide "Сторона:" items:#("Справа", "Слева", "С обеих сторон") width:200
        spinner spnShW "Ширина (мм):" range:[100,600,300] type:#integer fieldWidth:70 align:#right
    )
    group "Теневой зазор" (
        checkbox chkShadow "Включить теневой зазор" checked:true
        spinner spnShadowH "Высота (мм):" range:[1,20,4] type:#integer fieldWidth:70 align:#right
    )

    on rcOptions open do (
        chkAnt.checked = FC_Data.antresolEnabled
        spnAntH.value = FC_Data.antresolHeight
        chkShelves.checked = FC_Data.shelvesEnabled
        ddlShSide.selection = FC_Data.shelvesSide
        spnShW.value = FC_Data.shelvesWidth
        chkShadow.checked = FC_Data.shadowGapEnabled
        spnShadowH.value = FC_Data.shadowGapHeight
    )

    on chkAnt changed val do FC_Data.antresolEnabled = val
    on spnAntH changed val do FC_Data.antresolHeight = val
    on chkShelves changed val do FC_Data.shelvesEnabled = val
    on ddlShSide selected val do FC_Data.shelvesSide = val
    on spnShW changed val do FC_Data.shelvesWidth = val
    on chkShadow changed val do FC_Data.shadowGapEnabled = val
    on spnShadowH changed val do FC_Data.shadowGapHeight = val
)

-- ========================
-- ROLLOUT: DIMENSIONS
-- ========================
rollout rcDimensions "Размеры" width:800 (
    spinner spnLowH "Высота нижних шкафов:" range:[400,1000,720] type:#integer fieldWidth:70 align:#right
    spinner spnLowD "Глубина нижних шкафов:" range:[300,800,600] type:#integer fieldWidth:70 align:#right
    spinner spnCtT "Толщина столешницы:" range:[10,100,40] type:#integer fieldWidth:70 align:#right
    spinner spnCtO "Вылет столешницы:" range:[0,100,40] type:#integer fieldWidth:70 align:#right
    spinner spnBsG "Высота фартука (зазор):" range:[300,1000,600] type:#integer fieldWidth:70 align:#right
    spinner spnPlH "Высота цоколя:" range:[50,200,100] type:#integer fieldWidth:70 align:#right
    spinner spnPlR "Отступ цоколя:" range:[0,100,50] type:#integer fieldWidth:70 align:#right
    spinner spnFaT "Толщина фасада:" range:[8,30,16] type:#integer fieldWidth:70 align:#right
    spinner spnFaG "Зазор между фасадами:" range:[1,10,4] type:#integer fieldWidth:70 align:#right

    on rcDimensions open do (
        spnLowH.value = FC_Data.lowerHeight
        spnLowD.value = FC_Data.lowerDepth
        spnCtT.value = FC_Data.countertopThickness
        spnCtO.value = FC_Data.countertopOverhang
        spnBsG.value = FC_Data.backsplashGap
        spnPlH.value = FC_Data.plinthHeight
        spnPlR.value = FC_Data.plinthRecess
        spnFaT.value = FC_Data.facadeThickness
        spnFaG.value = FC_Data.facadeGap
    )

    on spnLowH changed val do FC_Data.lowerHeight = val
    on spnLowD changed val do FC_Data.lowerDepth = val
    on spnCtT changed val do FC_Data.countertopThickness = val
    on spnCtO changed val do FC_Data.countertopOverhang = val
    on spnBsG changed val do FC_Data.backsplashGap = val
    on spnPlH changed val do FC_Data.plinthHeight = val
    on spnPlR changed val do FC_Data.plinthRecess = val
    on spnFaT changed val do FC_Data.facadeThickness = val
    on spnFaG changed val do FC_Data.facadeGap = val
)

-- ========================
-- ROLLOUT: COLORS & MATERIALS
-- ========================
rollout rcColors "Цвета и материалы" width:800 (
    group "Фасады" (
        editText edtLowerCol "Нижние фасады (HEX):" text:"C8B9A6" fieldWidth:80 align:#right
        editText edtUpperCol "Верхние фасады (HEX):" text:"E8E0D4" fieldWidth:80 align:#right
        editText edtAntCol "Антресоль (HEX):" text:"8B7D6B" fieldWidth:80 align:#right
    )
    group "Столешница" (
        editText edtCtCol "Цвет (HEX):" text:"FFFFFF" fieldWidth:80 align:#right
        editText edtCtTex "Текстура:" text:"" fieldWidth:200 align:#right
        button btnCtBrowse "Обзор..." width:80 align:#right
    )
    group "Фартук" (
        editText edtBsCol "Цвет (HEX):" text:"FFFFFF" fieldWidth:80 align:#right
        editText edtBsTex "Текстура:" text:"" fieldWidth:200 align:#right
        button btnBsBrowse "Обзор..." width:80 align:#right
    )
    group "Прочее" (
        editText edtPlCol "Цоколь (HEX):" text:"1A1A1A" fieldWidth:80 align:#right
        editText edtSgCol "Теневой зазор (HEX):" text:"1A1A1A" fieldWidth:80 align:#right
        editText edtShCol "Каркас полок (HEX):" text:"1A1A1A" fieldWidth:80 align:#right
        editText edtWallCol "Стены (HEX):" text:"E8E4DF" fieldWidth:80 align:#right
        editText edtFloorCol "Пол (HEX):" text:"D4C9B8" fieldWidth:80 align:#right
        editText edtCeilCol "Потолок (HEX):" text:"FFFFFF" fieldWidth:80 align:#right
    )

    on rcColors open do (
        edtLowerCol.text = FC_Data.lowerFacadeColor
        edtUpperCol.text = FC_Data.upperFacadeColor
        edtAntCol.text = FC_Data.antresolColor
        edtCtCol.text = FC_Data.countertopColor
        edtCtTex.text = FC_Data.countertopTexture
        edtBsCol.text = FC_Data.backsplashColor
        edtBsTex.text = FC_Data.backsplashTexture
        edtPlCol.text = FC_Data.plinthColor
        edtSgCol.text = FC_Data.shadowGapColor
        edtShCol.text = FC_Data.shelvesFrameColor
        edtWallCol.text = FC_Data.wallColor
        edtFloorCol.text = FC_Data.floorColor
        edtCeilCol.text = FC_Data.ceilingColor
    )

    on edtLowerCol changed val do FC_Data.lowerFacadeColor = val
    on edtUpperCol changed val do FC_Data.upperFacadeColor = val
    on edtAntCol changed val do FC_Data.antresolColor = val
    on edtCtCol changed val do FC_Data.countertopColor = val
    on edtCtTex changed val do FC_Data.countertopTexture = val
    on edtBsCol changed val do FC_Data.backsplashColor = val
    on edtBsTex changed val do FC_Data.backsplashTexture = val
    on edtPlCol changed val do FC_Data.plinthColor = val
    on edtSgCol changed val do FC_Data.shadowGapColor = val
    on edtShCol changed val do FC_Data.shelvesFrameColor = val
    on edtWallCol changed val do FC_Data.wallColor = val
    on edtFloorCol changed val do FC_Data.floorColor = val
    on edtCeilCol changed val do FC_Data.ceilingColor = val

    on btnCtBrowse pressed do (
        local f = getOpenFileName caption:"Выбрать текстуру столешницы" types:"Image Files|*.jpg;*.png;*.bmp;*.tif|All|*.*"
        if f != undefined do (
            edtCtTex.text = f
            FC_Data.countertopTexture = f
        )
    )

    on btnBsBrowse pressed do (
        local f = getOpenFileName caption:"Выбрать текстуру фартука" types:"Image Files|*.jpg;*.png;*.bmp;*.tif|All|*.*"
        if f != undefined do (
            edtBsTex.text = f
            FC_Data.backsplashTexture = f
        )
    )
)

-- ========================
-- ROLLOUT: BUILD
-- ========================
rollout rcBuild "Сборка" width:800 (
    button btnBuild "СОБРАТЬ КУХНЮ" width:300 height:40
    button btnDelete "Удалить сгенерированное" width:300 height:25
    label lblStatus "" align:#left

    on btnBuild pressed do (
        lblStatus.text = "Сборка..."
        local count = FC_Build()
        lblStatus.text = "Готово! Создано объектов: " + (count as string)
    )

    on btnDelete pressed do (
        FC_DeleteGenerated()
        lblStatus.text = "Все FC объекты удалены."
    )
)

/*============================================================================
    SECTION 10: MAIN TABBED DIALOG
============================================================================*/

global FC_AllTabs = #(rcProject, rcRoom, rcLayout, rcUpper, rcOptions, rcDimensions, rcColors, rcBuild)
global FC_TabNames = #("Проект", "Комната", "Раскладка", "Верхние", "Опции", "Размеры", "Цвета", "СБОРКА")
global FC_ActiveTab = 0

rollout FC_MainDialog "FlatCraft v1.0" width:860 height:640 (
    -- Tab buttons across the top
    button btnT1 "Проект"    pos:[5,5]   width:105 height:30
    button btnT2 "Комната"   pos:[112,5] width:105 height:30
    button btnT3 "Раскладка" pos:[219,5] width:105 height:30
    button btnT4 "Верхние"   pos:[326,5] width:105 height:30
    button btnT5 "Опции"     pos:[433,5] width:105 height:30
    button btnT6 "Размеры"   pos:[540,5] width:105 height:30
    button btnT7 "Цвета"     pos:[647,5] width:105 height:30
    button btnT8 "СБОРКА"    pos:[754,5] width:100 height:30

    subRollout subPanel "" pos:[5,40] width:850 height:590

    fn switchTab idx = (
        if idx == FC_ActiveTab do return()
        -- Remove current rollout
        if FC_ActiveTab > 0 and FC_ActiveTab <= FC_AllTabs.count do (
            try (removeSubRollout subPanel FC_AllTabs[FC_ActiveTab]) catch()
        )
        -- Add new rollout
        if idx > 0 and idx <= FC_AllTabs.count do (
            addSubRollout subPanel FC_AllTabs[idx]
        )
        -- Update button captions to highlight active
        local btns = #(btnT1, btnT2, btnT3, btnT4, btnT5, btnT6, btnT7, btnT8)
        for i = 1 to btns.count do (
            if i == idx then
                btns[i].caption = "> " + FC_TabNames[i] + " <"
            else
                btns[i].caption = FC_TabNames[i]
        )
        FC_ActiveTab = idx
    )

    on FC_MainDialog open do switchTab 1
    on btnT1 pressed do switchTab 1
    on btnT2 pressed do switchTab 2
    on btnT3 pressed do switchTab 3
    on btnT4 pressed do switchTab 4
    on btnT5 pressed do switchTab 5
    on btnT6 pressed do switchTab 6
    on btnT7 pressed do switchTab 7
    on btnT8 pressed do switchTab 8
)

/*============================================================================
    SECTION 11: PROJECT SELECTOR DIALOG
============================================================================*/

rollout FC_ProjectDialog "FlatCraft - Проекты" width:400 height:450 (
    label lblTitle "FlatCraft v1.0" align:#center
    label lblSub "Автосборка кухни" align:#center
    listbox lbxProjects "Проекты:" height:12
    button btnNew "Новый проект" width:180 across:2
    button btnOpen "Открыть" width:180
    button btnDel "Удалить" width:180 across:2
    button btnDup "Дублировать" width:180

    fn refreshProjects = (
        lbxProjects.items = FC_GetProjectList()
    )

    fn openMainUI = (
        destroyDialog FC_ProjectDialog
        createDialog FC_MainDialog 860 640 style:#(#style_titlebar, #style_sysmenu, #style_resizing)
    )

    on FC_ProjectDialog open do (
        refreshProjects()
    )

    on btnNew pressed do (
        local name = getUserText "Новый проект" "Название:" "Кухня 1"
        if name != undefined and name != "" do (
            FC_Data = FC_ProjectData()
            FC_Data.projectName = name
            FC_SaveProject()
            openMainUI()
        )
    )

    on btnOpen pressed do (
        local sel = lbxProjects.selection
        if sel > 0 do (
            local projName = lbxProjects.items[sel]
            if FC_LoadProject projName do (
                openMainUI()
            )
        )
    )

    on btnDel pressed do (
        local sel = lbxProjects.selection
        if sel > 0 do (
            local projName = lbxProjects.items[sel]
            if queryBox ("Удалить проект '" + projName + "'?") title:"FlatCraft" do (
                FC_DeleteProject projName
                refreshProjects()
            )
        )
    )

    on btnDup pressed do (
        local sel = lbxProjects.selection
        if sel > 0 do (
            local srcName = lbxProjects.items[sel]
            local newName = getUserText "Дублировать проект" "Новое имя:" (srcName + " копия")
            if newName != undefined and newName != "" do (
                FC_DuplicateProject srcName newName
                refreshProjects()
            )
        )
    )
)

/*============================================================================
    SECTION 12: MAIN ENTRY POINT
============================================================================*/

-- Ensure projects directory exists
FC_EnsureDir FC_ProjectsDir

-- Launch project selector
createDialog FC_ProjectDialog 400 450
