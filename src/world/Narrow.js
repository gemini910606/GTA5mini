import * as THREE from 'three';

/**
 * Narrow-phase tests against an extruded polygon footprint.
 *
 * The broad phase indexes bounding boxes, which is the right thing for culling
 * and the wrong thing to stop a bullet with. A Tokyo footprint is an L, a T or
 * a wedge far more often than it is a rectangle: measured over the three
 * Shinjuku maps, the bounding boxes carry 19% to 43% more volume than the
 * buildings do. That difference is not a rounding — it is alleys you can see
 * and cannot walk into, and cover that stops shots it should not.
 *
 * So a prism collider keeps its AABB for the grid and answers the actual
 * question here. Everything is 2D in ( x, z ) plus a height slab, because the
 * buildings are prisms: there is no third dimension to the problem.
 *
 * Rings are flat `[ x0, z0, x1, z1, ... ]`, wound with a positive signed area,
 * and may be concave. None of these allocate.
 */

const EPS = 1e-9;

/** Crossing number. Points exactly on an edge may go either way; nothing here cares. */
export function pointInRing( ring, x, z ) {
  let inside = false;
  const n = ring.length;
  for ( let i = 0, j = n - 2; i < n; j = i, i += 2 ) {
    const zi = ring[ i + 1 ], zj = ring[ j + 1 ];
    if ( ( zi > z ) !== ( zj > z ) ) {
      const xi = ring[ i ], xj = ring[ j ];
      if ( x < xi + ( xj - xi ) * ( z - zi ) / ( zj - zi ) ) inside = ! inside;
    }
  }
  return inside;
}

/**
 * Does the segment ( ax, az ) -> ( bx, bz ) touch the axis-aligned rectangle?
 * Liang-Barsky: clip the segment's parameter range against each slab in turn.
 */
function segmentHitsRect( ax, az, bx, bz, minX, minZ, maxX, maxZ ) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dz = bz - az;

  for ( let axis = 0; axis < 2; axis ++ ) {
    const p = axis === 0 ? dx : dz;
    const q0 = axis === 0 ? ax : az;
    const lo = axis === 0 ? minX : minZ;
    const hi = axis === 0 ? maxX : maxZ;

    if ( Math.abs( p ) < EPS ) {
      if ( q0 < lo || q0 > hi ) return false;      // parallel and outside
      continue;
    }
    let ta = ( lo - q0 ) / p;
    let tb = ( hi - q0 ) / p;
    if ( ta > tb ) { const swap = ta; ta = tb; tb = swap; }
    if ( ta > t0 ) t0 = ta;
    if ( tb < t1 ) t1 = tb;
    if ( t0 > t1 ) return false;
  }
  return true;
}

/**
 * Does an axis-aligned rectangle overlap the ring?
 *
 * Three cases, and between them they are exhaustive for a simple polygon: a
 * ring vertex inside the rectangle, the rectangle wholly inside the ring (so
 * its centre is inside), or an edge crossing.
 */
export function ringOverlapsRect( ring, minX, minZ, maxX, maxZ ) {
  const n = ring.length;
  for ( let i = 0; i < n; i += 2 ) {
    const x = ring[ i ], z = ring[ i + 1 ];
    if ( x >= minX && x <= maxX && z >= minZ && z <= maxZ ) return true;
  }
  if ( pointInRing( ring, ( minX + maxX ) * 0.5, ( minZ + maxZ ) * 0.5 ) ) return true;
  for ( let i = 0, j = n - 2; i < n; j = i, i += 2 ) {
    if ( segmentHitsRect( ring[ j ], ring[ j + 1 ], ring[ i ], ring[ i + 1 ], minX, minZ, maxX, maxZ ) ) return true;
  }
  return false;
}

/** Does the box overlap the prism `ring` extruded from y=0 to y=top? */
export function boxHitsPrism( ring, top, box ) {
  if ( box.min.y > top || box.max.y < 0 ) return false;
  return ringOverlapsRect( ring, box.min.x, box.min.z, box.max.x, box.max.z );
}

/**
 * Nearest ray hit on the prism's outside, within `range`.
 *
 * Faces are tested one at a time rather than by finding the ray's span through
 * the polygon: a concave footprint has several spans, and testing faces also
 * hands back the surface normal, which the impact decals need.
 *
 * The bottom cap is not tested. It is never visible and nothing can get under
 * a building to shoot at it.
 *
 * @returns {number} distance along the ray, or -1
 */
