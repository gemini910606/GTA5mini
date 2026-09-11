/**
 * One tick of player intent: what the client asks the simulation to do.
 *
 * This is the only thing that crosses the wire upstream, so it is deliberately
 * tiny and fixed-width. Everything the simulation needs to advance a player by
 * one tick is here and nothing else is — no positions, no velocities. The
 * server derives those; a client that sends them is a client that can teleport.
 *
 * View angles ARE sent absolutely rather than as mouse deltas. That is the
 * Quake/Source arrangement and it is the right one: the client owns where it is
 * looking (recoil, aim smoothing and sensitivity are all client-side feel), and
 * a delta stream desynchronises the moment one packet is dropped.
 *
 * Wire format, little-endian, 10 bytes:
 *
 *   0  uint32  tick
 *   4  int16   yaw    quantised over [ -PI, PI )
 *   6  int16   pitch  quantised over [ -PI/2, PI/2 ]
 *   8  uint16  buttons
 *
 * 16 bits of yaw is 9.6e-5 rad, about 1 cm of aim error at 100 m — well inside
 * the hitbox of anything worth shooting at.
 */

export const BTN = {
  forward: 1 << 0,
  back: 1 << 1,
  left: 1 << 2,
  right: 1 << 3,
  jump: 1 << 4,
  crouch: 1 << 5,
  sprint: 1 << 6,
  fire: 1 << 7,
  aim: 1 << 8,
  reload: 1 << 9,
};

export const COMMAND_BYTES = 10;

const YAW_SCALE = 32767 / Math.PI;
const PITCH_SCALE = 32767 / ( Math.PI / 2 );

/** Wrap to [ -PI, PI ) so the quantisation never clips a legal angle. */
export function wrapAngle( a ) {
  const t = ( a + Math.PI ) % ( Math.PI * 2 );
  return ( t < 0 ? t + Math.PI * 2 : t ) - Math.PI;
}

const clamp = ( v, lo, hi ) => ( v < lo ? lo : v > hi ? hi : v );

export class Command {

  constructor() {
    this.tick = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.buttons = 0;
  }

  has( button ) {
    return ( this.buttons & button ) !== 0;
  }

  set( button, on ) {
    if ( on ) this.buttons |= button;
    else this.buttons &= ~button;
    return this;
  }

  copy( other ) {
    this.tick = other.tick;
    this.yaw = other.yaw;
    this.pitch = other.pitch;
    this.buttons = other.buttons;
    return this;
  }

  clone() {
    return new Command().copy( this );
  }

  /**
   * Rounds the angles to what the wire would carry.
   *
   * The client predicts with this applied so its own simulation sees exactly
   * the angles the server will: skip it and every shot disagrees by a fraction
   * of a degree, which is a reconciliation correction on every single tick.
   */
  quantise() {
    this.yaw = Math.round( wrapAngle( this.yaw ) * YAW_SCALE ) / YAW_SCALE;
    this.pitch = Math.round( clamp( this.pitch, -Math.PI / 2, Math.PI / 2 ) * PITCH_SCALE ) / PITCH_SCALE;
    return this;
  }
}

/** @param {DataView} view */
export function writeCommand( cmd, view, offset = 0 ) {
  view.setUint32( offset, cmd.tick >>> 0, true );
  view.setInt16( offset + 4, Math.round( wrapAngle( cmd.yaw ) * YAW_SCALE ), true );
  view.setInt16( offset + 6, Math.round( clamp( cmd.pitch, -Math.PI / 2, Math.PI / 2 ) * PITCH_SCALE ), true );
  view.setUint16( offset + 8, cmd.buttons & 0xffff, true );
  return offset + COMMAND_BYTES;
}

/** @param {DataView} view @param {Command} out */
export function readCommand( view, offset, out ) {
  out.tick = view.getUint32( offset, true );
  out.yaw = view.getInt16( offset + 4, true ) / YAW_SCALE;
  out.pitch = view.getInt16( offset + 6, true ) / PITCH_SCALE;
  out.buttons = view.getUint16( offset + 8, true );
  return offset + COMMAND_BYTES;
}
