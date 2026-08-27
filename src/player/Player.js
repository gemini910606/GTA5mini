import * as THREE from 'three';

/**
 * First-person character controller.
 *
 * Collision is swept-AABB against the level's static box list, resolved one
 * axis at a time, with a step-up retry so stairs and kerbs are walkable without
 * a navmesh. `position` is the feet position; the camera sits at `eyeHeight`.
 */

const STAND_HEIGHT = 1.78;
const CROUCH_HEIGHT = 1.08;
const RADIUS = 0.36;
const STEP_HEIGHT = 0.55;
const GRAVITY = -22;
const JUMP_SPEED = 7.6;

const SPEED = { walk: 5.4, sprint: 8.6, crouch: 2.6, air: 1.4 };

export class Player {

  constructor( camera, level ) {
    this.camera = camera;
    this.level = level;

    this.position = level.playerStart.clone();
    this.velocity = new THREE.Vector3();
    // forward = ( -sin(yaw), 0, -cos(yaw) ), so yaw 0 looks down -Z, which is
    // into the courtyard from the southern spawn.
    this.yaw = 0;
    this.pitch = 0;

    this.height = STAND_HEIGHT;
    this.targetHeight = STAND_HEIGHT;
    this.grounded = false;
    this.crouching = false;
    this.sprinting = false;

    this.health = 100;
    this.maxHealth = 100;
    this.stamina = 100;
    this.maxStamina = 100;

    this.baseFov = 75;
    this.adsFov = 52;
    this.aiming = false;
    this._adsBlend = 0;

    this._bobPhase = 0;
    this._bobAmount = 0;
    this._stepPhase = 0;
    /** Fired once per footfall. `( sprinting: boolean ) => void` */
    this.onStep = null;
    this._recoilPitch = 0;
    this._recoilYaw = 0;
    this._landDip = 0;

    this._tmpBox = new THREE.Box3();
    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();

    this.camera.fov = this.baseFov;
    this.camera.updateProjectionMatrix();
  }

  // -------------------------------------------------------------------------
  // Collision
  // -------------------------------------------------------------------------

  _boxAt( x, y, z, height = this.height ) {
    // Written in place: `Box3.set` copies its arguments, so building two fresh
    // vectors here would allocate twice on every collision probe.
    this._tmpBox.min.set( x - RADIUS, y, z - RADIUS );
    this._tmpBox.max.set( x + RADIUS, y + height, z + RADIUS );
    return this._tmpBox;
  }

