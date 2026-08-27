/**
 * Wave progression, death and restart.
 *
 * Before this the arena had no arc: enemies respawned forever, the player could
 * not die, and nothing ever resolved. This owns the loop — which wave is
 * running, how many are left to send in, when the player has lost, and how to
 * start over without rebuilding the world.
 *
 * Restart is a reset, never a reload. The enemy pool is preallocated once by
 * EnemyManager and the level is built once; a new run reuses both, so
 * `renderer.info.memory` reads the same after a hundred restarts as after one.
 */

/**
 * The whole difficulty curve, as data.
 *
 * `enemies` is how many arrive over the wave, `concurrent` how many may be
 * alive at once — the gap between them is what makes a wave feel like a stream
 * rather than a lump. `health` and `speed` scale the pool's defaults.
 */
export const WAVES = [
  { enemies: 4, concurrent: 3, health: 100, speed: 1.00 },
  { enemies: 6, concurrent: 4, health: 110, speed: 1.05 },
  { enemies: 9, concurrent: 5, health: 120, speed: 1.10 },
  { enemies: 12, concurrent: 6, health: 135, speed: 1.16 },
  { enemies: 16, concurrent: 7, health: 150, speed: 1.24 },
];

/** Seconds of breathing room between waves. */
export const INTERMISSION = 5.0;
/** Seconds the death screen holds before a restart is accepted. */
export const DEATH_HOLD = 1.6;

/** @typedef {'idle'|'fighting'|'intermission'|'dead'|'victory'} Phase */

export class GameState {

  /**
   * @param {object} deps
   * @param {import('../entities/Enemies.js').EnemyManager} deps.enemies
   * @param {object} deps.player
   * @param {(phase: Phase, state: GameState) => void} [deps.onPhase]
   */
  constructor( { enemies, player, onPhase = null } ) {
    this.enemies = enemies;
    this.player = player;
    this.onPhase = onPhase;

    /** @type {Phase} */
    this.phase = 'idle';
    this.wave = 0;
    this.kills = 0;
    this.timer = 0;

    this._toSpawn = 0;
    this._playerPosition = null;

    // The wave owns spawning; the pool must not quietly refill itself.
    this.enemies.autoRespawn = false;
    this.enemies.onDeath = () => this._onDeath();
  }

  get waveCount() { return WAVES.length; }
  get spec() { return WAVES[ Math.min( this.wave, WAVES.length - 1 ) ]; }
  /** Enemies still to come in this wave, alive or not yet sent. */
  get remaining() { return this._toSpawn + this.enemies.aliveCount; }

  // -------------------------------------------------------------------------

  _setPhase( phase ) {
    if ( this.phase === phase ) return;
    this.phase = phase;
    this.onPhase?.( phase, this );
  }

  /** Begins a run from wave one. Safe to call from any phase. */
  start( playerPosition ) {
    this.wave = 0;
    this.kills = 0;
    this._playerPosition = playerPosition;
    this._beginWave();
  }

  /**
   * Returns to a fresh run without touching the scene graph.
   *
   * Everything here is a field assignment or a pool reset — no geometry, no
   * materials, no textures. That is the whole point: reloading the page would
   * also work and would cost a full rebuild plus every procedural texture.
   */
  restart( playerPosition ) {
    this.player.reset?.();
    this.enemies.reset();
    this.start( playerPosition );
  }

  _beginWave() {
    const spec = this.spec;
    this._toSpawn = spec.enemies;
    this.timer = 0;
    this._setPhase( 'fighting' );
    this._fill();
  }

  /** Tops the arena up to the wave's concurrent limit. */
  _fill() {
    const spec = this.spec;
    while ( this._toSpawn > 0 && this.enemies.aliveCount < spec.concurrent ) {
      const e = this.enemies.spawnOne( this._playerPosition );
      if ( ! e ) break;                       // pool exhausted; try again later
      e.maxHealth = spec.health;
      e.health = spec.health;
      e.speed = ( 3.2 + Math.random() * 1.6 ) * spec.speed;
      this._toSpawn --;
    }
  }

  _onDeath() {
    this.kills ++;
    if ( this.phase === 'fighting' ) this._fill();
  }

  // -------------------------------------------------------------------------

  update( dt, playerPosition ) {
    this._playerPosition = playerPosition;

    if ( this.phase === 'fighting' ) {
      if ( this.player.health <= 0 ) {
        this.timer = 0;
        this._setPhase( 'dead' );
        return;
      }
      // Keep topping up: a corpse still counts as alive until it sinks, so the
      // slot it frees arrives a beat after the kill.
      this._fill();

      if ( this.remaining === 0 ) {
        this.timer = 0;
        this._setPhase( this.wave + 1 >= WAVES.length ? 'victory' : 'intermission' );
      }
      return;
    }

    if ( this.phase === 'intermission' ) {
      // Stragglers cannot exist here, but the player still can die to a shot
      // already in flight when the last enemy fell.
      if ( this.player.health <= 0 ) { this.timer = 0; this._setPhase( 'dead' ); return; }
      this.timer += dt;
      if ( this.timer >= INTERMISSION ) {
        this.wave ++;
        this._beginWave();
      }
      return;
    }

    if ( this.phase === 'dead' || this.phase === 'victory' ) this.timer += dt;
  }

  /** True once the end screen has held long enough to accept a restart. */
  get canRestart() {
    return ( this.phase === 'dead' && this.timer >= DEATH_HOLD )
      || this.phase === 'victory';
  }
}
