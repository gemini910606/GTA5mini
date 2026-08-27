import * as THREE from 'three';
import { HDRI } from './hdri.generated.js';
import { Sky } from 'three/addons/objects/Sky.js';

/**
 * Sky, image-based lighting, sun and fog.
 *
 * Two rules govern this file, and both are easy to get wrong:
 *
 * 1. The sun disc is NOT baked into the IBL. `Sky`'s fragment shader emits the
 *    solar disc at `vSunE * 19000` — roughly 7e5 in linear radiance. PMREM that
 *    and every surface in the scene is lit by a second sun on top of the
 *    `DirectionalLight`, which blows the whole frame to white. So the bake runs
 *    with `showSunDisc = 0`: the dome supplies ambient + specular, the
 *    directional light supplies the sun. No double counting.
 *
 * 2. The sky is a real mesh inside the camera's far plane, not `scene.background`.
 *    A PMREM cubemap used as a background is blurry and loses the sun and clouds;
 *    the mesh keeps them at full resolution.
 *
 * `environmentIntensity` values were measured, not guessed — see tools/probe-exposure.mjs.
 */

// Radius of the sky dome. Must be inside the camera's far plane (800) or the
// box is clipped away entirely and the sky renders as the clear colour.
const SKY_RADIUS = 450;

// The preset `envIntensity` values were measured against the procedural sky.
// The HDRI probe carries different absolute energy, so switching source without
// rescaling shifts exposure. Measured with `npm run probe` — see README.
const HDRI_INTENSITY_SCALE = 1.0;

export const TIME_OF_DAY = {
  goldenHour: {
    label: 'Late Afternoon',
    elevation: 30.0, azimuth: 68,
    turbidity: 6.0, rayleigh: 2.0, mieCoefficient: 0.007, mieDirectionalG: 0.87,
    cloudCoverage: 0.42, cloudDensity: 0.45, cloudElevation: 0.55,
    sunColor: 0xffd9b0, sunIntensity: 3.4,
    envIntensity: 0.20,
    hemiSky: 0xbcd6ff, hemiGround: 0x6b5844, hemiIntensity: 0.9,
    fogColor: 0xb8c4d4, fogDensity: 0.0048,
    exposure: 0.9,
  },
  noon: {
    label: 'Noon',
    elevation: 58, azimuth: 96,
    turbidity: 3.0, rayleigh: 1.2, mieCoefficient: 0.004, mieDirectionalG: 0.8,
    cloudCoverage: 0.30, cloudDensity: 0.35, cloudElevation: 0.4,
    sunColor: 0xfff4e2, sunIntensity: 3.9,
    envIntensity: 0.16,
    hemiSky: 0xc9dcff, hemiGround: 0x7a6c58, hemiIntensity: 0.8,
    fogColor: 0xcbd8e6, fogDensity: 0.0030,
    exposure: 0.8,
  },
  dusk: {
    label: 'Dusk',
    elevation: 1.0, azimuth: 186,
    turbidity: 9.0, rayleigh: 3.0, mieCoefficient: 0.011, mieDirectionalG: 0.9,
    cloudCoverage: 0.55, cloudDensity: 0.55, cloudElevation: 0.65,
    sunColor: 0xff9a5c, sunIntensity: 1.5,
    envIntensity: 0.34,
    hemiSky: 0x8fa3c8, hemiGround: 0x4a3f38, hemiIntensity: 1.1,
    fogColor: 0x76839c, fogDensity: 0.0080,
    exposure: 1.15,
  },
};

export class Environment {

