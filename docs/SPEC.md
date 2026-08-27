# GTA5mini — 技術規格

這份文件是**契約**。發包給 AI（或人）時，這裡定義的模組邊界、資料流與效能預算不得片面更動；
要改請先改這份文件，再改程式碼。

---

## 1. 目標與非目標

### 目標
- 瀏覽器內執行，**零安裝、零外部資產請求**（CSP 友善、可離線、可打包成單一 HTML）。
- 建立一條**現代化的 PBR + 後處理管線**，作為畫質天花板的實測基準。
- 提供**可自動驗證**的骨架，讓後續開發可以安全地發包給 AI agent。

### 非目標（明確不做）
- 開放世界串流。場景固定為單一封閉競技場，這是刻意的取捨（見 README）。
- 網路連線 / 多人。
- 載具、破壞、布娃娃物理。
- 任何需要下載執行檔的工作流程。

---

## 2. 執行環境契約

| 項目 | 要求 |
|---|---|
| 目標瀏覽器 | Chrome / Edge / Firefox / Safari 最新兩版 |
| 圖形 API | WebGL2（three.js `WebGLRenderer`）|
| 建置 | Vite 7，`npm run build` 產出 `dist/` 靜態檔 |
| 外部請求 | **零**。所有貼圖、HDRI、模型皆為程序生成或內嵌 |
| 相依 | `three` 為唯一 runtime 相依 |

> 「零外部請求」是硬性條件。任何 ticket 若需要外部資產，必須以 base64 / 程序生成內嵌，
> 或明確在 ticket 中申請解除此限制並說明理由。

---

## 3. 模組邊界

```
src/
├── main.js                 Game：組裝、固定步長迴圈、hitscan 派發
├── core/
│   ├── Renderer.js         WebGLRenderer + EffectComposer pass 順序 + 畫質預設
│   └── Input.js            鍵盤 / pointer-lock 滑鼠
├── world/
│   ├── Environment.js      Sky + PMREM IBL + 太陽 + 霧 + 時間預設
│   ├── Level.js            場景幾何 + AABB 碰撞盒 + 出生點
│   └── Textures.js         程序化 tileable PBR 貼圖生成
├── player/
│   ├── Player.js           FPS 控制器：移動、碰撞、鏡頭、後座
│   └── Weapon.js           視角模型、擊發時序、後座、槍口火光
├── entities/Enemies.js     敵人 blockout、hitbox、AI、死亡/重生
├── fx/Impacts.js           物件池：曳光彈、彈孔、火花、煙
├── ui/Hud.js               DOM HUD
└── shaders/GradeShader.js  後製調色 pass
```

**依賴方向是單向的**：`main.js` 認識所有模組；模組之間互不 import（`Player` 只透過建構子拿到 `level`）。
新增模組請維持這個形狀 —— 這是讓單一 ticket 可以獨立發包的前提。

---

## 4. 渲染管線（`core/Renderer.js`）

Pass 順序是這個專案的核心，**不得任意調換**：

| # | Pass | 色彩空間 | 為什麼在這個位置 |
|---|---|---|---|
| 1 | `RenderPass` | Linear HDR | 場景本身 |
| 2 | `GTAOPass` | Linear HDR | AO 必須作用在線性光照上 |
| 3 | `UnrealBloomPass` | Linear HDR | **必須在 tone mapping 之前**，否則亮部已被壓縮，bloom 會選錯像素 |
| 4 | `OutputPass` | HDR → sRGB | ACES tone mapping + 色彩空間轉換。HDR 到此結束 |
| 5 | `SMAAPass` | sRGB LDR | 對乾淨的 LDR 影像做抗鋸齒 |
| 6 | `GradePass` | sRGB LDR | 暈影 / 顆粒 / 色差 / 調色。顆粒必須在 AA 之後，否則會被抹平 |

### 畫質預設

| | Low | Medium | High |
|---|---|---|---|
| pixelRatio | 0.75 | 1.0 | min(DPR, 2) |
| shadow map | 1024 | 2048 | 4096 |
| GTAO | ✗ | ✓ | ✓ |
| Bloom | ✓ | ✓ | ✓ |
| SMAA | ✗ | ✓ | ✓ |

`renderer.info.autoReset = false`：composer 每幀發出多次 `render()`，開著 autoReset 會讓統計數字
只反映最後一個全螢幕 pass。任何新增 pass 的 ticket 都必須維持這個設定。

---

## 5. 效能預算

在 2020 年代中階獨顯 / Apple Silicon 內顯、1080p、High 畫質下：

| 指標 | 預算 | 實測（`npm run shots`）|
|---|---|---|
| Frame time | ≤ 16.6 ms (60 fps) | 真實 GPU 上待測 |
| Draw calls — Low | ≤ 260 | **227** |
| Draw calls — Medium | ≤ 520 | **~450** |
| Triangles | ≤ 400k | **16k (Low) / 32k (Medium)** |
| Shader programs | ≤ 45 | **38** |
| Geometries / Textures | — | **137 / 46** |
| 每幀 heap 配置 | **0** | `Impacts` 全部走物件池 |
| 啟動到可玩 | ≤ 3 s | 程序貼圖生成為主要成本 |

