/**
 * Converts a Project PLATEAU LOD1 building tile into a level JSON.
 *
 * PLATEAU LOD1 buildings are extruded footprints — a flat polygon lifted to a
 * single height — which is exactly the `prisms` element the level schema
 * describes. The conversion is therefore lossless for the geometry that
 * matters; what it throws away is absolute terrain elevation (the arena is
 * flat) and the CityGML attributes (we never had a use for them).
 *
 * Run by hand, output committed — same arrangement as `build-hdri.mjs`. The
 * source archive is 600 MB and is not a repository asset.
 *
 *   1. Download a 2nd-order mesh archive from the G-Spatial Information Center:
 *      https://www.geospatial.jp/ckan/dataset/plateau-tokyo23ku-obj4-2020
 *      e.g. https://gic-plateau.s3-ap-northeast-1.amazonaws.com/2020/Tokyo23kuOBJ4/533945_2.zip
 *   2. Unzip it, then unzip the LOD1.zip inside it. You get directories named
 *      after 3rd-order mesh codes, each holding one `*_bldg_6677.obj`.
 *   3. node tools/build-plateau.mjs --src <that directory> \
 *        --lat 35.69416 --lon 139.70267 --size 200 \
 *        --name kabukicho --title "Kabukicho" \
 *        --out src/world/levels/kabukicho.json
 *
 * Data licence: the PLATEAU datasets are free for anyone to use, commercial
 * use included, subject to the attribution in the site policy. The generated
 * JSON carries the attribution string; see README.md.
 * https://www.mlit.go.jp/plateau/site-policy/
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// --- JGD2011 / Japan Plane Rectangular CS IX (EPSG:6677) --------------------
//
// The OBJ vertices are already projected metres, so all we need is the forward
// projection to turn a lat/lon crop centre into the same coordinate space, and
// the inverse to write a human-readable location back into the JSON.

const A_E = 6378137.0;
const INV_F = 298.257222101;
const M0 = 0.9999;
const N = 1 / ( 2 * INV_F - 1 );

const ZONE_IX = { lat0: 36, lon0: 139 + 50 / 60 };

const A_COEF = [
  1 + N ** 2 / 4 + N ** 4 / 64,
  -1.5 * ( N - N ** 3 / 8 - N ** 5 / 64 ),
  ( 15 / 16 ) * ( N ** 2 - N ** 4 / 4 ),
  -( 35 / 48 ) * ( N ** 3 - ( 5 / 16 ) * N ** 5 ),
  ( 315 / 512 ) * N ** 4,
  -( 693 / 1280 ) * N ** 5,
];

const ALPHA = [ null,
  0.5 * N - ( 2 / 3 ) * N ** 2 + ( 5 / 16 ) * N ** 3 + ( 41 / 180 ) * N ** 4 - ( 127 / 288 ) * N ** 5,
  ( 13 / 48 ) * N ** 2 - ( 3 / 5 ) * N ** 3 + ( 557 / 1440 ) * N ** 4 + ( 281 / 630 ) * N ** 5,
  ( 61 / 240 ) * N ** 3 - ( 103 / 140 ) * N ** 4 + ( 15061 / 26880 ) * N ** 5,
  ( 49561 / 161280 ) * N ** 4 - ( 179 / 168 ) * N ** 5,
  ( 34729 / 80640 ) * N ** 5,
];

const BETA = [ null,
  0.5 * N - ( 2 / 3 ) * N ** 2 + ( 37 / 96 ) * N ** 3 - ( 1 / 360 ) * N ** 4 - ( 81 / 512 ) * N ** 5,
  ( 1 / 48 ) * N ** 2 + ( 1 / 15 ) * N ** 3 - ( 437 / 1440 ) * N ** 4 + ( 46 / 105 ) * N ** 5,
  ( 17 / 480 ) * N ** 3 - ( 37 / 840 ) * N ** 4 - ( 209 / 4480 ) * N ** 5,
  ( 4397 / 161280 ) * N ** 4 - ( 11 / 504 ) * N ** 5,
  ( 4583 / 161280 ) * N ** 5,
];

const DELTA = [ null,
  2 * N - ( 2 / 3 ) * N ** 2 - 2 * N ** 3 + ( 116 / 45 ) * N ** 4 + ( 26 / 45 ) * N ** 5,
  ( 7 / 3 ) * N ** 2 - ( 8 / 5 ) * N ** 3 - ( 227 / 45 ) * N ** 4 + ( 2704 / 315 ) * N ** 5,
  ( 56 / 15 ) * N ** 3 - ( 136 / 35 ) * N ** 4 - ( 1262 / 105 ) * N ** 5,
  ( 4279 / 630 ) * N ** 4 - ( 332 / 35 ) * N ** 5,
  ( 4174 / 315 ) * N ** 5,
];

const rad = d => d * Math.PI / 180;
const deg = r => r * 180 / Math.PI;
const atanh = x => 0.5 * Math.log( ( 1 + x ) / ( 1 - x ) );

function meridian( phi0 ) {
  let s = A_COEF[ 0 ] * phi0;
  for ( let j = 1; j < 6; j ++ ) s += A_COEF[ j ] * Math.sin( 2 * j * phi0 );
  return ( M0 * A_E / ( 1 + N ) ) * s;
}

/** lat/lon degrees -> { x: easting, y: northing } metres. */
function project( lat, lon, zone = ZONE_IX ) {
  const phi = rad( lat ), lam = rad( lon );
  const phi0 = rad( zone.lat0 ), lam0 = rad( zone.lon0 );
  const Abar = ( M0 * A_E / ( 1 + N ) ) * A_COEF[ 0 ];
  const S = meridian( phi0 );
  const r = 2 * Math.sqrt( N ) / ( 1 + N );
  const t = Math.sinh( atanh( Math.sin( phi ) ) - r * atanh( r * Math.sin( phi ) ) );
  const tt = Math.sqrt( 1 + t * t );
  const xi = Math.atan2( t, Math.cos( lam - lam0 ) );
  const eta = atanh( Math.sin( lam - lam0 ) / tt );
  let north = xi, east = eta;
  for ( let j = 1; j < 6; j ++ ) {
    north += ALPHA[ j ] * Math.sin( 2 * j * xi ) * Math.cosh( 2 * j * eta );
    east += ALPHA[ j ] * Math.cos( 2 * j * xi ) * Math.sinh( 2 * j * eta );
  }
  return { x: Abar * east, y: Abar * north - S };
}

