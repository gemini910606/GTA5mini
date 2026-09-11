import * as THREE from 'three';
import { boxHitsPrism, pointInPrism, rayHitsPrism, rayHitsBox } from './Narrow.js';

/**
 * Uniform-grid broad phase over the level's collision boxes.
 *
 * The arena got away with a linear scan: 54 boxes, tested twice per axis per
 * entity per substep at 120 Hz. A city block is 147 and the scan is the whole
 * cost, so the boxes go into a grid on the XZ plane — buildings are tall and
 * thin, so the vertical axis buys nothing and the box test handles it anyway.
 *
 * The grid is built once at level load. Queries allocate nothing: the CSR
 * layout is flat typed arrays, and the "already tested this box" guard is a
 * stamp array bumped per query rather than a Set.
 *
 * A collider may carry a narrow-phase shape, and a prism always does. Its box
 * is then only a cull: the real answer comes from the footprint, because a
 * Tokyo building fills as little as 40% of its own bounding box and the rest
 * would be alleys you can see and cannot enter. See `Narrow.js`.
 */

const _normal = new THREE.Vector3();

export class Colliders {

  /**
   * @param {THREE.Box3[]} boxes
   * @param {number} cell edge length in metres; ~8 m puts two or three
   *   buildings in a cell without exploding the bucket count.
   */
  /**
   * @param {THREE.Box3[]} boxes
   * @param {Array<{ ring: number[], top: number }|null>|null} [shapes]
   *   parallel to `boxes`; a null entry means the box is the shape.
   * @param {number} [cell] grid edge in metres.
   */
  constructor( boxes, shapes = null, cell = 8 ) {
    this.boxes = boxes;
    this.shapes = shapes;
    this.cell = cell;

    const bounds = new THREE.Box3();
    for ( const b of boxes ) bounds.union( b );
    // An empty level would give an inverted box; keep the grid degenerate but
    // valid so every query simply finds nothing.
    if ( ! boxes.length ) bounds.set( new THREE.Vector3(), new THREE.Vector3() );

    this.minX = bounds.min.x;
    this.minZ = bounds.min.z;
    this.cols = Math.max( 1, Math.ceil( ( bounds.max.x - bounds.min.x ) / cell ) + 1 );
    this.rows = Math.max( 1, Math.ceil( ( bounds.max.z - bounds.min.z ) / cell ) + 1 );

    const nCells = this.cols * this.rows;
    const counts = new Int32Array( nCells + 1 );

    const spans = [];
    for ( const b of boxes ) {
      const c0 = this._col( b.min.x ), c1 = this._col( b.max.x );
      const r0 = this._row( b.min.z ), r1 = this._row( b.max.z );
      spans.push( c0, c1, r0, r1 );
      for ( let r = r0; r <= r1; r ++ ) for ( let c = c0; c <= c1; c ++ ) counts[ r * this.cols + c + 1 ] ++;
    }
    for ( let i = 0; i < nCells; i ++ ) counts[ i + 1 ] += counts[ i ];

    this.start = counts;
    this.items = new Int32Array( counts[ nCells ] );
    const cursor = Int32Array.from( counts.subarray( 0, nCells ) );
    for ( let i = 0; i < boxes.length; i ++ ) {
      const c0 = spans[ i * 4 ], c1 = spans[ i * 4 + 1 ], r0 = spans[ i * 4 + 2 ], r1 = spans[ i * 4 + 3 ];
      for ( let r = r0; r <= r1; r ++ ) {
        for ( let c = c0; c <= c1; c ++ ) {
          const cellIndex = r * this.cols + c;
          this.items[ cursor[ cellIndex ] ++ ] = i;
        }
      }
    }

    this._stamp = new Int32Array( boxes.length );
    this._query = 0;
  }

  _col( x ) {
    return Math.min( this.cols - 1, Math.max( 0, Math.floor( ( x - this.minX ) / this.cell ) ) );
  }

  _row( z ) {
    return Math.min( this.rows - 1, Math.max( 0, Math.floor( ( z - this.minZ ) / this.cell ) ) );
  }

  /** Broad box overlap, then the narrow shape if the collider has one. */
  _overlaps( i, box ) {
    if ( ! box.intersectsBox( this.boxes[ i ] ) ) return false;
    const shape = this.shapes && this.shapes[ i ];
    return ! shape || boxHitsPrism( shape.ring, shape.top, box );
  }

