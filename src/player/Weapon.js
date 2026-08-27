import * as THREE from 'three';

/**
 * Weapon: viewmodel, fire timing, recoil, muzzle flash and tracers.
 *
 * The viewmodel is a child of the camera and is rendered in the main scene with
 * a very near clip plane. That is the prototype-grade solution; a shipping game
 * renders the viewmodel in a second pass with its own camera so it can never
 * intersect world geometry (see docs/TASKS.md, T-08).
 */

/** Height of the scope's optical axis in weapon-local space. */
const SCOPE_AXIS_Y = 0.100;

export const WEAPONS = {
  carbine: {
    name: 'Carbine',
    rpm: 640,
    magSize: 30,
    reserve: 180,
    reloadTime: 2.1,
    damage: 24,
    headshotMultiplier: 2.4,
    // Cone half-angle in radians, hip vs aimed.
    spreadHip: 0.030,
    spreadAds: 0.0035,
    spreadPerShot: 0.006,
    spreadMax: 0.075,
    spreadRecovery: 0.09,
    recoilPitch: 0.011,
    recoilYaw: 0.0035,
    range: 220,
    // Field of view while aimed. The scope is optical only in the sense that
    // matters to a player: a narrower frustum plus a sight picture. Rendering
    // the world a second time into the lens would cost a whole extra scene
    // pass for parallax nobody looks for at this range.
    scopeFov: 42,
  },
};

export class Weapon {

  constructor( camera, spec = WEAPONS.carbine ) {
    this.camera = camera;
    this.spec = spec;

    this.mag = spec.magSize;
    this.reserve = spec.reserve;
    this.reloading = false;
    this._reloadTimer = 0;
    this._cooldown = 0;
    this._spread = 0;

    this.group = new THREE.Group();
    this.group.name = 'Viewmodel';
    camera.add( this.group );

    this._restPos = new THREE.Vector3( 0.24, -0.20, -0.42 );
    // Puts the scope's optical axis exactly at eye height, so the player looks
    // down the bore rather than at the outside of the tube. Note this holds for
    // any value of the viewmodel compensation scale: the aimed offset and the
    // axis height cancel to zero before the scale is applied, and zero scales
    // to zero. Ballistics are unaffected either way -- the hitscan comes from
    // the camera, not from the model.
    this._adsPos = new THREE.Vector3( 0.0, -SCOPE_AXIS_Y, -0.30 );
    this._kick = new THREE.Vector3();
    this._kickRot = 0;
    this._swayTarget = new THREE.Vector2();
    this._sway = new THREE.Vector2();
    this._bobPhase = 0;
    this._reloadTilt = 0;

    this._buildViewmodel();
    this._buildMuzzleFlash();

    this.onFire = null;      // ( origin, direction, spreadAngle ) => void
    this.onDryFire = null;
    this.onReloadStart = null;
    this.onReloadEnd = null;
  }

  // -------------------------------------------------------------------------

