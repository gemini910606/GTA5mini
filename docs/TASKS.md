# 可發包的 Ticket 清單

每張 ticket 的格式與規則見 [`AI_HANDOFF.md`](./AI_HANDOFF.md) §3。
所有 ticket 共用的驗收條件（不再逐條重複）：

- [ ] `npm run build` 零錯誤
- [ ] `npm run shots` 零 console error，並貼出 scene stats
- [ ] draw calls：Low ≤ 260、Medium ≤ 520；triangles ≤ 400k（`npm run shots` 輸出）
- [ ] 不新增 runtime 相依、不發外部網路請求
- [ ] 未移除 `globalThis.__GAME__` 或 `Game.poseCamera()`

**排程規則：同一個「主要檔案」同時只能有一個 agent。**

---

## Tier 1 — 畫面（投資報酬率最高）

### T-01  用真實 HDRI 取代程序天空的 IBL
**目標** `Environment` 目前用 `Sky` 的 PMREM 當環境光。改為可切換：內建程序天空，
或內嵌的 equirectangular HDRI（RGBE 解碼後 `PMREMGenerator.fromEquirectangular`）。
畫面應出現目前完全沒有的真實環境反射細節。

**主要檔案** `src/world/Environment.js`
**可以改** `src/main.js`（只能加接線）
**不要碰** `src/core/Renderer.js`（pass 順序是契約）

**專屬驗收**
- [ ] HDRI 以 base64 內嵌或程序生成，不得外部請求
- [ ] 兩種模式可在執行期切換，且切換後不洩漏 render target（`renderer.info.memory.textures` 不遞增）
- [ ] `npm run probe` 的 mean luma 仍在 [0.32, 0.46]

**參考** Poly Haven（CC0 HDRI）。注意授權要寫進 `README`。
**風險** PMREM 沒 dispose 會漏顯存；切換時要先建新的再丟舊的。

---

### T-02  視角模型獨立渲染 pass
**目標** 武器目前是相機的 child，貼牆時會插進牆裡。改為第二個 pass：
獨立 scene + 獨立相機（較窄 FOV），在主場景之後、後處理之前疊上去。

**主要檔案** `src/core/Renderer.js`、`src/player/Weapon.js`
**不要碰** `src/world/`、`src/entities/`

**專屬驗收**
- [ ] 貼著任意牆面 `poseCamera()`，武器不得被牆面裁切（附截圖）
- [ ] 武器仍接收 `scene.environment` 的反射
- [ ] pass 順序：viewmodel 必須在 `OutputPass` **之前**，否則不會被 tone map

**風險** 深度緩衝共用會導致 GTAO 把武器算進 AO；需要獨立 depth。

---

### T-03  螢幕空間反射（濕地面）
**目標** 地面加入可調的 wetness，用 SSR 讓霓虹燈與天空在地面產生反射。
這是「夜景看起來貴」的最大單一來源。

**主要檔案** `src/core/Renderer.js`（插入 `SSRPass`）、`src/world/Level.js`（地面材質）
**不要碰** `src/shaders/GradeShader.js`

**專屬驗收**
- [ ] `SSRPass` 插在 `GTAOPass` 之後、`UnrealBloomPass` 之前（兩者都在線性空間）
- [ ] 加入 `wetness` 0/1 切換；關閉時 draw call 與現況差距 ≤ 5
- [ ] Low 畫質預設必須關閉 SSR

**風險** SSR 很貴。若 1080p 下 frame time 增加 > 4ms，改用平面反射（`Reflector`）。

---

### T-04  體積光 / 光柱
**目標** 低角度陽光穿過柱子與天橋時產生可見光柱。

**主要檔案** 新增 `src/shaders/GodRaysShader.js`、`src/core/Renderer.js`
**不要碰** `src/world/Environment.js`

**專屬驗收**
- [ ] radial blur 版本即可，不需要完整 raymarching
- [ ] 太陽在畫面外時效果必須歸零，不得殘留
- [ ] 只在 Medium 以上啟用

