import * as THREE from 'three';
import { makeSurface, panelPattern, metalPattern, windowPattern } from './Textures.js';
import { Colliders } from './Colliders.js';
import { buildPrisms } from './PrismGeometry.js';
import arena from './levels/arena.json';
import kabukicho from './levels/kabukicho.json';
import daikyocho from './levels/daikyocho.json';
import shinjuku1 from './levels/shinjuku1.json';

/**
 * Every map the build knows about, in cycle order.
 *
 * The three Tokyo maps are Project PLATEAU LOD1 extracts converted by
 * `tools/build-plateau.mjs`; see each file's `source` block for the exact
 * coordinates and mesh tiles, and README.md for the attribution.
 */
export const LEVELS = { arena, kabukicho, shinjuku1, daikyocho };

/**
 * Builds a level from a JSON description.
 *
 * The geometry doubles as the collision world: every element that opts into
 * `collide` derives an axis-aligned `THREE.Box3` from the mesh it just built.
 * There is deliberately no collider list in the JSON — a second, hand-written
 * copy of the geometry is exactly the thing that drifts out of sync with the
 * first. Repeated props go through `InstancedMesh` so the level stays in the
 * low hundreds of draw calls.
 *
 * Element types are primitives, not level-specific cases: `box`, `ramp`,
 * `instanced`, `prisms`, `pointLight`. Anything the arena expressed as a
 * build-time loop (the 108 facade windows, the stepped ramps) is either
 * flattened into an instanced transform list or covered by `ramp`, so adding a
 * second map needs no engine change.
 *
 * `prisms` is what a real city is made of: an extruded polygon footprint. The
 * PLATEAU maps are hundreds of those, so every prism in one element merges into
 * a single BufferGeometry — the budget that binds here is draw calls, not
 * triangles (SPEC §5).
 *
 * See docs/SPEC.md for the schema.
 */

// ---------------------------------------------------------------------------

/** Trapezoid cross-section jersey barrier, extruded along its length. */
function barrierGeometry() {
  const shape = new THREE.Shape();
  shape.moveTo( -0.5, -0.55 );
  shape.lineTo( 0.5, -0.55 );
  shape.lineTo( 0.28, 0.05 );
  shape.lineTo( 0.2, 0.55 );
  shape.lineTo( -0.2, 0.55 );
  shape.lineTo( -0.28, 0.05 );
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry( shape, {
    depth: 3.2, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: 1,
  } );
  geo.translate( 0, 0, -1.6 );
  geo.rotateY( Math.PI / 2 );
  geo.computeVertexNormals();
  return geo;
}

const hex = v => ( typeof v === 'string' ? parseInt( v, 16 ) : v );

const _scratch = new THREE.Box3();

// ---------------------------------------------------------------------------

export class Level {

  /** @param {object} [data] level description; defaults to the built-in arena. */
  constructor( data = arena ) {
    this.group = new THREE.Group();
    this.group.name = 'Level';
    this.data = data;

    /** @type {THREE.Box3[]} */
    this.colliders = [];
    /** @type {THREE.Object3D[]} */
    this.hittables = [];
    /** @type {THREE.Vector3[]} */
    this.spawnPoints = [];

    this._materials = {};
    for ( const [ name, def ] of Object.entries( data.materials ) ) {
      this._materials[ name ] = this._material( def );
    }

    this._buildGround( data.ground );
    for ( const element of data.elements ) this._add( element );

    this.spawnPoints = data.spawnPoints.map( p => new THREE.Vector3( ...p ) );

    /** Where the player starts; the arena's southern approach if unstated. */
    this.playerStart = new THREE.Vector3( ...( data.playerStart ?? [ 0, 0, 26 ] ) );

    /**
     * Broad phase over `colliders`. The array stays the source of truth — the
     * grid is an index over it, and `tools/test-colliders.mjs` holds the two to
     * the same answers.
     */
    this.broadphase = new Colliders( this.colliders );
  }

  // --- materials -----------------------------------------------------------

