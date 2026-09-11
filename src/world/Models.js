import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Loads glTF models for the `model` level element.
 *
 * This is the one place the project fetches anything at runtime, and it is
 * deliberately narrow. Hard rule 2 is that the single-player path makes no
 * external request and the offline single-file build still works; a level that
 * uses `model` opts out of the second half of that, and only that level does.
 * The arena and the PLATEAU maps are unaffected and still build into a file you
 * can double-click.
 *
 * `GLTFLoader` ships inside the `three` package and imports nothing but three's
 * own utilities, so rule 1 holds: `three` is still the only dependency.
 *
 * Compressed meshes are not supported on purpose. DRACO and KTX2 both need a
 * decoder shipped alongside, which is a second asset to host and a second thing
 * to go wrong; a model that needs them should be re-exported uncompressed.
 */

const loader = new GLTFLoader();

/**
 * One cache per URL, shared across levels.
 *
 * Cycling maps disposes a level's geometry, so a cached scene must never be
 * handed out twice: each instance gets its own clone, and the cache holds only
 * the parsed original.
 */
const cache = new Map();

export async function loadModel( url ) {
  let entry = cache.get( url );
  if ( ! entry ) {
    entry = loader.loadAsync( url ).then( gltf => gltf.scene );
    cache.set( url, entry );
  }
  return entry;
}

/** Drops a cached model. The clones already handed out keep working. */
export function forgetModel( url ) {
  cache.delete( url );
}

const _box = new THREE.Box3();

/**
 * Places one instance of a loaded model and derives its collision.
 *
 * Collision comes from the world AABB of each mesh in the model rather than its
 * triangles. That is the same bargain the rest of the level makes -- the solver
 * only consumes boxes -- but it is a worse fit here than for a building, since
 * an imported model is as likely to be an arch or a stairwell as a block. A
 * model with a big hole in it should be split into parts at export, or marked
 * `collide: false` and have boxes placed by hand.
 *
 * @returns {{ group: THREE.Object3D, boxes: THREE.Box3[] }}
 */
export function placeModel( source, { pos = [ 0, 0, 0 ], rotY = 0, scale = 1,
  collide = true, cast = true, receive = true } = {} ) {

  const group = source.clone( true );
  group.position.set( pos[ 0 ], pos[ 1 ], pos[ 2 ] );
  group.rotation.y = rotY;
  group.scale.setScalar( scale );
  group.updateMatrixWorld( true );

  const boxes = [];
  group.traverse( o => {
    if ( ! o.isMesh ) return;
    o.castShadow = cast;
    o.receiveShadow = receive;
    // Imported materials are whatever the exporter wrote. Anything with a
    // colour map must be told it is sRGB or the whole model renders washed out
    // against the procedural surfaces around it.
    const materials = Array.isArray( o.material ) ? o.material : [ o.material ];
    for ( const m of materials ) {
      if ( m?.map && m.map.colorSpace !== THREE.SRGBColorSpace ) {
        m.map.colorSpace = THREE.SRGBColorSpace;
        m.map.needsUpdate = true;
      }
    }
    if ( collide ) boxes.push( _box.setFromObject( o ).clone() );
  } );

  return { group, boxes };
}
