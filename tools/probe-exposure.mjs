/**
 * Exposure probe.
 *
 * Renders the arena at a fixed viewpoint across a sweep of exposure /
 * environment-intensity values and reports pixel statistics read straight off
 * the drawing buffer. Tuning a tone-mapped PBR scene by eye on a software
 * renderer is hopeless; this makes it arithmetic.
 *
 * Targets for a sunlit exterior:
 *   mean luma  0.32 - 0.46
 *   p95 luma   0.78 - 0.95   (highlights present but not fully crushed)
 *   clipped    < 3 %         (fraction of pixels at 250/255 or above)
 */
import { chromium } from 'playwright';
import { serve, CHROMIUM, NAV_TIMEOUT } from './static-server.mjs';

const PORT = 5197;
const server = await serve( new URL( '../dist/', import.meta.url ).pathname, PORT );
const browser = await chromium.launch( CHROMIUM );
const page = await browser.newPage( { viewport: { width: 480, height: 270 } } );

page.on( 'pageerror', e => console.error( 'pageerror:', e.message ) );

await page.goto( `http://localhost:${ PORT }/`, { waitUntil: 'load', timeout: NAV_TIMEOUT } );
await page.waitForFunction( () => globalThis.__GAME__ !== undefined, { timeout: 120000 } );

// `IBL=hdri` measures the embedded probe instead of the procedural sky, so the
// two sources can be compared with the same instrument rather than by eye.
const IBL = process.env.IBL ?? 'procedural';

await page.evaluate( ( ibl ) => {
  document.getElementById( 'overlay' ).classList.add( 'hidden' );
  const g = globalThis.__GAME__;
  g.environment.setIblSource( ibl );
  g.running = false;
  g.renderer.setQuality( 'low' );
  g.renderer.renderer.setPixelRatio( 1 );

  // Read the drawing buffer and reduce it to luma statistics.
  globalThis.__measure = () => {
    const gl = g.renderer.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array( w * h * 4 );
    gl.bindFramebuffer( gl.FRAMEBUFFER, null );
    gl.readPixels( 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px );

    const lumas = new Float64Array( w * h );
    let clipped = 0;
    for ( let i = 0; i < w * h; i ++ ) {
      const r = px[ i * 4 ] / 255, gr = px[ i * 4 + 1 ] / 255, b = px[ i * 4 + 2 ] / 255;
      const l = 0.2126 * r + 0.7152 * gr + 0.0722 * b;
      lumas[ i ] = l;
      if ( r > 0.98 && gr > 0.98 && b > 0.98 ) clipped ++;
    }
    lumas.sort();
    const q = f => lumas[ Math.min( lumas.length - 1, Math.floor( lumas.length * f ) ) ];
    let sum = 0;
    for ( const l of lumas ) sum += l;
    return {
      mean: sum / lumas.length,
      p05: q( 0.05 ), p50: q( 0.5 ), p95: q( 0.95 ),
      clipped: clipped / lumas.length,
    };
  };
}, IBL );

// Must match the 'courtyard' pose in shoot.mjs, so probe numbers and hero
// screenshots describe the same frame.
const VIEW = { position: [ 2, 0, 30 ], yaw: 0, pitch: -2 * Math.PI / 180 };

async function measure( preset, exposure, envIntensity, sunIntensity, hemi ) {
  return page.evaluate( ( p ) => {
    const g = globalThis.__GAME__;
    if ( g.environment.preset !== p.preset ) g.environment.applyPreset( p.preset );
    g.renderer.renderer.toneMappingExposure = p.exposure;
    g.scene.environmentIntensity = p.envIntensity;
    g.environment.sun.intensity = p.sunIntensity;
    if ( p.hemi !== undefined ) g.environment.bounce.intensity = p.hemi;
    g.poseCamera( { position: p.view.position, yaw: p.view.yaw, pitch: p.view.pitch } );
    g.renderer.render( g.elapsed );
    return globalThis.__measure();
  }, { preset, exposure, envIntensity, sunIntensity, hemi, view: VIEW } );
}

const fmt = n => n.toFixed( 3 ).padStart( 6 );
const pct = n => ( n * 100 ).toFixed( 1 ).padStart( 5 ) + '%';

console.log( `IBL source: ${ IBL }` );
console.log( 'preset       exp    env    sun   hemi |   mean    p05    p50    p95  clipped' );
console.log( '-'.repeat( 80 ) );

const SWEEP = JSON.parse( process.env.SWEEP ?? '[]' );
const SAVE = process.env.SAVE === '1';

for ( const [ preset, exp, env, sun, hemi ] of SWEEP ) {
  const m = await measure( preset, exp, env, sun, hemi );
  const tag = `${ preset }-e${ exp }-v${ env }-s${ sun }-h${ hemi }`;
  console.log(
    `${ preset.padEnd( 11 ) } ${ fmt( exp ) } ${ fmt( env ) } ${ fmt( sun ) } ${ fmt( hemi ?? 0 ) } | ` +
    `${ fmt( m.mean ) } ${ fmt( m.p05 ) } ${ fmt( m.p50 ) } ${ fmt( m.p95 ) } ${ pct( m.clipped ) }`,
  );
  if ( SAVE ) await page.screenshot( { path: `shots/probe-${ tag }.png` } );
}

await browser.close();
server.close();
