/**
 * Headless checks on the simulation core.
 *
 * This is the test that says whether networked play is possible at all. Client
 * prediction works by running the simulation ahead of the server, and
 * reconciliation works by rewinding to the server's last agreed state and
 * replaying every command since. Both collapse unless replaying a command
 * sequence from a saved state reproduces the state it produced the first time —
 * so that is checked directly, on the real maps, rather than assumed.
 *
 * It also checks that the simulation runs in Node at all. That is not a
 * formality: the moment anything here touches a camera, a mesh or the DOM, the
 * authoritative server stops being able to run the same movement code as the
 * client, and two implementations of movement is two sets of movement bugs.
 *
 *   node tools/test-sim.mjs
 */

import * as THREE from 'three';
import { readFileSync, readdirSync } from 'node:fs';
import { Colliders } from '../src/world/Colliders.js';
import { collidersFrom, spawnsFrom } from '../src/world/LevelColliders.js';
import { PlayerSim } from '../src/sim/PlayerSim.js';
import { Command, BTN, COMMAND_BYTES, writeCommand, readCommand, wrapAngle } from '../src/sim/Command.js';

const DT = 1 / 120;

let failures = 0;
const check = ( ok, message ) => {
  if ( ! ok ) {
    failures ++;
    if ( failures <= 12 ) console.error( `  FAIL ${ message }` );
  }
};

// Deterministic LCG: a failing sequence has to be reproducible to be useful.
let seed = 20260911;
const rnd = () => ( seed = ( seed * 1664525 + 1013904223 ) >>> 0 ) / 4294967296;

function world( file ) {
  const data = JSON.parse( readFileSync( `src/world/levels/${ file }`, 'utf8' ) );
  const { playerStart } = spawnsFrom( data );
  const { boxes, shapes } = collidersFrom( data );
  return { data, colliders: new Colliders( boxes, shapes ), playerStart };
}

/**
 * A command stream with the shape of someone actually playing: holds that last
 * several ticks, occasional jumps and crouches, a wandering aim. A stream of
 * independent random bits would exercise almost none of the state machine.
 */
function commandStream( count ) {
  const out = [];
  let yaw = 0, pitch = 0, buttons = 0;
  for ( let i = 0; i < count; i ++ ) {
    if ( i % 11 === 0 ) {
      buttons = 0;
      if ( rnd() < 0.75 ) buttons |= BTN.forward;
      if ( rnd() < 0.15 ) buttons |= BTN.back;
      if ( rnd() < 0.25 ) buttons |= BTN.left;
      if ( rnd() < 0.25 ) buttons |= BTN.right;
      if ( rnd() < 0.10 ) buttons |= BTN.jump;
      if ( rnd() < 0.15 ) buttons |= BTN.crouch;
      if ( rnd() < 0.30 ) buttons |= BTN.sprint;
      if ( rnd() < 0.20 ) buttons |= BTN.aim;
    }
    yaw += ( rnd() - 0.5 ) * 0.08;
    pitch = THREE.MathUtils.clamp( pitch + ( rnd() - 0.5 ) * 0.04, -1.4, 1.4 );

    const c = new Command();
    c.tick = i;
    c.yaw = yaw;
    c.pitch = pitch;
    c.buttons = buttons;
    out.push( c.quantise() );
  }
  return out;
}

const run = ( colliders, start, commands, from = 0, state = null ) => {
  const sim = new PlayerSim( colliders, start );
  if ( state ) sim.loadState( state );
  for ( let i = from; i < commands.length; i ++ ) sim.step( commands[ i ], DT );
  return sim;
};

/** Every field that has to match, and by how much. Positions are exact. */
function sameState( a, b, label ) {
  const sa = a.saveState(), sb = b.saveState();
  for ( const key of Object.keys( sa ) ) {
    check( sa[ key ] === sb[ key ],
      `${ label }: ${ key } ${ sa[ key ] } !== ${ sb[ key ] }` );
  }
}

// --- command codec -----------------------------------------------------------