---

### T-05  真實 PBR 材質取代程序貼圖
**目標** `Textures.js` 的程序貼圖是佔位。改為可載入 CC0 材質集
（albedo / normal / roughness / AO），保留程序生成作為 fallback。

**主要檔案** `src/world/Textures.js`
**可以改** `src/world/Level.js`（材質指派）

**專屬驗收**
- [ ] 至少 3 組材質（柏油、混凝土、金屬）
- [ ] 貼圖以 KTX2/basis 或內嵌 base64，總 payload 增加 ≤ 8 MB
- [ ] `map` 必須是 `SRGBColorSpace`，`normalMap`/`roughnessMap` 必須是 linear
      —— 這是最常見的錯誤，弄反了畫面會偏灰

**參考** ambientCG、Poly Haven Textures（皆 CC0）

---

## Tier 2 — 內容

### T-06  Mixamo 綁定角色取代 blockout 敵人
**目標** 敵人現在是方塊人。改為載入 GLTF 骨架 + `AnimationMixer`，
提供 idle / walk / run / hit / death 動作混合。

**主要檔案** `src/entities/Enemies.js`
**不要碰** `src/main.js` 的 hitscan 邏輯

**專屬驗收**
- [ ] **必須保留 `userData.part` 的 head/body/limb 標記**，掛在骨架的碰撞代理上
- [ ] 傷害倍率行為不變（頭 2.4×、身 1.0×、肢 0.72×）
- [ ] 8 個敵人同時在場，draw call 增加 ≤ 40（用 `SkeletonUtils.clone` 共用幾何）
- [ ] 死亡動畫結束後正確回收進物件池

**風險** 每個敵人一份骨架材質會炸掉 draw call；務必共用。

---

### T-07  音效系統
**目標** Web Audio 3D 定位音效：槍聲、彈殼、腳步、命中回饋、環境層。

**主要檔案** 新增 `src/audio/`
**可以改** `src/main.js`（接線）、`src/player/Weapon.js`（觸發點）

**專屬驗收**
- [ ] 音效以程序合成（`OfflineAudioContext` 產生 buffer）或內嵌，不得外部請求
- [ ] 使用 `PositionalAudio`，敵人槍聲有方位感
- [ ] 首次使用者互動前不得建立 `AudioContext`（瀏覽器自動播放政策）
- [ ] 同時 32 個音源不得爆音（需要 limiter 或 voice stealing）

---

### T-08  敵人尋路
**目標** 現在的 AI 是「朝玩家走，撞到就換方向」。改為在 `Level.colliders`
上烘一張格點 navmesh，跑 A*，讓敵人會繞掩體。

**主要檔案** `src/entities/Enemies.js`、新增 `src/entities/Navigation.js`
**不要碰** `src/world/Level.js`（只能讀 `colliders`）

**專屬驗收**
- [ ] 格點在建構時烘一次，執行期不重烘
- [ ] 8 個敵人同時尋路，`step()` 增加 ≤ 0.6 ms（附量測方法）
- [ ] **每幀零配置**：路徑陣列必須預先配置並重用
- [ ] 敵人不得卡在牆角超過 2 秒

---

### T-09  遊戲狀態機與關卡循環
**目標** 目前敵人無限重生、玩家死不了。加入：波次、玩家死亡、結算、重開。

**主要檔案** 新增 `src/core/GameState.js`
**可以改** `src/main.js`、`src/ui/Hud.js`

**專屬驗收**
- [ ] 玩家 HP 歸零觸發死亡流程，不得直接 reload 頁面
- [ ] 重開後 `renderer.info.memory` 的 geometries/textures 不遞增（無洩漏）
- [ ] 波次資料是純資料（陣列/物件），不是硬編碼在邏輯裡

---

## Tier 3 — 工程

