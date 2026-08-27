/**
 * DOM-based HUD.
 *
 * Kept out of the WebGL scene on purpose: text stays crisp at any pixel ratio,
 * costs no draw calls, and is far cheaper to restyle than a canvas overlay.
 * Every setter is guarded so a value that has not changed does not touch the DOM.
 */
export class Hud {

  constructor() {
    this.root = document.getElementById( 'hud' );
    this.crosshair = document.getElementById( 'crosshair' );
    this.hitmarker = document.getElementById( 'hitmarker' );
    this.healthFill = document.getElementById( 'healthFill' );
    this.staminaFill = document.getElementById( 'staminaFill' );
    this.ammoMag = document.getElementById( 'ammoMag' );
    this.ammoReserve = document.getElementById( 'ammoReserve' );
    this.weaponName = document.getElementById( 'weaponName' );
    this.reloading = document.getElementById( 'reloading' );
    this.scoreVal = document.getElementById( 'scoreVal' );
    this.stats = document.getElementById( 'stats' );
    this.floaters = document.getElementById( 'floaters' );
    this.vignette = document.getElementById( 'damageVignette' );

    this._last = {};
    this._hitmarkerTimer = null;
    this._vignetteTimer = null;
  }

  show() { this.root.classList.remove( 'hidden' ); }
  hide() { this.root.classList.add( 'hidden' ); }

  setHealth( value, max ) {
    const pct = Math.round( ( value / max ) * 100 );
    if ( this._last.health === pct ) return;
    this._last.health = pct;
    this.healthFill.style.width = `${ pct }%`;
  }

  setStamina( value, max ) {
    const pct = Math.round( ( value / max ) * 100 );
    if ( this._last.stamina === pct ) return;
    this._last.stamina = pct;
    this.staminaFill.style.width = `${ pct }%`;
  }

  setAmmo( mag, reserve, magSize ) {
    if ( this._last.mag !== mag ) {
      this._last.mag = mag;
      this.ammoMag.textContent = String( mag ).padStart( 2, '0' );
      this.ammoMag.classList.toggle( 'low', mag <= magSize * 0.25 );
    }
    if ( this._last.reserve !== reserve ) {
      this._last.reserve = reserve;
      this.ammoReserve.textContent = `/ ${ reserve }`;
    }
  }

  setWeaponName( name ) {
    if ( this._last.weapon === name ) return;
    this._last.weapon = name;
    this.weaponName.textContent = name;
  }

  setReloading( on ) {
    if ( this._last.reloading === on ) return;
    this._last.reloading = on;
    this.reloading.classList.toggle( 'on', on );
  }

  setScore( kills ) {
    if ( this._last.score === kills ) return;
    this._last.score = kills;
    this.scoreVal.textContent = String( kills );
  }

  /** Crosshair gap tracks the weapon's actual spread cone, in radians. */
  setSpread( spreadRadians, hidden = false ) {
    const gap = Math.round( 3 + spreadRadians * 340 );
    if ( this._last.gap !== gap ) {
      this._last.gap = gap;
      for ( const arm of this.crosshair.children ) {
        const cls = arm.className;
        const axis = cls === 't' || cls === 'b' ? 'translateY' : 'translateX';
        const sign = cls === 't' || cls === 'l' ? -1 : 1;
        arm.style.transform = `${ axis }(${ sign * gap }px)`;
      }
    }
    this.crosshair.classList.toggle( 'hide', hidden );
  }

  hitmark() {
    this.hitmarker.classList.remove( 'show' );
    // Force a reflow so the animation restarts on rapid consecutive hits.
    void this.hitmarker.offsetWidth;
    this.hitmarker.classList.add( 'show' );
  }

  damageFlash() {
    this.vignette.style.opacity = '1';
    clearTimeout( this._vignetteTimer );
    this._vignetteTimer = setTimeout( () => { this.vignette.style.opacity = '0'; }, 90 );
  }

  /** Floating damage number at a screen-space position. */
  floatDamage( x, y, amount, crit = false ) {
    const el = document.createElement( 'div' );
    el.className = crit ? 'floater crit' : 'floater';
    el.textContent = crit ? `${ amount }!` : String( amount );
    el.style.left = `${ x }px`;
    el.style.top = `${ y }px`;
    this.floaters.appendChild( el );
    setTimeout( () => el.remove(), 900 );
  }

  setStats( text ) {
    if ( this._last.stats === text ) return;
    this._last.stats = text;
    this.stats.textContent = text;
  }
}