  _buildViewmodel() {
    const bodyMat = new THREE.MeshStandardMaterial( { color: 0x24282e, roughness: 0.44, metalness: 0.82, envMapIntensity: 1.2 } );
    const gripMat = new THREE.MeshStandardMaterial( { color: 0x14161a, roughness: 0.78, metalness: 0.1 } );
    const railMat = new THREE.MeshStandardMaterial( { color: 0x33383f, roughness: 0.35, metalness: 0.9, envMapIntensity: 1.4 } );
    const accentMat = new THREE.MeshStandardMaterial( { color: 0x000000, emissive: 0x66e0ff, emissiveIntensity: 3.2, roughness: 1 } );

    const add = ( mat, size, pos, rot = [ 0, 0, 0 ] ) => {
      const m = new THREE.Mesh( new THREE.BoxGeometry( ...size ), mat );
      m.position.set( ...pos );
      m.rotation.set( ...rot );
      m.castShadow = false;
      m.receiveShadow = false;
      this.group.add( m );
      return m;
    };

    // Receiver / body
    add( bodyMat, [ 0.062, 0.075, 0.30 ], [ 0, 0, -0.02 ] );
    // Barrel + handguard
    add( railMat, [ 0.040, 0.040, 0.26 ], [ 0, 0.006, -0.26 ] );
    add( bodyMat, [ 0.030, 0.030, 0.10 ], [ 0, 0.006, -0.42 ] );
    // Stock
    add( gripMat, [ 0.050, 0.062, 0.16 ], [ 0, -0.008, 0.20 ] );
    // Pistol grip
    add( gripMat, [ 0.042, 0.105, 0.055 ], [ 0, -0.082, 0.05 ], [ 0.28, 0, 0 ] );
    // Magazine
    add( gripMat, [ 0.036, 0.125, 0.075 ], [ 0, -0.098, -0.06 ], [ -0.12, 0, 0 ] );
    // Top rail
    add( railMat, [ 0.030, 0.012, 0.24 ], [ 0, 0.045, -0.05 ] );

    // --- Iron sights: the ADS pose lines these up with screen centre ---------
    this._rearSight = add( railMat, [ 0.026, 0.030, 0.012 ], [ 0, 0.064, 0.06 ] );
    this._frontSight = add( railMat, [ 0.010, 0.034, 0.010 ], [ 0, 0.066, -0.34 ] );
    add( accentMat, [ 0.008, 0.008, 0.008 ], [ 0, 0.079, -0.34 ] );

    // --- Scope -------------------------------------------------------------
    // Sits above the irons rather than replacing them; the ADS pose is offset
    // by exactly the height difference so the aim point does not move.
    // Open-ended, and front-faces only: solid when seen from outside at the
    // hip, and culled away entirely once the eye is inside it. That is the
    // whole trick -- no separate render pass, no hiding the weapon on a
    // threshold, the tube simply stops occluding when you are looking through
    // it.
    const tube = new THREE.Mesh(
      new THREE.CylinderGeometry( 0.024, 0.024, 0.20, 16, 1, true ), railMat,
    );
    tube.rotation.x = Math.PI / 2;
    tube.position.set( 0, SCOPE_AXIS_Y, -0.06 );
    this.group.add( tube );

    const bell = new THREE.Mesh(
      new THREE.CylinderGeometry( 0.030, 0.024, 0.05, 16, 1, true ), railMat,
    );
    bell.rotation.x = Math.PI / 2;
    bell.position.set( 0, SCOPE_AXIS_Y, -0.175 );
    this.group.add( bell );

    add( railMat, [ 0.020, 0.030, 0.018 ], [ 0, SCOPE_AXIS_Y - 0.030, -0.13 ] );
    add( railMat, [ 0.020, 0.030, 0.018 ], [ 0, SCOPE_AXIS_Y - 0.030, 0.005 ] );

    // Charging handle detail + a lit status dot, both purely for silhouette.
    add( railMat, [ 0.014, 0.014, 0.05 ], [ 0.036, 0.030, 0.10 ] );
    add( accentMat, [ 0.012, 0.006, 0.006 ], [ 0.033, -0.010, 0.02 ] );

    this.group.position.copy( this._restPos );
  }

  _buildMuzzleFlash() {
    this._flashLight = new THREE.PointLight( 0xffc169, 0, 14, 2 );
    this._flashLight.position.set( 0, 0.006, -0.50 );
    this.group.add( this._flashLight );

    const flashMat = new THREE.MeshBasicMaterial( {
      color: 0xffd9a0, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    } );
    this._flash = new THREE.Mesh( new THREE.PlaneGeometry( 0.22, 0.22 ), flashMat );
    this._flash.position.set( 0, 0.006, -0.50 );
    this._flash.visible = false;
    this.group.add( this._flash );

    this._flashTimer = 0;
  }

  // -------------------------------------------------------------------------

  get muzzleWorldPosition() {
    return this._flash.getWorldPosition( new THREE.Vector3() );
  }

  get canFire() {
    return ! this.reloading && this.mag > 0 && this._cooldown <= 0;
  }

  get currentSpread() {
    const base = this._adsBlend > 0.5 ? this.spec.spreadAds : this.spec.spreadHip;
    return base + this._spread;
  }

  tryFire( player ) {
    if ( this.reloading ) return false;

    if ( this.mag <= 0 ) {
      if ( this._cooldown <= 0 ) {
        this._cooldown = 0.25;
        this.onDryFire?.();
      }
      return false;
    }
    if ( this._cooldown > 0 ) return false;

    this.mag --;
    this._cooldown = 60 / this.spec.rpm;

    // --- Recoil -------------------------------------------------------------
    // Vertical kick is deterministic (learnable); horizontal is random but
    // biased so the pattern drifts rather than jittering symmetrically.
    const shotIndex = this.spec.magSize - this.mag;
    const rampUp = Math.min( 1, 0.55 + shotIndex * 0.07 );
    const adsDamp = 1 - this._adsBlend * 0.35;

    const pitch = this.spec.recoilPitch * rampUp * adsDamp;
    const yaw = ( Math.sin( shotIndex * 1.7 ) * 0.6 + ( Math.random() - 0.5 ) * 0.8 )
      * this.spec.recoilYaw * rampUp * adsDamp;
    player.addRecoil( pitch, yaw );

    // Viewmodel kick
    this._kick.z += 0.045;
    this._kick.y += 0.010;
    this._kickRot -= 0.055;

    // Bloom the cone
    this._spread = Math.min( this.spec.spreadMax, this._spread + this.spec.spreadPerShot );

    // --- Muzzle flash --------------------------------------------------------
    this._flashTimer = 0.045;
    this._flash.visible = true;
    this._flash.rotation.z = Math.random() * Math.PI;
    this._flash.scale.setScalar( 0.85 + Math.random() * 0.5 );

    // --- Ray ----------------------------------------------------------------
    const direction = new THREE.Vector3( 0, 0, -1 ).applyQuaternion( this.camera.quaternion );
    const spread = this.currentSpread;
    if ( spread > 0 ) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt( Math.random() ) * spread;
      const up = new THREE.Vector3( 0, 1, 0 ).applyQuaternion( this.camera.quaternion );
      const right = new THREE.Vector3( 1, 0, 0 ).applyQuaternion( this.camera.quaternion );
      direction.addScaledVector( right, Math.cos( a ) * r ).addScaledVector( up, Math.sin( a ) * r ).normalize();
    }