/** { x: easting, y: northing } metres -> [ lat, lon ] degrees. */
function unproject( x, y, zone = ZONE_IX ) {
  const phi0 = rad( zone.lat0 ), lam0 = rad( zone.lon0 );
  const Abar = ( M0 * A_E / ( 1 + N ) ) * A_COEF[ 0 ];
  const xi = ( y + meridian( phi0 ) ) / Abar;
  const eta = x / Abar;
  let xi2 = xi, eta2 = eta;
  for ( let j = 1; j < 6; j ++ ) {
    xi2 -= BETA[ j ] * Math.sin( 2 * j * xi ) * Math.cosh( 2 * j * eta );
    eta2 -= BETA[ j ] * Math.cos( 2 * j * xi ) * Math.sinh( 2 * j * eta );
  }
  const chi = Math.asin( Math.sin( xi2 ) / Math.cosh( eta2 ) );
  let lat = chi;
  for ( let j = 1; j < 6; j ++ ) lat += DELTA[ j ] * Math.sin( 2 * j * chi );
  return [ deg( lat ), deg( lam0 + Math.atan2( Math.sinh( eta2 ), Math.cos( xi2 ) ) ) ];
}

// --- Japanese standard mesh codes -------------------------------------------
//
// PLATEAU ships one OBJ per 3rd-order mesh (roughly 1 km). Working out which
// codes a crop touches saves the caller from picking files by hand.

/** [ lat, lon ] -> 8-digit 3rd-order mesh code. */
function meshCode( lat, lon ) {
  const p = Math.floor( lat * 1.5 );
  const q = Math.floor( lon ) - 100;
  const restLat = lat - p / 1.5, restLon = lon - ( q + 100 );
  const u = Math.floor( restLat / ( ( 2 / 3 ) / 8 ) );
  const v = Math.floor( restLon / ( 1 / 8 ) );
  const m = Math.floor( ( restLat - u * ( ( 2 / 3 ) / 8 ) ) / ( ( 2 / 3 ) / 80 ) );
  const n = Math.floor( ( restLon - v * ( 1 / 8 ) ) / ( 1 / 80 ) );
  return `${ p }${ q }${ u }${ v }${ m }${ n }`;
}