  constructor( scene, renderer, preset = 'goldenHour' ) {
    this.scene = scene;
    this.renderer = renderer;
    this.pmrem = new THREE.PMREMGenerator( renderer );
    this.pmrem.compileEquirectangularShader();

    this.sky = new Sky();

    // Clamp the sky's linear output. `Sky` emits the solar disc at roughly
    // 7e5, which is physically reasonable and completely unusable: fed into
    // UnrealBloomPass it produces a bloom covering half the frame no matter
    // what the threshold is. 4.5 still reads as "far brighter than white"
    // after ACES — the sun is clearly a light source — but keeps the bloom
    // chain in a range where the threshold actually does something.
    this.sky.material.fragmentShader = this.sky.material.fragmentShader.replace(
      'gl_FragColor = vec4( texColor, 1.0 );',
      'gl_FragColor = vec4( min( texColor, vec3( 4.5 ) ), 1.0 );',
    );
    this.sky.material.needsUpdate = true;

    this.sky.scale.setScalar( SKY_RADIUS );
    this.sky.renderOrder = -1;
    scene.add( this.sky );

    this.sunDirection = new THREE.Vector3();
    this._envTarget = null;
    this.iblSource = 'procedural';

    this.sun = new THREE.DirectionalLight( 0xffffff, 1 );
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.setScalar( 4096 );
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.035;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 260;

    // Shadow resolution is texels-per-metre: a tight frustum beats a big map.
    const d = 52;
    Object.assign( this.sun.shadow.camera, { left: -d, right: d, top: d, bottom: -d } );
    this.sun.shadow.camera.updateProjectionMatrix();
    scene.add( this.sun );
    scene.add( this.sun.target );

    // Warm ground bounce. The PMREM of an empty sky cannot know the courtyard
    // floor is there, so this stands in for the missing first bounce.
    this.bounce = new THREE.HemisphereLight( 0xbcd6ff, 0x6b5844, 0.3 );
    scene.add( this.bounce );

    this.applyPreset( preset );
  }

  applyPreset( name ) {
    const p = TIME_OF_DAY[ name ] ?? TIME_OF_DAY.goldenHour;
    this.preset = name;
    this.presetSettings = p;

    const u = this.sky.material.uniforms;
    u.turbidity.value = p.turbidity;
    u.rayleigh.value = p.rayleigh;
    u.mieCoefficient.value = p.mieCoefficient;
    u.mieDirectionalG.value = p.mieDirectionalG;
    u.cloudCoverage.value = p.cloudCoverage;
    u.cloudDensity.value = p.cloudDensity;
    u.cloudElevation.value = p.cloudElevation;

    const phi = THREE.MathUtils.degToRad( 90 - p.elevation );
    const theta = THREE.MathUtils.degToRad( p.azimuth );
    this.sunDirection.setFromSphericalCoords( 1, phi, theta );
    u.sunPosition.value.copy( this.sunDirection );

    this.sun.position.copy( this.sunDirection ).multiplyScalar( 140 );
    this.sun.target.position.set( 0, 0, 0 );
    this.sun.target.updateMatrixWorld();
    this.sun.color.setHex( p.sunColor );
    this.sun.intensity = p.sunIntensity;

    this.bounce.color.setHex( p.hemiSky );
    this.bounce.groundColor.setHex( p.hemiGround );
    this.bounce.intensity = p.hemiIntensity;

    this.scene.fog = new THREE.FogExp2( p.fogColor, p.fogDensity );
    this.renderer.toneMappingExposure = p.exposure;
    this.refreshIBL();   // also applies envIntensity for the active source
    return p;
  }

  /**
   * Bakes `scene.environment` from whichever IBL source is selected.
   *
   * Both paths end the same way: build the new PMREM target, then drop the old
   * one, so a failed bake cannot leave the scene holding a disposed map.
   */
  refreshIBL() {
    let target;
    if ( this.iblSource === 'hdri' ) {
      // Decoded per bake and thrown away: PMREM consumes it here, and holding
      // it would leave a texture allocated for a mode that may never be
      // switched back on. Decoding 32k texels costs single-digit milliseconds.
      const equirect = this._decodeHDRI();
      target = this.pmrem.fromEquirectangular( equirect );
      equirect.dispose();
    } else {
      target = this._bakeProceduralSky();
    }

    this._envTarget?.dispose();
    this._envTarget = target;
    this.scene.environment = target.texture;
    this.scene.background = null;

    this._applyEnvIntensity();
  }