  _pattern( p ) {
    if ( ! p ) return null;
    switch ( p.kind ) {
      case 'panel': return panelPattern( p.cols, p.rows, p.groove, p.offsetAlternate );
      case 'window': return windowPattern( p.cols, p.rows, p );
      case 'metal': return metalPattern( p.ridges );
      default: throw new Error( `Level: unknown pattern kind "${ p.kind }"` );
    }
  }

  _material( def ) {
    if ( def.kind === 'surface' ) {
      const { pattern, ...surface } = def.surface;
      // Copied, not used in place: `makeSurface` caches and returns the same
      // object for identical inputs, so writing the overrides straight onto it
      // would leak one level's metalness into another level that shares the
      // surface definition but omits the override.
      const params = { ...makeSurface( { ...surface, pattern: this._pattern( pattern ) } ) };
      if ( def.metalness !== undefined ) params.metalness = def.metalness;
      if ( def.roughness !== undefined ) params.roughness = def.roughness;
      if ( def.normalScale ) params.normalScale = new THREE.Vector2( ...def.normalScale );
      return new THREE.MeshStandardMaterial( params );
    }

    if ( def.kind === 'plain' ) {
      const { kind, ...rest } = def;
      if ( rest.color !== undefined ) rest.color = hex( rest.color );
      if ( rest.emissive !== undefined ) rest.emissive = hex( rest.emissive );
      return new THREE.MeshStandardMaterial( rest );
    }

    throw new Error( `Level: unknown material kind "${ def.kind }"` );
  }

  // --- elements ------------------------------------------------------------

  _add( element ) {
    switch ( element.type ) {
      case 'box': return this._solid( element );
      case 'ramp': return this._ramp( element );
      case 'instanced': return this._instanced( element );
      case 'prisms': return this._prisms( element );
      case 'pointLight': return this._pointLight( element );
      default: throw new Error( `Level: unknown element type "${ element.type }"` );
    }
  }

  _buildGround( { material, size } ) {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry( size, size ), this._materials[ material ],
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.name = 'Ground';
    this.group.add( ground );
    this.hittables.push( ground );
    return ground;
  }