// --- OBJ -> building prisms --------------------------------------------------

/**
 * The tiles are an ungrouped triangle soup: no `o`/`g` statements, no normals,
 * no UVs. Buildings come back as connected components, and the footprint as the
 * boundary of the triangulated bottom cap. Reading the footprint off the vertex
 * order does NOT work — the file lists the top ring in a different order from
 * the bottom one.
 */

const Z_EPS = 1e-4;

function parseObj( text ) {
  const V = [], F = [];
  for ( const line of text.split( '\n' ) ) {
    if ( line.startsWith( 'v ' ) ) {
      const p = line.split( /\s+/ );
      V.push( [ +p[ 1 ], +p[ 2 ], +p[ 3 ] ] );   // easting, northing, elevation
    } else if ( line.startsWith( 'f ' ) ) {
      const p = line.trim().split( /\s+/ );
      F.push( [ +p[ 1 ].split( '/' )[ 0 ] - 1, +p[ 2 ].split( '/' )[ 0 ] - 1, +p[ 3 ].split( '/' )[ 0 ] - 1 ] );
    }
  }
  return { V, F };
}

function components( nv, F ) {
  const parent = new Int32Array( nv );
  for ( let i = 0; i < nv; i ++ ) parent[ i ] = i;
  const find = a => {
    while ( parent[ a ] !== a ) { parent[ a ] = parent[ parent[ a ] ]; a = parent[ a ]; }
    return a;
  };
  for ( const f of F ) {
    let r0 = find( f[ 0 ] );
    for ( let k = 1; k < 3; k ++ ) {
      const ri = find( f[ k ] );
      if ( ri !== r0 ) { parent[ ri ] = r0; r0 = find( r0 ); }
    }
  }
  const groups = new Map();
  for ( const f of F ) {
    const r = find( f[ 0 ] );
    let g = groups.get( r );
    if ( ! g ) groups.set( r, g = [] );
    g.push( f );
  }
  return groups;
}

/** Boundary rings of a triangle set: the edges used by exactly one triangle. */
function boundaryRings( tris ) {
  const used = new Map();
  for ( const t of tris ) {
    for ( let i = 0; i < 3; i ++ ) {
      const a = t[ i ], b = t[ ( i + 1 ) % 3 ];
      const k = a < b ? `${ a },${ b }` : `${ b },${ a }`;
      used.set( k, ( used.get( k ) ?? 0 ) + 1 );
    }
  }
  const adj = new Map();
  for ( const [ k, n ] of used ) {
    if ( n !== 1 ) continue;
    const [ a, b ] = k.split( ',' ).map( Number );
    if ( ! adj.has( a ) ) adj.set( a, [] );
    if ( ! adj.has( b ) ) adj.set( b, [] );
    adj.get( a ).push( b );
    adj.get( b ).push( a );
  }
  const rings = [], seen = new Set();
  for ( const start of adj.keys() ) {
    if ( seen.has( start ) ) continue;
    const ring = [ start ];
    seen.add( start );
    let cur = start, prev = -1;
    for ( ;; ) {
      const next = ( adj.get( cur ) ?? [] ).find( n => n !== prev && ! seen.has( n ) );
      if ( next === undefined ) break;
      ring.push( next );
      seen.add( next );
      prev = cur;
      cur = next;
    }
    if ( ring.length >= 3 ) rings.push( ring );
  }
  return rings;
}

const signedArea = ring => {
  let s = 0;
  for ( let i = 0; i < ring.length; i ++ ) {
    const [ x0, y0 ] = ring[ i ], [ x1, y1 ] = ring[ ( i + 1 ) % ring.length ];
    s += x0 * y1 - x1 * y0;
  }
  return s * 0.5;
};

