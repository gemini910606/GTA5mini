/**
 * Regenerates the embedded IBL probe in `src/world/hdri.generated.js`.
 *
 * Run by hand, not by the build — the output is committed so `npm run build`
 * never needs the network, which is what keeps the artifact's zero-request
 * claim true.
 *
 *   node tools/build-hdri.mjs [polyhaven-slug]
 *
 * Why the payload is small: this map is only ever fed to PMREMGenerator for
 * image-based lighting. PMREM's roughness mips blur well past 256x128, and the
 * shiniest material in the level is metal at roughness 0.4, so a larger source
 * costs bytes without reaching the screen. Measured for cedar_bridge_sunset_1:
 * 512x256 is 683 KB of base64 against 171 KB here, on a 0.84 MB artifact.
 */
import { writeFileSync } from 'node:fs';

const SLUG = process.argv[ 2 ] ?? 'cedar_bridge_sunset_1';
const OUT = new URL( '../src/world/hdri.generated.js', import.meta.url ).pathname;
const TARGET_WIDTH = 256;

// Matches the cap Environment applies to the procedural sky. A Radiance sky
// carries its solar disc at ~2e4, and the scene already lights itself with a
// DirectionalLight, so an unclamped probe double-counts the sun and saturates
// the bloom chain at any threshold.
const CLAMP = 4.5;

// ---------------------------------------------------------------------------
// Radiance .hdr (RGBE), new-style RLE scanlines only — what Poly Haven serves.
// ---------------------------------------------------------------------------

function decode( buf ) {
  let p = 0;
  const line = () => {
    let s = '';
    while ( buf[ p ] !== 0x0a ) s += String.fromCharCode( buf[ p ++ ] );
    p ++;
    return s;
  };
  if ( ! line().startsWith( '#?' ) ) throw new Error( 'not a Radiance file' );
  while ( line() !== '' ) { /* FORMAT=, EXPOSURE=, comments */ }
  const dim = line().match( /^-Y (\d+) \+X (\d+)$/ );
  if ( ! dim ) throw new Error( 'unsupported resolution line' );
  const height = + dim[ 1 ], width = + dim[ 2 ];

  const data = new Float32Array( width * height * 3 );
  const row = new Uint8Array( width * 4 );

  for ( let y = 0; y < height; y ++ ) {
    const isRLE = buf[ p ] === 2 && buf[ p + 1 ] === 2
      && ( ( buf[ p + 2 ] << 8 ) | buf[ p + 3 ] ) === width
      && width >= 8 && width < 0x8000;
    if ( ! isRLE ) throw new Error( `flat scanlines unsupported (row ${ y })` );
    p += 4;
    for ( let c = 0; c < 4; c ++ ) {
      let x = 0;
      while ( x < width ) {
        let count = buf[ p ++ ];
        if ( count > 128 ) {
          const v = buf[ p ++ ];
          for ( let i = 0, n = count - 128; i < n; i ++ ) row[ ( x ++ ) * 4 + c ] = v;
        } else {
          for ( let i = 0; i < count; i ++ ) row[ ( x ++ ) * 4 + c ] = buf[ p ++ ];
        }
      }
    }
    for ( let x = 0; x < width; x ++ ) {
      const e = row[ x * 4 + 3 ];
      const f = e === 0 ? 0 : Math.pow( 2, e - 136 );   // 2^(e-128) / 256
      const i = ( y * width + x ) * 3;
      data[ i ]     = row[ x * 4 ]     * f;
      data[ i + 1 ] = row[ x * 4 + 1 ] * f;
      data[ i + 2 ] = row[ x * 4 + 2 ] * f;
    }
  }
  return { width, height, data };
}

/** Box filter by an integer factor. Averaging in linear light is the point. */
function downsample( img, factor ) {
  const w = img.width / factor | 0, h = img.height / factor | 0;
  const out = new Float32Array( w * h * 3 );
  const n = factor * factor;
  for ( let y = 0; y < h; y ++ ) {
    for ( let x = 0; x < w; x ++ ) {
      let r = 0, g = 0, b = 0;
      for ( let dy = 0; dy < factor; dy ++ ) {
        for ( let dx = 0; dx < factor; dx ++ ) {
          const i = ( ( y * factor + dy ) * img.width + ( x * factor + dx ) ) * 3;
          r += img.data[ i ]; g += img.data[ i + 1 ]; b += img.data[ i + 2 ];
        }
      }
      const o = ( y * w + x ) * 3;
      out[ o ] = r / n; out[ o + 1 ] = g / n; out[ o + 2 ] = b / n;
    }
  }
  return { width: w, height: h, data: out };
}