console.log( 'command codec' );
{
  const buffer = new DataView( new ArrayBuffer( COMMAND_BYTES * 64 ) );
  const out = new Command();
  let worstYaw = 0, worstPitch = 0;
  for ( let i = 0; i < 64; i ++ ) {
    const c = new Command();
    c.tick = ( i * 7919 ) >>> 0;
    c.yaw = ( rnd() - 0.5 ) * Math.PI * 4;        // deliberately out of range
    c.pitch = ( rnd() - 0.5 ) * Math.PI * 1.4;
    c.buttons = Math.floor( rnd() * 1024 );
    c.quantise();

    writeCommand( c, buffer, i * COMMAND_BYTES );
    readCommand( buffer, i * COMMAND_BYTES, out );

    check( out.tick === c.tick, `tick ${ out.tick } !== ${ c.tick }` );
    check( out.buttons === c.buttons, `buttons ${ out.buttons } !== ${ c.buttons }` );
    // `quantise` is meant to land exactly on a representable angle, so the
    // round trip after it must be lossless, not merely close.
    worstYaw = Math.max( worstYaw, Math.abs( wrapAngle( out.yaw - c.yaw ) ) );
    worstPitch = Math.max( worstPitch, Math.abs( out.pitch - c.pitch ) );
  }
  check( worstYaw < 1e-9, `quantised yaw does not survive the wire: ${ worstYaw }` );
  check( worstPitch < 1e-9, `quantised pitch does not survive the wire: ${ worstPitch }` );
  console.log( `  ${ failures ? 'FAIL' : 'ok  ' } 64 commands, ${ COMMAND_BYTES } bytes each, `
    + `yaw error ${ worstYaw.toExponential( 1 ) } rad` );
}

// --- replay and reconciliation -----------------------------------------------

console.log( 'replay determinism' );
for ( const file of readdirSync( 'src/world/levels' ).sort() ) {
  if ( ! file.endsWith( '.json' ) ) continue;
  const { colliders, playerStart } = world( file );
  const before = failures;

  const commands = commandStream( 900 );

  // 1. The same commands from the same start must land in the same place.
  //    Everything below is worthless if this is not true.
  const a = run( colliders, playerStart, commands );
  const b = run( colliders, playerStart, commands );
  sameState( a, b, `${ file } replay` );

  // 2. Reconciliation: rewind to a saved state and replay the rest. This is
  //    literally what the client does when a server snapshot arrives, so it is
  //    tested at several rewind depths rather than one.
  for ( const rewind of [ 1, 7, 30, 120, 400 ] ) {
    const cut = commands.length - rewind;
    const mid = run( colliders, playerStart, commands.slice( 0, cut ) );
    const saved = mid.saveState();
    const replayed = run( colliders, playerStart, commands, cut, saved );
    sameState( a, replayed, `${ file } rewind ${ rewind }` );
  }

  // 3. A saved state must round-trip on its own, or a snapshot loses something
  //    that the next tick then invents differently.
  const loaded = new PlayerSim( colliders, playerStart ).loadState( a.saveState() );
  sameState( a, loaded, `${ file } state round trip` );

  const p = a.position;
  console.log( `  ${ failures === before ? 'ok  ' : 'FAIL' } ${ file.padEnd( 18 ) }`
    + ` end ${ p.x.toFixed( 2 ) },${ p.y.toFixed( 2 ) },${ p.z.toFixed( 2 ) }`
    + `  hp ${ a.health }  stam ${ a.stamina.toFixed( 1 ) }` );
}

// --- the simulation must actually simulate -----------------------------------
//
// A sim that never moved would pass every determinism check above.

console.log( 'sanity' );
{
  const { colliders, playerStart } = world( 'arena.json' );
  const forward = [];
  for ( let i = 0; i < 240; i ++ ) {
    const c = new Command();
    c.tick = i;
    c.buttons = BTN.forward;
    forward.push( c.quantise() );
  }
  const sim = run( colliders, playerStart, forward );
  const travelled = sim.position.distanceTo( playerStart );
  check( travelled > 3, `walking forward for 2 s moved only ${ travelled.toFixed( 2 ) } m` );
  check( sim.grounded, 'walking on flat ground left the player airborne' );

  // Walking into the world for two seconds must not put anyone inside it.
  const box = new THREE.Box3(
    new THREE.Vector3( sim.position.x - 0.3, sim.position.y + 0.1, sim.position.z - 0.3 ),
    new THREE.Vector3( sim.position.x + 0.3, sim.position.y + 1.6, sim.position.z + 0.3 ),
  );
  check( ! colliders.intersects( box ), 'the player ended up inside the level' );

  // Crouching has to actually lower the collision box, or you cannot take cover.
  const crouch = [];
  for ( let i = 0; i < 120; i ++ ) {
    const c = new Command();
    c.tick = i;
    c.buttons = BTN.crouch;
    crouch.push( c.quantise() );
  }
  const crouched = run( colliders, playerStart, crouch );
  check( crouched.height < 1.2, `crouching left the player ${ crouched.height.toFixed( 2 ) } m tall` );

  console.log( `  ok   walked ${ travelled.toFixed( 2 ) } m, crouched to ${ crouched.height.toFixed( 2 ) } m` );
}

if ( failures ) {
  console.error( `\n${ failures } failure(s)` );
  process.exit( 1 );
}
console.log( '\nreplaying a command stream reproduces the state it produced the first time' );
