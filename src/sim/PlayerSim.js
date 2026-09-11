import * as THREE from 'three';
import { BTN } from './Command.js';

/**
 * The authoritative half of the character controller.
 *
 * This is every part of a player that both the client and the server have to
 * agree on: where they are, how fast, which way they are facing, whether they
 * are crouched, how much health and stamina they have left. It takes a
 * `Command` and a `dt` and advances one tick. It touches no camera, no scene
 * graph and no DOM, so the identical code runs in the browser for prediction
 * and on the server for authority — which is the whole point, because two
 * implementations of movement is two sets of movement bugs and a permanent
 * disagreement about who is standing where.
 *
 * Head bob, the view kick after a shot, FOV and footstep audio are NOT here.
 * They change nothing another player can observe, so they stay in `Player`
 * where they belong.
 *
 * Collision is swept-AABB against the level's box list, resolved one axis at a
 * time, with a step-up retry so stairs and kerbs are walkable without a
 * navmesh. `position` is the feet position.
 *
 * Note what this deliberately does NOT promise: bit-identical results across
 * machines. `MathUtils.damp` runs `Math.exp`, whose last bit is not pinned by
 * the spec, so a lockstep peer-to-peer model would drift. Server-authoritative
 * prediction does not need that — the server's state wins and the client
 * resimulates from it — and buying cross-platform determinism would cost a
 * fixed-point rewrite of all of this.
 */

export const STAND_HEIGHT = 1.78;
export const CROUCH_HEIGHT = 1.08;
export const RADIUS = 0.36;
export const STEP_HEIGHT = 0.55;

const GRAVITY = -22;
const JUMP_SPEED = 7.6;
const SPEED = { walk: 5.4, sprint: 8.6, crouch: 2.6 };

export class PlayerSim {

  /**
   * @param {import('../world/Colliders.js').Colliders} colliders the static world
   * @param {THREE.Vector3} start feet position to spawn at
   */
  constructor( colliders, start ) {
    this.colliders = colliders;

    this.position = start ? start.clone() : new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    // forward = ( -sin(yaw), 0, -cos(yaw) ), so yaw 0 looks down -Z.
    this.yaw = 0;
    this.pitch = 0;

    this.height = STAND_HEIGHT;
    this.targetHeight = STAND_HEIGHT;
    this.grounded = false;
    this.crouching = false;
    this.sprinting = false;
    this.aiming = false;
    this.adsBlend = 0;

    this.health = 100;
    this.maxHealth = 100;
    this.stamina = 100;
    this.maxStamina = 100;

    /** Set on the tick a fall ends, for the client's landing dip. Not state. */
    this.landImpact = 0;

    this._box = new THREE.Box3();
    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._wish = new THREE.Vector3();
  }

  // --- collision -----------------------------------------------------------

  _boxAt( x, y, z, height = this.height ) {
    // Written in place: `Box3.set` copies its arguments, so building two fresh
    // vectors here would allocate twice on every collision probe.
    this._box.min.set( x - RADIUS, y, z - RADIUS );
    this._box.max.set( x + RADIUS, y + height, z + RADIUS );
    return this._box;
  }

  _collidesAt( x, y, z, height = this.height ) {
    return this.colliders.first( this._boxAt( x, y, z, height ) );
  }