  _collidesAt( x, y, z, height = this.height ) {
    return this.level.broadphase.first( this._boxAt( x, y, z, height ) );
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
        this._landDip = Math.min( 0.22, -this.velocity.y * 0.014 );
      }
      this.grounded = true;
    }
    this.velocity.y = 0;
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  update( dt, input ) {
    // --- Look ---------------------------------------------------------------
    const look = input.consumeLook();
    const aimScale = 1 - this._adsBlend * 0.45;   // slower turn while aiming
    this.yaw += look.yaw * aimScale;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch + look.pitch * aimScale,
      -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02,
    );

    // --- Stance -------------------------------------------------------------
    this.crouching = input.isDown( 'ControlLeft' ) || input.isDown( 'KeyC' );
    this.targetHeight = this.crouching ? CROUCH_HEIGHT : STAND_HEIGHT;

    // Refuse to stand up under an overhang.
    if ( ! this.crouching && this.height < STAND_HEIGHT - 0.01 ) {
      if ( this._collidesAt( this.position.x, this.position.y, this.position.z, STAND_HEIGHT ) ) {
        this.targetHeight = this.height;
      }
    }
    this.height = THREE.MathUtils.damp( this.height, this.targetHeight, 14, dt );

    // --- Desired horizontal velocity ---------------------------------------
    this._forward.set( -Math.sin( this.yaw ), 0, -Math.cos( this.yaw ) );
    this._right.set( Math.cos( this.yaw ), 0, -Math.sin( this.yaw ) );

    let ix = 0, iz = 0;
    if ( input.isDown( 'KeyW' ) ) iz += 1;
    if ( input.isDown( 'KeyS' ) ) iz -= 1;
    if ( input.isDown( 'KeyD' ) ) ix += 1;
    if ( input.isDown( 'KeyA' ) ) ix -= 1;

    const moving = ix !== 0 || iz !== 0;
    const wantsSprint = input.isDown( 'ShiftLeft' ) && iz > 0 && ! this.crouching && this.stamina > 1;
    this.sprinting = wantsSprint && this.grounded;

    // Sprinting and aiming are mutually exclusive; aiming wins.
    if ( this.aiming ) this.sprinting = false;

    this.stamina = THREE.MathUtils.clamp(
      this.stamina + ( this.sprinting ? -26 : 18 ) * dt, 0, this.maxStamina,
    );

    let speed = this.crouching ? SPEED.crouch : this.sprinting ? SPEED.sprint : SPEED.walk;
    if ( this.aiming ) speed *= 0.55;
    if ( ! this.grounded ) speed *= 1.0;

    const wish = new THREE.Vector3()
      .addScaledVector( this._forward, iz )
      .addScaledVector( this._right, ix );
    if ( wish.lengthSq() > 0 ) wish.normalize().multiplyScalar( speed );

    // Ground control is snappy; air control is deliberately weak.
    const accel = this.grounded ? 62 : 12;
    this.velocity.x = THREE.MathUtils.damp( this.velocity.x, wish.x, accel * 0.16, dt );
    this.velocity.z = THREE.MathUtils.damp( this.velocity.z, wish.z, accel * 0.16, dt );

    // --- Jump / gravity ------------------------------------------------------
    if ( input.isDown( 'Space' ) && this.grounded ) {
      this.velocity.y = JUMP_SPEED;
      this.grounded = false;
    }
    this.velocity.y += GRAVITY * dt;
    this.velocity.y = Math.max( this.velocity.y, -60 );

    // --- Integrate -----------------------------------------------------------
    this._moveHorizontal( this.velocity.x * dt, this.velocity.z * dt );
    this._moveVertical( this.velocity.y * dt );

    // Ground probe: without it, walking off a ledge keeps `grounded` true for a frame.
    if ( this.velocity.y <= 0 ) {
      this.grounded = !! this._collidesAt( this.position.x, this.position.y - 0.06, this.position.z )
        || this.position.y <= 0.001;
    }

    // --- Camera --------------------------------------------------------------
    this._updateCamera( dt, moving );
    return this;
  }

  _updateCamera( dt, moving ) {
    // Head bob, scaled by actual speed rather than input, so it settles naturally.
    const horizontalSpeed = Math.hypot( this.velocity.x, this.velocity.z );
    const bobTarget = ( moving && this.grounded ) ? Math.min( horizontalSpeed / SPEED.walk, 1.5 ) : 0;
    this._bobAmount = THREE.MathUtils.damp( this._bobAmount, bobTarget, 8, dt );
    this._bobPhase += horizontalSpeed * dt * 1.9;

    // The view bob already tracks stride; a footfall is a half-cycle of it, so
    // steps stay locked to the animation instead of running on a timer that
    // drifts against it.
    if ( moving && this.grounded ) {
      this._stepPhase += horizontalSpeed * dt * 1.9;
      if ( this._stepPhase >= Math.PI ) {
        this._stepPhase -= Math.PI;
        this.onStep?.( this.sprinting );
      }
    } else {
      // Land the next step promptly rather than mid-stride after a pause.
      this._stepPhase = Math.PI * 0.75;
    }

    const bobY = Math.sin( this._bobPhase * 2 ) * 0.032 * this._bobAmount * ( 1 - this._adsBlend * 0.8 );
    const bobX = Math.cos( this._bobPhase ) * 0.028 * this._bobAmount * ( 1 - this._adsBlend * 0.8 );
    const bobRoll = Math.cos( this._bobPhase ) * 0.008 * this._bobAmount;

    this._landDip = THREE.MathUtils.damp( this._landDip, 0, 9, dt );
    this._recoilPitch = THREE.MathUtils.damp( this._recoilPitch, 0, 11, dt );
    this._recoilYaw = THREE.MathUtils.damp( this._recoilYaw, 0, 11, dt );

    const eye = this.position.y + this.height - 0.14 + bobY - this._landDip;
    this.camera.position.set(
      this.position.x + bobX * this._right.x,
      eye,
      this.position.z + bobX * this._right.z,
    );

    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = this.yaw + this._recoilYaw;
    this.camera.rotation.x = this.pitch + this._recoilPitch;
    this.camera.rotation.z = bobRoll;

    // FOV: ADS pulls in, sprinting pushes out slightly for a sense of speed.
    const sprintPush = this.sprinting ? 4.5 : 0;
    const targetFov = THREE.MathUtils.lerp( this.baseFov + sprintPush, this.adsFov, this._adsBlend );
    if ( Math.abs( this.camera.fov - targetFov ) > 0.01 ) {
      this.camera.fov = THREE.MathUtils.damp( this.camera.fov, targetFov, 12, dt );
      this.camera.updateProjectionMatrix();
    }
  }

  setAiming( on, dt ) {
    this.aiming = on;
    this._adsBlend = THREE.MathUtils.damp( this._adsBlend, on ? 1 : 0, 16, dt );
  }

  get adsBlend() { return this._adsBlend; }

  /** Applied by the weapon; decays back to zero in `_updateCamera`. */
  addRecoil( pitch, yaw ) {
    this._recoilPitch += pitch;
    this._recoilYaw += yaw;
    // Half the kick is permanent, so sustained fire actually walks the aim up.
    this.pitch = THREE.MathUtils.clamp( this.pitch + pitch * 0.42, -Math.PI / 2, Math.PI / 2 );
    this.yaw += yaw * 0.42;
  }

  /**
   * Returns the player to a fresh run in place. Field assignments only — no
   * geometry is touched, so a restart allocates nothing.
   */
  reset( position = null ) {
    this.health = 100;
    this.stamina = this.maxStamina ?? this.stamina;
    this.velocity.set( 0, 0, 0 );
    if ( position ) this.position.copy( position );
    else this.position.copy( this.level.playerStart );
    this.yaw = 0;
    this.pitch = 0;
    this.grounded = true;
    this.crouching = false;
    this.sprinting = false;
    this._landDip = 0;
    this._recoilPitch = 0;
    this._recoilYaw = 0;
  }

  damage( amount ) {
    this.health = Math.max( 0, this.health - amount );
    return this.health;
  }

  get eyePosition() { return this.camera.position; }
}