export function rayHitsPrism( ring, top, origin, dir, range, outNormal ) {
  let best = -1;
  const n = ring.length;

  // Walls: each edge is a vertical rectangle. The plane normal of one is
  // horizontal, so the whole test stays 2D apart from the height bound.
  for ( let i = 0, j = n - 2; i < n; j = i, i += 2 ) {
    const ax = ring[ j ], az = ring[ j + 1 ];
    const bx = ring[ i ], bz = ring[ i + 1 ];
    const ux = bx - ax, uz = bz - az;
    const len = Math.hypot( ux, uz );
    if ( len < EPS ) continue;

    // Outward normal for a positively-wound ring. This must match what
    // `computeVertexNormals` derives from PrismGeometry's triangle order, or
    // the impact decals face into the wall they just hit. Negating it leaves
    // the hit distance alone -- it cancels in the plane equation -- so only a
    // test that checks the normal itself catches this.
    const nx = uz / len, nz = -ux / len;
    const denom = dir.x * nx + dir.z * nz;
    if ( Math.abs( denom ) < EPS ) continue;                 // parallel to the wall

    const t = ( ( ax - origin.x ) * nx + ( az - origin.z ) * nz ) / denom;
    if ( t < 0 || t > range || ( best >= 0 && t >= best ) ) continue;

    const y = origin.y + dir.y * t;
    if ( y < 0 || y > top ) continue;                        // above or below the wall

    // Inside the edge's span?
    const hx = origin.x + dir.x * t, hz = origin.z + dir.z * t;
    const along = ( ( hx - ax ) * ux + ( hz - az ) * uz ) / len;
    if ( along < 0 || along > len ) continue;

    best = t;
    if ( outNormal ) outNormal.set( nx, 0, nz );
  }

  // Roof.
  if ( Math.abs( dir.y ) > EPS ) {
    const t = ( top - origin.y ) / dir.y;
    if ( t >= 0 && t <= range && ( best < 0 || t < best ) ) {
      if ( pointInRing( ring, origin.x + dir.x * t, origin.z + dir.z * t ) ) {
        best = t;
        if ( outNormal ) outNormal.set( 0, 1, 0 );
      }
    }
  }

  return best;
}

/** Is the point inside the solid? Used to let something already clipped into a wall shoot out. */
export function pointInPrism( ring, top, p ) {
  return p.y >= 0 && p.y <= top && pointInRing( ring, p.x, p.z );
}

// ---------------------------------------------------------------------------

const _n = new THREE.Vector3();

/**
 * Nearest ray hit on a box, with its face normal. `Ray.intersectBox` gives the
 * point but not which face, and the decals need the face.
 *
 * @returns {number} distance along the ray, or -1
 */
export function rayHitsBox( box, origin, dir, range, outNormal ) {
  let tMin = 0, tMax = range;
  let axis = -1, sign = 1;

  for ( let a = 0; a < 3; a ++ ) {
    const o = a === 0 ? origin.x : a === 1 ? origin.y : origin.z;
    const d = a === 0 ? dir.x : a === 1 ? dir.y : dir.z;
    const lo = a === 0 ? box.min.x : a === 1 ? box.min.y : box.min.z;
    const hi = a === 0 ? box.max.x : a === 1 ? box.max.y : box.max.z;

    if ( Math.abs( d ) < EPS ) {
      if ( o < lo || o > hi ) return -1;
      continue;
    }
    const inv = 1 / d;
    let t1 = ( lo - o ) * inv, t2 = ( hi - o ) * inv;
    let s = -1;
    if ( t1 > t2 ) { const tmp = t1; t1 = t2; t2 = tmp; s = 1; }
    if ( t1 > tMin ) { tMin = t1; axis = a; sign = s; }
    if ( t2 < tMax ) tMax = t2;
    if ( tMin > tMax ) return -1;
  }

  if ( axis === -1 ) return -1;                              // started inside
  if ( outNormal ) {
    _n.set( 0, 0, 0 );
    if ( axis === 0 ) _n.x = sign; else if ( axis === 1 ) _n.y = sign; else _n.z = sign;
    outNormal.copy( _n );
  }
  return tMin;
}
