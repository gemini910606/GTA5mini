import * as THREE from 'three';

/**
 * Procedural, tileable PBR texture generation.
 *
 * Every surface in the prototype gets its albedo/roughness/normal from here, so
 * the repo stays asset-free. Swapping these for scanned Megascans/ambientCG maps
 * is the single biggest visual upgrade available — see docs/SPEC.md.
 */

const cache = new Map();

// ---------------------------------------------------------------------------
// Tileable value-noise fBm
// ---------------------------------------------------------------------------

function hash2( x, y, seed ) {
  let h = x * 374761393 + y * 668265263 + seed * 1442695040888963407;
  h = ( h ^ ( h >>> 13 ) ) * 1274126177;
  return ( ( h ^ ( h >>> 16 ) ) >>> 0 ) / 4294967295;
}

const fade = t => t * t * t * ( t * ( t * 6 - 15 ) + 10 );

/** Value noise on a `period`-wide integer lattice, so it wraps seamlessly. */
function valueNoise( x, y, period, seed ) {
  const xi = Math.floor( x ), yi = Math.floor( y );
  const xf = x - xi, yf = y - yi;
  const w = ( n ) => ( ( n % period ) + period ) % period;

  const x0 = w( xi ), x1 = w( xi + 1 );
  const y0 = w( yi ), y1 = w( yi + 1 );

  const n00 = hash2( x0, y0, seed ), n10 = hash2( x1, y0, seed );
  const n01 = hash2( x0, y1, seed ), n11 = hash2( x1, y1, seed );

  const u = fade( xf ), v = fade( yf );
  return ( n00 * ( 1 - u ) + n10 * u ) * ( 1 - v ) +
         ( n01 * ( 1 - u ) + n11 * u ) * v;
}

function fbm( x, y, basePeriod, octaves, seed ) {
  let sum = 0, amp = 1, norm = 0, period = basePeriod, freq = basePeriod;
  for ( let o = 0; o < octaves; o ++ ) {
    sum += valueNoise( x * freq, y * freq, period, seed + o * 101 ) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
    period *= 2;
  }
  return sum / norm;
}

// ---------------------------------------------------------------------------
// Height field -> maps
// ---------------------------------------------------------------------------

function makeCanvas( size ) {
  const c = document.createElement( 'canvas' );
  c.width = c.height = size;
  return c;
}

function finish( canvas, repeat, colorSpace ) {
  const tex = new THREE.CanvasTexture( canvas );
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set( repeat, repeat );
  tex.anisotropy = 8;
  if ( colorSpace ) tex.colorSpace = colorSpace;
  return tex;
}

/**
 * Builds an albedo + roughness + normal set from one height field.
 *
 * @param {object} o
 * @param {number} o.size      texture resolution (power of two)
 * @param {number[]} o.tint    base linear-ish RGB, 0..1
 * @param {number} o.contrast  how much the height field darkens the albedo
 * @param {number} o.roughBase midpoint roughness
 * @param {number} o.roughVar  roughness swing driven by the height field
 * @param {number} o.bump      normal-map strength
 * @param {number} o.period    lattice period; lower = larger features
 * @param {number} o.repeat    UV repeat applied to the resulting textures
 * @param {number} o.seed
 * @param {(x:number,y:number,h:number)=>number} [o.pattern]
 *        optional overlay run in UV space (0..1), returns the final height
 */