Medium 比 Low 多出的約 220 個 draw call 來自 GTAO 的 depth + normal prepass。
數字看起來大，但 WebGL2 的 draw call 成本要到數千才會成為瓶頸——這裡真正的
上限是 GTAO 與陰影的填充率，不是 CPU 送出的批次數。

**draw call 的最大單一來源目前是敵人**：8 個敵人 × 13 個 blockout 部件 = 104 個 mesh，
乘上主 pass / 陰影 / GTAO 三趟。合併方式見 `docs/TASKS.md` T-15。

**每幀零配置**是硬性要求。任何在 `update()` / `step()` 路徑上呼叫 `new` 的 PR 都應被退回
（`main.js` 的 hitscan 例外，該路徑只在擊發當幀執行）。

---

## 6. 座標與單位

- 單位為**公尺**。玩家站立高度 1.78 m，蹲下 1.08 m，碰撞半徑 0.36 m。
- Y 軸向上。`Player.position` 是**腳底**位置，不是眼睛位置。
- 重力 −22 m/s²（比真實的 −9.8 快，這是遊戲手感的標準作法，不是 bug）。
- 場地為 74 × 74 m 的封閉中庭，外牆高 15 m。

---

## 7. 模擬迴圈

- 固定步長 **120 Hz**，最多 6 個 substep，超過就丟棄累積時間。
- 渲染每個 animation frame 一次。
- `frameDt` 上限 0.25 s（分頁切回來時避免一次積分十秒）。

物理與遊戲邏輯放 `step(FIXED_DT)`；純視覺插值（粒子、HUD）放 `render(frameDt)`。

---

## 8. 碰撞

靜態 AABB 列表（`Level.colliders`），逐軸解算，附帶 0.55 m 的 step-up 重試讓樓梯可走。
**沒有 broadphase** —— 目前 54 個碰撞盒，線性掃描完全可接受。
碰撞盒超過 ~500 個時才需要引入空間分割（見 `docs/TASKS.md` T-12）。

---

## 9. 傷害模型

| 部位 | 倍率 |
|---|---|
| `head` | 2.4× |
| `body` | 1.0× |
| `limb` | 0.72× |

Hitbox 是敵人 group 底下真正的 child mesh，以 `userData.part` 標記。
`main.js` 的 hitscan 對「關卡 mesh + 敵人 hitbox」一起 raycast，取最近的 —— 掩體因此自動生效，
不需要額外的遮擋測試。

---

## 10. 驗證

```bash
npm run build          # 必須零錯誤
npm run shots          # headless Chromium 截圖 + smoke test，任何 console error 即失敗
```

`tools/shoot.mjs` 會輸出 draw call / 三角形 / 貼圖數量。**任何 PR 都必須附上這份輸出。**

`globalThis.__GAME__` 暴露整個 Game 實例，`poseCamera()` 可在無 pointer lock 的情況下擺鏡頭 ——
這是自動化驗證的掛鉤點，不要移除。

---

## 11. 關卡格式（`world/levels/*.json`）

`Level.js` 不含任何關卡幾何，只是一個直譯器。場景描述在 JSON 裡，
預設載入 `world/levels/arena.json`；`new Level( data )` 可傳入其他關卡。

**碰撞盒不在 JSON 裡。** 每個 `collide` 的元素在建好 mesh 之後自行推導
`THREE.Box3`。JSON 裡再寫一份碰撞資料，就是保證它遲早跟幾何對不上。

### 頂層

| 欄位 | 說明 |
|---|---|
| `name` | 關卡名稱 |
| `ground` | `{ material, size }` — 一張 `size × size` 的水平平面 |
| `materials` | 名稱 → 材質定義（見下） |
| `elements` | 元素陣列，依序建立 |
| `spawnPoints` | `[x, y, z]` 陣列，敵人生成點 |
| `playerStart` | `[x, y, z]`，玩家起點。省略時退回 `[0, 0, 26]`（arena 的南側入口） |
| `attribution` / `source` | 由外部資料產生的關卡帶著來源與授權標示；引擎不讀，但必須隨檔案保留 |

### 材質

`kind: "surface"` — 程序生成貼圖：

```json
{ "kind": "surface",
  "surface": { "size": 512, "tint": [0.52,0.34,0.28], "contrast": 0.34,
               "roughBase": 0.86, "roughVar": 0.16, "bump": 2.1,
               "period": 12, "repeat": 5, "seed": 21,
               "pattern": { "kind": "panel", "cols": 16, "rows": 3, "groove": 0.03 } },
  "metalness": 0.0, "normalScale": [1.4, 1.4] }
```

`surface` 原封不動傳給 `makeSurface()`；`metalness` / `roughness` / `normalScale`
覆寫在產出的貼圖之上。`pattern` 可省略，或用 `{ kind: "panel", cols, rows, groove?, offsetAlternate? }`
與 `{ kind: "metal", ridges }`、`{ kind: "window", cols, rows, sill?, lit?, seed? }`。

