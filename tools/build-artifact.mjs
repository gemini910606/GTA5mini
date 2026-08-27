/**
 * Inlines the Vite build into one self-contained HTML page.
 *
 * The page is authored as body content only (no doctype/html/head/body), which
 * is what the Artifact publisher wraps. Everything — three.js, the game, every
 * texture, every font — is either inline or generated at runtime, so the page
 * makes no network requests at all.
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const DIST = new URL( '../dist/', import.meta.url ).pathname;
const FONTS = new URL( './fonts/', import.meta.url ).pathname;

/**
 * The faces the page actually uses, in the latin subset only: the UI's CJK
 * text has always fallen back to system fonts, and bundling a CJK subset would
 * cost more than the rest of the page put together. Google Fonts serves IBM
 * Plex Sans as one variable file, so three weights share a single download.
 * See tools/fonts/LICENSE.txt for provenance and the OFL terms.
 */
const FACES = [
  [ 'Archivo Black', '400', 'archivo-black-400.woff2' ],
  [ 'IBM Plex Mono', '400', 'ibm-plex-mono-400.woff2' ],
  [ 'IBM Plex Mono', '500', 'ibm-plex-mono-500.woff2' ],
  [ 'IBM Plex Mono', '600', 'ibm-plex-mono-600.woff2' ],
  // A weight *range*, not three rules: one variable file covers 400-600, and
  // repeating it per weight would embed the same 45 KB three times.
  [ 'IBM Plex Sans', '400 600', 'ibm-plex-sans-var.woff2' ],
];

// Matches what the Google Fonts CDN declares for its latin subset, so glyphs
// outside it keep falling back exactly as they did before the fonts moved
// in-page (the → and ▸ in the title card were never in this range).
const LATIN = 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, '
  + 'U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, '
  + 'U+2193, U+2212, U+2215, U+FEFF, U+FFFD';

// Read each distinct file once; the variable face is referenced three times.
const fontData = new Map();
for ( const [ , , file ] of FACES ) {
  if ( ! fontData.has( file ) ) {
    fontData.set( file, ( await readFile( join( FONTS, file ) ) ).toString( 'base64' ) );
  }
}

const fontCss = FACES.map( ( [ family, weight, file ] ) => `@font-face {
  font-family: '${ family }';
  font-style: normal;
  font-weight: ${ weight };
  font-display: swap;
  src: url(data:font/woff2;base64,${ fontData.get( file ) }) format('woff2');
  unicode-range: ${ LATIN };
}` ).join( '\n' );
const out = process.argv[ 2 ];
if ( ! out ) throw new Error( 'usage: build-artifact.mjs <output.html>' );

const assets = await readdir( join( DIST, 'assets' ) );
const jsName = assets.find( f => f.endsWith( '.js' ) );
if ( ! jsName ) throw new Error( 'no bundle found in dist/assets' );

const js = await readFile( join( DIST, 'assets', jsName ), 'utf8' );
// A literal </script> anywhere in the bundle would close the tag early.
const safeJs = js.replaceAll( '</script', '<\\/script' );

