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

/**
 * Where the weapon sits in enemy-local space. Tracers and the line-of-sight
 * test must start from the same point, or an enemy can be denied a shot the
 * player watched it take.
 */
const MUZZLE = [ 0.30, 1.14, -0.48 ];

/**
 * How long a blocked enemy waits before testing again.
 *
 * Without this the fire timer would sit expired behind cover and discharge the
 * instant the player leans out, which punishes peeking harder than the old
 * shoot-through-walls behaviour did. This doubles as a crude reaction time.
 */
const BLOCKED_RECHECK = 0.35;

/**
 * Perception, not omniscience.
 *
 * Before this the AI read the player's exact position every frame and snapped
 * to face it, which is what made it feel like a machine rather than a person.
 * These four numbers are the whole difference: a cone it has to be looking
 * through, a rate it has to turn at, a delay before it reacts, and a memory
 * that outlives losing sight.
 */
const FOV_HALF = Math.PI * 55 / 180;   // 110° total, roughly human useful vision
const SIGHT_RANGE = 46;
const TURN_RATE = 3.2;                 // rad/s — fast, but a flank can beat it
const REACTION = 0.28;                 // seconds in view before it will shoot
const MEMORY = 4.0;                    // seconds it searches once it gets there
const ARRIVED = 4.0;                   // metres — close enough to count as "there"
const SCAN_RATE = 0.75;                // idle look-around, radians/s of sweep phase
const SCAN_SWEEP = Math.PI * 40 / 180; // ±40° either side of where it lost interest

/**
 * How often the occlusion ray actually runs. Perception is queried every frame
 * but the ray costs ~2 µs against 54 boxes, and re-testing at 120 Hz buys
 * nothing a human could perceive — 80 ms of lag here reads as reaction, not as
 * latency.
 */
const LOS_INTERVAL = 0.08;

/** Signed shortest angular difference, in (-π, π]. */
function wrapAngle( a ) {
  return a - Math.PI * 2 * Math.floor( ( a + Math.PI ) / ( Math.PI * 2 ) );
}

/** Step `from` toward `to` by at most `maxStep`, the short way round. */
function approachAngle( from, to, maxStep ) {
  const delta = wrapAngle( to - from );
  return from + Math.sign( delta ) * Math.min( Math.abs( delta ), maxStep );
}