/** Drop repeated and collinear vertices; PLATEAU footprints carry both. */
function simplify( ring, tol = 0.05 ) {
  const out = [];
  for ( const p of ring ) {
    const last = out[ out.length - 1 ];
    if ( ! last || Math.hypot( p[ 0 ] - last[ 0 ], p[ 1 ] - last[ 1 ] ) > tol ) out.push( p );
  }
  while ( out.length > 2 && Math.hypot( out[ 0 ][ 0 ] - out[ out.length - 1 ][ 0 ], out[ 0 ][ 1 ] - out[ out.length - 1 ][ 1 ] ) <= tol ) out.pop();
  const keep = [];
  for ( let i = 0; i < out.length; i ++ ) {
    const a = out[ ( i - 1 + out.length ) % out.length ], b = out[ i ], c = out[ ( i + 1 ) % out.length ];
    const cross = ( b[ 0 ] - a[ 0 ] ) * ( c[ 1 ] - a[ 1 ] ) - ( b[ 1 ] - a[ 1 ] ) * ( c[ 0 ] - a[ 0 ] );
    if ( Math.abs( cross ) > tol ) keep.push( b );
  }
  return keep;
}

const cross2 = ( o, a, b ) => ( a[ 0 ] - o[ 0 ] ) * ( b[ 1 ] - o[ 1 ] ) - ( a[ 1 ] - o[ 1 ] ) * ( b[ 0 ] - o[ 0 ] );

/**
 * Rejects self-intersecting rings. The runtime triangulator produces garbage
 * on them rather than throwing, so they have to die here where it is visible.
 */
function isSimple( ring ) {
  const n = ring.length;
  const hits = ( p1, p2, p3, p4 ) => {
    const d1 = cross2( p3, p4, p1 ), d2 = cross2( p3, p4, p2 );
    const d3 = cross2( p1, p2, p3 ), d4 = cross2( p1, p2, p4 );
    return ( ( d1 > 0 ) !== ( d2 > 0 ) ) && ( ( d3 > 0 ) !== ( d4 > 0 ) );
  };
  for ( let i = 0; i < n; i ++ ) {
    for ( let j = i + 1; j < n; j ++ ) {
      if ( i === j || ( i + 1 ) % n === j || ( j + 1 ) % n === i ) continue;
      if ( hits( ring[ i ], ring[ ( i + 1 ) % n ], ring[ j ], ring[ ( j + 1 ) % n ] ) ) return false;
    }
  }
  return true;
}

function extractPrisms( text ) {
  const { V, F } = parseObj( text );
  const out = [];
  for ( const tris of components( V.length, F ).values() ) {
    let zmin = Infinity, zmax = -Infinity;
    for ( const t of tris ) for ( const i of t ) {
      const z = V[ i ][ 2 ];
      if ( z < zmin ) zmin = z;
      if ( z > zmax ) zmax = z;
    }
    if ( zmax - zmin < 0.5 ) continue;

    let rings = [];
    for ( const plane of [ zmin, zmax ] ) {
      const cap = tris.filter( t => t.every( i => Math.abs( V[ i ][ 2 ] - plane ) < Z_EPS ) );
      rings = boundaryRings( cap );
      if ( rings.length ) break;
    }
    if ( ! rings.length ) continue;

    let best = null, bestArea = 0;
    for ( const r of rings ) {
      const poly = r.map( i => [ V[ i ][ 0 ], V[ i ][ 1 ] ] );
      const a = Math.abs( signedArea( poly ) );
      if ( a > bestArea ) { bestArea = a; best = poly; }
    }
    let ring = simplify( best );
    if ( ring.length < 3 ) continue;
    if ( signedArea( ring ) < 0 ) ring.reverse();
    if ( ! isSimple( ring ) ) continue;

    out.push( { ring, base: zmin, height: zmax - zmin, area: Math.abs( signedArea( ring ) ) } );
  }
  return out;
}

// --- level assembly ----------------------------------------------------------

/**
 * Facade assignment. Height is the honest signal here: a 4 m shopfront and a
 * 40 m office block do not share a wall treatment, and banding by height makes
 * the skyline read as a city rather than as one extruded material.
 */