// Must be the first bytes on the page. The inlined fonts push the first
// non-ASCII character (the → in the pipeline strip) past offset 148000, far
// beyond the 1024-byte window the encoding prescan reads, so without an
// explicit declaration the browser falls back to latin-1 and every arrow, dot
// and em dash renders as mojibake. Entities would not be enough on their own:
// the bundle carries a non-ASCII character inside <script>, where they do not
// decode.
const page = String.raw`<meta charset="utf-8">
<title>GTA5mini</title>
<!-- Same mark as index.html. Without it the browser probes /favicon.ico and
     the page's first act is a failed request. -->
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%230b0e13'/%3E%3Ccircle cx='16' cy='16' r='9' fill='none' stroke='%23e8eef5' stroke-width='2'/%3E%3Cpath d='M16 3v7M16 22v7M3 16h7M22 16h7' stroke='%23e8eef5' stroke-width='2'/%3E%3C/svg%3E">

<style>
${ fontCss }

/* ---------------------------------------------------------------------------
   Palette is taken from the scene itself: the courtyard's emissive sign is
   #ff5a3c and its light strips are #4fc3f7. Committed dark — this is a game
   screen, not a document — so every colour is painted explicitly rather than
   inherited from the host theme.
   --------------------------------------------------------------------------- */
:root {
  --ground:  #05080c;
  --panel:   #0b1119;
  --ink:     #e6ecf3;
  --muted:   #7b8798;   /* blue-biased neutral, not a default grey */
  --line:    #1c2735;
  --accent:  #ff5a3c;   /* the neon sign */
  --cool:    #4fc3f7;   /* the light strips */
  --good:    #57e08a;

  --display: 'Archivo Black', 'Arial Black', system-ui, sans-serif;
  --sans:    'IBM Plex Sans', system-ui, -apple-system, sans-serif;
  --mono:    'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace;
}

* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 100%; height: 100%; overflow: hidden; }
body {
  background: var(--ground);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 13px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
#app { position: fixed; inset: 0; }
#app canvas { display: block; width: 100%; height: 100%; }

/* ---------- HUD ---------- */
#hud { position: absolute; inset: 0; pointer-events: none; user-select: none; font-family: var(--mono); }
#hud.hidden { display: none; }

#crosshair { position: absolute; left: 50%; top: 50%; width: 26px; height: 26px; transform: translate(-50%,-50%); }
#crosshair i { position: absolute; background: #fff; opacity: .85; box-shadow: 0 0 2px rgba(0,0,0,.9); transition: transform .06s ease-out; }
#crosshair i.t { left: 50%; top: 0;    width: 2px; height: 8px; margin-left: -1px; }
#crosshair i.b { left: 50%; bottom: 0; width: 2px; height: 8px; margin-left: -1px; }
#crosshair i.l { top: 50%; left: 0;    height: 2px; width: 8px; margin-top: -1px; }
#crosshair i.r { top: 50%; right: 0;   height: 2px; width: 8px; margin-top: -1px; }
#crosshair.hide i { opacity: 0; }

#hitmarker { position: absolute; left: 50%; top: 50%; width: 22px; height: 22px; transform: translate(-50%,-50%) scale(1.6); opacity: 0; }
#hitmarker svg { width: 100%; height: 100%; }
#hitmarker.show { animation: hm .22s ease-out; }
@keyframes hm {
  0%   { opacity: 1; transform: translate(-50%,-50%) scale(1.7); }
  100% { opacity: 0; transform: translate(-50%,-50%) scale(1.0); }
}

#vitals { position: absolute; left: 28px; bottom: 26px; display: flex; flex-direction: column; gap: 9px; }
.bar { width: 210px; height: 4px; background: rgba(255,255,255,.14); overflow: hidden; }
.bar > div { height: 100%; width: 100%; transition: width .18s ease-out; }
#healthFill { background: var(--good); }
#staminaFill { background: var(--cool); }
#vitals .lbl { font-size: 9px; letter-spacing: .2em; color: var(--muted); text-transform: uppercase; margin-bottom: 5px; }

#ammo { position: absolute; right: 30px; bottom: 22px; text-align: right; }
#ammoMag { font-family: var(--display); font-size: 44px; letter-spacing: -.02em; line-height: 1; text-shadow: 0 2px 14px rgba(0,0,0,.85); font-variant-numeric: tabular-nums; }
#ammoMag.low { color: var(--accent); }
#ammoReserve { font-size: 14px; color: var(--muted); margin-left: 5px; font-variant-numeric: tabular-nums; }
#weaponName { font-size: 9px; letter-spacing: .2em; color: var(--muted); text-transform: uppercase; margin-top: 5px; }
#reloading { font-size: 10px; letter-spacing: .2em; color: var(--accent); opacity: 0; text-transform: uppercase; margin-top: 6px; }
#reloading.on { opacity: 1; }

#score { position: absolute; left: 50%; top: 20px; transform: translateX(-50%); text-align: center; }
#scoreVal { font-family: var(--display); font-size: 26px; text-shadow: 0 2px 10px rgba(0,0,0,.85); font-variant-numeric: tabular-nums; }
#scoreLbl { font-size: 9px; letter-spacing: .22em; color: var(--muted); text-transform: uppercase; }

#damageVignette { position: absolute; inset: 0; opacity: 0; transition: opacity .35s ease-out; background: radial-gradient(ellipse at center, transparent 42%, rgba(190,20,20,.6) 100%); }
#stats { position: absolute; left: 28px; top: 20px; font-size: 10px; line-height: 1.8; color: rgba(230,236,243,.55); white-space: pre; text-shadow: 0 1px 4px #000; }

#floaters { position: absolute; inset: 0; overflow: hidden; }
.floater { position: absolute; font-family: var(--display); font-size: 15px; color: #ffe082; text-shadow: 0 2px 6px rgba(0,0,0,.9); animation: fl .85s ease-out forwards; }
.floater.crit { color: var(--accent); font-size: 20px; }
@keyframes fl {
  0%   { opacity: 1; transform: translate(-50%,-50%); }
  100% { opacity: 0; transform: translate(-50%,-160%); }
}

/* ---------- Title card ----------
   Not a centred modal. A lower-left slab, the way a game's title card sits
   over its own establishing shot, with the render pipeline spelled out along
   the top edge — the pipeline is the whole point of the page, so it is on it. */
#overlay {
  position: absolute; inset: 0; z-index: 10; cursor: pointer;
  background:
    linear-gradient(to top, rgba(5,8,12,.94) 0%, rgba(5,8,12,.72) 34%, rgba(5,8,12,.18) 62%, rgba(5,8,12,.34) 100%);
  display: grid; grid-template-rows: auto 1fr auto;
}
#overlay.hidden { display: none; }

.chain {
  display: flex; flex-wrap: wrap; align-items: center; gap: 0 10px;
  padding: 16px 30px; font-family: var(--mono); font-size: 10px;
  letter-spacing: .16em; text-transform: uppercase; color: #9aa7b8;
  border-bottom: 1px solid var(--line);
  /* The live scene sits behind this strip and the sky can be near-white, so
     the bar carries its own ground rather than relying on the page's. */
  background: linear-gradient(to bottom, rgba(5,8,12,.92), rgba(5,8,12,.72));
  backdrop-filter: blur(6px);
}
.chain b { color: var(--ink); font-weight: 600; }
.chain .sep { color: var(--accent); }
.chain .tail { margin-left: auto; color: #6f7c8d; letter-spacing: .14em; }

.card { padding: 0 30px 34px; display: flex; flex-wrap: wrap; align-items: flex-end; gap: 40px; }

.wordmark { min-width: 260px; }
.wordmark .eyebrow {
  font-family: var(--mono); font-size: 10px; letter-spacing: .26em;
  text-transform: uppercase; color: var(--cool); margin-bottom: 10px;
}
.wordmark h1 {
  font-family: var(--display); font-size: clamp(46px, 8vw, 82px);
  line-height: .92; letter-spacing: -.03em; text-wrap: balance;
  color: var(--ink); margin-bottom: 14px;
  text-shadow: 0 4px 30px rgba(5,8,12,.9);
}
.wordmark p { font-size: 13px; color: #93a0b1; max-width: 34ch; margin-bottom: 20px; }
.wordmark .cta {
  display: inline-flex; align-items: center; gap: 10px;
  font-family: var(--mono); font-size: 11px; letter-spacing: .2em; text-transform: uppercase;
  color: var(--ground); background: var(--accent); padding: 12px 22px; font-weight: 600;
}
.wordmark .cta::after { content: '▸'; font-size: 13px; }

.legend { display: grid; grid-template-columns: auto auto; gap: 6px 16px; font-family: var(--mono); font-size: 11px; align-content: end; }
.legend dt { color: var(--ink); font-weight: 500; }
.legend dd { color: #93a0b1; }

#err { grid-row: 2; align-self: center; justify-self: center; max-width: 60ch; padding: 0 30px; color: var(--accent); font-family: var(--mono); font-size: 11px; white-space: pre-wrap; }

@media (max-width: 620px) {
  .card { gap: 24px; padding-bottom: 24px; }
  .legend { font-size: 10px; }
  .chain { font-size: 9px; padding: 12px 20px; }
  #vitals { left: 18px; bottom: 18px; }
  .bar { width: 150px; }
}
@media (prefers-reduced-motion: reduce) {
  #hitmarker.show, .floater { animation-duration: .01ms; }
}
</style>

<div id="app"></div>

<div id="hud" class="hidden">
  <div id="damageVignette"></div>
  <div id="stats"></div>
  <div id="score"><div id="scoreVal">0</div><div id="scoreLbl">Targets Down</div></div>
  <div id="crosshair"><i class="t"></i><i class="b"></i><i class="l"></i><i class="r"></i></div>
  <div id="hitmarker">
    <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
      <path d="M4 4 L9 9 M20 4 L15 9 M4 20 L9 15 M20 20 L15 15"/>
    </svg>
  </div>
  <div id="floaters"></div>
  <div id="vitals">
    <div><div class="lbl">Health</div><div class="bar"><div id="healthFill"></div></div></div>
    <div><div class="lbl">Stamina</div><div class="bar"><div id="staminaFill"></div></div></div>
  </div>
  <div id="ammo">
    <div><span id="ammoMag">30</span><span id="ammoReserve">/ 180</span></div>
    <div id="weaponName">Carbine</div>
    <div id="reloading">Reloading</div>
  </div>
</div>

<div id="overlay">
  <div class="chain">
    <b>GTAO</b><span class="sep">→</span>
    <b>Bloom</b><span class="sep">→</span>
    <b>ACES</b><span class="sep">→</span>
    <b>SMAA</b><span class="sep">→</span>
    <b>Grade</b>
    <span class="tail">0 external assets · every texture generated at runtime</span>
  </div>

  <div id="err"></div>

  <div class="card">
    <div class="wordmark">
      <div class="eyebrow">Three.js · WebGL2</div>
      <h1>GTA5mini</h1>
      <p>How far a browser gets on rendering alone, when nothing is downloaded and no artist was hired.</p>
      <span class="cta">Click to play</span>
    </div>

    <dl class="legend">
      <dt>WASD</dt><dd>Move</dd>
      <dt>Shift</dt><dd>Sprint</dd>
      <dt>Space</dt><dd>Jump</dd>
      <dt>Ctrl / C</dt><dd>Crouch</dd>
      <dt>Left click</dt><dd>Fire — hold for auto</dd>
      <dt>Right click</dt><dd>Aim down sights</dd>
      <dt>R</dt><dd>Reload</dd>
      <dt>F</dt><dd>Flashlight</dd>
      <dt>1 / 2 / 3</dt><dd>Quality</dd>
      <dt>T</dt><dd>Time of day</dd>
      <dt>H</dt><dd>IBL source</dd>
      <dt>Esc</dt><dd>Release mouse</dd>
    </dl>
  </div>
</div>

<script type="module">
${ safeJs }
</script>
`;

await writeFile( out, page, 'utf8' );
console.log( `wrote ${ out } (${ ( page.length / 1024 / 1024 ).toFixed( 2 ) } MB)` );