  /**
   * Moves along one horizontal axis, retrying the move raised by STEP_HEIGHT
   * when blocked so the player walks up stairs instead of jamming on them.
   */
  _moveHorizontal( dx, dz ) {
    const tryAxis = ( axis, amount ) => {
      if ( amount === 0 ) return;
      const p = this.position;
      const nx = axis === 'x' ? p.x + amount : p.x;
      const nz = axis === 'z' ? p.z + amount : p.z;

      if ( ! this._collidesAt( nx, p.y, nz ) ) {
        p.x = nx; p.z = nz;
        return;
      }

      // Step-up retry: is it clear one step higher, and is there floor there?
      const stepY = p.y + STEP_HEIGHT;
      if ( ! this._collidesAt( nx, stepY, nz ) ) {
        // Drop back down onto whatever is beneath the stepped-up position.
        let landY = stepY;
        for ( let t = 0; t <= STEP_HEIGHT; t += 0.05 ) {
          if ( this._collidesAt( nx, stepY - t, nz ) ) { landY = stepY - t + 0.05; break; }
          landY = stepY - t;
        }
        if ( landY - p.y <= STEP_HEIGHT + 0.01 ) {
          p.x = nx; p.z = nz; p.y = landY;
          this.grounded = true;
          return;
        }
      }
      // Blocked: kill velocity on this axis so we slide along the wall.
      if ( axis === 'x' ) this.velocity.x = 0; else this.velocity.z = 0;
    };

    tryAxis( 'x', dx );
    tryAxis( 'z', dz );
  }

  _moveVertical( dy ) {
    const p = this.position;
    const ny = p.y + dy;

    if ( ! this._collidesAt( p.x, ny, p.z ) ) {
      p.y = ny;
      this.grounded = false;
      if ( p.y < 0 ) { p.y = 0; this.velocity.y = 0; this.grounded = true; }
      return;
    }

    // Resolve by bisecting toward the blocking surface.
    let lo = 0, hi = dy;
    for ( let i = 0; i < 8; i ++ ) {
      const mid = ( lo + hi ) / 2;
      if ( this._collidesAt( p.x, p.y + mid, p.z ) ) hi = mid; else lo = mid;
    }
    p.y += lo;

    if ( dy < 0 ) {
      if ( ! this.grounded && this.velocity.y < -7 ) {
        this.landImpact = Math.min( 0.22, -this.velocity.y * 0.014 );
      }
      this.grounded = true;
    }
    this.velocity.y = 0;
  }

  // --- tick ----------------------------------------------------------------

  /**
   * Advances one tick.
   *
   * @param {import('./Command.js').Command} cmd
   * @param {number} dt seconds; the fixed timestep, never a frame delta
   */
  step( cmd, dt ) {
    this.landImpact = 0;

    // View angles are taken, not integrated: the command carries them
    // absolutely, so a dropped packet costs one stale tick rather than a
    // permanent offset between what the client aims at and what the server
    // thinks it aims at.
    this.yaw = cmd.yaw;
    this.pitch = cmd.pitch;

    // --- stance -------------------------------------------------------------
    this.crouching = cmd.has( BTN.crouch );
    this.targetHeight = this.crouching ? CROUCH_HEIGHT : STAND_HEIGHT;

    // Refuse to stand up under an overhang.
    if ( ! this.crouching && this.height < STAND_HEIGHT - 0.01 ) {
      if ( this._collidesAt( this.position.x, this.position.y, this.position.z, STAND_HEIGHT ) ) {
        this.targetHeight = this.height;
      }
    }
    this.height = THREE.MathUtils.damp( this.height, this.targetHeight, 14, dt );

    // --- desired horizontal velocity ----------------------------------------
    this._forward.set( -Math.sin( this.yaw ), 0, -Math.cos( this.yaw ) );
    this._right.set( Math.cos( this.yaw ), 0, -Math.sin( this.yaw ) );

    let ix = 0, iz = 0;
    if ( cmd.has( BTN.forward ) ) iz += 1;
    if ( cmd.has( BTN.back ) ) iz -= 1;
    if ( cmd.has( BTN.right ) ) ix += 1;
    if ( cmd.has( BTN.left ) ) ix -= 1;
    this.moving = ix !== 0 || iz !== 0;

    this.aiming = cmd.has( BTN.aim );
    this.adsBlend = THREE.MathUtils.damp( this.adsBlend, this.aiming ? 1 : 0, 16, dt );

    const wantsSprint = cmd.has( BTN.sprint ) && iz > 0 && ! this.crouching && this.stamina > 1;
    this.sprinting = wantsSprint && this.grounded;
    // Sprinting and aiming are mutually exclusive; aiming wins.
    if ( this.aiming ) this.sprinting = false;

    this.stamina = THREE.MathUtils.clamp(
      this.stamina + ( this.sprinting ? -26 : 18 ) * dt, 0, this.maxStamina,
    );

    let speed = this.crouching ? SPEED.crouch : this.sprinting ? SPEED.sprint : SPEED.walk;
    if ( this.aiming ) speed *= 0.55;

    this._wish.set( 0, 0, 0 )
      .addScaledVector( this._forward, iz )
      .addScaledVector( this._right, ix );
    if ( this._wish.lengthSq() > 0 ) this._wish.normalize().multiplyScalar( speed );

    // Ground control is snappy; air control is deliberately weak.
    const accel = this.grounded ? 62 : 12;
    this.velocity.x = THREE.MathUtils.damp( this.velocity.x, this._wish.x, accel * 0.16, dt );
    this.velocity.z = THREE.MathUtils.damp( this.velocity.z, this._wish.z, accel * 0.16, dt );

    // --- jump / gravity -------------------------------------------------------
    if ( cmd.has( BTN.jump ) && this.grounded ) {
      this.velocity.y = JUMP_SPEED;
      this.grounded = false;
    }
    this.velocity.y += GRAVITY * dt;
    this.velocity.y = Math.max( this.velocity.y, -60 );

    // --- integrate ------------------------------------------------------------
    this._moveHorizontal( this.velocity.x * dt, this.velocity.z * dt );
    this._moveVertical( this.velocity.y * dt );

    // Ground probe: without it, walking off a ledge keeps `grounded` true for
    // a frame.
    if ( this.velocity.y <= 0 ) {
      this.grounded = !! this._collidesAt( this.position.x, this.position.y - 0.06, this.position.z )
        || this.position.y <= 0.001;
    }

    return this;
  }

