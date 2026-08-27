import * as THREE from 'three';

/**
 * Blockout humanoid targets with hitbox-based damage, crude steering AI and a
 * death/respawn cycle.
 *
 * Hitboxes are real child meshes tagged in `userData`, so the same raycast that
 * hits the world also resolves head vs. body multipliers with no extra work.
 * Swapping the blockout for a Mixamo-rigged GLB is the intended next step —
 * the AI, damage and hitbox tagging all survive that change (docs/TASKS.md, T-11).
 */

const MAX_ENEMIES = 8;
const RESPAWN_DELAY = 2.6;

const PALETTE = [
  { body: 0x2f3a4a, accent: 0xd94f3d },
  { body: 0x3d3a32, accent: 0xe0a02c },
  { body: 0x2b3b34, accent: 0x4fc3a1 },
  { body: 0x39303c, accent: 0x9b6bd6 },
];

let _idCounter = 0;

class Enemy {

  constructor( manager, palette ) {
    this.manager = manager;
    this.id = ++ _idCounter;

    this.maxHealth = 100;
    this.health = this.maxHealth;
    this.alive = false;
    /** False until `spawn()` has ever been called; keeps the pool inert. */
    this.deployed = false;
    this.state = 'idle';

    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.facing = 0;
    this.speed = 3.2 + Math.random() * 1.6;
    this.radius = 0.38;
    this.height = 1.82;

    this._respawnTimer = 0;
    this._deathTime = 0;
    this._hitFlash = 0;
    this._fireTimer = 1 + Math.random() * 2;
    this._strafeDir = Math.random() < 0.5 ? -1 : 1;
    this._strafeTimer = 0;
    this._repathTimer = 0;
    this._blockedTime = 0;

    this.group = new THREE.Group();
    this.group.visible = false;
    this._build( palette );
  }

  _build( palette ) {
    const bodyMat = new THREE.MeshStandardMaterial( {
      color: palette.body, roughness: 0.68, metalness: 0.12, envMapIntensity: 1.0,
    } );
    const accentMat = new THREE.MeshStandardMaterial( {
      color: palette.accent, roughness: 0.5, metalness: 0.2, envMapIntensity: 1.1,
    } );
    const headMat = new THREE.MeshStandardMaterial( {
      color: 0x8d7461, roughness: 0.72, metalness: 0.0,
    } );
    const visorMat = new THREE.MeshStandardMaterial( {
      color: 0x000000, emissive: palette.accent, emissiveIntensity: 2.4, roughness: 1,
    } );

    this.materials = [ bodyMat, accentMat, headMat, visorMat ];

    const part = ( mat, geo, pos, partName, rot = [ 0, 0, 0 ] ) => {
      const m = new THREE.Mesh( geo, mat );
      m.position.set( ...pos );
      m.rotation.set( ...rot );
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.part = partName;
      m.userData.enemy = this;
      this.group.add( m );
      return m;
    };

    // Torso + chest rig
    part( bodyMat, new THREE.BoxGeometry( 0.52, 0.62, 0.30 ), [ 0, 1.20, 0 ], 'body' );
    part( accentMat, new THREE.BoxGeometry( 0.56, 0.24, 0.34 ), [ 0, 1.34, 0 ], 'body' );
    // Hips
    part( bodyMat, new THREE.BoxGeometry( 0.46, 0.26, 0.28 ), [ 0, 0.80, 0 ], 'body' );

    // Head + visor
    this.head = part( headMat, new THREE.SphereGeometry( 0.145, 16, 12 ), [ 0, 1.68, 0 ], 'head' );
    part( bodyMat, new THREE.BoxGeometry( 0.30, 0.16, 0.30 ), [ 0, 1.74, 0 ], 'head' );
    part( visorMat, new THREE.BoxGeometry( 0.22, 0.05, 0.04 ), [ 0, 1.68, -0.145 ], 'head' );
    // Neck
    part( bodyMat, new THREE.CylinderGeometry( 0.075, 0.085, 0.14, 8 ), [ 0, 1.55, 0 ], 'body' );

    // Arms
    this.armL = part( bodyMat, new THREE.CapsuleGeometry( 0.085, 0.42, 4, 8 ), [ -0.34, 1.16, 0 ], 'limb' );
    this.armR = part( bodyMat, new THREE.CapsuleGeometry( 0.085, 0.42, 4, 8 ), [ 0.34, 1.16, 0 ], 'limb' );

    // Legs
    this.legL = part( bodyMat, new THREE.CapsuleGeometry( 0.105, 0.52, 4, 8 ), [ -0.14, 0.42, 0 ], 'limb' );
    this.legR = part( bodyMat, new THREE.CapsuleGeometry( 0.105, 0.52, 4, 8 ), [ 0.14, 0.42, 0 ], 'limb' );

    // A stubby rifle so the silhouette reads as armed.
    part( accentMat, new THREE.BoxGeometry( 0.07, 0.09, 0.52 ), [ 0.30, 1.14, -0.22 ], 'limb' );
  }

