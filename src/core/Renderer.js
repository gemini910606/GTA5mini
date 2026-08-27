import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { GradeShader } from '../shaders/GradeShader.js';

/**
 * Renderer + post-processing stack.
 *
 * Pass order matters and is the whole point of this file:
 *
 *   RenderPass  -> scene, linear HDR
 *   GTAOPass    -> ground-truth ambient occlusion, still linear HDR
 *   BloomPass   -> must be linear HDR to bloom the right pixels
 *   OutputPass  -> tone map (ACES) + sRGB transfer. HDR ends here.
 *   SMAAPass    -> anti-alias the clean LDR image
 *   GradePass   -> vignette / grain / chromatic aberration / colour grade
 *
 * Getting bloom before tone mapping and AA before grain is most of the
 * difference between "a WebGL demo" and "a game".
 */

export const QUALITY = {
  low: {
    label: 'Low',
    pixelRatio: 0.75,
    shadowMapSize: 1024,
    shadows: true,
    gtao: false,
    bloom: true,
    smaa: false,
    grade: true,
  },
  medium: {
    label: 'Medium',
    pixelRatio: 1.0,
    shadowMapSize: 2048,
    shadows: true,
    gtao: true,
    bloom: true,
    smaa: true,
    grade: true,
  },
  high: {
    label: 'High',
    pixelRatio: Math.min( globalThis.devicePixelRatio || 1, 2 ),
    shadowMapSize: 4096,
    shadows: true,
    gtao: true,
    bloom: true,
    smaa: true,
    grade: true,
  },
};

export class Renderer {

  constructor( container, scene, camera ) {
    this.scene = scene;
    this.camera = camera;

    this.renderer = new THREE.WebGLRenderer( {
      antialias: false,          // SMAA handles this in post
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
    } );
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // The composer issues many render() calls per frame; with autoReset on,
    // renderer.info would only ever describe the final fullscreen pass.
    this.renderer.info.autoReset = false;
    container.appendChild( this.renderer.domElement );

    this._buildComposer();
    this.setQuality( 'high' );

    this._onResize = () => this.resize();
    window.addEventListener( 'resize', this._onResize );
    this.resize();
  }

  _buildComposer() {
    const { scene, camera, renderer } = this;
    const w = window.innerWidth, h = window.innerHeight;

    this.composer = new EffectComposer( renderer );

    this.renderPass = new RenderPass( scene, camera );
    this.composer.addPass( this.renderPass );

    this.gtaoPass = new GTAOPass( scene, camera, w, h );
    this.gtaoPass.output = GTAOPass.OUTPUT.Default;
    this.gtaoPass.blendIntensity = 0.85;
    this.gtaoPass.updateGtaoMaterial( {
      radius: 0.5,
      distanceExponent: 1.4,
      thickness: 1.0,
      scale: 1.0,
      samples: 16,
      distanceFallOff: 1.0,
      screenSpaceRadius: false,
    } );
    this.composer.addPass( this.gtaoPass );

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2( w, h ),
      0.34,   // strength — restrained; bloom is seasoning, not sauce
      0.55,   // radius
      1.15,   // threshold: only pixels brighter than white bloom. Below 1.0
              // this catches ordinary sunlit surfaces and the frame hazes over.
    );
    this.composer.addPass( this.bloomPass );

    this.outputPass = new OutputPass();
    this.composer.addPass( this.outputPass );

    this.smaaPass = new SMAAPass();
    this.composer.addPass( this.smaaPass );

    this.gradePass = new ShaderPass( GradeShader );
    this.composer.addPass( this.gradePass );
  }

  setQuality( name ) {
    const q = QUALITY[ name ] ?? QUALITY.medium;
    this.quality = name;
    this.qualitySettings = q;

    this.renderer.setPixelRatio( q.pixelRatio );
    this.renderer.shadowMap.enabled = q.shadows;

    this.gtaoPass.enabled = q.gtao;
    this.bloomPass.enabled = q.bloom;
    this.smaaPass.enabled = q.smaa;
    this.gradePass.enabled = q.grade;

    // The one directional light owns the shadow map; resizing it needs a rebuild.
    this.scene.traverse( ( obj ) => {
      if ( obj.isDirectionalLight && obj.castShadow ) {
        if ( obj.shadow.mapSize.width !== q.shadowMapSize ) {
          obj.shadow.mapSize.setScalar( q.shadowMapSize );
          obj.shadow.map?.dispose();
          obj.shadow.map = null;
        }
      }
    } );

    this.scene.traverse( ( obj ) => {
      if ( obj.isMesh && obj.material ) obj.material.needsUpdate = true;
    } );

    this.resize();
    return q;
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();

    this.renderer.setSize( w, h );
    this.composer.setSize( w, h );

    const pr = this.renderer.getPixelRatio();
    this.gradePass.uniforms.uResolution.value = [ w * pr, h * pr ];
  }

  render( elapsed ) {
    this.renderer.info.reset();
    this.gradePass.uniforms.uTime.value = elapsed;
    this.composer.render();
  }

  get info() { return this.renderer.info; }

  dispose() {
    window.removeEventListener( 'resize', this._onResize );
    this.composer.dispose();
    this.renderer.dispose();
  }
}