  /** Eye position: where the camera sits and where shots come from. */
  eye( out ) {
    return out.set( this.position.x, this.position.y + this.height - 0.14, this.position.z );
  }

  damage( amount ) {
    this.health = Math.max( 0, this.health - amount );
    return this.health;
  }

  respawn( position ) {
    this.position.copy( position );
    this.velocity.set( 0, 0, 0 );
    this.health = this.maxHealth;
    this.stamina = this.maxStamina;
    this.yaw = 0;
    this.pitch = 0;
    this.height = STAND_HEIGHT;
    this.targetHeight = STAND_HEIGHT;
    this.grounded = true;
    this.crouching = false;
    this.sprinting = false;
    this.aiming = false;
    this.adsBlend = 0;
    this.landImpact = 0;
    return this;
  }

  // --- snapshots -----------------------------------------------------------
  //
  // Everything the client has to roll back to when the server disagrees.
  // `landImpact` and `moving` are outputs of a tick, not inputs to one, so they
  // are deliberately absent.

  saveState( out = {} ) {
    out.x = this.position.x; out.y = this.position.y; out.z = this.position.z;
    out.vx = this.velocity.x; out.vy = this.velocity.y; out.vz = this.velocity.z;
    out.yaw = this.yaw; out.pitch = this.pitch;
    out.height = this.height; out.targetHeight = this.targetHeight;
    out.grounded = this.grounded; out.crouching = this.crouching;
    out.sprinting = this.sprinting; out.aiming = this.aiming; out.adsBlend = this.adsBlend;
    out.health = this.health; out.stamina = this.stamina;
    return out;
  }

  loadState( s ) {
    this.position.set( s.x, s.y, s.z );
    this.velocity.set( s.vx, s.vy, s.vz );
    this.yaw = s.yaw; this.pitch = s.pitch;
    this.height = s.height; this.targetHeight = s.targetHeight;
    this.grounded = s.grounded; this.crouching = s.crouching;
    this.sprinting = s.sprinting; this.aiming = s.aiming; this.adsBlend = s.adsBlend;
    this.health = s.health; this.stamina = s.stamina;
    return this;
  }
}
