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
    this.sensitivity = 0.0022;

    this._pressedThisFrame = new Set();
    this._listeners = { lock: [], unlock: [] };

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
      this.mouseDelta.x += e.movementX || 0;
      this.mouseDelta.y += e.movementY || 0;
    };

    this._onMouseDown = ( e ) => { if ( this.locked ) { this.buttons.add( e.button ); e.preventDefault(); } };
    this._onMouseUp = ( e ) => this.buttons.delete( e.button );
    this._onContextMenu = ( e ) => { if ( this.locked ) e.preventDefault(); };

    this._onPointerLockChange = () => {
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
    // Losing focus mid-key leaves that key stuck down otherwise.
    window.addEventListener( 'blur', () => { this.keys.clear(); this.buttons.clear(); } );
  }

  on( event, fn ) { this._listeners[ event ]?.push( fn ); return this; }
  _emit( event ) { this._listeners[ event ]?.forEach( fn => fn() ); }

  requestLock() { this.dom.requestPointerLock?.(); }

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