  spawn( position ) {
    this.position.copy( position );
    this.velocity.set( 0, 0, 0 );
    this.health = this.maxHealth;
    this.alive = true;
    this.deployed = true;
    this.state = 'chase';
    this._deathTime = 0;
    this._hitFlash = 0;
    this._fireTimer = 1.2 + Math.random() * 2.2;
    this.group.visible = true;
    this.group.position.copy( position );
    this.group.rotation.set( 0, 0, 0 );
    this.group.scale.setScalar( 1 );
    this.group.traverse( o => { if ( o.isMesh ) o.material.emissiveIntensity ??= 0; } );
  }

  /**
   * @returns {{ killed: boolean, damage: number, headshot: boolean }}
   */
  takeDamage( amount, part ) {
    if ( ! this.alive ) return { killed: false, damage: 0, headshot: false };

    const headshot = part === 'head';
    const multiplier = headshot ? 2.4 : part === 'limb' ? 0.72 : 1;
    const dealt = Math.round( amount * multiplier );

    this.health -= dealt;
    this._hitFlash = 0.14;

    if ( this.health <= 0 ) {
      this.health = 0;
      this.alive = false;
      this.state = 'dead';
      this._deathTime = 0;
      this._respawnTimer = RESPAWN_DELAY;
      return { killed: true, damage: dealt, headshot };
    }
    return { killed: false, damage: dealt, headshot };
  }

  update( dt, ctx ) {
    if ( ! this.deployed ) return null;
    if ( ! this.alive ) return this._updateDead( dt, ctx );

    const { playerPosition, level } = ctx;

    // --- Steering ------------------------------------------------------------
    const toPlayer = new THREE.Vector3().subVectors( playerPosition, this.position );
    toPlayer.y = 0;
    const distance = toPlayer.length();
    if ( distance > 0.001 ) toPlayer.divideScalar( distance );

    this._strafeTimer -= dt;
    if ( this._strafeTimer <= 0 ) {
      this._strafeTimer = 1.1 + Math.random() * 1.8;
      this._strafeDir = Math.random() < 0.5 ? -1 : 1;
    }

    const strafe = new THREE.Vector3( -toPlayer.z, 0, toPlayer.x ).multiplyScalar( this._strafeDir );

    // Hold a firing stand-off band rather than walking into the player's face.
    let approach = 0;
    if ( distance > 16 ) approach = 1;
    else if ( distance < 7 ) approach = -0.7;
    else approach = 0.15;

    const desired = new THREE.Vector3()
      .addScaledVector( toPlayer, approach )
      .addScaledVector( strafe, 0.55 );
    if ( desired.lengthSq() > 0 ) desired.normalize().multiplyScalar( this.speed );

    this.velocity.x = THREE.MathUtils.damp( this.velocity.x, desired.x, 8, dt );
    this.velocity.z = THREE.MathUtils.damp( this.velocity.z, desired.z, 8, dt );

    const before = this.position.clone();
    this._moveWithCollision( this.velocity.x * dt, this.velocity.z * dt, level );

    // Wall-hugging fallback: if we barely moved, flip the strafe direction.
    if ( before.distanceToSquared( this.position ) < ( this.speed * dt * 0.25 ) ** 2 ) {
      this._blockedTime += dt;
      if ( this._blockedTime > 0.35 ) { this._strafeDir *= -1; this._blockedTime = 0; }
    } else {
      this._blockedTime = 0;
    }

    // --- Gravity / ground snap ----------------------------------------------
    this.velocity.y -= 22 * dt;
    this._moveVertical( this.velocity.y * dt, level );

    // --- Facing + animation --------------------------------------------------
    this.facing = Math.atan2( toPlayer.x, toPlayer.z );
    this.group.position.copy( this.position );
    this.group.rotation.y = this.facing + Math.PI;

    const gait = Math.hypot( this.velocity.x, this.velocity.z );
    this._animate( ctx.elapsed, gait );

    // --- Hit flash -----------------------------------------------------------
    if ( this._hitFlash > 0 ) {
      this._hitFlash -= dt;
      const k = Math.max( 0, this._hitFlash / 0.14 );
      this.materials[ 0 ].emissive.setRGB( k * 0.9, k * 0.05, k * 0.05 );
      this.materials[ 0 ].emissiveIntensity = 1;
      this.materials[ 2 ].emissive.setRGB( k * 0.9, k * 0.05, k * 0.05 );
      this.materials[ 2 ].emissiveIntensity = 1;
    }

    // --- Shooting ------------------------------------------------------------
    this._fireTimer -= dt;
    if ( this._fireTimer <= 0 && distance < 34 ) {
      this._fireTimer = 1.4 + Math.random() * 1.6;
      ctx.onEnemyFire?.( this, distance );
    }

    return null;
  }