### T-10  效能：視錐剔除與 LOD
**目標** 目前所有東西每幀都送出。加入手動視錐剔除與遠距 LOD。

**主要檔案** `src/world/Level.js`、`src/main.js`
**專屬驗收**
- [ ] 面向牆角時 draw call 至少下降 35%
- [ ] 轉動視角不得出現物件突然彈出（LOD 切換要有 hysteresis）
- [ ] 加入 `npm run shots` 可讀取的剔除統計

### T-11  手把支援與鍵位重綁
**主要檔案** `src/core/Input.js`
**專屬驗收**
- [ ] Gamepad API，含右蠹瞄準加速曲線與死區
- [ ] 鍵位存在 `localStorage`，`Input` 不得直接讀 DOM 以外的全域狀態
- [ ] 鍵盤與手把可同時作用，不互相打斷

### T-12  設定選單
**主要檔案** 新增 `src/ui/Settings.js`
**專屬驗收**
- [ ] 畫質、滑鼠靈敏度、FOV、時段、音量
- [ ] 設定持久化到 `localStorage`，並在 `try/catch` 中讀寫（無痕模式會丟例外）
- [ ] 開啟選單自動釋放 pointer lock

### T-13  關卡改為資料驅動
**目標** `Level.js` 現在是硬編碼的幾何。改為讀 JSON 場景描述。

**主要檔案** `src/world/Level.js`、新增 `src/world/levels/arena.json`
**專屬驗收**
- [ ] 現有場景完整以 JSON 重現，截圖與現況差異僅限抗鋸齒
- [ ] 碰撞盒由 JSON 推導，不得手寫第二份
- [ ] JSON schema 寫進 `docs/SPEC.md`

### ~~T-14  單檔打包~~ — 已撤銷

實作過（`npm run artifact`），後來整個移除。

單檔打包的前提是「零外部請求」，而專案決定改用外部素材（CDN 上的模型與貼圖）。
兩者無法並存：一旦素材要下載，產出的就不是可離線開啟的單一檔案，
守著它的 `check-artifact.mjs` 也只會變成一個大家學會忽略的紅燈。

**不要重做這張 ticket**，除非「零外部請求」重新成為專案目標。
歷史實作見 git log 中的 `build-artifact.mjs` 與 `check-artifact.mjs`。

---

### T-15  合併敵人 blockout 部件
**目標** 每個敵人現在是 13 個獨立 mesh（8 個敵人 = 104 個），是 draw call 的最大單一來源。
依材質合併成 3–4 個（body / head / accent / visor）。

**主要檔案** `src/entities/Enemies.js`
**不要碰** `src/main.js` 的 hitscan

**專屬驗收**
- [ ] **必須保留 `userData.part` 的 head/body/limb 判定**——可以改用不可見的碰撞代理 mesh
      承載標記，但傷害倍率行為必須完全不變
- [ ] 8 個敵人在場時，Medium 的 draw call 下降 ≥ 150
- [ ] 走路動畫（四肢擺動）仍然要動；若合併後無法動，改用骨架或直接做 T-06

**風險** 合併後四肢無法各自旋轉。若走這條路，等於必須先做 T-06（Mixamo 骨架）。
兩張 ticket 擇一，不要同時發。

---

## 已知的既有問題（也可以當 ticket 發）

| # | 問題 | 位置 |
|---|---|---|
| B-1 | 武器貼牆會插進牆裡 | 見 T-02 |
| B-2 | 旋轉的 prop 只有 AABB，碰撞盒偏大 | `Level._instanced` |
| B-3 | 沒有 broadphase，碰撞是線性掃描 | `Player._collidesAt` |
| B-4 | 敵人可能重疊站位（彼此之間無碰撞） | `Enemies.Enemy._moveWithCollision` |
| B-5 | `FogExp2` 不影響天空 mesh，地平線有接縫 | `Environment` |
| B-6 | 換彈是位移動畫，不是真正的動作 | `Weapon.update` |