function facadeFor( b, i ) {
  if ( b.height < 7 ) return 'shopfront';
  if ( b.height < 16 ) return ( i % 3 === 0 ) ? 'tile' : 'plasterWall';
  if ( b.height < 30 ) return ( i % 2 === 0 ) ? 'officeLow' : 'tile';
  return 'officeTall';
}

/** Metres per storey. One texture tile covers exactly this. */
const STOREY = 3;

const round = ( v, dp = 2 ) => Number( v.toFixed( dp ) );

/**
 * Douglas-Peucker on a closed ring. Only the backdrop uses it: those buildings
 * are never closer than the play boundary, so a 1.2 m deviation is well under
 * a pixel, and they are 80% of the file before simplification.
 */
function decimate( ring, tol ) {
  if ( ring.length <= 4 ) return ring;
  const keep = new Uint8Array( ring.length );
  keep[ 0 ] = 1;
  const dist = ( p, a, b ) => {
    const dx = b[ 0 ] - a[ 0 ], dz = b[ 1 ] - a[ 1 ];
    const len = Math.hypot( dx, dz );
    if ( len < 1e-9 ) return Math.hypot( p[ 0 ] - a[ 0 ], p[ 1 ] - a[ 1 ] );
    return Math.abs( ( p[ 0 ] - a[ 0 ] ) * dz - ( p[ 1 ] - a[ 1 ] ) * dx ) / len;
  };
  const walk = ( lo, hi ) => {
    if ( hi <= lo + 1 ) return;
    let worst = -1, at = -1;
    for ( let i = lo + 1; i < hi; i ++ ) {
      const d = dist( ring[ i ], ring[ lo ], ring[ hi % ring.length ] );
      if ( d > worst ) { worst = d; at = i; }
    }
    if ( worst < tol ) return;
    keep[ at ] = 1;
    walk( lo, at );
    walk( at, hi );
  };
  // Split at the two extreme points so the closed ring becomes two open chains.
  let far = 1, best = -1;
  for ( let i = 1; i < ring.length; i ++ ) {
    const d = Math.hypot( ring[ i ][ 0 ] - ring[ 0 ][ 0 ], ring[ i ][ 1 ] - ring[ 0 ][ 1 ] );
    if ( d > best ) { best = d; far = i; }
  }
  keep[ far ] = 1;
  walk( 0, far );
  walk( far, ring.length );
  const out = ring.filter( ( _, i ) => keep[ i ] );
  return out.length >= 3 ? out : ring;
}

/**
 * Spawn points on the street. Samples a grid, keeps anything with clearance
 * from every building, then thins to a spread-out set — clustered spawns put
 * the whole squad in one alley.
 */
function streetPoints( boxes, half, { clearance = 2.2, spacing = 22, limit = 16 } ) {
  const candidates = [];
  for ( let x = -half + 6; x <= half - 6; x += 2 ) {
    for ( let z = -half + 6; z <= half - 6; z += 2 ) {
      let clear = true, nearest = Infinity;
      for ( const b of boxes ) {
        const dx = Math.max( b.minX - x, 0, x - b.maxX );
        const dz = Math.max( b.minZ - z, 0, z - b.maxZ );
        const d = Math.hypot( dx, dz );
        if ( d < clearance ) { clear = false; break; }
        if ( d < nearest ) nearest = d;
      }
      // Prefer points with a little room but still in the street network, not
      // marooned in the middle of a car park.
      if ( clear && nearest < 14 ) candidates.push( { x, z, nearest } );
    }
  }
  candidates.sort( ( a, b ) => b.nearest - a.nearest );
  const picked = [];
  for ( const c of candidates ) {
    if ( picked.every( p => Math.hypot( p.x - c.x, p.z - c.z ) >= spacing ) ) picked.push( c );
    if ( picked.length >= limit ) break;
  }
  return picked;
}

// --- materials ---------------------------------------------------------------
//
// Kept in the generator rather than a shared file so a level JSON stays a
// self-contained description: one file, one map, no cross-level coupling.