`window` 是給建築立面用的：把高度場推到兩極，讓 `makeSurface` 產出「暗玻璃 vs 亮牆」
的反照率對比。`panel` 只切淺溝，五十公尺外整棟樓會讀成一塊白板。
搭配元素的 `uvScale`，慣例是**一個貼圖單元 = 一層樓**（產生器用 3 公尺，`rows: 1`），
於是 `cols` 直接讀作「每層樓幾扇窗」。

`kind: "plain"` — 直接餵給 `MeshStandardMaterial`，`color` 與 `emissive`
寫成十六進位字串（`"0x4fc3f7"`）。發光材質走這條。

### 元素

所有元素都是**通用基本型**，沒有為特定關卡開的特例。座標單位是公尺，
`pos` 是盒子中心，`rotY` 是弧度。

| `type` | 欄位 | 說明 |
|---|---|---|
| `box` | `material`, `size`, `pos`, `collide?`, `rotY?`, `cast?`, `receive?`, `visible?`, `name?` | 單一實心盒 |
| `ramp` | `material`, `base`, `width`, `height`, `run`, `steps?` | 階梯式斜坡，展開成 `steps` 個盒子 |
| `instanced` | `material`, `geometry`, `transforms`, `colliderSize?`, `collide?`, `cast?` | 一個 `InstancedMesh`；`transforms` 是 `[x, y, z, rotY]` 陣列 |
| `prisms` | `material`, `buildings`, `uvScale?`, `collide?`, `cast?`, `receive?`, `hittable?`, `name?` | 一組擠出的多邊形柱體，合併成**單一** `BufferGeometry` |
| `pointLight` | `color`, `intensity`, `distance`, `decay`, `pos` | 點光源 |

`geometry` 為 `{ kind: "box", size }` 或 `{ kind: "barrier" }`。

`collide` 預設 `true`（`instanced` 需同時給 `colliderSize`），`cast` 與 `receive` 預設 `true`，
`visible` 與 `hittable` 預設 `true`，`rotY` 與 `colliderSize` 預設 `0`，`uvScale` 預設 `6`。

`visible: false` 的 `box` 是邊界牆：擋住玩家但**不進 `hittables`**，
否則對著天際線開槍會在空氣中打出火花。

### `prisms`：一座城市的基本型

`buildings` 的每一筆是 `{ h, ring }`，`ring` 是攤平的 `[x0, z0, x1, z1, …]` 底面多邊形，
`h` 是高度（公尺，從地面算起）。這正是 PLATEAU LOD1 建築的資料形狀，
所以轉換幾乎無損。

幾何建在 `world/PrismGeometry.js`，**不在 `Level.js` 裡**：它只依賴 three 的數學，
不碰 canvas 也不碰 WebGL，因此 `npm test` 可以無頭載入它檢查面的朝向。
這件事非做不可 —— 纏繞方向反了的建築**看起來仍然是實心的**（近側的牆被背面剔除，
你看到的是遠側牆的內面），第一版城市每一棟都是裡外顛倒的，靠眼睛完全看不出來。

`uvScale` 是每個貼圖單元幾公尺；牆面的 U 沿周長累積、V 取高度，
所以同一張貼圖貼在店面和辦公大樓上都不會被拉伸。底面不產生 —— 永遠看不到，
而且佔三分之一的三角形。

碰撞取底面的 AABB 而不是多邊形本身：一個街廓夠接近它的包圍盒，
遊戲中看不出差別，而碰撞求解器本來也只吃盒子。

旋轉的 instanced 物件用保守 AABB：半徑取 `colliderSize / 2 × √2`，
也就是用對角線而不是邊長，否則轉 45° 的箱子會有角落穿出碰撞盒。

### 為什麼窗戶是 108 筆 transform 而不是迴圈

外牆的窗戶原本由 `4 面 × 3 層 × 9 開間` 的迴圈生成。改成資料驅動之後，
那些迴圈變成 JSON 裡展開的 transform 陣列 —— 因為它們對應的**執行期結構**
本來就是一個 `InstancedMesh`。把生成規則留在引擎裡，等於為這張關卡開特例；
攤平之後，第二張關卡不需要動任何程式碼。

代價是 `arena.json` 約 35 KB，其中大半是那 216 筆座標。這是資料，不是程式碼。

### 碰撞的粗篩（`world/Colliders.js`）

arena 的 54 個碰撞盒可以線性掃描：每個實體、每軸、每個 substep，120 Hz。
一個東京街廓是 147 個，掃描就變成全部的成本，所以碰撞盒進 XZ 平面的均勻網格。
建築又高又細，垂直軸切格子毫無幫助，盒子測試本來就處理得了。

網格在關卡載入時建一次。查詢**不配置任何記憶體**：CSR 佈局是扁平的 typed array，
「這個盒子這次查過了」用的是每次查詢遞增的 stamp 陣列，不是 `Set`。

`level.colliders` 陣列仍然是唯一真相，網格只是它的索引。
`Colliders` 同時保留線性版的 `firstLinear` / `blockedLinear`，
`npm test` 拿兩者互相比對 —— DDA 走格子很容易寫出微妙的錯，
而錯的後果是敵人隔牆看到你，那在畫面上是看不見的。
