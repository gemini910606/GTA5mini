# CLAUDE.md

給在這個 repo 工作的 AI agent 的指引。人類讀者請從 [`README.md`](./README.md) 開始。

## 這是什麼

瀏覽器內的 three.js 第一人稱射擊原型。目的是實測「不裝任何執行檔」的前提下，
現代 Web 渲染管線的畫質天花板在哪。**零外部資產請求**——貼圖與天空全部程序生成，
少數實測資料（IBL 探針、PLATEAU 建築）在 build 前轉檔並進版控，執行期一樣不發請求。

## 動手之前必讀

1. [`docs/SPEC.md`](./docs/SPEC.md) — 模組邊界、post-processing pass 順序、效能預算。**這是契約。**
2. [`docs/AI_HANDOFF.md`](./docs/AI_HANDOFF.md) — ticket 怎麼寫、什麼該發包、prompt 模板。
3. [`docs/TASKS.md`](./docs/TASKS.md) — 待辦 ticket，每張都標了「主要檔案 / 不要碰」。

## 地圖資料

`world/levels/` 下的三張新宿地圖由 `tools/build-plateau.mjs` 從
[Project PLATEAU](https://www.mlit.go.jp/plateau/)（國土交通省）的 LOD1 建築模型轉出，
和 `build-hdri.mjs` 一樣是**手動執行、產出進版控**。原始壓縮檔 600 MB，不是 repo 資產；
工具檔頭寫了下載與執行方式。授權見 README。

## 指令

```bash
npm install
npm run dev      # Vite dev server
npm run build    # 產出 dist/
npm run shots    # headless Chromium 截圖 8 個視角 + smoke test（任何 console error 即失敗）
npm run shots:levels  # 每張地圖的預算表 + 截圖，並檢查切換地圖不漏記憶體
npm run probe    # 曝光掃描 + 太陽眩光檢查（街道被抬亮超過 1.45 倍就失敗）
npm test         # 無頭檢查：碰撞粗篩 vs 線性掃描、prism 面朝向、模擬重放一致性
```

`npm run shots` 需要 Chromium。路徑寫在 `tools/static-server.mjs` 的 `CHROMIUM`，
換環境時改那裡一個地方就好。

## 硬性規則

1. **不新增 runtime 相依。** `three` 是唯一一個。
2. **單人模式不發外部網路請求。** 資產一律程序生成，或在 build 前轉成 repo 內的檔案
   （`hdri.generated.js` 的 base64、`levels/*.json` 的建築）。轉檔工具可以連網，
   單人遊玩路徑上的程式碼不行——單檔離線版必須永遠成立。
   連線只在玩家**主動**加入房間時建立，而且不得有任何資產靠它下載。
3. **不要動 `core/Renderer.js` 的 pass 順序**，除非 ticket 明確授權——
   bloom 必須在 tone mapping 之前，顆粒必須在抗鋸齒之後。理由見 SPEC §4。
4. **每幀更新路徑不得配置記憶體。** `step()` / `update()` / `render()` 裡不准 `new`。
   `fx/Impacts.js` 是物件池的參考寫法。
5. **不得移除 `globalThis.__GAME__` 或 `Game.poseCamera()`。** 這是自動化驗收的唯一入口。
6. 只改 ticket 授權的檔案。要動別的，先停下來說明理由。

## 容易踩的坑

- **色彩空間**：`map` 要 `SRGBColorSpace`；`normalMap` / `roughnessMap` 要 linear（預設）。弄反畫面會偏灰。
- **光照單位**：three r155 之後是物理單位。`DirectionalLight` 的 3.4 和舊版的 3.4 不是同一件事。
- **`Sky` 的太陽圓盤亮度約 7×10⁵**。烘進 PMREM 會和 `DirectionalLight` 重複計光，整個畫面全白。
  `Environment.refreshIBL()` 烘之前會把 `showSunDisc` 設為 0，**不要拿掉**。
- **`renderer.info.autoReset` 必須是 `false`**。composer 每幀多次 `render()`，開著的話統計只反映最後一個 pass。
- **`Sky` 的 box 必須在相機 far plane 之內**（目前 450，far 是 800），否則整個被裁掉。
- **太陽圓盤的亮度鉗值(`SKY_CLAMP`)和 bloom 半徑是一組的。** 單獨調鉗值沒用——
  眩光是空間性的,要靠半徑收。動任一個都要跑 `npm run probe`,它量的是
  「面向太陽時街道被抬亮幾倍」,不是天空多亮(天空本來就該亮)。
- **`UnrealBloomPass` 的擴散和解析度有關。** 它走 mip 鏈,framebuffer 越小、同樣半徑
  蓋掉的畫面比例越大。probe 在 480×270 量,讀數比實際遊玩解析度保守。
- **`prisms` 的面朝向用眼睛驗不出來。** 纏繞方向反掉的建築看起來還是實心的 ——
  近側的牆被背面剔除，你看到的是遠側牆的內面。改到 `PrismGeometry.js` 一定要跑 `npm test`。
- **`sim/` 底下不准碰 camera、mesh、DOM。** 那層是客戶端與伺服器共用的模擬，
  一旦碰到場景圖，權威伺服器就跑不了同一份移動邏輯——而兩份移動邏輯就是兩組移動 bug
  加上一個永久的位置分歧。`npm test` 會在 Node 裡載入它，碰了就爆。
- **`Level` 與 `LevelColliders` 是同一個碰撞世界的兩份推導。** 客戶端從建好的 mesh 推，
  伺服器沒有 canvas 只能從 JSON 推。`npm run shots:levels` 會逐個盒子比對兩者，
  改任一邊都要跑。
- **`makeSurface` 的快取鍵**曾經用 `pattern.toString()`，但所有 `panelPattern` 閉包的
  原始碼字串都一樣，只差參數的兩種立面會共用同一張貼圖。pattern 工廠現在會掛 `fn.key`，
  新增 pattern 種類時**記得也掛**。

## 改完之後

跑 `npm run build` 和 `npm run shots`，兩個都要零錯誤，並在回報中貼出 `shots` 印出的 scene stats。
畫面相關的改動請附上前後截圖。

**畫質類的改動不要用眼睛判斷。** 用 `npm run probe` 量：它讀 `gl.readPixels()` 算 luma 分位數。
理由與用法見 `docs/AI_HANDOFF.md` §2。
