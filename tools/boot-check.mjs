import { chromium } from 'playwright';
import { serve, CHROMIUM, NAV_TIMEOUT } from './static-server.mjs';

const server = await serve( new URL( '../dist/', import.meta.url ).pathname, 5198 );
const browser = await chromium.launch( CHROMIUM );
const page = await browser.newPage( { viewport: { width: 640, height: 360 } } );

const errors = [];
page.on( 'console', m => { if ( m.type() === 'error' ) errors.push( 'console: ' + m.text() ); } );
page.on( 'pageerror', e => errors.push( 'pageerror: ' + e.message ) );

const t0 = Date.now();
await page.goto( 'http://localhost:5198/', { waitUntil: 'load', timeout: NAV_TIMEOUT } );
await page.waitForFunction(
  () => globalThis.__GAME__ !== undefined || document.getElementById( 'err' )?.textContent,
  { timeout: 120000 },
);
console.log( 'boot ms:', Date.now() - t0 );

const startupError = await page.$eval( '#err', el => el.textContent ).catch( () => '' );
if ( startupError ) console.log( 'STARTUP ERROR:\n' + startupError );

const ok = await page.evaluate( () => !! globalThis.__GAME__ );
console.log( 'game object:', ok );

if ( ok ) {
  await page.evaluate( () => globalThis.__GAME__.renderer.setQuality( 'low' ) );
  const t1 = Date.now();
  await page.evaluate( () => {
    const g = globalThis.__GAME__;
    g.running = false;
    g.poseCamera( { position: [ 0, 0, 26 ], yaw: Math.PI, pitch: -0.05 } );
  } );
  console.log( 'posed render ms:', Date.now() - t1 );
  console.log( 'stats:', JSON.stringify( await page.evaluate( () => ( {
    draws: globalThis.__GAME__.renderer.info.render.calls,
    tris: globalThis.__GAME__.renderer.info.render.triangles,
    colliders: globalThis.__GAME__.level.colliders.length,
    alive: globalThis.__GAME__.enemies.enemies.filter( e => e.alive ).length,
  } ) ) ) );
  await page.screenshot( { path: 'shots/boot.png' } );
}

console.log( errors.length ? 'ERRORS:\n' + errors.join( '\n' ) : 'no console errors' );
await browser.close();
server.close();
