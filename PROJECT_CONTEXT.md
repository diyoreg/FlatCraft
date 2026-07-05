# FlatCraft - Kitchen Auto-Assembly Script

## About the Project
MAXScript for 3ds Max + Corona Renderer that automatically generates kitchen interiors from parameters.
User is an interior designer with 5 years of experience, working freelance.

## File Structure
```
D:\FlatCraft\
  FlatCraft.ms                    -- Main script (~1700 lines, UTF-8 with BOM)
  PROJECT_CONTEXT.md              -- This file
  models\                         -- 3D assets by category
    вытяжка\                      -- Kitchen hoods
    газовая и электроплита\       -- Gas/electric stoves
    дверная ручка\                -- Door handles (.obj/.fbx/.max)
    мойка кухонная\               -- Kitchen sinks
    пол\таркет\                   -- Floor (tarkett)
    посудомойка\                  -- Dishwashers
    стиральная машина\            -- Washing machines (2 models)
    холодильники\                 -- Refrigerators
  textures\
    текстура фартука и сталешнице\  -- Backsplash/countertop textures (3 sets)
  projects\                       -- Saved project configs (INI files)
  kitchen sample image hi tech\   -- Reference renders (~47 folders)
```

## How Models Are Organized
- Each category folder contains subfolders with individual models
- Each model subfolder has exactly 1 `.max` file (plus textures/maps)
- Models are positioned at origin (0,0,0) in millimeters
- Model names encode dimensions, e.g. "вытяжка чёрная 600 мм 1"

## Technical Decisions

### Core
- **Language**: MAXScript (single file `FlatCraft.ms`)
- **Encoding**: UTF-8 with BOM (required for Cyrillic UI in MAXScript)
- **Renderer**: Corona (CoronaPhysicalMtl), fallback to StandardMaterial
- **Units**: Millimeters
- **Colors**: User inputs HEX codes
- **UI Language**: Russian (Cyrillic)
- **Coordinate system**: Room interior from [0,0,0] to [roomLength, roomWidth, roomHeight]
- **Kitchen placement**: Currently south wall only (Y=0, facing +Y, elements along +X)

### UI Architecture
- **Project selector dialog** on startup (создать/открыть/удалить/дублировать)
- **Main dialog**: 860×640, tabbed interface with 8 tabs across top
  - Tabs: Проект | Комната | Раскладка | Верхние | Опции | Размеры | Цвета | СБОРКА
  - Content switches via SubRollout (add/remove rollouts)
  - Active tab highlighted with `> Name <` prefix
- **Text input helper**: Modal dialog with global `FC_InputResult` / `FC_InputDefault` (avoids MAXScript closure issues)
- All labels, buttons, messages, tooltips in Russian Cyrillic

### Project System
- Projects saved as INI files in `projects/<name>/config.ini`
- All parameters serialized: room dims, openings, elements, colors, dimensions
- Functions: FC_SaveProject, FC_LoadProject, FC_DeleteProject, FC_DuplicateProject

### Geometry Generation (what the script creates)
All generated objects named with `FC_` prefix (used for cleanup on rebuild).

**Room:**
- 4 walls (Box), floor, ceiling
- Wall openings via boolean subtraction (operator `-`)

**Kitchen elements (user defines sequence left-to-right):**
1. **Фасад** (elType=1) - Box: width × facadeThickness(16) × lowerHeight(720)
2. **Ящики** (elType=2) - N stacked Boxes with gaps
3. **Техника** (elType=3) - mergeMAXFile from models folder, positioned automatically
4. **Пенал** (elType=4) - Full-height facades with niche cutout for appliance

**Auto-generated:**
- Столешница (spans regular zones, with overhang)
- Фартук (thin panel against wall, between countertop and upper cabinets)
- Цоколь (recessed from facade front by 50mm)
- Теневой зазор (4mm dark strip between facades and countertop)
- Верхние фасады (auto-divided into N doors, one slot for hood)
- Антресоль (above upper cabinets, optional)
- Открытые полки with metal frame (optional, left/right/both sides)

### Standard Dimensions (defaults, user-adjustable)
| Parameter | Default | Description (RU) |
|-----------|---------|------------------|
| plinthHeight | 100мм | Высота цоколя (плинтуса) |
| plinthRecess | 50мм | Отступ цоколя от фасада |
| lowerHeight | 720мм | Высота нижних шкафов |
| lowerDepth | 600мм | Глубина нижних шкафов |
| facadeThickness | 16мм | Толщина фасада |
| facadeGap | 4мм | Зазор между фасадами |
| shadowGapHeight | 4мм | Теневой зазор (полоса между фасадом и столешницей) |
| countertopThickness | 40мм | Толщина столешницы |
| countertopOverhang | 40мм | Вылет столешницы |
| backsplashGap | 600мм | Высота фартука (зазор столешница → верхние шкафы) |
| upperHeight | 720мм | Высота верхних шкафов |
| upperDepth | 350мм | Глубина верхних шкафов |
| antresolHeight | 360мм | Высота антресоли |
| wallThickness | 400мм | Толщина стен |