  /**
   * Ray against one collider. Returns the distance, or -1.
   *
   * A collider the ray starts inside cannot occlude it: an enemy clipped into
   * a wall would otherwise be permanently blind.
   */
  _rayHit( i, origin, direction, range, outNormal ) {
    const shape = this.shapes && this.shapes[ i ];
    if ( shape ) {
      if ( pointInPrism( shape.ring, shape.top, origin ) ) return -1;
      return rayHitsPrism( shape.ring, shape.top, origin, direction, range, outNormal );
    }
    const box = this.boxes[ i ];
    if ( box.containsPoint( origin ) ) return -1;
    return rayHitsBox( box, origin, direction, range, outNormal );
  }

  /** First collider overlapping `box`, or null. */
  first( box ) {
    const c0 = this._col( box.min.x ), c1 = this._col( box.max.x );
    const r0 = this._row( box.min.z ), r1 = this._row( box.max.z );
    const stamp = ++ this._query;
    for ( let r = r0; r <= r1; r ++ ) {
      const rowBase = r * this.cols;
      for ( let c = c0; c <= c1; c ++ ) {
        const cellIndex = rowBase + c;
        const end = this.start[ cellIndex + 1 ];
        for ( let k = this.start[ cellIndex ]; k < end; k ++ ) {
          const i = this.items[ k ];
          if ( this._stamp[ i ] === stamp ) continue;
          this._stamp[ i ] = stamp;
          if ( this._overlaps( i, box ) ) return this.boxes[ i ];
        }
      }
    }
    return null;
  }

  /** @returns {boolean} whether anything overlaps `box`. */
  intersects( box ) {
    return this.first( box ) !== null;
  }

  /**
   * Line-of-sight test. Walks the grid along the ray (Amanatides & Woo) instead
   * of testing every box, and skips boxes containing the origin — an enemy
   * clipped into a wall would otherwise be permanently blind.
   *
   * @returns {boolean} true when something blocks the segment.
   */
  blocked( origin, direction, range ) {
    const stamp = ++ this._query;

    let col = this._col( origin.x );
    let row = this._row( origin.z );
    const stepX = direction.x > 0 ? 1 : direction.x < 0 ? -1 : 0;
    const stepZ = direction.z > 0 ? 1 : direction.z < 0 ? -1 : 0;

    // Parametric distance to the next cell boundary on each axis, and the
    // distance between successive boundaries. A ray that does not move on an
    // axis gets Infinity, which parks that branch of the walk for good.
    const invX = direction.x !== 0 ? 1 / direction.x : 0;
    const invZ = direction.z !== 0 ? 1 / direction.z : 0;
    const tDeltaX = stepX === 0 ? Infinity : Math.abs( this.cell * invX );
    const tDeltaZ = stepZ === 0 ? Infinity : Math.abs( this.cell * invZ );

    const edge = ( value, min, index, step ) => min + ( step > 0 ? index + 1 : index ) * this.cell - value;
    let tMaxX = stepX === 0 ? Infinity : Math.abs( edge( origin.x, this.minX, col, stepX ) * invX );
    let tMaxZ = stepZ === 0 ? Infinity : Math.abs( edge( origin.z, this.minZ, row, stepZ ) * invZ );

    // Bounded so a numerically odd ray cannot spin forever.
    const maxSteps = this.cols + this.rows + 2;
    for ( let step = 0, t = 0; t <= range && step < maxSteps; step ++ ) {
      const cellIndex = row * this.cols + col;
      const end = this.start[ cellIndex + 1 ];
      for ( let k = this.start[ cellIndex ]; k < end; k ++ ) {
        const i = this.items[ k ];
        if ( this._stamp[ i ] === stamp ) continue;
        this._stamp[ i ] = stamp;
        if ( this._rayHit( i, origin, direction, range, null ) >= 0 ) return true;
      }

      if ( tMaxX < tMaxZ ) {
        col += stepX;
        t = tMaxX;
        tMaxX += tDeltaX;
      } else {
        row += stepZ;
        t = tMaxZ;
        tMaxZ += tDeltaZ;
      }
      if ( col < 0 || col >= this.cols || row < 0 || row >= this.rows ) break;
    }
    return false;
  }

