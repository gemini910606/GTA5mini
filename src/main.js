import * as THREE from 'three';
import { Renderer, QUALITY } from './core/Renderer.js';
import { Input } from './core/Input.js';
import { Environment, TIME_OF_DAY } from './world/Environment.js';
import { Level } from './world/Level.js';
import { Player } from './player/Player.js';
import { Weapon, WEAPONS } from './player/Weapon.js';
import { Impacts } from './fx/Impacts.js';
import { Audio } from './audio/Audio.js';
import { EnemyManager } from './entities/Enemies.js';
import { Hud } from './ui/Hud.js';

/**
 * Entry point: builds the world, owns the fixed-timestep loop, and routes
 * input -> player -> weapon -> hitscan -> damage -> feedback.
 *
 * Simulation runs at a fixed 120 Hz with a substep cap; rendering runs once per
 * animation frame. Decoupling them keeps physics deterministic when the frame
 * rate drops, and stops a background tab from integrating a ten-second dt.
 */

const FIXED_DT = 1 / 120;
const MAX_SUBSTEPS = 6;

class Game {

  constructor( container ) {
    this.container = container;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera( 75, window.innerWidth / window.innerHeight, 0.02, 800 );
    // The viewmodel is a child of the camera, so the camera must be in the graph.
    this.scene.add( this.camera );

    this.renderer = new Renderer( container, this.scene, this.camera );
    this.environment = new Environment( this.scene, this.renderer.renderer, 'goldenHour' );

    this.level = new Level();
    this.scene.add( this.level.group );

    this.player = new Player( this.camera, this.level );
    this.weapon = new Weapon( this.camera, WEAPONS.carbine );
    this.impacts = new Impacts( this.scene );
    this.enemies = new EnemyManager( this.scene, this.level );
    this.hud = new Hud();
    this.input = new Input( this.renderer.renderer.domElement );
    this.audio = new Audio( this.camera, this.scene );

    this._buildFlashlight();
    this._wireEvents();

    this.enemies.spawnInitial( 5 );

    this.raycaster = new THREE.Raycaster();
    this.raycaster.far = this.weapon.spec.range;

    this.elapsed = 0;
    this._accumulator = 0;
    this._lastTime = performance.now() / 1000;
    this._frames = 0;
    this._fpsTimer = 0;
    this._fps = 0;
    this._lastLook = { x: 0, y: 0 };
    this.running = false;

    // Handy for the screenshot harness and for anyone poking at it from devtools.
    globalThis.__GAME__ = this;
  }

  // -------------------------------------------------------------------------

  _buildFlashlight() {
    this.flashlight = new THREE.SpotLight( 0xfff0d8, 0, 40, Math.PI / 8, 0.45, 1.6 );
    this.flashlight.position.set( 0.1, -0.06, 0 );
    this.flashlight.target.position.set( 0, 0, -1 );
    this.camera.add( this.flashlight );
    this.camera.add( this.flashlight.target );
    this.flashlightOn = false;
  }

  _wireEvents() {
    // Autoplay policy: the AudioContext may only be built inside a user
    // gesture. Bound on the document rather than to the pointer-lock event, so
    // it also covers the drag-to-look fallback, where lock never fires and the
    // game would otherwise stay silent.
    window.addEventListener(
      'pointerdown', () => { this.audio.start(); }, { once: true },
    );

    this.player.onStep = ( sprinting ) => this.audio.play( 'step', {
      volume: sprinting ? 0.5 : 0.32,
      rate: 0.9 + Math.random() * 0.25,
    } );

    const overlay = document.getElementById( 'overlay' );

    overlay.addEventListener( 'click', () => this.input.requestLock() );

    this.input.on( 'fallback', () => {
      // Tell the player why the mouse is not captured, once.
      const el = document.getElementById( 'weaponName' );
      if ( el ) el.textContent = 'Carbine — hold mouse to look';
    } );

    this.input.on( 'lock', () => {
      overlay.classList.add( 'hidden' );
      this.hud.show();
      this.running = true;
      // Drop the frame the pointer lock consumed, or we integrate a huge dt.
      this._lastTime = performance.now() / 1000;
    } );

    this.input.on( 'unlock', () => {
      overlay.classList.remove( 'hidden' );
      this.hud.hide();
      this.running = false;
    } );

    this.weapon.onFire = ( origin, direction ) => {
      // Slight per-shot detune, or a held trigger sounds like one looping sample.
      this.audio.play( 'shot', { volume: 0.85, rate: 0.96 + Math.random() * 0.08 } );
      this._hitscan( origin, direction );
    };

    this.enemies.onEnemyFire = ( enemy, distance ) => {
      // Enemies are deliberately inaccurate and fall off hard with range.
      const hitChance = THREE.MathUtils.clamp( 0.55 - distance * 0.012, 0.06, 0.55 );
      if ( Math.random() < hitChance ) {
        this.player.damage( 4 + Math.random() * 6 );
        this.hud.damageFlash();
        this.audio.play( 'hurt', { volume: 0.8 } );
      }
      const muzzle = enemy.group.localToWorld( new THREE.Vector3( 0.30, 1.14, -0.48 ) );
      this.audio.playAt( 'enemyShot', muzzle, { rate: 0.94 + Math.random() * 0.12 } );
      this.impacts.spawnTracer( muzzle, this.camera.position );
      this.impacts.spawnSparks( muzzle, new THREE.Vector3( 0, 0.4, 0 ), 4 );
    };
  }