function encodeRGBE( img ) {
  const out = Buffer.alloc( img.width * img.height * 4 );
  for ( let i = 0, o = 0; i < img.data.length; i += 3, o += 4 ) {
    const r = img.data[ i ], g = img.data[ i + 1 ], b = img.data[ i + 2 ];
    const m = Math.max( r, g, b );
    if ( m < 1e-32 ) continue;                       // buffer is already zeroed
    const e = Math.ceil( Math.log2( m ) );
    const s = Math.pow( 2, - e ) * 256;
    out[ o ]     = Math.min( 255, Math.round( r * s ) );
    out[ o + 1 ] = Math.min( 255, Math.round( g * s ) );
    out[ o + 2 ] = Math.min( 255, Math.round( b * s ) );
    out[ o + 3 ] = e + 128;
  }
  return out;
}

const luma = ( d, i ) => 0.2126 * d[ i ] + 0.7152 * d[ i + 1 ] + 0.0722 * d[ i + 2 ];

// ---------------------------------------------------------------------------

const meta = await ( await fetch( `https://api.polyhaven.com/assets?t=hdris` ) ).json();
const asset = meta[ SLUG ];
if ( ! asset ) throw new Error( `no such Poly Haven HDRI: ${ SLUG }` );

const files = await ( await fetch( `https://api.polyhaven.com/files/${ SLUG }` ) ).json();
const src = files.hdri[ '1k' ].hdr;
console.log( `${ SLUG }: fetching 1k (${ ( src.size / 1024 / 1024 ).toFixed( 2 ) } MB)` );

const img = decode( Buffer.from( await ( await fetch( src.url ) ).arrayBuffer() ) );
console.log( `decoded ${ img.width }x${ img.height }` );

const small = downsample( img, img.width / TARGET_WIDTH );

let peak = 0, clipped = 0;
for ( let i = 0; i < small.data.length; i += 3 ) peak = Math.max( peak, luma( small.data, i ) );
for ( let i = 0; i < small.data.length; i ++ ) {
  if ( small.data[ i ] > CLAMP ) { small.data[ i ] = CLAMP; clipped ++; }
}

let sum = 0;
for ( let i = 0; i < small.data.length; i += 3 ) sum += luma( small.data, i );
const mean = sum / ( small.data.length / 3 );

const payload = encodeRGBE( small ).toString( 'base64' );
console.log(
  `${ small.width }x${ small.height } | peak luma ${ peak.toFixed( 0 ) } -> clamped at ${ CLAMP }`
  + ` (${ ( 100 * clipped / small.data.length ).toFixed( 2 ) }% of channels)`
  + ` | mean luma ${ mean.toFixed( 4 ) } | ${ ( payload.length / 1024 ).toFixed( 0 ) } KB base64`,
);

const authors = Object.keys( asset.authors ?? {} ).join( ', ' );

writeFileSync( OUT, `// Generated by tools/build-hdri.mjs — do not edit by hand.
//
// ${ asset.name } by ${ authors }, from Poly Haven (https://polyhaven.com/a/${ SLUG }).
// Licensed CC0: no attribution required, credited anyway. See README.
//
// Downsampled to ${ small.width }x${ small.height } and clamped to ${ CLAMP } linear, matching the cap
// Environment applies to the procedural sky. The source peaks at ${ peak.toFixed( 0 ) } linear
// because the solar disc is baked in; the scene lights itself with a real
// DirectionalLight, so leaving that in would double-count the sun.
//
// Payload is flat RGBE (4 bytes/texel), base64. Decoded in Environment.js.

export const HDRI = {
  slug: ${ JSON.stringify( SLUG ) },
  name: ${ JSON.stringify( asset.name ) },
  authors: ${ JSON.stringify( authors ) },
  width: ${ small.width },
  height: ${ small.height },
  clamp: ${ CLAMP },
  meanLuma: ${ mean.toFixed( 6 ) },
  rgbe: '${ payload }',
};
` );
console.log( `wrote ${ OUT }` );