  /**
   * Nearest hit along the ray, with the surface normal.
   *
   * This is what a hitscan weapon asks, on the client and on the server alike.
   * `THREE.Raycaster` cannot answer it for a server: it walks the scene graph,
   * and a server has no scene.
   *
   * @param {{ distance: number, point: THREE.Vector3, normal: THREE.Vector3, index: number }} out
   * @returns {boolean} whether anything was hit
   */
  raycast( origin, direction, range, out ) {
    const stamp = ++ this._query;
    let best = -1, bestIndex = -1;

    let col = this._col( origin.x );
    let row = this._row( origin.z );
    const stepX = direction.x > 0 ? 1 : direction.x < 0 ? -1 : 0;
    const stepZ = direction.z > 0 ? 1 : direction.z < 0 ? -1 : 0;
    const invX = direction.x !== 0 ? 1 / direction.x : 0;
    const invZ = direction.z !== 0 ? 1 / direction.z : 0;
    const tDeltaX = stepX === 0 ? Infinity : Math.abs( this.cell * invX );
    const tDeltaZ = stepZ === 0 ? Infinity : Math.abs( this.cell * invZ );
    const edge = ( value, min, index, step ) => min + ( step > 0 ? index + 1 : index ) * this.cell - value;
    let tMaxX = stepX === 0 ? Infinity : Math.abs( edge( origin.x, this.minX, col, stepX ) * invX );
    let tMaxZ = stepZ === 0 ? Infinity : Math.abs( edge( origin.z, this.minZ, row, stepZ ) * invZ );

    const maxSteps = this.cols + this.rows + 2;
    for ( let step = 0, t = 0; t <= range && step < maxSteps; step ++ ) {
      const cellIndex = row * this.cols + col;
      const end = this.start[ cellIndex + 1 ];
      for ( let k = this.start[ cellIndex ]; k < end; k ++ ) {
        const i = this.items[ k ];
        if ( this._stamp[ i ] === stamp ) continue;
        this._stamp[ i ] = stamp;
        const hit = this._rayHit( i, origin, direction, range, _normal );
        if ( hit >= 0 && ( best < 0 || hit < best ) ) {
          best = hit;
          bestIndex = i;
          out.normal.copy( _normal );
        }
      }

      const leaving = tMaxX < tMaxZ ? tMaxX : tMaxZ;
      // Nothing in a later cell can be nearer than where this one ends, so a
      // hit already inside the current cell is the answer.
      if ( best >= 0 && best <= leaving ) break;

      if ( tMaxX < tMaxZ ) { col += stepX; t = tMaxX; tMaxX += tDeltaX; }
      else { row += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; }
      if ( col < 0 || col >= this.cols || row < 0 || row >= this.rows ) break;
    }

    if ( best < 0 ) return false;
    out.distance = best;
    out.index = bestIndex;
    out.point.copy( origin ).addScaledVector( direction, best );
    return true;
  }

  // --- linear references ---------------------------------------------------
  //
  // The grid is only an index, so these must answer identically. They share
  // the narrow phase deliberately: a reference that skipped it would be
  // testing the wrong question.

  firstLinear( box ) {
    for ( let i = 0; i < this.boxes.length; i ++ ) if ( this._overlaps( i, box ) ) return this.boxes[ i ];
    return null;
  }

  blockedLinear( origin, direction, range ) {
    for ( let i = 0; i < this.boxes.length; i ++ ) {
      if ( this._rayHit( i, origin, direction, range, null ) >= 0 ) return true;
    }
    return false;
  }

  raycastLinear( origin, direction, range, out ) {
    let best = -1, bestIndex = -1;
    for ( let i = 0; i < this.boxes.length; i ++ ) {
      const hit = this._rayHit( i, origin, direction, range, _normal );
      if ( hit >= 0 && ( best < 0 || hit < best ) ) {
        best = hit;
        bestIndex = i;
        out.normal.copy( _normal );
      }
    }
    if ( best < 0 ) return false;
    out.distance = best;
    out.index = bestIndex;
    out.point.copy( origin ).addScaledVector( direction, best );
    return true;
  }

  /** Reported in the shots scene stats. */
  get stats() {
    const shaped = this.shapes ? this.shapes.reduce( ( n, s ) => n + ( s ? 1 : 0 ), 0 ) : 0;
    return { boxes: this.boxes.length, shaped, cells: this.cols * this.rows, entries: this.items.length };
  }
}