  // -------------------------------------------------------------------------

  /** Magazine out, then seated — two events, because one click reads as a bug. */
  _reloadSound() {
    this.audio.play( 'reloadOut', { volume: 0.6 } );
    const seat = this.weapon.spec.reloadTime ?? 1.6;
    setTimeout( () => this.audio.play( 'reloadIn', { volume: 0.6 } ), seat * 620 );
  }

  _hitscan( origin, direction ) {
    this.raycaster.set( origin, direction );
    this.raycaster.far = this.weapon.spec.range;

    const targets = this.level.hittables.concat( this.enemies.hitboxes );
    const hits = this.raycaster.intersectObjects( targets, false );

    const muzzle = this.weapon.muzzleWorldPosition;

    if ( hits.length === 0 ) {
      const end = origin.clone().addScaledVector( direction, this.weapon.spec.range );
      this.impacts.spawnTracer( muzzle, end );
      return;
    }

    const hit = hits[ 0 ];
    const normal = hit.face
      ? hit.face.normal.clone().transformDirection( hit.object.matrixWorld )
      : direction.clone().negate();

    const enemyResult = hit.object.userData.enemy
      ? this.enemies.applyHit( hit.object, this.weapon.spec.damage )
      : null;

    if ( enemyResult ) {
      this.impacts.fleshImpact( muzzle, hit.point, normal );
      this.hud.hitmark();
      this.audio.play( enemyResult.killed ? 'kill' : 'hitmarker',
        { volume: enemyResult.headshot ? 0.9 : 0.65 } );

      // Damage number, projected from the hit point into screen space.
      const ndc = hit.point.clone().project( this.camera );
      if ( ndc.z < 1 ) {
        this.hud.floatDamage(
          ( ndc.x * 0.5 + 0.5 ) * window.innerWidth,
          ( -ndc.y * 0.5 + 0.5 ) * window.innerHeight,
          enemyResult.damage,
          enemyResult.headshot,
        );
      }
    } else {
      this.impacts.bulletImpact( muzzle, hit.point, normal );
      // At the point of impact, not at the muzzle — a shot into the far wall
      // should crack over there.
      this.audio.playAt( 'impact', hit.point, { volume: 0.5, rate: 0.9 + Math.random() * 0.3 } );
    }
  }

  // -------------------------------------------------------------------------

  _handleActions( dt ) {
    const input = this.input;

    this.player.setAiming( input.isMouseDown( 2 ), dt );

    if ( input.isMouseDown( 0 ) ) this.weapon.tryFire( this.player );
    if ( input.wasPressed( 'KeyR' ) && this.weapon.startReload() ) this._reloadSound();

    // Auto-reload on a dry mag keeps the prototype playable without thinking.
    if ( this.weapon.mag === 0 && ! this.weapon.reloading && this.weapon.startReload() ) this._reloadSound();

    if ( input.wasPressed( 'KeyF' ) ) {
      this.flashlightOn = ! this.flashlightOn;
      this.flashlight.intensity = this.flashlightOn ? 90 : 0;
    }

    if ( input.wasPressed( 'Digit1' ) ) this.setQuality( 'low' );
    if ( input.wasPressed( 'Digit2' ) ) this.setQuality( 'medium' );
    if ( input.wasPressed( 'Digit3' ) ) this.setQuality( 'high' );

    if ( input.wasPressed( 'KeyT' ) ) this.cycleTimeOfDay();
  }