function materials() {
  // One texture tile is one storey: the elements below set `uvScale` to
  // STOREY, and every pattern uses `rows: 1`. That makes `cols` read directly
  // as "windows per STOREY metres of wall", so a facade is specified in the
  // units a building is actually built in rather than in texture space.
  return {
    asphalt: {
      kind: 'surface',
      surface: { size: 512, tint: [ 0.30, 0.30, 0.32 ], contrast: 0.12, roughBase: 0.9, roughVar: 0.1, bump: 0.5, period: 24, repeat: 76, seed: 3 },
      metalness: 0.02, normalScale: [ 0.5, 0.5 ],
    },
    // Ground-floor retail: one wide bay per 1.5 m, most of it lit.
    shopfront: {
      kind: 'surface',
      surface: { size: 512, tint: [ 0.50, 0.48, 0.48 ], contrast: 0.42, roughBase: 0.42, roughVar: 0.3, bump: 0.9, period: 6, repeat: 1, seed: 23,
        pattern: { kind: 'window', cols: 2, rows: 1, sill: 0.09, lit: 0.55, seed: 3 } },
      metalness: 0.16, normalScale: [ 0.9, 0.9 ],
    },
    // Low-rise plaster: small punched windows, few of them lit.
    plasterWall: {
      kind: 'surface',
      surface: { size: 512, tint: [ 0.68, 0.66, 0.62 ], contrast: 0.40, roughBase: 0.84, roughVar: 0.2, bump: 1.0, period: 9, repeat: 1, seed: 41,
        pattern: { kind: 'window', cols: 2, rows: 1, sill: 0.28, lit: 0.16, seed: 11 } },
      metalness: 0, normalScale: [ 0.9, 0.9 ],
    },
    // Tiled mid-rise, the default Japanese commercial block.
    tile: {
      kind: 'surface',
      surface: { size: 512, tint: [ 0.56, 0.54, 0.52 ], contrast: 0.40, roughBase: 0.66, roughVar: 0.22, bump: 1.0, period: 5, repeat: 1, seed: 67,
        pattern: { kind: 'window', cols: 2, rows: 1, sill: 0.22, lit: 0.26, seed: 29 } },
      metalness: 0.06, normalScale: [ 1.0, 1.0 ],
    },
    officeLow: {
      kind: 'surface',
      surface: { size: 512, tint: [ 0.44, 0.45, 0.48 ], contrast: 0.42, roughBase: 0.46, roughVar: 0.24, bump: 1.0, period: 7, repeat: 1, seed: 89,
        pattern: { kind: 'window', cols: 3, rows: 1, sill: 0.15, lit: 0.30, seed: 47 } },
      metalness: 0.26, normalScale: [ 1.0, 1.0 ],
    },
    // Ribbon glazing: the sill shrinks and the glass runs together.
    officeTall: {
      kind: 'surface',
      surface: { size: 512, tint: [ 0.38, 0.40, 0.44 ], contrast: 0.40, roughBase: 0.32, roughVar: 0.2, bump: 0.85, period: 8, repeat: 1, seed: 101,
        pattern: { kind: 'window', cols: 3, rows: 1, sill: 0.10, lit: 0.34, seed: 61 } },
      metalness: 0.38, normalScale: [ 0.95, 0.95 ],
    },
    // Scenery beyond the play boundary. It is never walked up to, but it IS
    // looked at from twenty metres, so it needs windows like everything else —
    // just a coarser grid, which also keeps it from aliasing at distance.
    backdrop: {
      kind: 'surface',
      surface: { size: 512, tint: [ 0.50, 0.50, 0.52 ], contrast: 0.36, roughBase: 0.72, roughVar: 0.18, bump: 0.7, period: 7, repeat: 1, seed: 131,
        pattern: { kind: 'window', cols: 2, rows: 1, sill: 0.20, lit: 0.24, seed: 71 } },
      metalness: 0.1, normalScale: [ 0.7, 0.7 ],
    },
  };
}

// --- main --------------------------------------------------------------------

function arg( name, fallback ) {
  const i = process.argv.indexOf( `--${ name }` );
  if ( i === -1 ) {
    if ( fallback === undefined ) throw new Error( `build-plateau: missing --${ name }` );
    return fallback;
  }
  return process.argv[ i + 1 ];
}