  /**
   * A solid box: mesh + collider + raycast target.
   * `size` and `pos` are metres, `pos` is the box centre.
   */
  _solid( { material, size, pos, collide = true, rotY = 0, receive = true, cast = true, visible = true, name } ) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry( size[ 0 ], size[ 1 ], size[ 2 ] ), this._materials[ material ],
    );
    mesh.position.set( pos[ 0 ], pos[ 1 ], pos[ 2 ] );
    mesh.rotation.y = rotY;
    mesh.castShadow = cast && visible;
    mesh.receiveShadow = receive && visible;
    mesh.visible = visible;
    if ( name ) mesh.name = name;
    mesh.updateMatrixWorld( true );
    this.group.add( mesh );

    if ( collide ) {
      // Rotated boxes still register an AABB — fine here because every rotated
      // prop is either a ramp or a decorative panel the player cannot reach.
      this.colliders.push( new THREE.Box3().setFromObject( mesh ) );
    }
    // An invisible box is a boundary wall: it should stop the player without
    // catching bullets, or shots at the skyline would spark on thin air.
    if ( visible ) this.hittables.push( mesh );
    return mesh;
  }

  /**
   * Stepped ramp: cheap, collides correctly with the AABB solver, and the steps
   * catch the low sun in a way a smooth wedge does not.
   */
  _ramp( { material, base, width, height, run, steps = 7 } ) {
    for ( let i = 0; i < steps; i ++ ) {
      const h = height * ( i + 1 ) / steps;
      const d = run / steps;
      this._solid( {
        material,
        size: [ width, h, d ],
        pos: [ base[ 0 ], h / 2, base[ 2 ] - run / 2 + d * ( i + 0.5 ) ],
      } );
    }
  }

  _geometry( g ) {
    switch ( g.kind ) {
      case 'box': return new THREE.BoxGeometry( g.size[ 0 ], g.size[ 1 ], g.size[ 2 ] );
      case 'barrier': return barrierGeometry();
      default: throw new Error( `Level: unknown geometry kind "${ g.kind }"` );
    }
  }

  _instanced( { material, geometry, transforms, colliderSize = 0, collide = true, cast = true } ) {
    const geo = this._geometry( geometry );
    const mesh = new THREE.InstancedMesh( geo, this._materials[ material ], transforms.length );
    mesh.castShadow = cast;
    mesh.receiveShadow = true;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const axis = new THREE.Vector3( 0, 1, 0 );
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3( 1, 1, 1 );

    geo.computeBoundingBox();
    const hy = ( geo.boundingBox.max.y - geo.boundingBox.min.y ) * 0.5;
    // Conservative AABB: a rotated box needs its diagonal, not its edge.
    const r = colliderSize * 0.5 * Math.SQRT2;

    transforms.forEach( ( [ x, y, z, rotY ], i ) => {
      pos.set( x, y, z );
      q.setFromAxisAngle( axis, rotY );
      m.compose( pos, q, scale );
      mesh.setMatrixAt( i, m );

      if ( ! collide ) return;
      this.colliders.push( new THREE.Box3(
        new THREE.Vector3( x - r, y - hy, z - r ),
        new THREE.Vector3( x + r, y + hy, z + r ),
      ) );
    } );

    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.group.add( mesh );
    this.hittables.push( mesh );
    return mesh;
  }

  /**
   * Extruded polygon footprints, merged into one geometry.
   *
   * Walls get UVs in metres so a shopfront and an office block share a texture
   * without either looking stretched; the roof is projected straight down. The
   * bottom cap is skipped — it is never visible and it is a third of the
   * triangles. The geometry itself is built by `PrismGeometry`, which has no
   * canvas or WebGL dependency so the winding can be tested headlessly.
   */
  _prisms( { material, buildings, uvScale = 6, collide = true, cast = true, receive = true, hittable = true, name } ) {
    const { geometry, boxes } = buildPrisms( buildings, uvScale );
    if ( collide ) for ( const b of boxes ) this.colliders.push( b );

    const mesh = new THREE.Mesh( geometry, this._materials[ material ] );
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    mesh.name = name ?? `Prisms:${ material }`;
    this.group.add( mesh );
    if ( hittable ) this.hittables.push( mesh );
    return mesh;
  }

  _pointLight( { color, intensity, distance, decay, pos } ) {
    const light = new THREE.PointLight( hex( color ), intensity, distance, decay );
    light.position.set( pos[ 0 ], pos[ 1 ], pos[ 2 ] );
    this.group.add( light );
    return light;
  }

  // -------------------------------------------------------------------------

  /**
   * Releases the geometry this level built.
   *
   * Textures are deliberately left alone: `makeSurface` caches them by their
   * definition, so the three city maps share one set, and disposing them here
   * would hand the next level a dead texture. The cache is bounded by the
   * number of distinct surface definitions in the build, not by how many times
   * the player cycles maps.
   */
  dispose() {
    this.group.traverse( o => o.geometry?.dispose() );
    for ( const m of Object.values( this._materials ) ) m.dispose();
    this.group.clear();
    this.colliders.length = 0;
    this.hittables.length = 0;
  }

  /** Cheap "is this AABB clear" test used by enemy spawning. */
  isClear( box ) {
    return ! this.broadphase.intersects( box );
  }

  /**
   * Whether someone player-sized could stand at ( x, y, z ).
   *
   * `y` is the floor they stand on, not their eyeline — the arena spawns two
   * of its enemies on top of platforms, and a test that assumed ground level
   * called both of them blocked. The box matches `Enemy._boxAt`.
   */
  isStandingClear( x, y, z, height = 1.82, radius = 0.4 ) {
    _scratch.min.set( x - radius, y + 0.05, z - radius );
    _scratch.max.set( x + radius, y + height, z + radius );
    return this.isClear( _scratch );
  }
}