  setQuality( name ) {
    this.renderer.setQuality( name );
    return name;
  }

  cycleTimeOfDay() {
    const keys = Object.keys( TIME_OF_DAY );
    const next = keys[ ( keys.indexOf( this.environment.preset ) + 1 ) % keys.length ];
    this.environment.applyPreset( next );
    return next;
  }

  // -------------------------------------------------------------------------

  step( dt ) {
    this._lastLook = { x: this.input.mouseDelta.x, y: this.input.mouseDelta.y };

    this._handleActions( dt );
    this.player.update( dt, this.input );

    this.weapon.update( dt, {
      adsBlend: this.player.adsBlend,
      lookDelta: { x: this._lastLook.x * 0.004, y: this._lastLook.y * 0.004 },
      speed: Math.hypot( this.player.velocity.x, this.player.velocity.z ),
      grounded: this.player.grounded,
    } );

    this.enemies.update( dt, {
      playerPosition: this.camera.position,
      elapsed: this.elapsed,
    } );

    this.environment.followTarget( this.player.position );
    this.environment.update( this.elapsed );
    this.input.endFrame();
  }

  render( frameDt ) {
    this.impacts.update( frameDt, this.camera );
    this.renderer.render( this.elapsed );
  }

  updateHud() {
    const p = this.player, w = this.weapon;
    this.hud.setHealth( p.health, p.maxHealth );
    this.hud.setStamina( p.stamina, p.maxStamina );
    this.hud.setAmmo( w.mag, w.reserve, w.spec.magSize );
    if ( ! this.input.dragFallback ) this.hud.setWeaponName( w.spec.name );
    this.hud.setReloading( w.reloading );
    this.hud.setScore( this.enemies.kills );
    this.hud.setSpread( w.currentSpread, p.adsBlend > 0.75 );

    const info = this.renderer.info;
    this.hud.setStats(
      `${ this._fps } fps   ${ info.render.calls } draws   ${ ( info.render.triangles / 1000 ).toFixed( 0 ) }k tris\n` +
      `${ QUALITY[ this.renderer.quality ].label }   ${ this.environment.presetSettings.label }   [1/2/3] quality  [T] time`,
    );
  }

  start() {
    const tick = () => {
      requestAnimationFrame( tick );

      const now = performance.now() / 1000;
      let frameDt = now - this._lastTime;
      this._lastTime = now;
      // A tab that was backgrounded returns a huge dt; clamp rather than explode.
      frameDt = Math.min( frameDt, 0.25 );

      this._fpsTimer += frameDt;
      this._frames ++;
      if ( this._fpsTimer >= 0.5 ) {
        this._fps = Math.round( this._frames / this._fpsTimer );
        this._frames = 0;
        this._fpsTimer = 0;
      }

      if ( this.running ) {
        this.elapsed += frameDt;
        this._accumulator += frameDt;

        let substeps = 0;
        while ( this._accumulator >= FIXED_DT && substeps < MAX_SUBSTEPS ) {
          this.step( FIXED_DT );
          this._accumulator -= FIXED_DT;
          substeps ++;
        }
        if ( substeps === MAX_SUBSTEPS ) this._accumulator = 0;

        this.updateHud();
      }

      this.render( frameDt );
    };
    tick();
    return this;
  }

  /** Places the camera for a scripted screenshot without pointer lock. */
  poseCamera( { position, yaw, pitch } ) {
    if ( position ) this.player.position.set( ...position );
    if ( yaw !== undefined ) this.player.yaw = yaw;
    if ( pitch !== undefined ) this.player.pitch = pitch;
    this.player.update( 1 / 120, this.input );
    this.weapon.update( 1 / 120, {} );
    this.enemies.update( 1 / 120, { playerPosition: this.camera.position, elapsed: this.elapsed } );
    this.renderer.render( this.elapsed );
  }
}

// ---------------------------------------------------------------------------

try {
  const game = new Game( document.getElementById( 'app' ) );
  game.start();
} catch ( error ) {
  console.error( error );
  const el = document.getElementById( 'err' );
  if ( el ) el.textContent = `Failed to start:\n${ error?.stack ?? error }`;
}
