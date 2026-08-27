/**
 * Headless screenshot harness + smoke test.
 *
 * Boots the built game in Chromium (SwiftShader software GL), poses the camera
 * at fixed viewpoints and writes PNGs to shots/. Exits non-zero on any console
 * error or page exception, so CI can gate on it.
 *
 * Software rendering is roughly 50-100x slower than a real GPU here; the frame
 * times this prints are a smoke signal, not a performance measurement.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { serve, CHROMIUM } from './static-server.mjs';

const PORT = 5199;
const WIDTH = 1280, HEIGHT = 720;

// [ name, x, y, z, yawDeg, pitchDeg, quality, timeOfDay ]
const POSES = [
  [ 'courtyard',    2,   0,  30,    0,  -2, 'medium', 'goldenHour' ],
  [ 'platform',   -33,   0,  -4,  -47,  -5, 'medium', 'goldenHour' ],
  [ 'catwalk',    -19, 5.75, 14,    0,  -7, 'medium', 'goldenHour' ],
  [ 'sign',         5,   0, -14,   12,  18, 'medium', 'goldenHour' ],
  [ 'crates',      -8,   0,  12,  -41,  -4, 'medium', 'goldenHour' ],
  [ 'dusk',         4,   0,  30,    3,  -1, 'medium', 'dusk' ],
  [ 'noon',       -16,   0,  12,  -53,  -3, 'medium', 'noon' ],
  [ 'low-quality',  2,   0,  30,    0,  -2, 'low',    'goldenHour' ],
];

const server = await serve( new URL( '../dist/', import.meta.url ).pathname, PORT );
await mkdir( new URL( '../shots/', import.meta.url ), { recursive: true } );

const browser = await chromium.launch( CHROMIUM );
const page = await browser.newPage( { viewport: { width: WIDTH, height: HEIGHT } } );

const errors = [];
page.on( 'console', m => { if ( m.type() === 'error' ) errors.push( `console.error: ${ m.text() }` ); } );
page.on( 'pageerror', e => errors.push( `pageerror: ${ e.message }` ) );

await page.goto( `http://localhost:${ PORT }/`, { waitUntil: 'load' } );
await page.waitForFunction(
  () => globalThis.__GAME__ !== undefined || document.getElementById( 'err' )?.textContent,
  { timeout: 120000 },
);

const startupError = await page.$eval( '#err', el => el.textContent ).catch( () => '' );
if ( startupError ) {
  errors.push( `startup: ${ startupError }` );
} else {
  // Reveal the game: hide the click-to-play overlay, show the HUD, and let the
  // simulation run for a moment so enemies are mid-stride rather than at spawn.
  await page.evaluate( () => {
    document.getElementById( 'overlay' ).classList.add( 'hidden' );
    document.getElementById( 'hud' ).classList.remove( 'hidden' );
    const g = globalThis.__GAME__;
    g.running = false;
    // Force pixel ratio 1: SwiftShader at DPR 2 is unusably slow.
    g.renderer.renderer.setPixelRatio( 1 );
  } );

  for ( const [ name, x, y, z, yawDeg, pitchDeg, quality, tod ] of POSES ) {
    const t0 = Date.now();

    await page.evaluate( ( p ) => {
      const g = globalThis.__GAME__;
      g.renderer.setQuality( p.quality );
      g.renderer.renderer.setPixelRatio( 1 );
      if ( g.environment.preset !== p.tod ) g.environment.applyPreset( p.tod );

      // Advance the simulation deterministically so the shot has motion in it.
      g.player.position.set( p.x, p.y, p.z );
      g.player.yaw = p.yawDeg * Math.PI / 180;
      g.player.pitch = p.pitchDeg * Math.PI / 180;
      for ( let i = 0; i < 90; i ++ ) {
        g.elapsed += 1 / 120;
        g.enemies.update( 1 / 120, { playerPosition: g.camera.position, elapsed: g.elapsed } );
      }
      g.poseCamera( { position: [ p.x, p.y, p.z ], yaw: g.player.yaw, pitch: g.player.pitch } );
      g.updateHud();
    }, { x, y, z, yawDeg, pitchDeg, quality, tod } );

    // Two extra renders: shadow maps and the bloom chain need a settled frame.
    await page.evaluate( () => {
      const g = globalThis.__GAME__;
      g.renderer.render( g.elapsed );
      g.renderer.render( g.elapsed );
    } );

    await page.screenshot( { path: `shots/${ name }.png` } );
    process.stdout.write( `shot ${ name.padEnd( 12 ) } ${ Date.now() - t0 }ms\n` );
  }
}

const stats = await page.evaluate( () => {
  const g = globalThis.__GAME__;
  if ( ! g ) return null;
  return {
    drawCalls: g.renderer.info.render.calls,
    triangles: g.renderer.info.render.triangles,
    geometries: g.renderer.info.memory.geometries,
    textures: g.renderer.info.memory.textures,
    programs: g.renderer.renderer.info.programs?.length ?? 0,
    colliders: g.level.colliders.length,
    enemiesAlive: g.enemies.enemies.filter( e => e.alive ).length,
  };
} );
console.log( '\nscene stats:', JSON.stringify( stats, null, 2 ) );

await browser.close();
server.close();

if ( errors.length ) {
  console.error( '\nERRORS:\n' + errors.join( '\n' ) );
  process.exit( 1 );
}
console.log( '\nno console errors' );
