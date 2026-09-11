import * as THREE from 'three';
import { PlayerSim, STAND_HEIGHT } from '../sim/PlayerSim.js';
import { Command, BTN } from '../sim/Command.js';

/**
 * The local player: a `PlayerSim` plus everything that only the person holding
 * the mouse can see.
 *
 * The split is the load-bearing part. `PlayerSim` owns anything another player
 * could observe — position, velocity, stance, health — and runs headlessly, so
 * the same code can run on an authoritative server. This class owns the feel:
 * mouse look, head bob, the view kick after a shot, FOV, footstep audio, and
 * writing the result into the camera. None of it is simulation, and none of it
 * belongs anywhere a server can see.
 *
 * Input is funnelled through a `Command` rather than read straight off the
 * keyboard, because that is the thing that goes on the wire: if movement can
 * only be driven by a command, then a replayed command reproduces the movement,
 * which is exactly what prediction and reconciliation need.
 */

const SPEED_WALK = 5.4;

export class Player {

  constructor( camera, level ) {
    this.camera = camera;
    this._level = level;

    this.sim = new PlayerSim( level.broadphase, level.playerStart );
    this.cmd = new Command();

    this.baseFov = 75;
    this.adsFov = 52;

    this._bobPhase = 0;
    this._bobAmount = 0;
    this._stepPhase = 0;
    /** Fired once per footfall. `( sprinting: boolean ) => void` */
    this.onStep = null;
    this._recoilPitch = 0;
    this._recoilYaw = 0;
    this._landDip = 0;
    this._aimHeld = false;

    this._right = new THREE.Vector3();

    this.camera.fov = this.baseFov;
    this.camera.updateProjectionMatrix();
  }

  // --- state the rest of the game reads ------------------------------------
  //
  // Forwarded rather than mirrored: two copies of a player's position is the
  // kind of thing that stays correct right up until one of them does not.

  get position() { return this.sim.position; }
  get velocity() { return this.sim.velocity; }
  get yaw() { return this.sim.yaw; }
  set yaw( v ) { this.sim.yaw = v; }
  get pitch() { return this.sim.pitch; }
  set pitch( v ) { this.sim.pitch = v; }
  get grounded() { return this.sim.grounded; }
  get crouching() { return this.sim.crouching; }
  get sprinting() { return this.sim.sprinting; }
  get aiming() { return this.sim.aiming; }
  get health() { return this.sim.health; }
  get adsBlend() { return this.sim.adsBlend; }
  get eyePosition() { return this.camera.position; }

  get level() { return this._level; }

  /** Swapping the map swaps the collision world the simulation runs against. */
  set level( level ) {
    this._level = level;
    this.sim.colliders = level.broadphase;
  }

  // --- input -> command ----------------------------------------------------

  /**
   * Folds this frame's mouse movement into the view angles and packs the
   * keyboard into the command's button mask.
   *
   * The angles are accumulated here rather than in the simulation because they
   * are the one thing the client genuinely owns: sensitivity, the aim-down-
   * sights slowdown and recoil are all feel, and a server that integrated mouse
   * deltas would have to agree about all three.
   */
  _buildCommand( input, tick ) {
    const look = input.consumeLook();
    const aimScale = 1 - this.sim.adsBlend * 0.45;   // slower turn while aiming
    const cmd = this.cmd;

    cmd.tick = tick;
    cmd.yaw = this.sim.yaw + look.yaw * aimScale;
    cmd.pitch = THREE.MathUtils.clamp(
      this.sim.pitch + look.pitch * aimScale,
      -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02,
    );

    cmd.buttons = 0;
    cmd.set( BTN.forward, input.isDown( 'KeyW' ) );
    cmd.set( BTN.back, input.isDown( 'KeyS' ) );
    cmd.set( BTN.left, input.isDown( 'KeyA' ) );
    cmd.set( BTN.right, input.isDown( 'KeyD' ) );
    cmd.set( BTN.jump, input.isDown( 'Space' ) );
    cmd.set( BTN.crouch, input.isDown( 'ControlLeft' ) || input.isDown( 'KeyC' ) );
    cmd.set( BTN.sprint, input.isDown( 'ShiftLeft' ) );
    cmd.set( BTN.aim, this._aimHeld );

    // Rounded to wire precision here, so the local prediction sees exactly the
    // angles a server would: skip it and every tick is off by a fraction of a
    // degree, which reads as a permanent disagreement rather than a rounding.
    return cmd.quantise();
  }