  /** PMREM of the sky dome with the solar disc suppressed. */
  _bakeProceduralSky() {
    const uniforms = this.sky.material.uniforms;
    const hadSunDisc = uniforms.showSunDisc.value;
    uniforms.showSunDisc.value = 0;

    const skyScene = new THREE.Scene();
    const proxy = new THREE.Mesh( this.sky.geometry, this.sky.material );
    proxy.scale.setScalar( SKY_RADIUS );
    skyScene.add( proxy );

    const target = this.pmrem.fromScene( skyScene, 0.02 );

    uniforms.showSunDisc.value = hadSunDisc;
    skyScene.remove( proxy );
    return target;
  }

  /**
   * Decodes the embedded RGBE probe into an equirectangular texture.
   *
   * Half float rather than full: PMREM consumes this immediately and the
   * source is already clamped to a narrow range, so the extra mantissa buys
   * nothing and doubles the upload.
   */
  _decodeHDRI() {
    const bytes = Uint8Array.from( atob( HDRI.rgbe ), c => c.charCodeAt( 0 ) );
    const texels = HDRI.width * HDRI.height;
    const rgba = new Uint16Array( texels * 4 );

    for ( let i = 0; i < texels; i ++ ) {
      const e = bytes[ i * 4 + 3 ];
      const f = e === 0 ? 0 : Math.pow( 2, e - 136 );   // 2^(e-128) / 256
      rgba[ i * 4 ]     = THREE.DataUtils.toHalfFloat( bytes[ i * 4 ] * f );
      rgba[ i * 4 + 1 ] = THREE.DataUtils.toHalfFloat( bytes[ i * 4 + 1 ] * f );
      rgba[ i * 4 + 2 ] = THREE.DataUtils.toHalfFloat( bytes[ i * 4 + 2 ] * f );
      rgba[ i * 4 + 3 ] = THREE.DataUtils.toHalfFloat( 1 );
    }

    const tex = new THREE.DataTexture(
      rgba, HDRI.width, HDRI.height, THREE.RGBAFormat, THREE.HalfFloatType,
    );
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.LinearSRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * The two sources carry different absolute energy, so the preset's
   * `envIntensity` — measured against the procedural sky — has to be rescaled
   * for the probe. The factor is measured with `npm run probe`, not guessed.
   */
  _applyEnvIntensity() {
    const base = this.presetSettings.envIntensity;
    this.scene.environmentIntensity = this.iblSource === 'hdri'
      ? base * HDRI_INTENSITY_SCALE
      : base;
  }

  /**
   * Switches IBL source at runtime. Returns the source actually in effect.
   */
  setIblSource( source ) {
    const next = source === 'hdri' ? 'hdri' : 'procedural';
    if ( next === this.iblSource ) return next;
    this.iblSource = next;
    this.refreshIBL();
    return next;
  }

  /** Flips between the two sources. */
  cycleIblSource() {
    return this.setIblSource( this.iblSource === 'hdri' ? 'procedural' : 'hdri' );
  }

  /** Keeps the shadow frustum and the sky dome centred on the player. */
  followTarget( position ) {
    this.sun.target.position.set( position.x, 0, position.z );
    this.sun.position
      .copy( this.sunDirection ).multiplyScalar( 140 )
      .add( new THREE.Vector3( position.x, 0, position.z ) );
    this.sun.target.updateMatrixWorld();
    this.sky.position.set( position.x, 0, position.z );
  }

  /** Drives cloud drift. Cheap; safe to call every frame. */
  update( elapsed ) {
    this.sky.material.uniforms.time.value = elapsed;
  }

  dispose() {
    this.pmrem.dispose();
    this._envTarget?.dispose();
  }
}
