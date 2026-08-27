/**
 * Keyboard + pointer-lock mouse input.
 *
 * Mouse look is accumulated as deltas and drained once per frame, so a fast
 * mouse producing several events per frame is not silently dropped.
 */
export class Input {

  constructor( domElement ) {
    this.dom = domElement;
    this.keys = new Set();
    this.mouseDelta = { x: 0, y: 0 };
    this.buttons = new Set();
    this.locked = false;
    /** True when pointer lock was refused and we are using drag-to-look. */
    this.dragFallback = false;
    this.sensitivity = 0.0022;

    this._pressedThisFrame = new Set();
    this._listeners = { lock: [], unlock: [], fallback: [] };

    this._onKeyDown = ( e ) => {
      if ( e.repeat ) return;
      this.keys.add( e.code );
      this._pressedThisFrame.add( e.code );
      // Space scrolls, ctrl+W is a browser shortcut, / opens quick-find in some browsers
      if ( [ 'Space', 'Tab', 'Slash' ].includes( e.code ) ) e.preventDefault();
    };
    this._onKeyUp = ( e ) => this.keys.delete( e.code );

    this._onMouseMove = ( e ) => {
      if ( ! this.locked ) return;
      // In drag-fallback mode only look while a button is held, otherwise the
      // camera spins whenever the cursor crosses the page.
      if ( this.dragFallback && this.buttons.size === 0 ) return;
      this.mouseDelta.x += e.movementX || 0;
      this.mouseDelta.y += e.movementY || 0;
    };

    this._onMouseDown = ( e ) => { if ( this.locked ) { this.buttons.add( e.button ); e.preventDefault(); } };
    this._onPointerLockError = () => this._enableDragFallback();
    this._onMouseUp = ( e ) => this.buttons.delete( e.button );
    this._onContextMenu = ( e ) => { if ( this.locked ) e.preventDefault(); };

    this._onPointerLockChange = () => {
      if ( this.dragFallback ) return;
      this.locked = document.pointerLockElement === this.dom;
      if ( ! this.locked ) {
        this.keys.clear();
        this.buttons.clear();
      }
      this._emit( this.locked ? 'lock' : 'unlock' );
    };

    window.addEventListener( 'keydown', this._onKeyDown );
    window.addEventListener( 'keyup', this._onKeyUp );
    window.addEventListener( 'mousemove', this._onMouseMove );
    window.addEventListener( 'mousedown', this._onMouseDown );
    window.addEventListener( 'mouseup', this._onMouseUp );
    window.addEventListener( 'contextmenu', this._onContextMenu );
    document.addEventListener( 'pointerlockchange', this._onPointerLockChange );
    document.addEventListener( 'pointerlockerror', this._onPointerLockError );
    // Losing focus mid-key leaves that key stuck down otherwise.
    window.addEventListener( 'blur', () => { this.keys.clear(); this.buttons.clear(); } );

    // Escape leaves drag-fallback mode, mirroring what pointer lock does.
    window.addEventListener( 'keydown', ( e ) => {
      if ( e.code === 'Escape' && this.dragFallback ) {
        this.dragFallback = false;
        this.locked = false;
        this.keys.clear();
        this.buttons.clear();
        this._emit( 'unlock' );
      }
    } );
  }

  on( event, fn ) { this._listeners[ event ]?.push( fn ); return this; }
  _emit( event ) { this._listeners[ event ]?.forEach( fn => fn() ); }

  /**
   * Requests pointer lock, falling back to drag-to-look.
   *
   * Pointer lock needs `allow="pointer-lock"` on the frame, which embeds
   * (artifact viewers, docs, itch.io) do not always grant. Without a fallback
   * the game is simply unplayable there, with no error to explain why.
   */
  requestLock() {
    const request = this.dom.requestPointerLock?.( { unadjustedMovement: true } )
      ?? this.dom.requestPointerLock?.();

    // Chromium returns a promise; other engines return undefined and fire
    // pointerlockerror instead, which `_onPointerLockError` handles.
    if ( request && typeof request.catch === 'function' ) {
      request.catch( () => this._enableDragFallback() );
    }

    // If lock has not engaged shortly after the gesture, assume it never will.
    setTimeout( () => {
      if ( ! this.locked && ! this.dragFallback ) this._enableDragFallback();
    }, 400 );
  }

  _enableDragFallback() {
    if ( this.dragFallback ) return;
    this.dragFallback = true;
    this.locked = true;         // the rest of the game treats this as "playing"
    this._emit( 'lock' );
    this._emit( 'fallback' );
  }

  isDown( code ) { return this.keys.has( code ); }
  /** True only on the frame the key went down. */
  wasPressed( code ) { return this._pressedThisFrame.has( code ); }
  isMouseDown( button ) { return this.buttons.has( button ); }

  /** Returns accumulated look delta in radians and resets it. */
  consumeLook() {
    const yaw = -this.mouseDelta.x * this.sensitivity;
    const pitch = -this.mouseDelta.y * this.sensitivity;
    this.mouseDelta.x = 0;
    this.mouseDelta.y = 0;
    return { yaw, pitch };
  }

  endFrame() { this._pressedThisFrame.clear(); }
}