function findObjTiles( dir ) {
  const found = new Map();
  const walk = d => {
    for ( const entry of readdirSync( d ) ) {
      const p = join( d, entry );
      if ( statSync( p ).isDirectory() ) walk( p );
      else {
        const m = entry.match( /^(\d{8})_bldg_\d+\.obj$/ );
        if ( m ) found.set( m[ 1 ], p );
      }
    }
  };
  walk( dir );
  return found;
}

function main() {
  const src = arg( 'src' );
  const lat = Number( arg( 'lat' ) );
  const lon = Number( arg( 'lon' ) );
  const size = Number( arg( 'size', '200' ) );
  const name = arg( 'name' );
  const title = arg( 'title', name );
  const out = arg( 'out', `src/world/levels/${ name }.json` );
  // 440 m by default: at the fog densities in Environment.js less than 2% of
  // anything further away survives to the camera.
  const backdropSize = Math.round( Number( arg( 'backdrop', String( size * 2.2 ) ) ) );

  const half = size / 2;
  const backHalf = backdropSize / 2;
  const centre = project( lat, lon );

  // Every 3rd-order mesh the backdrop radius touches. One tile is ~1 km, so a
  // 640 m backdrop can straddle four of them.
  const tiles = findObjTiles( src );
  const need = new Set();
  for ( const dx of [ -backHalf, 0, backHalf ] ) {
    for ( const dy of [ -backHalf, 0, backHalf ] ) {
      const [ la, lo ] = unproject( centre.x + dx, centre.y + dy );
      need.add( meshCode( la, lo ) );
    }
  }

  const used = [];
  let all = [];
  for ( const code of [ ...need ].sort() ) {
    const path = tiles.get( code );
    if ( ! path ) { console.warn( `  tile ${ code }: not found in --src, skipping` ); continue; }
    const prisms = extractPrisms( readFileSync( path, 'utf8' ) );
    console.log( `  tile ${ code }: ${ prisms.length } buildings` );
    used.push( code );
    all = all.concat( prisms );
  }
  if ( ! used.length ) throw new Error( 'build-plateau: no source tiles matched the requested area' );

  // Project into game space: +X east, +Z south, +Y up. Buildings are dropped
  // onto a flat ground plane — PLATEAU bases follow terrain, and a shooter
  // arena with a 6 m elevation gradient plays badly and looks like a bug.
  const toGame = b => {
    const ring = b.ring.map( ( [ e, n ] ) => [ e - centre.x, -( n - centre.y ) ] );
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, cx = 0, cz = 0;
    for ( const [ x, z ] of ring ) {
      minX = Math.min( minX, x ); maxX = Math.max( maxX, x );
      minZ = Math.min( minZ, z ); maxZ = Math.max( maxZ, z );
      cx += x; cz += z;
    }
    // The east->+X, north->-Z flip mirrors the plane, so the winding flips too.
    if ( signedArea( ring ) < 0 ) ring.reverse();
    return { ring, height: b.height, area: b.area, minX, maxX, minZ, maxZ,
      cx: cx / ring.length, cz: cz / ring.length };
  };

  // A 20 m setback: without it a backdrop building can sit against the invisible
  // wall, and the first thing the player sees is scenery they cannot reach.
  const SETBACK = 20;
  const inSquare = ( b, h ) => Math.abs( b.cx ) <= h && Math.abs( b.cz ) <= h;
  const game = all.map( toGame );
  const play = game.filter( b => inSquare( b, half ) );
  const backdrop = game.filter( b => ! inSquare( b, half + SETBACK ) && inSquare( b, backHalf ) );

  // Group by facade so each material becomes one merged draw call.
  const byMaterial = new Map();
  play.forEach( ( b, i ) => {
    const m = facadeFor( b, i );
    if ( ! byMaterial.has( m ) ) byMaterial.set( m, [] );
    byMaterial.get( m ).push( b );
  } );

  // Play geometry keeps centimetre precision — the player stands against these
  // walls. The backdrop is decimated and rounded to 10 cm.
  const emit = ( b, dp = 2, tol = 0 ) => {
    const ring = tol ? decimate( b.ring, tol ) : b.ring;
    return { h: round( b.height, dp ), ring: ring.flatMap( ( [ x, z ] ) => [ round( x, dp ), round( z, dp ) ] ) };
  };

  const elements = [];
  for ( const [ material, list ] of [ ...byMaterial ].sort( ( a, b ) => a[ 0 ].localeCompare( b[ 0 ] ) ) ) {
    elements.push( { type: 'prisms', material, uvScale: STOREY, buildings: list.map( b => emit( b ) ) } );
  }
  // The backdrop is scenery: no collision, no shadow casting, no raycast target.
  // Without it the map ends in a void 100 m from the player.
  elements.push( {
    type: 'prisms', material: 'backdrop', uvScale: STOREY, collide: false, cast: false, hittable: false,
    buildings: backdrop.map( b => emit( b, 1, 1.2 ) ),
  } );

  // Invisible walls at the play boundary. The backdrop is walk-through scenery,
  // so something has to stop the player wandering into it.
  const T = 2, H = 40;
  for ( const [ sx, sz, dx, dz ] of [ [ 0, -half - T, half + T, T ], [ 0, half + T, half + T, T ],
    [ -half - T, 0, T, half + T ], [ half + T, 0, T, half + T ] ] ) {
    elements.push( { type: 'box', material: 'backdrop', visible: false, cast: false,
      size: [ dx * 2, H, dz * 2 ], pos: [ sx, H / 2, sz ] } );
  }

  const boxes = play;
  const spawns = streetPoints( boxes, half, {} );
  if ( spawns.length < 6 ) throw new Error( `build-plateau: only ${ spawns.length } spawn points; the crop is too built-up` );

  // The player starts at whichever clear point sits deepest inside the block.
  // `streetPoints` ranks by openness, and the most open spot in a city block is
  // reliably its outer edge — which puts the player facing the backdrop.
  const start = spawns.reduce( ( best, p ) =>
    ( Math.hypot( p.x, p.z ) < Math.hypot( best.x, best.z ) ? p : best ), spawns[ 0 ] );

  const level = {
    name: title,
    attribution: '3D都市モデル（Project PLATEAU）／国土交通省 — https://www.mlit.go.jp/plateau/',
    source: {
      dataset: 'plateau-tokyo23ku-obj4-2020 (LOD1)',
      tiles: used,
      centre: [ round( lat, 6 ), round( lon, 6 ) ],
      size,
      crs: 'EPSG:6677',
    },
    ground: { material: 'asphalt', size: Math.round( backdropSize + 120 ) },
    playerStart: [ round( start.x ), 0, round( start.z ) ],
    materials: materials(),
    elements,
    spawnPoints: spawns.filter( p => p !== start ).map( p => [ round( p.x ), 0, round( p.z ) ] ),
  };

  // Indent the structure but collapse pure-number arrays onto one line: with
  // one ring coordinate per line the formatting outweighs the geometry.
  const json = JSON.stringify( level, null, 1 )
    .replace( /\[\s+(-?[\d.]+(?:,\s+-?[\d.]+)*)\s+\]/g, ( _, body ) => `[ ${ body.replace( /\s+/g, ' ' ) } ]` );
  writeFileSync( out, json + '\n' );

  const tris = play.reduce( ( n, b ) => n + b.ring.length * 2 + ( b.ring.length - 2 ), 0 )
    + backdrop.reduce( ( n, b ) => n + b.ring.length * 2 + ( b.ring.length - 2 ), 0 );
  console.log( `\n${ out }` );
  console.log( `  centre      ${ lat }, ${ lon }  (${ round( centre.x ) }, ${ round( centre.y ) } in EPSG:6677)` );
  console.log( `  play        ${ play.length } buildings in ${ size } m square` );
  console.log( `  backdrop    ${ backdrop.length } buildings out to ${ backdropSize } m` );
  console.log( `  draw calls  ${ elements.filter( e => e.type === 'prisms' ).length } merged + ${ elements.length - byMaterial.size - 1 } walls` );
  console.log( `  triangles   ~${ tris }` );
  console.log( `  colliders   ${ play.length + 4 }` );
  console.log( `  spawns      ${ spawns.length - 1 } (+ player start)` );
  console.log( `  size        ${ ( statSync( out ).size / 1024 ).toFixed( 1 ) } KB` );
}

main();
