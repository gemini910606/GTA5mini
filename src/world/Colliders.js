import * as THREE from 'three';

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
 */

const _hitPoint = new THREE.Vector3();
const _ray = new THREE.Ray();

export class Colliders {

  /**
   * @param {THREE.Box3[]} boxes
   * @param {number} cell edge length in metres; ~8 m puts two or three
   *   buildings in a cell without exploding the bucket count.
   */
  constructor( boxes, cell = 8 ) {
    this.boxes = boxes;
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
          if ( box.intersectsBox( this.boxes[ i ] ) ) return this.boxes[ i ];
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
    _ray.origin.copy( origin );
    _ray.direction.copy( direction );

    const stamp = ++ this._query;
    const rangeSq = range * range;

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
        const box = this.boxes[ i ];
        if ( box.containsPoint( origin ) ) continue;
        if ( _ray.intersectBox( box, _hitPoint ) && _hitPoint.distanceToSquared( origin ) < rangeSq ) return true;
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

  /** Reference implementation; the grid is checked against this in the tests. */
  firstLinear( box ) {
    for ( const c of this.boxes ) if ( box.intersectsBox( c ) ) return c;
    return null;
  }

  blockedLinear( origin, direction, range ) {
    _ray.origin.copy( origin );
    _ray.direction.copy( direction );
    for ( const box of this.boxes ) {
      if ( box.containsPoint( origin ) ) continue;
      if ( _ray.intersectBox( box, _hitPoint ) && _hitPoint.distanceToSquared( origin ) < range * range ) return true;
    }
    return false;
  }

  /** Reported in the shots scene stats. */
  get stats() {
    return { boxes: this.boxes.length, cells: this.cols * this.rows, entries: this.items.length };
  }
}
