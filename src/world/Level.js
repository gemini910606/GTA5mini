import * as THREE from 'three';
import { makeSurface, panelPattern, metalPattern } from './Textures.js';

/**
 * The arena: a walled urban courtyard.
 *
 * Geometry doubles as the collision world — every solid box registers an
 * axis-aligned `THREE.Box3` in `colliders`, which the player and the hitscan
 * both query. Repeated props go through `InstancedMesh` so the whole level
 * stays in the low hundreds of draw calls.
 */

const ARENA = 74;        // inner courtyard half-extent * 2
const HALF = ARENA / 2;
const WALL_H = 15;

export class Level {

  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'Level';

    /** @type {THREE.Box3[]} */
    this.colliders = [];
    /** @type {THREE.Object3D[]} */
    this.hittables = [];
    /** @type {THREE.Vector3[]} */
    this.spawnPoints = [];

    this._materials = this._buildMaterials();
    this._buildGround();
    this._buildPerimeter();
    this._buildProps();
    this._buildLights();
  }

  // -------------------------------------------------------------------------

  _buildMaterials() {
    const asphalt = makeSurface( {
      // High `period` = small features. A low period at repeat 26 produced
      // metre-scale rolling shapes that read as water rather than asphalt.
      size: 512, tint: [ 0.355, 0.35, 0.365 ], contrast: 0.10,
      roughBase: 0.88, roughVar: 0.10, bump: 0.55, period: 26, repeat: 30, seed: 3,
    } );

    const concrete = makeSurface( {
      size: 512, tint: [ 0.60, 0.585, 0.55 ], contrast: 0.30,
      roughBase: 0.82, roughVar: 0.22, bump: 1.1, period: 7, repeat: 4, seed: 11,
    } );

    const brick = makeSurface( {
      size: 512, tint: [ 0.52, 0.34, 0.28 ], contrast: 0.34,
      roughBase: 0.86, roughVar: 0.16, bump: 2.1, period: 12, repeat: 5, seed: 21,
      // Facade tiles are ~17.2m x 3m on screen; 16x3 cells makes them ~1m square.
      pattern: panelPattern( 16, 3, 0.03 ),
    } );

    const plaster = makeSurface( {
      size: 512, tint: [ 0.70, 0.68, 0.63 ], contrast: 0.22,
      roughBase: 0.78, roughVar: 0.20, bump: 0.9, period: 6, repeat: 6, seed: 31,
      pattern: panelPattern( 8, 2, 0.022, false ),
    } );

    const metal = makeSurface( {
      size: 512, tint: [ 0.46, 0.48, 0.51 ], contrast: 0.24,
      roughBase: 0.42, roughVar: 0.30, bump: 1.3, period: 9, repeat: 2, seed: 41,
      pattern: metalPattern( 22 ),
    } );

    const crate = makeSurface( {
      size: 256, tint: [ 0.48, 0.36, 0.22 ], contrast: 0.30,
      roughBase: 0.80, roughVar: 0.20, bump: 1.5, period: 8, repeat: 1, seed: 53,
      pattern: panelPattern( 4, 4, 0.05, false ),
    } );

    return {
      asphalt: new THREE.MeshStandardMaterial( { ...asphalt, metalness: 0.02, normalScale: new THREE.Vector2( 0.55, 0.55 ) } ),
      concrete: new THREE.MeshStandardMaterial( { ...concrete, metalness: 0.0, normalScale: new THREE.Vector2( 0.9, 0.9 ) } ),
      brick: new THREE.MeshStandardMaterial( { ...brick, metalness: 0.0, normalScale: new THREE.Vector2( 1.4, 1.4 ) } ),
      plaster: new THREE.MeshStandardMaterial( { ...plaster, metalness: 0.0, normalScale: new THREE.Vector2( 0.7, 0.7 ) } ),
      metal: new THREE.MeshStandardMaterial( { ...metal, metalness: 0.85, roughness: 0.4, normalScale: new THREE.Vector2( 0.8, 0.8 ) } ),
      crate: new THREE.MeshStandardMaterial( { ...crate, metalness: 0.0, normalScale: new THREE.Vector2( 1.2, 1.2 ) } ),
      glass: new THREE.MeshStandardMaterial( {
        color: 0x0d1a26, metalness: 0.95, roughness: 0.08,
        envMapIntensity: 1.4,
      } ),
    };
  }

  // -------------------------------------------------------------------------

  /**
   * Adds a solid box: mesh + collider + raycast target.
   * `size` and `pos` are in metres, `pos` is the box centre.
   */
  _solid( material, size, pos, { collide = true, rotY = 0, receive = true, cast = true } = {} ) {
    const geo = new THREE.BoxGeometry( size[ 0 ], size[ 1 ], size[ 2 ] );
    const mesh = new THREE.Mesh( geo, material );
    mesh.position.set( pos[ 0 ], pos[ 1 ], pos[ 2 ] );
    mesh.rotation.y = rotY;
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    mesh.updateMatrixWorld( true );
    this.group.add( mesh );

    if ( collide ) {
      // Rotated boxes still register an AABB — fine here because every rotated
      // prop is either a ramp or a decorative panel the player cannot reach.
      const box = new THREE.Box3().setFromObject( mesh );
      this.colliders.push( box );
    }
    this.hittables.push( mesh );
    return mesh;
  }

  _buildGround() {
    const geo = new THREE.PlaneGeometry( 400, 400 );
    const ground = new THREE.Mesh( geo, this._materials.asphalt );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.name = 'Ground';
    this.group.add( ground );
    this.hittables.push( ground );

    // Kerb ring: reads as a real street edge and catches the low sun.
    const kerbMat = this._materials.concrete;
    const k = HALF + 1.2;
    this._solid( kerbMat, [ k * 2 + 1.6, 0.28, 0.8 ], [ 0, 0.14, -k ], { collide: false } );
    this._solid( kerbMat, [ k * 2 + 1.6, 0.28, 0.8 ], [ 0, 0.14, k ], { collide: false } );
    this._solid( kerbMat, [ 0.8, 0.28, k * 2 + 1.6 ], [ -k, 0.14, 0 ], { collide: false } );
    this._solid( kerbMat, [ 0.8, 0.28, k * 2 + 1.6 ], [ k, 0.14, 0 ], { collide: false } );
  }

  _buildPerimeter() {
    const { brick, plaster, glass, concrete } = this._materials;
    const facadeMats = [ brick, plaster, brick, plaster ];

    // Four building slabs enclosing the courtyard.
    const sides = [
      { pos: [ 0, WALL_H / 2, -HALF - 3 ], size: [ ARENA + 12, WALL_H, 6 ], axis: 'x', inward:  1 },
      { pos: [ 0, WALL_H / 2, HALF + 3 ],  size: [ ARENA + 12, WALL_H, 6 ], axis: 'x', inward: -1 },
      { pos: [ -HALF - 3, WALL_H / 2, 0 ], size: [ 6, WALL_H, ARENA + 12 ], axis: 'z', inward:  1 },
      { pos: [ HALF + 3, WALL_H / 2, 0 ],  size: [ 6, WALL_H, ARENA + 12 ], axis: 'z', inward: -1 },
    ];

    // Windows were 4 sides x 3 storeys x 9 bays x 2 meshes = 216 draw calls
    // before shadow and AO passes tripled them. Collected here and emitted as
    // two InstancedMesh instead; the transforms are identical, only the
    // per-instance rotation differs between the X- and Z-facing walls.
    const glassTransforms = [];
    const sillTransforms = [];
    const BAYS = 9, STOREYS = 3;

    sides.forEach( ( side, i ) => {
      this._solid( facadeMats[ i ], side.size, side.pos );

      const along = ARENA;
      const rotY = side.axis === 'x' ? 0 : Math.PI / 2;

      for ( let storey = 0; storey < STOREYS; storey ++ ) {
        const y = 3.4 + storey * 4.0;

        for ( let bay = 0; bay < BAYS; bay ++ ) {
          const t = ( bay / ( BAYS - 1 ) - 0.5 ) * along * 0.92;

          const glassPos = side.axis === 'x'
            ? [ t, y, side.pos[ 2 ] + side.inward * 3.05 ]
            : [ side.pos[ 0 ] + side.inward * 3.05, y, t ];
          const sillPos = side.axis === 'x'
            ? [ t, y - 1.15, side.pos[ 2 ] + side.inward * 2.95 ]
            : [ side.pos[ 0 ] + side.inward * 2.95, y - 1.15, t ];

          glassTransforms.push( [ ...glassPos, rotY ] );
          sillTransforms.push( [ ...sillPos, rotY ] );
        }
      }
    } );

    this._instanced(
      glass, new THREE.BoxGeometry( 2.6, 2.0, 0.12 ), glassTransforms, 0,
      { collide: false, cast: false },
    );
    this._instanced(
      concrete, new THREE.BoxGeometry( 3.1, 0.22, 0.42 ), sillTransforms, 0,
      { collide: false, cast: true },
    );

    // Roof parapets, so the skyline is not a flat cut against the sky.
    const par = concrete;
    this._solid( par, [ ARENA + 12, 1.1, 0.7 ], [ 0, WALL_H + 0.55, -HALF - 5.6 ], { collide: false } );
    this._solid( par, [ ARENA + 12, 1.1, 0.7 ], [ 0, WALL_H + 0.55, HALF + 5.6 ], { collide: false } );
    this._solid( par, [ 0.7, 1.1, ARENA + 12 ], [ -HALF - 5.6, WALL_H + 0.55, 0 ], { collide: false } );
    this._solid( par, [ 0.7, 1.1, ARENA + 12 ], [ HALF + 5.6, WALL_H + 0.55, 0 ], { collide: false } );
  }

  _buildProps() {
    const { concrete, metal, crate } = this._materials;

    // --- Raised platform with a ramp -----------------------------------------
    this._solid( concrete, [ 18, 2.6, 13 ], [ -19, 1.3, -17 ] );
    this._buildRamp( concrete, [ -19, 0, -7.5 ], 6, 2.6, 5.5 );

    this._solid( concrete, [ 13, 4.2, 13 ], [ 21, 2.1, 19 ] );
    this._buildRamp( concrete, [ 21, 0, 10.5 ], 6, 4.2, 7.0 );

    // --- Catwalk connecting nothing in particular, but it reads as a city ----
    this._solid( metal, [ 3.2, 0.35, 26 ], [ -19, 5.4, 3 ], { collide: true } );
    for ( const z of [ -8, 2, 12 ] ) {
      this._solid( metal, [ 0.42, 5.4, 0.42 ], [ -20.4, 2.7, z ], { collide: false } );
      this._solid( metal, [ 0.42, 5.4, 0.42 ], [ -17.6, 2.7, z ], { collide: false } );
    }
    // Railings
    this._solid( metal, [ 0.12, 1.0, 26 ], [ -20.5, 6.05, 3 ], { collide: false } );
    this._solid( metal, [ 0.12, 1.0, 26 ], [ -17.5, 6.05, 3 ], { collide: false } );

    // --- Pillars --------------------------------------------------------------
    const pillars = [ [ -8, -30 ], [ 8, -30 ], [ -8, 30 ], [ 8, 30 ], [ 30, -8 ], [ 30, 8 ] ];
    this._instanced(
      concrete, new THREE.BoxGeometry( 1.6, 9, 1.6 ),
      pillars.map( ( [ x, z ] ) => [ x, 4.5, z, 0 ] ), 1.6,
    );
    this._instanced(
      concrete, new THREE.BoxGeometry( 2.2, 0.4, 2.2 ),
      pillars.map( ( [ x, z ] ) => [ x, 9.2, z, 0 ] ), 0,
      { collide: false },
    );

    // --- Instanced crates -----------------------------------------------------
    const crateTransforms = [
      [ -2, 0.9, 4, 0.3 ], [ -0.4, 2.7, 4.2, 0.1 ], [ 1.4, 0.9, 4.6, -0.4 ],
      [ 12, 0.9, -6, 0.9 ], [ 13.6, 0.9, -7.4, 0.2 ], [ 12.8, 2.7, -6.7, 0.5 ],
      [ -26, 0.9, 12, -0.7 ], [ -24.4, 0.9, 13.2, 0.15 ],
      [ 6, 0.9, 24, 1.1 ], [ 7.8, 0.9, 25.2, 0.4 ], [ 6.9, 2.7, 24.6, -0.2 ],
      [ -12, 0.9, -26, 0.6 ], [ 28, 0.9, -22, -0.3 ], [ 26.4, 0.9, -23.4, 0.8 ],
      [ -32, 0.9, -8, 0.25 ], [ 18, 0.9, 2, -0.55 ],
    ];
    this._instanced( crate, new THREE.BoxGeometry( 1.8, 1.8, 1.8 ), crateTransforms, 1.8 );

    // --- Instanced concrete barriers -----------------------------------------
    const barrierTransforms = [
      [ -6, 0.55, -12, 0 ], [ -2.5, 0.55, -12, 0 ], [ 1, 0.55, -12, 0 ],
      [ 20, 0.55, -2, Math.PI / 2 ], [ 20, 0.55, 1.5, Math.PI / 2 ],
      [ -30, 0.55, 26, 0.4 ], [ -26.6, 0.55, 27.2, 0.4 ],
      [ 10, 0.55, 14, Math.PI / 2 ], [ 10, 0.55, 17.5, Math.PI / 2 ],
      [ -14, 0.55, 20, 0 ], [ -10.5, 0.55, 20, 0 ],
    ];
    this._instanced( concrete, this._barrierGeometry(), barrierTransforms, 1.1 );

    // --- Spawn points, on open ground away from the player's start ------------
    this.spawnPoints = [
      [ -28, 0, -28 ], [ 28, 0, -28 ], [ -28, 0, 28 ], [ 30, 0, 6 ],
      [ 0, 0, -30 ], [ -32, 0, 0 ], [ 16, 0, -20 ], [ -16, 0, 16 ],
      [ 4, 0, 30 ], [ -19, 2.6, -17 ], [ 21, 4.2, 19 ],
    ].map( ( [ x, y, z ] ) => new THREE.Vector3( x, y, z ) );
  }

  _buildRamp( material, base, width, height, run ) {
    // Stepped ramp: cheap, collides correctly with the AABB solver, and the
    // steps catch the low sun in a way a smooth wedge does not.
    const steps = 7;
    for ( let i = 0; i < steps; i ++ ) {
      const h = height * ( i + 1 ) / steps;
      const d = run / steps;
      this._solid(
        material,
        [ width, h, d ],
        [ base[ 0 ], h / 2, base[ 2 ] - run / 2 + d * ( i + 0.5 ) ],
      );
    }
  }

  _barrierGeometry() {
    // Trapezoid cross-section jersey barrier.
    const shape = new THREE.Shape();
    shape.moveTo( -0.5, -0.55 );
    shape.lineTo( 0.5, -0.55 );
    shape.lineTo( 0.28, 0.05 );
    shape.lineTo( 0.2, 0.55 );
    shape.lineTo( -0.2, 0.55 );
    shape.lineTo( -0.28, 0.05 );
    shape.closePath();

    const geo = new THREE.ExtrudeGeometry( shape, { depth: 3.2, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: 1 } );
    geo.translate( 0, 0, -1.6 );
    geo.rotateY( Math.PI / 2 );
    geo.computeVertexNormals();
    return geo;
  }

  _instanced( material, geometry, transforms, colliderSize, { collide = true, cast = true } = {} ) {
    const mesh = new THREE.InstancedMesh( geometry, material, transforms.length );
    mesh.castShadow = cast;
    mesh.receiveShadow = true;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3( 1, 1, 1 );

    transforms.forEach( ( [ x, y, z, rotY ], i ) => {
      pos.set( x, y, z );
      q.setFromAxisAngle( new THREE.Vector3( 0, 1, 0 ), rotY );
      m.compose( pos, q, scale );
      mesh.setMatrixAt( i, m );

      if ( ! collide ) return;

      // Conservative AABB: a rotated box needs its diagonal, not its edge.
      geometry.computeBoundingBox();
      const bb = geometry.boundingBox;
      const hy = ( bb.max.y - bb.min.y ) * 0.5;
      const r = colliderSize * 0.5 * Math.SQRT2;

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

  _buildLights() {
    // Emissive strips: these exist to feed the bloom threshold and to give the
    // shaded side of the courtyard some colour separation from the sunlit side.
    const stripMat = new THREE.MeshStandardMaterial( {
      color: 0x000000, emissive: 0x4fc3f7, emissiveIntensity: 6.0,
      roughness: 1, metalness: 0,
    } );
    const signMat = new THREE.MeshStandardMaterial( {
      color: 0x000000, emissive: 0xff5a3c, emissiveIntensity: 7.5,
      roughness: 1, metalness: 0,
    } );

    for ( const z of [ -20, -4, 12, 28 ] ) {
      const strip = this._solid( stripMat, [ 0.16, 0.16, 5.5 ], [ -HALF + 0.2, 6.2, z ], { collide: false, cast: false } );
      strip.name = 'strip';
      const l = new THREE.PointLight( 0x4fc3f7, 14, 16, 2 );
      l.position.set( -HALF + 1.2, 6.2, z );
      this.group.add( l );
    }

    const sign = this._solid( signMat, [ 7.5, 1.4, 0.2 ], [ 0, 9.5, -HALF - 0.1 ], { collide: false, cast: false } );
    sign.name = 'sign';
    const signLight = new THREE.PointLight( 0xff5a3c, 40, 30, 2 );
    signLight.position.set( 0, 9.0, -HALF + 2.5 );
    this.group.add( signLight );

    // Warm practicals over the raised platforms.
    for ( const [ x, z ] of [ [ -19, -17 ], [ 21, 19 ] ] ) {
      const l = new THREE.PointLight( 0xffb060, 26, 22, 2 );
      l.position.set( x, 7.5, z );
      this.group.add( l );
      const bulbMat = new THREE.MeshStandardMaterial( {
        color: 0x000000, emissive: 0xffb060, emissiveIntensity: 8, roughness: 1,
      } );
      this._solid( bulbMat, [ 0.5, 0.14, 0.5 ], [ x, 7.55, z ], { collide: false, cast: false } );
    }
  }

  // -------------------------------------------------------------------------

  /** Cheap "is this AABB clear" test used by enemy spawning. */
  isClear( box ) {
    return ! this.colliders.some( c => c.intersectsBox( box ) );
  }
}