    this.onFire?.( this.camera.getWorldPosition( new THREE.Vector3() ), direction, spread );
    return true;
  }

  /** Back to a full magazine and full reserve, for a restart. */
  resetAmmo() {
    this.mag = this.spec.magSize;
    this.reserve = this.spec.reserve;
    this.reloading = false;
    this._cooldown = 0;
  }

  /** 0 at the hip, 1 fully aimed. Drives the camera's field of view. */
  get adsBlend() { return this._adsBlend; }

  startReload() {
    if ( this.reloading || this.mag >= this.spec.magSize || this.reserve <= 0 ) return false;
    this.reloading = true;
    this._reloadTimer = this.spec.reloadTime;
    this.onReloadStart?.();
    return true;
  }

  update( dt, { adsBlend = 0, lookDelta = { x: 0, y: 0 }, speed = 0, grounded = true } = {} ) {
    this._adsBlend = adsBlend;
    this._cooldown = Math.max( 0, this._cooldown - dt );
    this._spread = Math.max( 0, this._spread - this.spec.spreadRecovery * dt );

    // --- Reload -------------------------------------------------------------
    if ( this.reloading ) {
      this._reloadTimer -= dt;
      const t = 1 - this._reloadTimer / this.spec.reloadTime;
      // Dip the gun out of frame and back: a stand-in for a reload animation.
      this._reloadTilt = Math.sin( t * Math.PI ) * 1.0;

      if ( this._reloadTimer <= 0 ) {
        const need = this.spec.magSize - this.mag;
        const take = Math.min( need, this.reserve );
        this.mag += take;
        this.reserve -= take;
        this.reloading = false;
        this._reloadTilt = 0;
        this.onReloadEnd?.();
      }
    } else {
      this._reloadTilt = THREE.MathUtils.damp( this._reloadTilt, 0, 12, dt );
    }

    // --- Muzzle flash decay --------------------------------------------------
    if ( this._flashTimer > 0 ) {
      this._flashTimer -= dt;
      const k = Math.max( 0, this._flashTimer / 0.045 );
      this._flashLight.intensity = 26 * k;
      this._flash.material.opacity = k;
      if ( this._flashTimer <= 0 ) {
        this._flash.visible = false;
        this._flashLight.intensity = 0;
      }
    }

    // --- Sway: viewmodel lags the camera ------------------------------------
    this._swayTarget.set(
      THREE.MathUtils.clamp( -lookDelta.x * 2.2, -0.045, 0.045 ),
      THREE.MathUtils.clamp( -lookDelta.y * 2.2, -0.045, 0.045 ),
    );
    this._sway.x = THREE.MathUtils.damp( this._sway.x, this._swayTarget.x, 9, dt );
    this._sway.y = THREE.MathUtils.damp( this._sway.y, this._swayTarget.y, 9, dt );

    // --- Bob ----------------------------------------------------------------
    this._bobPhase += speed * dt * 1.9;
    const bobScale = ( grounded ? Math.min( speed / 5.4, 1.6 ) : 0 ) * ( 1 - adsBlend * 0.85 );
    const bobX = Math.cos( this._bobPhase ) * 0.014 * bobScale;
    const bobY = Math.sin( this._bobPhase * 2 ) * 0.010 * bobScale;

    // --- Kick decay ----------------------------------------------------------
    this._kick.multiplyScalar( Math.exp( -dt * 15 ) );
    this._kickRot = THREE.MathUtils.damp( this._kickRot, 0, 15, dt );

    // --- Compose final transform --------------------------------------------
    const base = this._restPos.clone().lerp( this._adsPos, adsBlend );
    this.group.position.set(
      base.x + this._sway.x + bobX,
      base.y + this._sway.y + bobY + this._kick.y - this._reloadTilt * 0.22,
      base.z + this._kick.z,
    );
    this.group.rotation.set(
      this._kickRot + this._sway.y * 1.6 - this._reloadTilt * 0.55,
      -this._sway.x * 1.6 + ( 1 - adsBlend ) * 0.045,
      this._reloadTilt * 0.30 + ( 1 - adsBlend ) * 0.02,
    );
  }
}
