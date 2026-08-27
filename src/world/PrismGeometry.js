import * as THREE from 'three';

/**
 * Builds one merged geometry from a list of extruded polygon footprints.
 *
 * Split out of `Level` so it can be exercised without a WebGL context or a
 * canvas: `tools/test-level.mjs` imports this directly and checks the face
 * winding, which is the one property here that a screenshot will not reveal —
 * an inside-out building still looks solid, because the near walls are culled
 * and you end up looking at the inside of the far ones.
 *
 * Depends on nothing but three's own maths.
 */

/**
 * @param {Array<{ h: number, ring: number[] }>} buildings
 *   `ring` is a flat [ x0, z0, x1, z1, ... ] footprint; `h` is the height in
 *   metres above the ground plane.
 * @param {number} uvScale metres per texture tile.
 * @returns {{ geometry: THREE.BufferGeometry, boxes: THREE.Box3[] }}
 */
export function buildPrisms( buildings, uvScale = 6 ) {
  let vertexCount = 0;
  for ( const b of buildings ) {
    const n = b.ring.length / 2;
    if ( n < 3 ) continue;
    vertexCount += n * 6 + ( n - 2 ) * 3;      // walls: 2 tris per edge, roof: n - 2
  }

  const position = new Float32Array( vertexCount * 3 );
  const uv = new Float32Array( vertexCount * 2 );
  const boxes = [];
  let v = 0;

  const contour = [];
  const write = ( x, y, z, u, w ) => {
    position[ v * 3 ] = x; position[ v * 3 + 1 ] = y; position[ v * 3 + 2 ] = z;
    uv[ v * 2 ] = u; uv[ v * 2 + 1 ] = w;
    v ++;
  };

  for ( const b of buildings ) {
    const ring = b.ring;
    const n = ring.length / 2;
    if ( n < 3 ) continue;
    const top = b.h;

    // Walls.
    //
    // The winding is the easy thing to get backwards here. Footprints arrive
    // with a positive signed area in ( x, z ), and for that orientation the
    // outward-facing triangles are ( p0 bottom, p1 top, p1 bottom ) and
    // ( p0 bottom, p0 top, p1 top ).
    let run = 0;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for ( let i = 0; i < n; i ++ ) {
      const x0 = ring[ i * 2 ], z0 = ring[ i * 2 + 1 ];
      const j = ( i + 1 ) % n;
      const x1 = ring[ j * 2 ], z1 = ring[ j * 2 + 1 ];
      const len = Math.hypot( x1 - x0, z1 - z0 );
      const u0 = run / uvScale, u1 = ( run + len ) / uvScale;
      const vt = top / uvScale;
      run += len;

      write( x0, 0, z0, u0, 0 );
      write( x1, top, z1, u1, vt );
      write( x1, 0, z1, u1, 0 );

      write( x0, 0, z0, u0, 0 );
      write( x0, top, z0, u0, vt );
      write( x1, top, z1, u1, vt );

      if ( x0 < minX ) minX = x0;
      if ( x0 > maxX ) maxX = x0;
      if ( z0 < minZ ) minZ = z0;
      if ( z0 > maxZ ) maxZ = z0;
    }

    // Roof. `triangulateShape` wants a clockwise contour, the same check
    // ExtrudeGeometry makes before calling it, and returns triangles in that
    // same clockwise order — which points the face down, so each one is
    // reversed on the way out.
    contour.length = 0;
    for ( let i = 0; i < n; i ++ ) contour.push( new THREE.Vector2( ring[ i * 2 ], ring[ i * 2 + 1 ] ) );
    if ( ! THREE.ShapeUtils.isClockWise( contour ) ) contour.reverse();
    for ( const [ a, b2, c ] of THREE.ShapeUtils.triangulateShape( contour, [] ) ) {
      for ( const k of [ a, c, b2 ] ) {
        const p = contour[ k ];
        write( p.x, top, p.y, p.x / uvScale, p.y / uvScale );
      }
    }

    // Collision uses the footprint AABB rather than the polygon. A city block
    // is close enough to its bounding box that the difference is invisible in
    // play, and the solver only consumes boxes anyway.
    boxes.push( new THREE.Box3(
      new THREE.Vector3( minX, 0, minZ ), new THREE.Vector3( maxX, top, maxZ ),
    ) );
  }

  const geometry = new THREE.BufferGeometry();
  // `v` can fall short of the estimate when a footprint defeats the
  // triangulator; trim so the tail is not a cloud of degenerate origin faces.
  geometry.setAttribute( 'position', new THREE.BufferAttribute( position.subarray( 0, v * 3 ), 3 ) );
  geometry.setAttribute( 'uv', new THREE.BufferAttribute( uv.subarray( 0, v * 2 ), 2 ) );
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  return { geometry, boxes };
}
