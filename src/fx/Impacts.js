import * as THREE from 'three';

/**
 * Pooled hit feedback: tracers, sparks, impact decals and smoke puffs.
 *
 * Everything here is allocated once at construction. Nothing in `update()`
 * calls `new` — per-frame allocation is the cheapest way to introduce GC
 * hitching into an otherwise smooth frame.
 */

const TRACER_POOL = 24;
const DECAL_POOL = 64;
const SPARK_POOL = 320;
const PUFF_POOL = 24;

function radialTexture( inner = 'rgba(20,18,16,0.95)', outer = 'rgba(20,18,16,0)' ) {
  const c = document.createElement( 'canvas' );
  c.width = c.height = 128;
  const ctx = c.getContext( '2d' );
  const g = ctx.createRadialGradient( 64, 64, 2, 64, 64, 62 );
  g.addColorStop( 0, inner );
  g.addColorStop( 0.55, inner.replace( /[\d.]+\)$/, '0.55)' ) );
  g.addColorStop( 1, outer );
  ctx.fillStyle = g;
  ctx.fillRect( 0, 0, 128, 128 );
  // A few speckles so decals do not read as perfect circles.
  ctx.globalCompositeOperation = 'source-atop';
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  for ( let i = 0; i < 22; i ++ ) {
    const a = Math.random() * Math.PI * 2, r = 12 + Math.random() * 44;
    ctx.beginPath();
    ctx.arc( 64 + Math.cos( a ) * r, 64 + Math.sin( a ) * r, 1.5 + Math.random() * 4, 0, Math.PI * 2 );
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture( c );
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Impacts {

  constructor( scene ) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'Impacts';
    scene.add( this.group );

    this._initTracers();
    this._initDecals();
    this._initSparks();
    this._initPuffs();

    this._tmpA = new THREE.Vector3();
    this._tmpB = new THREE.Vector3();
    this._tmpQ = new THREE.Quaternion();
    this._up = new THREE.Vector3( 0, 1, 0 );
  }

  // --- Tracers -------------------------------------------------------------

  _initTracers() {
    const geo = new THREE.CylinderGeometry( 0.012, 0.012, 1, 5, 1, true );
    geo.rotateX( Math.PI / 2 );          // align to -Z so we can lookAt()
    geo.translate( 0, 0, -0.5 );

    this._tracers = [];
    for ( let i = 0; i < TRACER_POOL; i ++ ) {
      const mat = new THREE.MeshBasicMaterial( {
        color: 0xffd9a0, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      } );
      const mesh = new THREE.Mesh( geo, mat );
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.group.add( mesh );
      this._tracers.push( { mesh, life: 0, maxLife: 0.07 } );
    }
    this._tracerCursor = 0;
  }

  spawnTracer( from, to ) {
    const t = this._tracers[ this._tracerCursor ];
    this._tracerCursor = ( this._tracerCursor + 1 ) % TRACER_POOL;

    const dist = from.distanceTo( to );
    t.mesh.position.copy( from );
    t.mesh.lookAt( to );
    t.mesh.scale.set( 1, 1, dist );
    t.mesh.visible = true;
    t.mesh.material.opacity = 0.85;
    t.life = t.maxLife;
  }

  // --- Decals --------------------------------------------------------------

  _initDecals() {
    const tex = radialTexture();
    const geo = new THREE.PlaneGeometry( 1, 1 );

    this._decals = [];
    for ( let i = 0; i < DECAL_POOL; i ++ ) {
      const mat = new THREE.MeshBasicMaterial( {
        map: tex, transparent: true, opacity: 0, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      } );
      const mesh = new THREE.Mesh( geo, mat );
      mesh.visible = false;
      this.group.add( mesh );
      this._decals.push( { mesh, life: 0, maxLife: 14 } );
    }
    this._decalCursor = 0;
  }

  spawnDecal( point, normal, size = 0.18 ) {
    const d = this._decals[ this._decalCursor ];
    this._decalCursor = ( this._decalCursor + 1 ) % DECAL_POOL;

    d.mesh.position.copy( point ).addScaledVector( normal, 0.012 );
    this._tmpA.copy( point ).add( normal );
    d.mesh.lookAt( this._tmpA );
    d.mesh.rotateZ( Math.random() * Math.PI * 2 );
    d.mesh.scale.setScalar( size * ( 0.75 + Math.random() * 0.6 ) );
    d.mesh.visible = true;
    d.mesh.material.opacity = 0.9;
    d.life = d.maxLife;
  }

  // --- Sparks --------------------------------------------------------------

  _initSparks() {
    const positions = new Float32Array( SPARK_POOL * 3 );
    const colors = new Float32Array( SPARK_POOL * 3 );
    const sizes = new Float32Array( SPARK_POOL );

    this._sparkVel = new Float32Array( SPARK_POOL * 3 );
    this._sparkLife = new Float32Array( SPARK_POOL );
    this._sparkMaxLife = new Float32Array( SPARK_POOL );
    this._sparkCursor = 0;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
    geo.setAttribute( 'color', new THREE.BufferAttribute( colors, 3 ) );
    geo.setAttribute( 'size', new THREE.BufferAttribute( sizes, 1 ) );
    geo.setDrawRange( 0, SPARK_POOL );

    const mat = new THREE.PointsMaterial( {
      size: 0.05, vertexColors: true, transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    } );

    this._sparks = new THREE.Points( geo, mat );
    this._sparks.frustumCulled = false;
    this.group.add( this._sparks );

    // Park every particle far below the level until it is used.
    for ( let i = 0; i < SPARK_POOL; i ++ ) positions[ i * 3 + 1 ] = -1000;
  }

  spawnSparks( point, normal, count = 14, color = [ 1.0, 0.72, 0.32 ] ) {
    const pos = this._sparks.geometry.attributes.position.array;
    const col = this._sparks.geometry.attributes.color.array;

    for ( let n = 0; n < count; n ++ ) {
      const i = this._sparkCursor;
      this._sparkCursor = ( this._sparkCursor + 1 ) % SPARK_POOL;

      pos[ i * 3 + 0 ] = point.x;
      pos[ i * 3 + 1 ] = point.y;
      pos[ i * 3 + 2 ] = point.z;

      // Scatter in the hemisphere around the surface normal.
      const speed = 2.2 + Math.random() * 5.5;
      const jitter = 0.85;
      this._sparkVel[ i * 3 + 0 ] = ( normal.x + ( Math.random() - 0.5 ) * jitter * 2 ) * speed;
      this._sparkVel[ i * 3 + 1 ] = ( normal.y + ( Math.random() - 0.5 ) * jitter * 2 + 0.5 ) * speed;
      this._sparkVel[ i * 3 + 2 ] = ( normal.z + ( Math.random() - 0.5 ) * jitter * 2 ) * speed;

      col[ i * 3 + 0 ] = color[ 0 ];
      col[ i * 3 + 1 ] = color[ 1 ];
      col[ i * 3 + 2 ] = color[ 2 ];

      this._sparkMaxLife[ i ] = 0.28 + Math.random() * 0.42;
      this._sparkLife[ i ] = this._sparkMaxLife[ i ];
    }
    this._sparks.geometry.attributes.position.needsUpdate = true;
    this._sparks.geometry.attributes.color.needsUpdate = true;
  }

  // --- Smoke puffs ---------------------------------------------------------

  _initPuffs() {
    const tex = radialTexture( 'rgba(180,178,172,0.55)', 'rgba(180,178,172,0)' );
    const geo = new THREE.PlaneGeometry( 1, 1 );

    this._puffs = [];
    for ( let i = 0; i < PUFF_POOL; i ++ ) {
      const mat = new THREE.MeshBasicMaterial( {
        map: tex, transparent: true, opacity: 0, depthWrite: false,
      } );
      const mesh = new THREE.Mesh( geo, mat );
      mesh.visible = false;
      this.group.add( mesh );
      this._puffs.push( { mesh, life: 0, maxLife: 0.55 } );
    }
    this._puffCursor = 0;
  }

  spawnPuff( point, normal ) {
    const p = this._puffs[ this._puffCursor ];
    this._puffCursor = ( this._puffCursor + 1 ) % PUFF_POOL;
    p.mesh.position.copy( point ).addScaledVector( normal, 0.05 );
    p.mesh.scale.setScalar( 0.22 );
    p.mesh.visible = true;
    p.mesh.material.opacity = 0.5;
    p.life = p.maxLife;
  }

  /** Convenience: everything a bullet hitting a hard surface should do. */
  bulletImpact( from, point, normal ) {
    this.spawnTracer( from, point );
    this.spawnDecal( point, normal );
    this.spawnSparks( point, normal, 12 );
    this.spawnPuff( point, normal );
  }

  /** Flesh hit: no decal, red particles, no smoke. */
  fleshImpact( from, point, normal ) {
    this.spawnTracer( from, point );
    this.spawnSparks( point, normal, 16, [ 0.85, 0.12, 0.10 ] );
  }

  // -------------------------------------------------------------------------

  update( dt, camera ) {
    // Tracers
    for ( const t of this._tracers ) {
      if ( t.life <= 0 ) continue;
      t.life -= dt;
      const k = Math.max( 0, t.life / t.maxLife );
      t.mesh.material.opacity = k * 0.85;
      if ( t.life <= 0 ) t.mesh.visible = false;
    }

    // Decals: hold full opacity, then fade over the last two seconds.
    for ( const d of this._decals ) {
      if ( d.life <= 0 ) continue;
      d.life -= dt;
      if ( d.life < 2 ) d.mesh.material.opacity = Math.max( 0, d.life / 2 ) * 0.9;
      if ( d.life <= 0 ) d.mesh.visible = false;
    }

    // Puffs: expand and fade, billboarded to the camera.
    for ( const p of this._puffs ) {
      if ( p.life <= 0 ) continue;
      p.life -= dt;
      const k = Math.max( 0, p.life / p.maxLife );
      p.mesh.material.opacity = k * 0.5;
      p.mesh.scale.setScalar( 0.22 + ( 1 - k ) * 0.75 );
      p.mesh.quaternion.copy( camera.quaternion );
      if ( p.life <= 0 ) p.mesh.visible = false;
    }

    // Sparks: ballistic, with drag.
    const pos = this._sparks.geometry.attributes.position.array;
    const col = this._sparks.geometry.attributes.color.array;
    let anyAlive = false;

    for ( let i = 0; i < SPARK_POOL; i ++ ) {
      if ( this._sparkLife[ i ] <= 0 ) continue;
      anyAlive = true;
      this._sparkLife[ i ] -= dt;

      const drag = Math.exp( -dt * 3.2 );
      this._sparkVel[ i * 3 + 0 ] *= drag;
      this._sparkVel[ i * 3 + 1 ] = this._sparkVel[ i * 3 + 1 ] * drag - 16 * dt;
      this._sparkVel[ i * 3 + 2 ] *= drag;

      pos[ i * 3 + 0 ] += this._sparkVel[ i * 3 + 0 ] * dt;
      pos[ i * 3 + 1 ] += this._sparkVel[ i * 3 + 1 ] * dt;
      pos[ i * 3 + 2 ] += this._sparkVel[ i * 3 + 2 ] * dt;

      // Fade by dimming the vertex colour; PointsMaterial has no per-point alpha.
      const k = Math.max( 0, this._sparkLife[ i ] / this._sparkMaxLife[ i ] );
      const f = k * k;
      col[ i * 3 + 0 ] *= 1; // hue held, brightness scaled below
      const base = 1 / Math.max( 0.0001, f + dt );
      void base;
      col[ i * 3 + 0 ] = Math.min( col[ i * 3 + 0 ], 1 ) * ( 0.9 + 0.1 * f );
      col[ i * 3 + 1 ] *= ( 0.88 + 0.12 * f );
      col[ i * 3 + 2 ] *= ( 0.82 + 0.18 * f );

      if ( this._sparkLife[ i ] <= 0 ) pos[ i * 3 + 1 ] = -1000;
    }

    if ( anyAlive ) {
      this._sparks.geometry.attributes.position.needsUpdate = true;
      this._sparks.geometry.attributes.color.needsUpdate = true;
    }
  }
}
