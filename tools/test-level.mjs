/**
 * Headless checks on what `Level` derives from a level JSON.
 *
 * Two things are tested, both of which a passing build and a plausible-looking
 * screenshot will happily hide:
 *
 *   1. The collision broad phase must answer exactly what the linear scan
 *      answers, or enemies see through walls and the player walks into
 *      buildings.
 *   2. Prism walls and roofs must face outward. An inside-out building still
 *      reads as solid, because its near walls are culled and you are looking at
 *      the inside of the far ones — it took a normals dump, not an eye, to
 *      catch that every building in the first city build was inverted.
 *
 *   node tools/test-level.mjs
 *
 * `Colliders` exists only as an optimisation: it must answer exactly what the
 * linear scan answers, or enemies see through walls and the player walks into
 * buildings. Both implementations live side by side in the class for precisely
 * this reason, and this compares them over random scenes plus the real level
 * JSONs.
 *
 *   node tools/test-colliders.mjs
 */

import * as THREE from 'three';
import { readFileSync, readdirSync } from 'node:fs';
import { Colliders } from '../src/world/Colliders.js';
import { buildPrisms } from '../src/world/PrismGeometry.js';
import { collidersFrom } from '../src/world/LevelColliders.js';
import { pointInRing, ringOverlapsRect, rayHitsPrism } from '../src/world/Narrow.js';

// Deterministic LCG: a failure has to be reproducible to be worth reporting.
let seed = 20260827;
const rnd = () => ( seed = ( seed * 1664525 + 1013904223 ) >>> 0 ) / 4294967296;
const range = ( a, b ) => a + rnd() * ( b - a );

let failures = 0;
const check = ( ok, message ) => {
  if ( ! ok ) {
    failures ++;
    if ( failures <= 10 ) console.error( `  FAIL ${ message }` );
  }
};

function randomBoxes( n, extent, size ) {
  const boxes = [];
  for ( let i = 0; i < n; i ++ ) {
    const x = range( -extent, extent ), z = range( -extent, extent );
    const w = range( 1, size ), d = range( 1, size ), h = range( 2, 40 );
    boxes.push( new THREE.Box3(
      new THREE.Vector3( x - w / 2, 0, z - d / 2 ),
      new THREE.Vector3( x + w / 2, h, z + d / 2 ),
    ) );
  }
  return boxes;
}

function exercise( label, boxes, queries, shapes = null ) {
  const grid = new Colliders( boxes, shapes );
  const before = failures;

  const box = new THREE.Box3();
  const origin = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const hitA = { distance: 0, index: -1, point: new THREE.Vector3(), normal: new THREE.Vector3() };
  const hitB = { distance: 0, index: -1, point: new THREE.Vector3(), normal: new THREE.Vector3() };

  // Overlap queries, sized like a player capsule and like an enemy.
  for ( let i = 0; i < queries; i ++ ) {
    const x = range( -140, 140 ), y = range( 0, 20 ), z = range( -140, 140 );
    const r = range( 0.2, 3 );
    box.min.set( x - r, y, z - r );
    box.max.set( x + r, y + range( 0.5, 2 ), z + r );
    check( ( grid.first( box ) !== null ) === ( grid.firstLinear( box ) !== null ),
      `${ label } overlap @ ${ x.toFixed( 2 ) },${ y.toFixed( 2 ) },${ z.toFixed( 2 ) } r=${ r.toFixed( 2 ) }` );
  }

  // Line of sight, including axis-aligned rays and rays starting inside a box.
  for ( let i = 0; i < queries; i ++ ) {
    origin.set( range( -140, 140 ), range( 0.5, 12 ), range( -140, 140 ) );
    const mode = i % 8;
    if ( mode === 0 ) dir.set( 1, 0, 0 );
    else if ( mode === 1 ) dir.set( -1, 0, 0 );
    else if ( mode === 2 ) dir.set( 0, 0, 1 );
    else if ( mode === 3 ) dir.set( 0, 0, -1 );
    else if ( mode === 4 ) dir.set( 0, 1, 0 );
    else dir.set( range( -1, 1 ), range( -0.4, 0.4 ), range( -1, 1 ) );
    if ( dir.lengthSq() < 1e-6 ) dir.set( 1, 0, 0 );
    dir.normalize();
    const dist = range( 4, 90 );
    const where = `${ label } ray @ ${ origin.toArray().map( v => v.toFixed( 2 ) ) } dir ${ dir.toArray().map( v => v.toFixed( 3 ) ) } d=${ dist.toFixed( 2 ) }`;
    check( grid.blocked( origin, dir, dist ) === grid.blockedLinear( origin, dir, dist ), `${ where } (blocked)` );

    // `raycast` walks the grid with an early-out once a hit is nearer than the
    // current cell's exit, which is where a DDA usually goes wrong.
    const gridHit = grid.raycast( origin, dir, dist, hitA );
    const lineHit = grid.raycastLinear( origin, dir, dist, hitB );
    check( gridHit === lineHit, `${ where } (raycast found)` );
    if ( gridHit && lineHit ) {
      check( Math.abs( hitA.distance - hitB.distance ) < 1e-9,
        `${ where } (raycast distance ${ hitA.distance } vs ${ hitB.distance })` );
    }
  }

  const s = grid.stats;
  const status = failures === before ? 'ok  ' : 'FAIL';
  console.log( `  ${ status } ${ label.padEnd( 22 ) } boxes=${ String( s.boxes ).padStart( 4 ) }`
    + ` shaped=${ String( s.shaped ).padStart( 4 ) } cells=${ String( s.cells ).padStart( 5 ) }`
    + ` entries=${ String( s.entries ).padStart( 5 ) }` );
}

