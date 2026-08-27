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

/**
 * Rebuilds the colliders a level JSON would produce, without a WebGL context.
 *
 * This does duplicate `Level`'s derivation, which the level schema otherwise
 * goes out of its way to avoid. `Level` cannot run here — it builds canvas
 * textures — and the alternative is leaving the real maps untested, so the
 * duplication is the lesser evil. It only has to agree on box extents.
 */
function levelBoxes( data ) {
  const boxes = [];
  const push = ( sx, sy, sz, px, py, pz ) => boxes.push( new THREE.Box3(
    new THREE.Vector3( px - sx / 2, py - sy / 2, pz - sz / 2 ),
    new THREE.Vector3( px + sx / 2, py + sy / 2, pz + sz / 2 ),
  ) );

  for ( const e of data.elements ) {
    if ( e.type === 'ramp' ) {
      const steps = e.steps ?? 7;
      for ( let i = 0; i < steps; i ++ ) {
        const h = e.height * ( i + 1 ) / steps;
        const d = e.run / steps;
        push( e.width, h, d, e.base[ 0 ], h / 2, e.base[ 2 ] - e.run / 2 + d * ( i + 0.5 ) );
      }
    } else if ( e.type === 'instanced' ) {
      if ( e.collide === false || ! e.colliderSize ) continue;
      // Level uses the geometry's own height; approximate with the declared box.
      const hy = e.geometry.kind === 'box' ? e.geometry.size[ 1 ] : 1.1;
      const r = e.colliderSize * 0.5 * Math.SQRT2;
      for ( const [ x, y, z ] of e.transforms ) {
        boxes.push( new THREE.Box3(
          new THREE.Vector3( x - r, y - hy / 2, z - r ),
          new THREE.Vector3( x + r, y + hy / 2, z + r ),
        ) );
      }
    } else if ( e.type === 'prisms' ) {
      if ( e.collide === false ) continue;
      for ( const b of e.buildings ) {
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for ( let i = 0; i < b.ring.length; i += 2 ) {
          minX = Math.min( minX, b.ring[ i ] ); maxX = Math.max( maxX, b.ring[ i ] );
          minZ = Math.min( minZ, b.ring[ i + 1 ] ); maxZ = Math.max( maxZ, b.ring[ i + 1 ] );
        }
        boxes.push( new THREE.Box3( new THREE.Vector3( minX, 0, minZ ), new THREE.Vector3( maxX, b.h, maxZ ) ) );
      }
    } else if ( e.type === 'box' && e.collide !== false ) {
      push( e.size[ 0 ], e.size[ 1 ], e.size[ 2 ], e.pos[ 0 ], e.pos[ 1 ], e.pos[ 2 ] );
    }
  }
  return boxes;
}

function exercise( label, boxes, queries ) {
  const grid = new Colliders( boxes );
  const before = failures;

  const box = new THREE.Box3();
  const origin = new THREE.Vector3();
  const dir = new THREE.Vector3();

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
    check( grid.blocked( origin, dir, dist ) === grid.blockedLinear( origin, dir, dist ),
      `${ label } ray @ ${ origin.toArray().map( v => v.toFixed( 2 ) ) } dir ${ dir.toArray().map( v => v.toFixed( 3 ) ) } d=${ dist.toFixed( 2 ) }` );
  }

  const s = grid.stats;
  const status = failures === before ? 'ok  ' : 'FAIL';
  console.log( `  ${ status } ${ label.padEnd( 26 ) } boxes=${ String( s.boxes ).padStart( 4 ) } cells=${ String( s.cells ).padStart( 5 ) } entries=${ String( s.entries ).padStart( 5 ) }` );
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
  const boxes = levelBoxes( data );
  if ( ! boxes.length ) { console.log( `  skip ${ file } (no prism/box colliders)` ); continue; }
  exercise( file, boxes, 30000 );
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
