/**
 * Renders every map in `LEVELS` from a few positions and reports its budget.
 *
 * `npm run shots` covers the arena in depth; this one is about the maps as a
 * set — that each one builds, stays inside the draw-call budget, puts the
 * player somewhere legal, and leaves the console clean. Switching maps is the
 * only path in the game that disposes and rebuilds the world, so it is also
 * where a leak would show, and the run checks that geometry count returns to
 * where it started after a full cycle.
 *
 *   node tools/shoot-levels.mjs
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { serve, CHROMIUM, NAV_TIMEOUT } from './static-server.mjs';

const OUT = 'shots/levels';
mkdirSync( OUT, { recursive: true } );

const server = await serve( new URL( '../dist/', import.meta.url ).pathname, 5201 );
const browser = await chromium.launch( CHROMIUM );
const page = await browser.newPage( { viewport: { width: 960, height: 540 } } );

const errors = [];
page.on( 'console', m => { if ( m.type() === 'error' ) errors.push( 'console: ' + m.text() ); } );
page.on( 'pageerror', e => errors.push( 'pageerror: ' + e.message ) );

await page.goto( 'http://localhost:5201/', { waitUntil: 'load', timeout: NAV_TIMEOUT } );
await page.waitForFunction( () => globalThis.__GAME__ !== undefined, { timeout: 120000 } );
await page.evaluate( () => {
  globalThis.__GAME__.running = false;
  globalThis.__GAME__.renderer.setQuality( 'medium' );
  document.getElementById( 'overlay' ).classList.add( 'hidden' );
  document.getElementById( 'hud' ).classList.remove( 'hidden' );
} );

const names = await page.evaluate( () => globalThis.__GAME__.levelNames );
const baseline = await page.evaluate( () => globalThis.__GAME__.renderer.info.memory.geometries );

const rows = [];
for ( const name of names ) {
  const info = await page.evaluate( n => {
    const g = globalThis.__GAME__;
    g.setLevel( n );
    const start = g.level.playerStart;
    // Standing at the spawn: if the converter put the player inside a building
    // this is where it shows.
    g.poseCamera( { position: [ start.x, start.y, start.z ], yaw: 0.6, pitch: -0.02 } );
    return {
      name: n,
      title: g.level.data.name,
      draws: g.renderer.info.render.calls,
      tris: g.renderer.info.render.triangles,
      textures: g.renderer.info.memory.textures,
      geometries: g.renderer.info.memory.geometries,
      colliders: g.level.colliders.length,
      cells: g.level.broadphase.stats.cells,
      entries: g.level.broadphase.stats.entries,
      spawns: g.level.spawnPoints.length,
      start: [ start.x, start.z ],
      // The spawn must not be inside geometry, and neither must any enemy point.
      startClear: g.level.isStandingClear( start.x, start.y, start.z ),
      spawnsClear: g.level.spawnPoints.every( p => g.level.isStandingClear( p.x, p.y, p.z ) ),
    };
  }, name );
  rows.push( info );
  await page.screenshot( { path: `${ OUT }/${ name }-eye.png` } );

  // A rooftop-height look back over the block. Kept low deliberately: the fog
  // in Environment.js is exponential and height-independent, so a genuinely
  // aerial camera renders 150 m of haze and nothing else.
  await page.evaluate( () => {
    const g = globalThis.__GAME__;
    g.poseCamera( { position: [ 55, 42, 78 ], yaw: 0.62, pitch: -0.34 } );
  } );
  await page.screenshot( { path: `${ OUT }/${ name }-aerial.png` } );
}

// Two more full cycles, then compare like for like. `info.memory.geometries`
// counts uploaded geometry, so the reading has to follow a render or the new
// level's buffers simply have not been created yet and it looks like a win.
const settle = async () => {
  await page.evaluate( () => globalThis.__GAME__.poseCamera( { position: [ 0, 60, 90 ], yaw: 0, pitch: -0.5 } ) );
  return page.evaluate( () => globalThis.__GAME__.renderer.info.memory.geometries );
};
await page.evaluate( () => globalThis.__GAME__.setLevel( 'arena' ) );
const oneCycle = await settle();
for ( let i = 0; i < 2; i ++ ) {
  for ( const n of names ) await page.evaluate( x => globalThis.__GAME__.setLevel( x ), n );
  await page.evaluate( () => globalThis.__GAME__.setLevel( 'arena' ) );
}
const after = await settle();

const pad = ( v, n ) => String( v ).padStart( n );
console.log( 'name         draws   tris  tex  geo  coll cells entries spawns  start        clear' );
for ( const r of rows ) {
  console.log(
    `${ r.name.padEnd( 12 ) }${ pad( r.draws, 5 ) }${ pad( r.tris, 7 ) }${ pad( r.textures, 5 ) }`
    + `${ pad( r.geometries, 5 ) }${ pad( r.colliders, 6 ) }${ pad( r.cells, 6 ) }${ pad( r.entries, 8 ) }`
    + `${ pad( r.spawns, 7 ) }  ${ String( r.start.map( v => v.toFixed( 0 ) ).join( ',' ) ).padEnd( 12 ) } `
    + `${ r.startClear ? 'start' : 'START-BLOCKED' } ${ r.spawnsClear ? 'spawns' : 'SPAWN-BLOCKED' }`,
  );
}
console.log( `\ngeometries: ${ baseline } at boot, ${ oneCycle } after one cycle, ${ after } after three` );

const problems = [];
for ( const r of rows ) {
  if ( r.draws > 520 ) problems.push( `${ r.name }: ${ r.draws } draw calls exceeds the medium budget of 520` );
  if ( r.tris > 400000 ) problems.push( `${ r.name }: ${ r.tris } triangles exceeds the budget of 400k` );
  if ( ! r.startClear ) problems.push( `${ r.name }: player start is inside geometry` );
  if ( ! r.spawnsClear ) problems.push( `${ r.name }: a spawn point is inside geometry` );
  if ( r.spawns < 6 ) problems.push( `${ r.name }: only ${ r.spawns } spawn points` );
}
if ( after > oneCycle ) problems.push( `geometry leak: ${ oneCycle } after one cycle, ${ after } after three` );

console.log( errors.length ? '\nERRORS:\n' + errors.join( '\n' ) : '\nno console errors' );
if ( problems.length ) console.error( '\nPROBLEMS:\n' + problems.join( '\n' ) );

await browser.close();
server.close();
if ( problems.length || errors.length ) process.exit( 1 );