  // --- tick ----------------------------------------------------------------

  update( dt, input, tick = 0 ) {
    this.sim.step( this._buildCommand( input, tick ), dt );
    if ( this.sim.landImpact > 0 ) this._landDip = this.sim.landImpact;
    this._updateCamera( dt, this.sim.moving );
    return this;
  }

  _updateCamera( dt, moving ) {
    const sim = this.sim;
    // Head bob, scaled by actual speed rather than input, so it settles naturally.
    const horizontalSpeed = Math.hypot( sim.velocity.x, sim.velocity.z );
    const bobTarget = ( moving && sim.grounded ) ? Math.min( horizontalSpeed / SPEED_WALK, 1.5 ) : 0;
    this._bobAmount = THREE.MathUtils.damp( this._bobAmount, bobTarget, 8, dt );
    this._bobPhase += horizontalSpeed * dt * 1.9;

    // The view bob already tracks stride; a footfall is a half-cycle of it, so
    // steps stay locked to the animation instead of running on a timer that
    // drifts against it.
    if ( moving && sim.grounded ) {
      this._stepPhase += horizontalSpeed * dt * 1.9;
      if ( this._stepPhase >= Math.PI ) {
        this._stepPhase -= Math.PI;
        this.onStep?.( sim.sprinting );
      }
    } else {
      // Land the next step promptly rather than mid-stride after a pause.
      this._stepPhase = Math.PI * 0.75;
    }

    const fade = 1 - sim.adsBlend * 0.8;
    const bobY = Math.sin( this._bobPhase * 2 ) * 0.032 * this._bobAmount * fade;
    const bobX = Math.cos( this._bobPhase ) * 0.028 * this._bobAmount * fade;
    const bobRoll = Math.cos( this._bobPhase ) * 0.008 * this._bobAmount;

    this._landDip = THREE.MathUtils.damp( this._landDip, 0, 9, dt );
    this._recoilPitch = THREE.MathUtils.damp( this._recoilPitch, 0, 11, dt );
    this._recoilYaw = THREE.MathUtils.damp( this._recoilYaw, 0, 11, dt );

    this._right.set( Math.cos( sim.yaw ), 0, -Math.sin( sim.yaw ) );

    const eye = sim.position.y + sim.height - 0.14 + bobY - this._landDip;
    this.camera.position.set(
      sim.position.x + bobX * this._right.x,
      eye,
      sim.position.z + bobX * this._right.z,
    );

    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = sim.yaw + this._recoilYaw;
    this.camera.rotation.x = sim.pitch + this._recoilPitch;
    this.camera.rotation.z = bobRoll;

    // FOV: ADS pulls in, sprinting pushes out slightly for a sense of speed.
    const sprintPush = sim.sprinting ? 4.5 : 0;
    const targetFov = THREE.MathUtils.lerp( this.baseFov + sprintPush, this.adsFov, sim.adsBlend );
    if ( Math.abs( this.camera.fov - targetFov ) > 0.01 ) {
      this.camera.fov = THREE.MathUtils.damp( this.camera.fov, targetFov, 12, dt );
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * `dt` is no longer used — the blend is simulated, because how far a player
   * has aimed down sight changes their speed, and speed is everyone's business.
   * The parameter stays so callers do not have to change.
   */
  setAiming( on ) {
    this._aimHeld = on;
  }

  /** Applied by the weapon; the visual part decays back to zero in `_updateCamera`. */
  addRecoil( pitch, yaw ) {
    this._recoilPitch += pitch;
    this._recoilYaw += yaw;
    // Half the kick is permanent, so sustained fire actually walks the aim up.
    // It lands on the simulation's angles, which is what the next command sends.
    this.sim.pitch = THREE.MathUtils.clamp( this.sim.pitch + pitch * 0.42, -Math.PI / 2, Math.PI / 2 );
    this.sim.yaw += yaw * 0.42;
  }

  /**
   * Returns the player to a fresh run in place. Field assignments only — no
   * geometry is touched, so a restart allocates nothing.
   */
  reset( position = null ) {
    this.sim.respawn( position ?? this._level.playerStart );
    this.sim.height = STAND_HEIGHT;
    this._landDip = 0;
    this._recoilPitch = 0;
    this._recoilYaw = 0;
    this._bobAmount = 0;
    this._aimHeld = false;
  }

  damage( amount ) {
    return this.sim.damage( amount );
  }
}
