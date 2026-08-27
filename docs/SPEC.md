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