export function makeSurface( o ) {
  const key = JSON.stringify( { ...o, pattern: o.pattern ? o.pattern.toString() : null } );
  if ( cache.has( key ) ) return cache.get( key );

  const {
    size = 512, tint = [ 0.5, 0.5, 0.5 ], contrast = 0.35,
    roughBase = 0.75, roughVar = 0.25, bump = 1.0,
    period = 8, repeat = 1, seed = 1, pattern = null,
  } = o;

  // 1. Height field ---------------------------------------------------------
  const height = new Float32Array( size * size );
  for ( let y = 0; y < size; y ++ ) {
    for ( let x = 0; x < size; x ++ ) {
      const u = x / size, v = y / size;
      let h = fbm( u, v, period, 5, seed );
      if ( pattern ) h = pattern( u, v, h );
      height[ y * size + x ] = h;
    }
  }

  // 2. Albedo + roughness (packed as grayscale) -----------------------------
  const albedoCanvas = makeCanvas( size );
  const roughCanvas = makeCanvas( size );
  const aCtx = albedoCanvas.getContext( '2d' );
  const rCtx = roughCanvas.getContext( '2d' );
  const aImg = aCtx.createImageData( size, size );
  const rImg = rCtx.createImageData( size, size );

  for ( let i = 0; i < size * size; i ++ ) {
    const h = height[ i ];
    const shade = 1 - contrast + h * contrast * 2;

    aImg.data[ i * 4 + 0 ] = Math.min( 255, Math.max( 0, tint[ 0 ] * shade * 255 ) );
    aImg.data[ i * 4 + 1 ] = Math.min( 255, Math.max( 0, tint[ 1 ] * shade * 255 ) );
    aImg.data[ i * 4 + 2 ] = Math.min( 255, Math.max( 0, tint[ 2 ] * shade * 255 ) );
    aImg.data[ i * 4 + 3 ] = 255;

    // Rougher where the surface is pitted, smoother on the high spots.
    const r = Math.min( 1, Math.max( 0, roughBase + ( 0.5 - h ) * roughVar * 2 ) );
    const rv = r * 255;
    rImg.data[ i * 4 + 0 ] = rv;
    rImg.data[ i * 4 + 1 ] = rv;
    rImg.data[ i * 4 + 2 ] = rv;
    rImg.data[ i * 4 + 3 ] = 255;
  }
  aCtx.putImageData( aImg, 0, 0 );
  rCtx.putImageData( rImg, 0, 0 );

  // 3. Normal map, Sobel-differentiated from the height field ---------------
  const normalCanvas = makeCanvas( size );
  const nCtx = normalCanvas.getContext( '2d' );
  const nImg = nCtx.createImageData( size, size );
  const at = ( x, y ) => height[ ( ( y + size ) % size ) * size + ( ( x + size ) % size ) ];

  for ( let y = 0; y < size; y ++ ) {
    for ( let x = 0; x < size; x ++ ) {
      const dx =
        ( at( x + 1, y - 1 ) + 2 * at( x + 1, y ) + at( x + 1, y + 1 ) ) -
        ( at( x - 1, y - 1 ) + 2 * at( x - 1, y ) + at( x - 1, y + 1 ) );
      const dy =
        ( at( x - 1, y + 1 ) + 2 * at( x, y + 1 ) + at( x + 1, y + 1 ) ) -
        ( at( x - 1, y - 1 ) + 2 * at( x, y - 1 ) + at( x + 1, y - 1 ) );

      let nx = -dx * bump * 2, ny = -dy * bump * 2, nz = 1;
      const len = Math.hypot( nx, ny, nz );
      nx /= len; ny /= len; nz /= len;

      const i = ( y * size + x ) * 4;
      nImg.data[ i + 0 ] = ( nx * 0.5 + 0.5 ) * 255;
      nImg.data[ i + 1 ] = ( ny * 0.5 + 0.5 ) * 255;
      nImg.data[ i + 2 ] = ( nz * 0.5 + 0.5 ) * 255;
      nImg.data[ i + 3 ] = 255;
    }
  }
  nCtx.putImageData( nImg, 0, 0 );

  const result = {
    map:          finish( albedoCanvas, repeat, THREE.SRGBColorSpace ),
    roughnessMap: finish( roughCanvas, repeat ),
    normalMap:    finish( normalCanvas, repeat ),
  };

  cache.set( key, result );
  return result;
}

// ---------------------------------------------------------------------------
// Pattern overlays
// ---------------------------------------------------------------------------

/** Rectangular brick/panel courses cut into the height field. */
export function panelPattern( cols, rows, groove = 0.03, offsetAlternate = true ) {
  return ( u, v, h ) => {
    const row = Math.floor( v * rows );
    const shift = offsetAlternate && row % 2 === 1 ? 0.5 / cols : 0;
    const cu = ( u + shift ) * cols;
    const cv = v * rows;
    // Distance to the nearest cell edge, measured in CELL units. Dividing by
    // cols/rows here (as an earlier version did) makes `du` smaller than any
    // sane groove width, so every texel reads as mortar and the surface turns
    // into horizontal blinds.
    const du = Math.abs( cu - Math.round( cu ) );
    const dv = Math.abs( cv - Math.round( cv ) );
    const inGroove = du < groove || dv < groove;
    // Per-brick tonal variation keeps courses from reading as a flat grid.
    const brickTone = ( hash2( Math.floor( cu ), row, 77 ) - 0.5 ) * 0.25;
    return inGroove ? h * 0.25 : Math.min( 1, h * 0.7 + 0.3 + brickTone );
  };
}

/** Concentric wear rings + directional scoring, for metal plate. */
export function metalPattern( ridges = 26 ) {
  return ( u, v, h ) => {
    const streak = Math.sin( v * Math.PI * ridges ) * 0.5 + 0.5;
    return Math.min( 1, h * 0.45 + streak * 0.2 + 0.35 );
  };
}
