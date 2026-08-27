import * as THREE from 'three';

/**
 * Procedurally synthesised sound. No audio files, no network requests.
 *
 * Three rules shape this file:
 *
 * 1. Nothing is constructed until the first user gesture. `THREE.AudioListener`
 *    builds an `AudioContext` in its constructor, so even creating the listener
 *    early would trip the browser's autoplay policy and leave a permanently
 *    suspended context. `start()` is the only entry point.
 *
 * 2. Every buffer is rendered once, at startup, through an `OfflineAudioContext`.
 *    Filtering a noise burst through a real `BiquadFilterNode` is both better
 *    and shorter than hand-rolling a filter over a `Float32Array`, and the
 *    render happens in well under a frame.
 *
 * 3. Audio is optional. A headless browser with no output device, a blocked
 *    context, a browser without `AudioContext` — all of them must degrade to
 *    silence rather than throwing, because the screenshot harnesses fail the
 *    build on any console error.
 */

const RATE = 44100;

/** Voices reserved for world-positioned sound. Beyond this, the oldest is stolen. */
const POSITIONAL_VOICES = 24;
/** Voices for sound with no position: the player's own weapon, HUD feedback. */
const AMBIENT_VOICES = 8;

// ---------------------------------------------------------------------------
// Synthesis
//
// Each entry renders one buffer. `ctx` is an OfflineAudioContext already sized
// to the duration; connect sources to `ctx.destination` and the caller renders.
// ---------------------------------------------------------------------------

/** Fills a buffer with white noise. Shared by every percussive sound here. */
function noiseBuffer( ctx, seconds ) {
  const buf = ctx.createBuffer( 1, Math.ceil( seconds * ctx.sampleRate ), ctx.sampleRate );
  const d = buf.getChannelData( 0 );
  // Deterministic: a fixed LCG rather than Math.random, so a rendered shot is
  // the same every run and the screenshot harnesses stay reproducible.
  let seed = 0x2f6e2b1;
  for ( let i = 0; i < d.length; i ++ ) {
    seed = ( seed * 1664525 + 1013904223 ) >>> 0;
    d[ i ] = ( seed / 0x80000000 ) - 1;
  }
  return buf;
}

function noise( ctx, seconds, { gain = 1, type = 'lowpass', from = 8000, to = 400, q = 1 } = {} ) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer( ctx, seconds );

  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.Q.value = q;
  filter.frequency.setValueAtTime( from, 0 );
  filter.frequency.exponentialRampToValueAtTime( Math.max( 40, to ), seconds );

  const amp = ctx.createGain();
  amp.gain.setValueAtTime( gain, 0 );
  amp.gain.exponentialRampToValueAtTime( 0.0001, seconds );

  src.connect( filter ).connect( amp ).connect( ctx.destination );
  src.start( 0 );
  return amp;
}

function tone( ctx, seconds, { freq = 220, to = null, gain = 0.5, type = 'sine', delay = 0 } = {} ) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime( freq, delay );
  if ( to !== null ) osc.frequency.exponentialRampToValueAtTime( to, delay + seconds );

  const amp = ctx.createGain();
  amp.gain.setValueAtTime( 0.0001, delay );
  amp.gain.exponentialRampToValueAtTime( gain, delay + seconds * 0.06 );
  amp.gain.exponentialRampToValueAtTime( 0.0001, delay + seconds );

  osc.connect( amp ).connect( ctx.destination );
  osc.start( delay );
  osc.stop( delay + seconds );
  return amp;
}

/**
 * The sound set.
 *
 * A carbine is a crack plus a body: the crack is broadband noise collapsing
 * from bright to dark in about 60 ms, the body is a short low sine that gives
 * it weight through small speakers. Everything else is a variation on that.
 */
const SOUNDS = {
  shot: [ 0.28, ctx => {
    noise( ctx, 0.09, { gain: 0.9, from: 11000, to: 700 } );
    noise( ctx, 0.26, { gain: 0.22, from: 1800, to: 120 } );      // tail
    tone( ctx, 0.10, { freq: 150, to: 55, gain: 0.55 } );          // body
  } ],

  // Darker and softer: enemy fire arrives through air and geometry, and it is
  // positioned, so it does not need to compete with the player's own weapon.
  enemyShot: [ 0.34, ctx => {
    noise( ctx, 0.10, { gain: 0.8, from: 7000, to: 500 } );
    noise( ctx, 0.32, { gain: 0.3, from: 1200, to: 90 } );
    tone( ctx, 0.12, { freq: 120, to: 45, gain: 0.5 } );
  } ],

  impact: [ 0.12, ctx => {
    noise( ctx, 0.05, { gain: 0.7, type: 'bandpass', from: 3200, to: 1400, q: 1.2 } );
    noise( ctx, 0.11, { gain: 0.25, from: 900, to: 200 } );
  } ],

  hitmarker: [ 0.07, ctx => {
    tone( ctx, 0.06, { freq: 1250, to: 1100, gain: 0.5, type: 'triangle' } );
  } ],

  kill: [ 0.22, ctx => {
    tone( ctx, 0.09, { freq: 1400, gain: 0.45, type: 'triangle' } );
    tone( ctx, 0.14, { freq: 880, to: 620, gain: 0.4, type: 'triangle', delay: 0.07 } );
  } ],

  // Two mechanical events rather than one: the magazine leaving, then seating.
  reloadOut: [ 0.12, ctx => {
    noise( ctx, 0.05, { gain: 0.45, type: 'bandpass', from: 2600, to: 1600, q: 3 } );
  } ],
  reloadIn: [ 0.16, ctx => {
    noise( ctx, 0.06, { gain: 0.5, type: 'bandpass', from: 1800, to: 900, q: 4 } );
    tone( ctx, 0.07, { freq: 260, to: 150, gain: 0.3, type: 'square' } );
  } ],

  hurt: [ 0.3, ctx => {
    noise( ctx, 0.28, { gain: 0.35, from: 700, to: 90 } );
    tone( ctx, 0.22, { freq: 90, to: 50, gain: 0.5 } );
  } ],

  step: [ 0.14, ctx => {
    noise( ctx, 0.12, { gain: 0.16, from: 1600, to: 260 } );
  } ],
};