### Height Stack (from floor, south wall kitchen)
```
Z=0          Пол
Z=100        Верх цоколя / низ нижних фасадов
Z=820        Верх нижних фасадов (100 + 720)
Z=824        Верх теневого зазора (820 + 4)
Z=864        Верх столешницы (824 + 40)
Z=1464       Низ верхних шкафов (864 + 600)
Z=2184       Верх верхних шкафов (1464 + 720)
Z=2188       Низ антресоли (2184 + 4 зазор)
Z=2548       Верх антресоли (2188 + 360)
Z=2700       Потолок
```

### Positioning Math (Box pivot = center of bottom face)
- **Facade**: pos = [startX + width/2, lowerDepth - thickness/2, plinthHeight]
- **Countertop**: pos = [centerX, totalDepth/2, countertopZ]
- **Backsplash**: pos = [centerX, 5, countertopTop]
- **Plinth**: pos = [centerX, lowerDepth - plinthRecess - thickness/2, 0]
- **Walls**: pos = [centerX, wallCenterY, 0]

### Appliance Positioning Logic
- Under-counter (посудомойка, стиральная машина): Z = plinthHeight
- Countertop (газовая плита, мойка): Z = countertopTop
- Hood (вытяжка): Z = upperCabinetBottom - 200 (approximate)
- Tall column (пенал): Z = nicheFromFloor (user-specified)

### Material Creation
```maxscript
-- Corona available:
CoronaPhysicalMtl(), baseColor, baseRoughness, baseTexmap

-- Fallback:
StandardMaterial(), diffuse, specularLevel, glossiness, diffuseMap
```

## Script Structure (sections in FlatCraft.ms)
1. **Section 1**: Struct definitions (FC_Opening, FC_Element, FC_ProjectData)
2. **Section 2**: Global variables (paths, FC_Data)
3. **Section 3**: Utility functions (HexToColor, model scanning, FC_WallNames, FC_ElementLabel, FC_OpeningLabel)
4. **Section 4**: Project management (save/load/delete/duplicate, INI helpers)
5. **Section 5**: Material creation (FC_HasCorona, FC_CreateMaterial)
6. **Section 6**: Room builder (FC_BuildRoom - walls, floor, ceiling, openings)
7. **Section 7**: Kitchen geometry builder (FC_BuildKitchen - all kitchen elements)
8. **Section 8**: Main build function (FC_Build - orchestrates room + kitchen)
9. **Section 9**: UI Rollouts (8 rollouts: rcProject, rcRoom, rcLayout, rcUpper, rcOptions, rcDimensions, rcColors, rcBuild)
10. **Section 10**: Main tabbed dialog (FC_MainDialog 860×640, SubRollout switching)
11. **Section 11**: Project selector dialog (FC_ProjectDialog 400×450)
12. **Section 12**: Entry point (ensure dirs, launch selector)

## Current Status (v1)

### Implemented
- [x] Project management (save/load/delete/duplicate via INI)
- [x] Room generation (4 walls, floor, ceiling)
- [x] Wall openings (windows/doors via boolean)
- [x] Linear kitchen layout (south wall)
- [x] Lower elements: фасад, ящики, техника, пенал
- [x] Upper cabinets (auto-divided, hood slot skip)
- [x] Countertop, backsplash, plinth, shadow gap
- [x] Antresol (optional)
- [x] Open shelves with metal frame (optional)
- [x] Asset merging (mergeMAXFile)
- [x] Corona material assignment with HEX colors
- [x] Texture support for countertop and backsplash
- [x] Full tabbed UI (860×640) with all parameters
- [x] Full Russian Cyrillic UI (all labels, buttons, messages, dropdown items)
- [x] UTF-8 with BOM encoding for Cyrillic support

### Not Yet Implemented (v2 roadmap)
- [ ] L-shaped, U-shaped, island layouts
- [ ] Kitchen on other walls (East, North, West) - needs rotation transform
- [ ] Framed/profiled facade geometry (neoclassic, classic styles)
- [ ] Handle placement (hi-tech with handles style)
- [ ] Wood texture on facades
- [ ] Floor model merging (tarkett asset)
- [ ] Духовка (oven) as separate category

### Known Issues / Bug Fixes Applied
1. MAXScript doesn't allow nested functions to access outer local variables - all nested fns were inlined or moved to global scope
2. Box pivot is at center of bottom face - Z positions fixed (was using height/2, corrected to 0)
3. `getUserText` helper uses global `FC_InputResult`/`FC_InputDefault` instead of closure
4. `default` is a reserved keyword in MAXScript - renamed parameter to `defVal`
5. Boolean subtraction for wall openings uses `-` operator with try/catch fallback
6. File must be saved as **UTF-8 with BOM** for Cyrillic to work in MAXScript

## User Preferences
- Tabbed horizontal UI (not vertical scrolling)
- Project system with save/load
- Russian Cyrillic interface
- Element sequence defined by user (not auto-arranged)
- Upper cabinet door count and widths calculated automatically
- Facade widths specified manually per element
- Lighting and cameras set manually by user (not generated)
- Style focus: hi-tech without handles (flat facades) for v1

## Sample Kitchen Reference
See `kitchen sample image hi tech/` folder - 47 projects showing:
- Hi-tech (flat facades, no handles) - most common
- Hi-tech with handles (bar handles)
- Neoclassic (framed facades with handles)
- Classic (ornate framed facades)
- Colors: typically 2-tone (light lower + dark upper, or reverse)
- Common elements: marble backsplash, black appliances (Bosch), tarkett floor, open shelves with black metal frame
