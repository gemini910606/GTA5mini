import * as THREE from 'three';
import { makeSurface, panelPattern, metalPattern } from './Textures.js';
import arena from './levels/arena.json';

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
 * `instanced`, `pointLight`. Anything the arena expressed as a build-time loop
 * (the 108 facade windows, the stepped ramps) is either flattened into an
 * instanced transform list or covered by `ramp`, so adding a second map needs
 * no engine change.
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
  }

  // --- materials -----------------------------------------------------------

  _pattern( p ) {
    if ( ! p ) return null;
    switch ( p.kind ) {
      case 'panel': return panelPattern( p.cols, p.rows, p.groove, p.offsetAlternate );
      case 'metal': return metalPattern( p.ridges );
      default: throw new Error( `Level: unknown pattern kind "${ p.kind }"` );
    }
  }

  _material( def ) {
    if ( def.kind === 'surface' ) {
      const { pattern, ...surface } = def.surface;
      const params = makeSurface( { ...surface, pattern: this._pattern( pattern ) } );
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
  _solid( { material, size, pos, collide = true, rotY = 0, receive = true, cast = true, name } ) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry( size[ 0 ], size[ 1 ], size[ 2 ] ), this._materials[ material ],
    );
    mesh.position.set( pos[ 0 ], pos[ 1 ], pos[ 2 ] );
    mesh.rotation.y = rotY;
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    if ( name ) mesh.name = name;
    mesh.updateMatrixWorld( true );
    this.group.add( mesh );

    if ( collide ) {
      // Rotated boxes still register an AABB — fine here because every rotated
      // prop is either a ramp or a decorative panel the player cannot reach.
      this.colliders.push( new THREE.Box3().setFromObject( mesh ) );
    }
    this.hittables.push( mesh );
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

  _pointLight( { color, intensity, distance, decay, pos } ) {
    const light = new THREE.PointLight( hex( color ), intensity, distance, decay );
    light.position.set( pos[ 0 ], pos[ 1 ], pos[ 2 ] );
    this.group.add( light );
    return light;
  }

  // -------------------------------------------------------------------------

  /** Cheap "is this AABB clear" test used by enemy spawning. */
  isClear( box ) {
    return ! this.colliders.some( c => c.intersectsBox( box ) );
  }
}
