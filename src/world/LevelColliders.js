import * as THREE from 'three';
import { buildPrisms } from './PrismGeometry.js';

/**
 * Derives a level's collision boxes from its JSON, without building any of it.
 *
 * `Level` derives colliders from the meshes it has just built, which is the
 * right thing for the client: the collision world cannot drift from the
 * geometry if it is read off the geometry. But `Level` needs a canvas — it
 * generates textures — so a headless authoritative server, or a Node test,
 * cannot use it.
 *
 * This is the same derivation over the same element descriptions, sharing
 * `PrismGeometry` with `Level` and reproducing the rest operation for
 * operation. It is a second implementation, which the level schema otherwise
 * goes out of its way to avoid, so `npm run shots:levels` asserts box for box
 * that the two agree.
 *
 * Everything here is pure three maths: it runs in Node, in a Worker, and in a
 * Cloudflare Worker.
 */

/** Barrier profile, duplicated from `Level` because the bounds depend on it. */
function barrierGeometry() {
  const shape = new THREE.Shape();
  shape.moveTo( -0.5, -0.55 );
  shape.lineTo( 0.5, -0.55 );
  shape.lineTo( 0.28, 0.05 );
  shape.lineTo( 0.2, 0.55 );
  shape.lineTo( -0.2, 0.55 );
  shape.lineTo( -0.28, 0.05 );
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry( shape, {
    depth: 3.2, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: 1,
  } );
  geo.translate( 0, 0, -1.6 );
  geo.rotateY( Math.PI / 2 );
  geo.computeVertexNormals();
  return geo;
}

function elementGeometry( g ) {
  switch ( g.kind ) {
    case 'box': return new THREE.BoxGeometry( g.size[ 0 ], g.size[ 1 ], g.size[ 2 ] );
    case 'barrier': return barrierGeometry();
    default: throw new Error( `LevelColliders: unknown geometry kind "${ g.kind }"` );
  }
}

/**
 * A rotated box's AABB. Matches `Level._solid`, which reads it off the built
 * mesh with `Box3.setFromObject` — same result, without a material.
 */
function solidBox( { size, pos, rotY = 0 }, out ) {
  const geo = new THREE.BoxGeometry( size[ 0 ], size[ 1 ], size[ 2 ] );
  const mesh = new THREE.Mesh( geo );
  mesh.position.set( pos[ 0 ], pos[ 1 ], pos[ 2 ] );
  mesh.rotation.y = rotY;
  mesh.updateMatrixWorld( true );
  out.setFromObject( mesh );
  geo.dispose();
  return out;
}

/**
 * @param {object} data a level JSON
 * @returns {{ boxes: THREE.Box3[], shapes: Array<{ring:number[],top:number}|null> }}
 *   in the same order `Level` pushes them. A null shape means the box is the
 *   shape; a prism carries its footprint, because its box is up to 43% larger
 *   than the building (see `Narrow.js`).
 */
export function collidersFrom( data ) {
  const boxes = [];
  const shapes = [];

  for ( const element of data.elements ) {
    switch ( element.type ) {

      case 'box': {
        if ( element.collide === false ) break;
        boxes.push( solidBox( element, new THREE.Box3() ) );
        shapes.push( null );
        break;
      }

      case 'ramp': {
        // Expanded into steps exactly as `Level._ramp` does, each one a solid.
        const steps = element.steps ?? 7;
        for ( let i = 0; i < steps; i ++ ) {
          const h = element.height * ( i + 1 ) / steps;
          const d = element.run / steps;
          boxes.push( solidBox( {
            size: [ element.width, h, d ],
            pos: [ element.base[ 0 ], h / 2, element.base[ 2 ] - element.run / 2 + d * ( i + 0.5 ) ],
          }, new THREE.Box3() ) );
          shapes.push( null );
        }
        break;
      }

      case 'instanced': {
        if ( element.collide === false ) break;
        const geo = elementGeometry( element.geometry );
        geo.computeBoundingBox();
        const hy = ( geo.boundingBox.max.y - geo.boundingBox.min.y ) * 0.5;
        geo.dispose();
        // Conservative AABB: a rotated box needs its diagonal, not its edge.
        const r = ( element.colliderSize ?? 0 ) * 0.5 * Math.SQRT2;
        for ( const [ x, y, z ] of element.transforms ) {
          boxes.push( new THREE.Box3(
            new THREE.Vector3( x - r, y - hy, z - r ),
            new THREE.Vector3( x + r, y + hy, z + r ),
          ) );
          shapes.push( null );
        }
        break;
      }

      case 'prisms': {
        if ( element.collide === false ) break;
        const { geometry, boxes: prismBoxes } = buildPrisms( element.buildings, element.uvScale ?? 6 );
        geometry.dispose();
        prismBoxes.forEach( ( b, i ) => {
          boxes.push( b );
          shapes.push( { ring: element.buildings[ i ].ring, top: element.buildings[ i ].h } );
        } );
        break;
      }

      case 'pointLight': break;

      default: throw new Error( `LevelColliders: unknown element type "${ element.type }"` );
    }
  }

  return { boxes, shapes };
}

/** Spawn points and the player start, as plain vectors. */
export function spawnsFrom( data ) {
  return {
    playerStart: new THREE.Vector3( ...( data.playerStart ?? [ 0, 0, 26 ] ) ),
    spawnPoints: data.spawnPoints.map( p => new THREE.Vector3( ...p ) ),
  };
}