// ---------------------------------------------------------------------------

export class Audio {

  constructor( camera, scene ) {
    this.camera = camera;
    this.scene = scene;
    this.ready = false;
    this.listener = null;
    this.buffers = {};
    this._positional = [];
    this._ambient = [];
    this._tick = 0;
  }

  /**
   * Builds the audio graph. Must be called from a user gesture; safe to call
   * repeatedly. Returns true once sound is actually available.
   */
  async start() {
    if ( this.ready ) return true;
    if ( typeof window === 'undefined' || ! ( window.AudioContext || window.webkitAudioContext ) ) {
      return false;
    }

    try {
      this.listener = new THREE.AudioListener();
      this.camera.add( this.listener );

      const ctx = this.listener.context;
      if ( ctx.state === 'suspended' ) await ctx.resume();

      // Master limiter. Thirty-two simultaneous shots would otherwise sum well
      // past full scale and clip; this keeps the peak in range instead.
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -8;
      limiter.knee.value = 6;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.18;
      this.listener.setFilter( limiter );
      this.listener.setMasterVolume( 0.7 );

      await this._bake();

      this._group = new THREE.Group();
      this._group.name = 'AudioVoices';
      this.scene.add( this._group );

      for ( let i = 0; i < POSITIONAL_VOICES; i ++ ) {
        const v = new THREE.PositionalAudio( this.listener );
        v.setRefDistance( 6 );
        v.setRolloffFactor( 1.1 );
        v.setDistanceModel( 'exponential' );
        this._group.add( v );
        this._positional.push( v );
      }
      for ( let i = 0; i < AMBIENT_VOICES; i ++ ) {
        this._ambient.push( new THREE.Audio( this.listener ) );
      }

      this.ready = true;
      return true;
    } catch {
      // No output device, a blocked context, an exotic browser — play silent
      // rather than breaking the game or failing a headless run.
      this.ready = false;
      return false;
    }
  }

  /** Renders every sound once through an OfflineAudioContext. */
  async _bake() {
    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    for ( const [ name, [ seconds, build ] ] of Object.entries( SOUNDS ) ) {
      const ctx = new Offline( 1, Math.ceil( seconds * RATE ), RATE );
      build( ctx );
      this.buffers[ name ] = await ctx.startRendering();
    }
  }

  /**
   * Claims a voice, stealing the longest-running one if all are busy.
   * `THREE.Audio` cannot overlap itself, hence a pool rather than one node.
   */
  _claim( pool ) {
    const free = pool.find( v => ! v.isPlaying );
    if ( free ) return free;

    let oldest = pool[ 0 ];
    for ( const v of pool ) if ( v._startedAt < oldest._startedAt ) oldest = v;
    oldest.stop();
    return oldest;
  }

  _fire( voice, name, volume, rate ) {
    voice.setBuffer( this.buffers[ name ] );
    voice.setVolume( volume );
    voice.setPlaybackRate( rate );
    voice._startedAt = this._tick ++;
    voice.play();
  }

  /** Plays without position — the player's own weapon, HUD feedback. */
  play( name, { volume = 1, rate = 1 } = {} ) {
    if ( ! this.ready || ! this.buffers[ name ] ) return;
    this._fire( this._claim( this._ambient ), name, volume, rate );
  }

  /** Plays at a world position, panned and attenuated by distance. */
  playAt( name, position, { volume = 1, rate = 1 } = {} ) {
    if ( ! this.ready || ! this.buffers[ name ] ) return;
    const voice = this._claim( this._positional );
    voice.position.copy( position );
    voice.updateMatrixWorld( true );
    this._fire( voice, name, volume, rate );
  }

  dispose() {
    if ( this.listener ) this.camera.remove( this.listener );
    if ( this._group ) this.scene.remove( this._group );
    this.ready = false;
  }
}