console.log( 'random scenes' );
exercise( 'sparse', randomBoxes( 20, 60, 8 ), 20000 );
exercise( 'arena-like', randomBoxes( 54, 60, 6 ), 20000 );
exercise( 'city-like', randomBoxes( 150, 100, 18 ), 20000 );
exercise( 'dense', randomBoxes( 600, 120, 14 ), 20000 );
exercise( 'empty', [], 2000 );
exercise( 'single', randomBoxes( 1, 5, 10 ), 5000 );

console.log( 'level JSON' );
for ( const file of readdirSync( 'src/world/levels' ).sort() ) {
  if ( ! file.endsWith( '.json' ) ) continue;
  const data = JSON.parse( readFileSync( `src/world/levels/${ file }`, 'utf8' ) );
  const { boxes, shapes, incomplete } = collidersFrom( data );
  if ( incomplete.length ) { console.log( `  skip ${ file } (${ incomplete.join( ', ' ) } needs a loader)` ); continue; }
  if ( ! boxes.length ) { console.log( `  skip ${ file } (no colliders)` ); continue; }
  exercise( file, boxes, 30000, shapes );
}

// --- narrow phase, against known geometry -----------------------------------
//
// The differential test above shares one narrow phase between the grid and the
// linear scan, so it cannot catch the narrow phase itself being wrong. These
// are hand-checked answers on a shape whose bounding box lies about it.

console.log( 'narrow phase' );
{
  const before = failures;
  // An L: 10x10 with the ( 5..10, 5..10 ) quadrant cut out. Positively wound.
  const L = [ 0, 0, 10, 0, 10, 5, 5, 5, 5, 10, 0, 10 ];
  const TOP = 12;

  // The notch is inside the bounding box and outside the building. This is the
  // whole point: on the real maps the bounding boxes carry 19-43% more volume
  // than the buildings, and all of it used to stop bullets and players.
  check( ! pointInRing( L, 7.5, 7.5 ), 'the notch reads as inside the footprint' );
  check( pointInRing( L, 2.5, 2.5 ), 'the solid corner reads as outside' );
  check( pointInRing( L, 7.5, 2.5 ), 'the solid arm reads as outside' );
  check( ! pointInRing( L, -1, 5 ), 'a point left of the building reads as inside' );

  check( ! ringOverlapsRect( L, 6, 6, 9, 9 ), 'a box in the notch collides' );
  check( ringOverlapsRect( L, 1, 1, 3, 3 ), 'a box inside the solid does not collide' );
  check( ringOverlapsRect( L, 4, 4, 6, 6 ), 'a box straddling the inner corner does not collide' );
  check( ringOverlapsRect( L, -2, -2, 12, 12 ), 'a box swallowing the building does not collide' );
  check( ! ringOverlapsRect( L, 20, 20, 22, 22 ), 'a box far away collides' );

  const o = new THREE.Vector3(), d = new THREE.Vector3(), n = new THREE.Vector3();

  // Across the notch at z = 7.5: the upper arm ends at x = 5, so a shot from
  // x = 20 travels 15 m of what the bounding box calls solid before it hits
  // anything. That 15 m is the bug this whole narrow phase exists to fix.
  o.set( 20, 6, 7.5 ); d.set( -1, 0, 0 );
  let t = rayHitsPrism( L, TOP, o, d, 40, n );
  check( Math.abs( t - 15 ) < 1e-6, `shot across the notch hit at ${ t }, expected 15` );
  check( Math.abs( n.x - 1 ) < 1e-6, `notch-side wall normal faced ${ n.toArray() }, expected +X` );

  // Clear of the building in z: nothing to hit at all.
  o.set( 20, 6, 12 ); d.set( -1, 0, 0 );
  check( rayHitsPrism( L, TOP, o, d, 40, n ) < 0, 'a shot clear of the building is blocked' );

  // Into the arm: hits the face at z = 5, so 15 m away.
  o.set( 7.5, 3, 20 ); d.set( 0, 0, -1 );
  t = rayHitsPrism( L, TOP, o, d, 40, n );
  check( Math.abs( t - 15 ) < 1e-6, `shot into the arm hit at ${ t }, expected 15` );
  check( Math.abs( n.z - 1 ) < 1e-6, `wall normal faced ${ n.toArray() }, expected +Z` );

  // Over the top: the roof at y = 12.
  o.set( 2, 30, 2 ); d.set( 0, -1, 0 );
  t = rayHitsPrism( L, TOP, o, d, 40, n );
  check( Math.abs( t - 18 ) < 1e-6, `shot onto the roof hit at ${ t }, expected 18` );
  check( Math.abs( n.y - 1 ) < 1e-6, `roof normal faced ${ n.toArray() }, expected +Y` );

  // Over the notch at roof height: nothing there.
  o.set( 7.5, 30, 7.5 ); d.set( 0, -1, 0 );
  check( rayHitsPrism( L, TOP, o, d, 40, n ) < 0, 'the notch has a roof' );

  // Above the building entirely: passes over.
  o.set( -5, 14, 2 ); d.set( 1, 0, 0 );
  check( rayHitsPrism( L, TOP, o, d, 40, n ) < 0, 'a shot above the roofline is blocked' );

  console.log( `  ${ failures === before ? 'ok  ' : 'FAIL' } L-shaped footprint: notch is empty, arm is solid, roof is at ${ TOP } m` );
}