// Scratch vectors: the sight test runs on the update path and must not allocate.
const _ray = new THREE.Ray();
const _from = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _hit = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _toTarget = new THREE.Vector3();
const _strafe = new THREE.Vector3();
const _look = new THREE.Vector3();
const _flat = new THREE.Vector3();

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

    // --- Perception ---------------------------------------------------------
    /** Where this enemy believes the player is. Only meaningful with `hasTarget`. */
    this.lastKnown = new THREE.Vector3();
    this.hasTarget = false;
    /** True only while the player is genuinely in view this frame. */
    this.visible = false;
    /** In view long enough to shoot. */
    this.engaged = false;

    this._sawFor = 0;
    this._sinceSeen = Infinity;
    this._losTimer = 0;
    this._losCached = false;
    this._alertPending = false;
    this._scanPhase = Math.random() * Math.PI * 2;
    this._scanBase = null;

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

  /**
   * @param {THREE.Vector3} position spawn point
   * @param {THREE.Vector3} [knownTarget] where the player was when this enemy
   *   arrived. A reinforcement is not a sentry: without this it stands at its
   *   spawn point scanning until the player happens to walk into its cone.
   *   It is a belief, not knowledge — it still has to see the player to shoot,
   *   and it decays like any other.
   */
  spawn( position, knownTarget = null ) {
    this.position.copy( position );
    this.velocity.set( 0, 0, 0 );
    this.health = this.maxHealth;
    this.alive = true;
    this.deployed = true;
    this.state = 'chase';
    this._deathTime = 0;
    this._hitFlash = 0;

    this.visible = false;
    this.engaged = false;
    this._sawFor = 0;
    this._losTimer = 0;
    this._losCached = false;
    this._alertPending = false;
    this._scanBase = null;
    this.hasTarget = !! knownTarget;
    this._sinceSeen = knownTarget ? 0 : Infinity;
    if ( knownTarget ) this.lastKnown.copy( knownTarget );
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
    // Taking a hit tells you roughly where it came from even with your back
    // turned. Resolved on the next update, so it records where the player was
    // when the shot landed rather than tracking them from then on.
    this._alertPending = true;

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

    const distance = this._perceive( dt, playerPosition, level );

    // --- Steering -------------------------------------------------------------
    // Steer at what it believes, not at the player. With no belief it holds
    // position and looks around, which is what "lost him" is supposed to be.
    const desired = _desired.set( 0, 0, 0 );

    if ( this.hasTarget ) {
      const toTarget = _toTarget.subVectors( this.lastKnown, this.position );
      toTarget.y = 0;
      const range = toTarget.length();
      if ( range > 0.001 ) toTarget.divideScalar( range );

      this._strafeTimer -= dt;
      if ( this._strafeTimer <= 0 ) {
        this._strafeTimer = 1.1 + Math.random() * 1.8;
        this._strafeDir = Math.random() < 0.5 ? -1 : 1;
      }

      // Hold a firing stand-off band rather than walking into the player's
      // face — but only while actually looking at them. Closing on a remembered
      // position means walking all the way to it.
      let approach, strafeWeight;
      if ( this.visible ) {
        approach = range > 16 ? 1 : range < 7 ? -0.7 : 0.15;
        strafeWeight = 0.55;
      } else {
        approach = range > 1.5 ? 1 : 0;
        strafeWeight = 0.15;
      }

      const strafe = _strafe.set( -toTarget.z, 0, toTarget.x ).multiplyScalar( this._strafeDir );
      desired.addScaledVector( toTarget, approach ).addScaledVector( strafe, strafeWeight );
      if ( desired.lengthSq() > 0 ) desired.normalize().multiplyScalar( this.speed );
    }

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
    // Turned at a rate, never snapped. An instant lock onto the player is the
    // single most machine-like thing an enemy can do, and it makes flanking
    // impossible by construction.
    if ( this.hasTarget ) {
      this._scanBase = null;
      const look = _look.subVectors( this.lastKnown, this.position );
      this.facing = approachAngle(
        this.facing, Math.atan2( look.x, look.z ), TURN_RATE * dt,
      );
    } else {
      // Nothing to look at: sweep ±SCAN_SWEEP around the heading it gave up on,
      // so a player creeping along the edge of the cone is eventually found.
      // Bounded deliberately — integrating a sine into `facing` directly lets
      // the drift accumulate until the enemy has spun to face the other way,
      // which looks like searching for about a second and like a lighthouse
      // after that.
      if ( this._scanBase === null ) this._scanBase = this.facing;
      this._scanPhase += dt * SCAN_RATE;
      this.facing = approachAngle(
        this.facing,
        this._scanBase + Math.sin( this._scanPhase ) * SCAN_SWEEP,
        TURN_RATE * dt,
      );
    }

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
      // `engaged` already means in cone, unoccluded, and looked at for long
      // enough — so there is no second sight test to keep in step with this one.
      if ( this.engaged ) {
        this._fireTimer = 1.4 + Math.random() * 1.6;
        ctx.onEnemyFire?.( this, distance );
      } else {
        this._fireTimer = BLOCKED_RECHECK;
      }
    }

    return null;
  }

  /**
   * Updates what this enemy believes about the player, and returns the true
   * ground distance to them (steering and the fire range still need it).
   *
   * Belief is deliberately weaker than knowledge: the player has to be inside
   * the vision cone, unoccluded, and stay there for `REACTION` before the enemy
   * will shoot. Losing sight does not erase the belief — `lastKnown` survives
   * for `MEMORY`, which is what turns "he vanished" into pursuit rather than
   * into an instant reset.
   */
  _perceive( dt, playerPosition, level ) {
    const flat = _flat.subVectors( playerPosition, this.position );
    flat.y = 0;
    const distance = flat.length();

    // Cheap tests first: the occlusion ray only runs for a player who is close
    // enough and actually within the cone.
    const bearing = distance > 1e-4 ? Math.atan2( flat.x, flat.z ) : this.facing;
    const inCone = distance < SIGHT_RANGE
      && Math.abs( wrapAngle( bearing - this.facing ) ) <= FOV_HALF;

    this._losTimer -= dt;
    if ( inCone ) {
      if ( this._losTimer <= 0 ) {
        this._losTimer = LOS_INTERVAL;
        this._losCached = this.canSee( playerPosition, level );
      }
    } else {
      this._losCached = false;
    }

    this.visible = inCone && this._losCached;

    if ( this.visible ) {
      this._sawFor = Math.min( this._sawFor + dt, REACTION );
      this._sinceSeen = 0;
      this.lastKnown.copy( playerPosition );
      this.hasTarget = true;
    } else {
      // Decays slower than it builds, so brief cover does not reset the enemy
      // all the way back to unaware.
      this._sawFor = Math.max( 0, this._sawFor - dt * 0.6 );

      // The forget-clock only runs once it has actually reached where it last
      // saw them. Running it while still travelling means anything further away
      // than MEMORY x speed can never be reached — a reinforcement would give
      // up halfway across the arena, every time.
      const dx = this.position.x - this.lastKnown.x;
      const dz = this.position.z - this.lastKnown.z;
      if ( dx * dx + dz * dz < ARRIVED * ARRIVED ) this._sinceSeen += dt;
    }

    if ( this._alertPending ) {
      this._alertPending = false;
      this.lastKnown.copy( playerPosition );
      this.hasTarget = true;
      this._sinceSeen = 0;
    }

    if ( this.hasTarget && this._sinceSeen > MEMORY ) {
      this.hasTarget = false;
      this._sawFor = 0;
    }

    this.engaged = this.visible && this._sawFor >= REACTION;
    this.state = this.engaged ? 'engaged' : this.hasTarget ? 'searching' : 'idle';

    return distance;
  }

  /** World position of the weapon muzzle — where tracers and sight both start. */
  muzzleWorld( target = new THREE.Vector3() ) {
    return this.group.localToWorld( target.set( MUZZLE[ 0 ], MUZZLE[ 1 ], MUZZLE[ 2 ] ) );
  }

  /**
   * Can this enemy actually see `target`?
   *
   * Tests the muzzle-to-eye segment against the level's collider boxes — the
   * same world the player collides with, so anything that stops the player
   * stops a bullet. Enemies previously rolled to hit on distance alone and
   * shot straight through walls, which made every piece of cover in the level
   * decorative for one side of the fight and real for the other.
   *
   * Colliders rather than `hittables`: railings, window glass and roof
   * parapets are deliberately non-colliding, and none of them should grant
   * cover the player cannot also stand behind.
   */
  canSee( target, level ) {
    const from = this.muzzleWorld( _from );
    _dir.subVectors( target, from );
    const range = _dir.length();
    if ( range < 1e-4 ) return true;

    _ray.set( from, _dir.divideScalar( range ) );

    for ( const box of level.colliders ) {
      // A box the muzzle is already inside cannot occlude this shot — an enemy
      // clipped into a barrier would otherwise be permanently blind.
      if ( box.containsPoint( from ) ) continue;
      if ( _ray.intersectBox( box, _hit ) && _hit.distanceToSquared( from ) < range * range ) {
        return false;
      }
    }
    return true;
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
      e.spawn( p, awayFrom );
      return e;
    }
    // Every point was too close; take the first anyway rather than stall.
    e.spawn( points[ 0 ], awayFrom );
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
