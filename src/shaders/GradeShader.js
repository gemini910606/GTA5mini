/**
 * Post-tonemap film pass: chromatic aberration, vignette, film grain,
 * lift/gamma/gain colour grading and a subtle sharpen.
 *
 * Runs on the LDR sRGB image, i.e. after OutputPass + SMAA.
 */
export const GradeShader = {
  name: 'GradeShader',

  uniforms: {
    tDiffuse:    { value: null },
    uTime:       { value: 0 },
    uResolution: { value: [1, 1] },
    uAberration: { value: 0.0009 },
    uVignette:   { value: 0.36 },
    uGrain:      { value: 0.035 },
    uSharpen:    { value: 0.18 },
    uLift:       { value: [0.012, 0.016, 0.028] },
    uGain:       { value: [1.045, 1.005, 0.965] },
    uSaturation: { value: 1.08 },
    uContrast:   { value: 1.06 },
  },

  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
  `,

  fragmentShader: /* glsl */`
    precision highp float;

    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2  uResolution;
    uniform float uAberration;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uSharpen;
    uniform vec3  uLift;
    uniform vec3  uGain;
    uniform float uSaturation;
    uniform float uContrast;

    varying vec2 vUv;

    float hash( vec2 p ) {
      p = fract( p * vec2( 443.897, 441.423 ) );
      p += dot( p, p.yx + 19.19 );
      return fract( ( p.x + p.y ) * p.x );
    }

    void main() {
      vec2 uv = vUv;
      vec2 fromCentre = uv - 0.5;
      float r2 = dot( fromCentre, fromCentre );

      // --- Chromatic aberration: radial, strongest at frame edges -------------
      vec2 offset = fromCentre * uAberration * ( 0.35 + r2 * 2.4 );
      vec3 colour;
      colour.r = texture2D( tDiffuse, uv + offset ).r;
      colour.g = texture2D( tDiffuse, uv ).g;
      colour.b = texture2D( tDiffuse, uv - offset ).b;

      // --- Unsharp mask -------------------------------------------------------
      if ( uSharpen > 0.0 ) {
        vec2 texel = 1.0 / uResolution;
        vec3 blur =
            texture2D( tDiffuse, uv + vec2(  texel.x, 0.0 ) ).rgb
          + texture2D( tDiffuse, uv + vec2( -texel.x, 0.0 ) ).rgb
          + texture2D( tDiffuse, uv + vec2( 0.0,  texel.y ) ).rgb
          + texture2D( tDiffuse, uv + vec2( 0.0, -texel.y ) ).rgb;
        colour += ( colour - blur * 0.25 ) * uSharpen;
      }

      // --- Lift / gain, contrast, saturation ----------------------------------
      colour = colour * uGain + uLift;
      colour = ( colour - 0.5 ) * uContrast + 0.5;

      float luma = dot( colour, vec3( 0.2126, 0.7152, 0.0722 ) );
      colour = mix( vec3( luma ), colour, uSaturation );

      // --- Vignette -----------------------------------------------------------
      float vig = 1.0 - uVignette * smoothstep( 0.12, 0.78, r2 );
      colour *= vig;

      // --- Animated film grain, scaled down in the highlights -----------------
      float grain = hash( uv * uResolution + fract( uTime ) * 137.0 ) - 0.5;
      colour += grain * uGrain * ( 1.0 - 0.7 * luma );

      gl_FragColor = vec4( clamp( colour, 0.0, 1.0 ), 1.0 );
    }
  `,
};
