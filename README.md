# GTA5mini

瀏覽器內的 three.js 第一人稱射擊原型。**零安裝、零外部資產請求。**
地圖是真的東京——新宿三個街廓，來自國土交通省的 Project PLATEAU 開放資料。

這個 repo 想回答一個具體的問題：

> 在不下載任何 `.exe` 的前提下（純瀏覽器 / 純腳本），畫質天花板到底在哪？

## 結論

**技術上可以做到 GTA5（2013, PS3/Xbox360）等級的渲染，成品上不行。**

GTA5 在 PS3 上是 720p / 30fps，技術是 deferred rendering + cascaded shadow maps + SSAO，
PBR 當時甚至還沒標準化。這套技術現在的 WebGL2 完全跑得動，這個 repo 就是實證。

它看起來震撼的原因不是引擎，是**約 1000 人做了 5 年**堆出來的美術資產量、動畫與關卡調校。
那是內容問題，不是程式問題，換什麼語言或引擎都不會改變。

所以這個原型的取捨是刻意的：**放棄開放世界，把預算全押在單一場景的光照品質上。**
小團隊唯一能在畫面上跟 3A 正面碰撞的方式，就是縮小範圍、提高密度。

## 跑起來

```bash
npm install
npm run dev
```

| 按鍵 | |
|---|---|
| `WASD` | 移動 |
| `Shift` | 衝刺 |
| `Space` | 跳躍 |
| `Ctrl` / `C` | 蹲下 |
| 左鍵 | 射擊（按住連發）|
| 右鍵 | ADS 機瞄 |
| `R` | 換彈 |
| `F` | 手電筒 |
| `1` `2` `3` | 畫質：低 / 中 / 高 |
| `T` | 切換時段（黃昏 / 正午 / 日落）|
| `H` | 切換環境光來源（程序天空 / HDRI 探針）|
| `Esc` | 釋放滑鼠 |

在無法取得 pointer lock 的環境（iframe 內嵌、部分文件檢視器），
會自動退回「按住滑鼠拖曳轉視角」模式。

## 已經做了什麼

**渲染**
- 完整後處理鏈：GTAO → Bloom → ACES tone mapping → SMAA → 調色（暈影 / 顆粒 / 色差 / 銳化）
- 物理天空 + PMREM 影像式光照（IBL），三組時段預設
- PCF 軟陰影，陰影視錐跟隨玩家
- 三段畫質預設

**玩法**
- FPS 控制器：AABB 碰撞、樓梯 step-up、蹲下、衝刺 / 體力、頭部搖晃、落地下沉
- 武器：視角模型、後座（垂直可學習 + 水平隨機）、彈著散佈、ADS、換彈、槍口火光
- Hitscan + 部位判定（頭 2.4× / 身 1.0× / 肢 0.72×）
- 敵人：blockout 人形、掩體感知的走位、命中反應、死亡 / 重生
- 物件池化的命中特效：曳光彈、彈孔、火花、煙

**工程**
- 固定步長 120 Hz 模擬，與渲染解耦
- 全部貼圖程序生成（tileable fBm + Sobel 法線）
- 四張地圖，遊戲內 `M` 鍵切換：一張練習場，三張真實的新宿街廓
- 碰撞用均勻網格粗篩，查詢零配置；無頭測試拿它跟線性掃描逐一比對
- Headless Chromium 截圖 harness，兼作 smoke test
- 曝光參數掃描工具（讀 `gl.readPixels` 算 luma 分位數）

## 沒有做，而且是刻意的

開放世界串流、多人連線、載具、布娃娃物理。
理由見上面的「結論」——這些會把預算從畫質上抽走。

## 這個場景長怎樣

![courtyard](shots/courtyard.png)

更多視角在 [`shots/`](./shots)。全部由 `npm run shots` 自動產生。

## 文件

| | |
|---|---|
| [`docs/SPEC.md`](./docs/SPEC.md) | 技術規格：模組邊界、pass 順序、效能預算 |
| [`docs/AI_HANDOFF.md`](./docs/AI_HANDOFF.md) | **怎麼把這個專案發包給 AI agent** |
| [`docs/TASKS.md`](./docs/TASKS.md) | 14 張可直接發包的 ticket |
| [`CLAUDE.md`](./CLAUDE.md) | AI agent 的進入點 |

## 授權

程式碼 MIT。

所有貼圖、天空和練習場的幾何都是程序生成，執行期算出來的。有兩項外部資料，
兩項都在 build 前轉檔並進版控，**執行期一樣不發任何請求**：

- **Cedar Bridge Sunset 1** — 作者 Dario Barresi，來自 [Poly Haven](https://polyhaven.com/a/cedar_bridge_sunset_1)，
  授權 CC0（不要求署名，仍然註明）。降採樣到 256×128 後以 base64 內嵌於
  `src/world/hdri.generated.js`，用 `node tools/build-hdri.mjs` 重新產生。

- **3D 都市モデル（Project PLATEAU）** — 國土交通省。
  三張新宿地圖（歌舞伎町一丁目、新宿一丁目、大京町）是從東京都 23 區的
  LOD1 建築模型（`plateau-tokyo23ku-obj4-2020`，EPSG:6677）裁切轉出的，
  用 `node tools/build-plateau.mjs` 重新產生。
  PLATEAU 的資料[任何人都可免費自由使用，包含商用](https://www.mlit.go.jp/plateau/site-policy/)。
  原始壓縮檔 600 MB，不在 repo 裡；工具檔頭寫了下載方式。
  每張關卡 JSON 自己帶著 `attribution` 與 `source` 欄位。

（單檔打包與守著它的 `check:artifact` 已經移除，見 `docs/TASKS.md` 的 T-14。
內嵌這件事本身沒變，但「零網路請求」現在沒有測試在把關了。）