// --- face winding ------------------------------------------------------------

console.log( 'prism winding' );
for ( const file of readdirSync( 'src/world/levels' ).sort() ) {
  if ( ! file.endsWith( '.json' ) ) continue;
  const data = JSON.parse( readFileSync( `src/world/levels/${ file }`, 'utf8' ) );
  const elements = data.elements.filter( e => e.type === 'prisms' );
  if ( ! elements.length ) { console.log( `  skip ${ file } (no prisms)` ); continue; }

  const before = failures;
  let walls = 0, roofs = 0, buildings = 0;

  for ( const element of elements ) {
    for ( const b of element.buildings ) {
      const n = b.ring.length / 2;
      if ( n < 3 ) continue;
      buildings ++;

      // Build this one building alone so triangle indices map to it directly.
      const { geometry } = buildPrisms( [ b ], element.uvScale ?? 6 );
      const P = geometry.attributes.position.array;
      const N = geometry.attributes.normal.array;

      let cx = 0, cz = 0;
      for ( let i = 0; i < n; i ++ ) { cx += b.ring[ i * 2 ]; cz += b.ring[ i * 2 + 1 ]; }
      cx /= n; cz /= n;

      const triangles = P.length / 9;
      for ( let t = 0; t < triangles; t ++ ) {
        const o = t * 9;
        const mx = ( P[ o ] + P[ o + 3 ] + P[ o + 6 ] ) / 3;
        const mz = ( P[ o + 2 ] + P[ o + 5 ] + P[ o + 8 ] ) / 3;
        const ny = N[ o + 1 ];

        if ( Math.abs( ny ) > 0.9 ) {
          // Roof: must face up. Nothing renders the underside.
          roofs ++;
          check( ny > 0, `${ file } roof faces down at ${ mx.toFixed( 1 ) },${ mz.toFixed( 1 ) }` );
        } else {
          // Walls are judged per building rather than per triangle: the
          // centroid is only guaranteed to be inside a convex ring, so one edge
          // of an L-shaped footprint can look wrong while the winding is fine.
          walls ++;
        }
      }

      // Majority verdict on the walls of this building.
      let outward = 0, inward = 0;
      for ( let t = 0; t < triangles; t ++ ) {
        const o = t * 9;
        if ( Math.abs( N[ o + 1 ] ) > 0.9 ) continue;
        const mx = ( P[ o ] + P[ o + 3 ] + P[ o + 6 ] ) / 3;
        const mz = ( P[ o + 2 ] + P[ o + 5 ] + P[ o + 8 ] ) / 3;
        if ( N[ o ] * ( mx - cx ) + N[ o + 2 ] * ( mz - cz ) < 0 ) inward ++; else outward ++;
      }
      check( outward >= inward,
        `${ file } building at ${ cx.toFixed( 1 ) },${ cz.toFixed( 1 ) } is inside out (${ inward }/${ inward + outward } walls face in)` );
    }
  }
  const status = failures === before ? 'ok  ' : 'FAIL';
  console.log( `  ${ status } ${ file.padEnd( 26 ) } buildings=${ String( buildings ).padStart( 4 ) } wall tris=${ String( walls ).padStart( 6 ) } roof tris=${ String( roofs ).padStart( 5 ) }` );
}

if ( failures ) {
  console.error( `\n${ failures } failure(s)` );
  process.exit( 1 );
}
console.log( '\nbroad phase agrees with the linear scan, and every prism faces outward' );
