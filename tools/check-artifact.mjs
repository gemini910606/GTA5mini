import { chromium } from 'playwright';
import { serve, CHROMIUM } from './static-server.mjs';

const root = process.argv[ 2 ];
const server = await serve( root, 5196 );
const browser = await chromium.launch( CHROMIUM );
const page = await browser.newPage( { viewport: { width: 1100, height: 620 } } );

const errors = [];
const requests = [];
page.on( 'console', m => { if ( m.type() === 'error' ) errors.push( 'console: ' + m.text() ); } );
page.on( 'pageerror', e => errors.push( 'pageerror: ' + e.message ) );
page.on( 'request', r => {
  const u = r.url();
  if ( ! u.startsWith( 'http://localhost:5196' ) && ! u.startsWith( 'data:' ) ) requests.push( u );
} );

await page.goto( 'http://localhost:5196/', { waitUntil: 'load' } );
await page.screenshot( { path: 'shots/artifact-title.png' } );

await page.waitForFunction(
  () => globalThis.__GAME__ !== undefined || document.getElementById( 'err' )?.textContent,
  { timeout: 120000 },
);
const startupError = await page.$eval( '#err', el => el.textContent ).catch( () => '' );
if ( startupError ) errors.push( 'startup: ' + startupError );

console.log( 'game booted:', await page.evaluate( () => !! globalThis.__GAME__ ) );

// The title card must survive boot, then the click must hand over to the HUD.
await page.screenshot( { path: 'shots/artifact-title.png' } );
await page.click( '#overlay' );
await page.waitForTimeout( 1200 );

const state = await page.evaluate( () => ( {
  overlayHidden: document.getElementById( 'overlay' ).classList.contains( 'hidden' ),
  hudVisible: ! document.getElementById( 'hud' ).classList.contains( 'hidden' ),
  running: globalThis.__GAME__?.running ?? false,
  dragFallback: globalThis.__GAME__?.input.dragFallback ?? null,
} ) );
console.log( 'after click:', JSON.stringify( state ) );

await page.evaluate( () => { globalThis.__GAME__.renderer.setQuality( 'low' ); } );
await page.waitForTimeout( 2500 );
await page.screenshot( { path: 'shots/artifact-playing.png' } );

const external = [ ...new Set( requests ) ].filter( u => ! u.includes( 'fonts.googleapis' ) && ! u.includes( 'fonts.gstatic' ) );
console.log( 'external requests (excluding Google Fonts):', external.length ? external : 'none' );

await browser.close();
server.close();
console.log( errors.length ? 'ERRORS:\n' + errors.join( '\n' ) : 'no console errors' );
process.exit( errors.length ? 1 : 0 );