  _updateDead( dt, ctx ) {
    this._deathTime += dt;
    this._respawnTimer -= dt;

    // Topple forward, then sink out of sight.
    const t = Math.min( 1, this._deathTime / 0.55 );
    const ease = 1 - Math.pow( 1 - t, 3 );
    this.group.rotation.x = ease * ( Math.PI / 2 ) * 0.92;
    this.group.position.y = this.position.y - ease * 0.32;

    if ( this._deathTime > 1.6 ) {
      const sink = Math.min( 1, ( this._deathTime - 1.6 ) / 1.0 );
      this.group.position.y = this.position.y - 0.32 - sink * 1.4;
    }

    this.materials[ 0 ].emissiveIntensity = 0;
    this.materials[ 2 ].emissiveIntensity = 0;

    if ( this._respawnTimer <= 0 ) {
      this.group.visible = false;
      this.deployed = false;
      return 'respawn';
    }
    return null;
  }

  _animate( elapsed, gait ) {
    const swing = Math.sin( elapsed * 7 + this.id ) * Math.min( gait / 3.2, 1 );
    this.legL.rotation.x = swing * 0.55;
    this.legR.rotation.x = -swing * 0.55;
    this.armL.rotation.x = -swing * 0.32;
    this.armR.rotation.x = swing * 0.18;
    // Slight vertical bounce sells the walk more than limb swing alone.
    this.group.position.y = this.position.y + Math.abs( Math.sin( elapsed * 7 + this.id ) ) * 0.03 * Math.min( gait / 3.2, 1 );
  }

  _boxAt( x, y, z ) {
    return new THREE.Box3(
      new THREE.Vector3( x - this.radius, y + 0.05, z - this.radius ),
      new THREE.Vector3( x + this.radius, y + this.height, z + this.radius ),
    );
  }

  _collides( x, y, z, level ) {
    const box = this._boxAt( x, y, z );
    return level.colliders.some( c => box.intersectsBox( c ) );
  }

  _moveWithCollision( dx, dz, level ) {
    const p = this.position;
    if ( dx !== 0 && ! this._collides( p.x + dx, p.y, p.z, level ) ) p.x += dx;
    if ( dz !== 0 && ! this._collides( p.x, p.y, p.z + dz, level ) ) p.z += dz;
  }

  _moveVertical( dy, level ) {
    const p = this.position;
    if ( ! this._collides( p.x, p.y + dy, p.z, level ) ) {
      p.y += dy;
      if ( p.y < 0 ) { p.y = 0; this.velocity.y = 0; }
    } else {
      this.velocity.y = 0;
    }
  }
}

// ---------------------------------------------------------------------------

export class EnemyManager {

  constructor( scene, level ) {
    this.scene = scene;
    this.level = level;
    this.group = new THREE.Group();
    this.group.name = 'Enemies';
    scene.add( this.group );

    this.enemies = [];
    for ( let i = 0; i < MAX_ENEMIES; i ++ ) {
      const e = new Enemy( this, PALETTE[ i % PALETTE.length ] );
      this.group.add( e.group );
      this.enemies.push( e );
    }

    this.kills = 0;
    this._spawnCursor = 0;
    this.onEnemyFire = null;
  }

  /** Raycast targets — every hitbox mesh of every living enemy. */
  get hitboxes() {
    const out = [];
    for ( const e of this.enemies ) {
      if ( e.alive ) out.push( ...e.group.children );
    }
    return out;
  }

  spawnInitial( count = 5 ) {
    for ( let i = 0; i < count; i ++ ) this.spawnOne();
  }

  spawnOne( awayFrom = null, minDistance = 18 ) {
    const e = this.enemies.find( x => ! x.deployed );
    if ( ! e ) return null;

    const points = this.level.spawnPoints;
    for ( let attempt = 0; attempt < points.length; attempt ++ ) {
      const p = points[ ( this._spawnCursor + attempt ) % points.length ];
      if ( awayFrom && p.distanceTo( awayFrom ) < minDistance ) continue;
      this._spawnCursor = ( this._spawnCursor + attempt + 1 ) % points.length;
      e.spawn( p );
      return e;
    }
    // Every point was too close; take the first anyway rather than stall.
    e.spawn( points[ 0 ] );
    return e;
  }

  update( dt, ctx ) {
    for ( const e of this.enemies ) {
      const result = e.update( dt, { ...ctx, level: this.level, onEnemyFire: this.onEnemyFire } );
      if ( result === 'respawn' ) this.spawnOne( ctx.playerPosition );
    }
  }

  /** Resolves a raycast hit against an enemy hitbox into damage. */
  applyHit( object, damage ) {
    const enemy = object.userData.enemy;
    if ( ! enemy ) return null;
    const result = enemy.takeDamage( damage, object.userData.part );
    if ( result.killed ) this.kills ++;
    return { ...result, enemy };
  }
}
