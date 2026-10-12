// Display-only bloom: a WebGL2 overlay that reads the frame currently on
// screen, keeps what's brighter than a threshold, blurs it through a mip
// chain (dual-filter down/up sampling) and draws only the glow. The host
// stacks it over the image with additive blending.
//
// It never feeds back into sampling: palettes come from engine.shade(), so
// the colors stay exact while the picture glows.

export interface Bloom {
  readonly canvas: HTMLCanvasElement;
  /** Glow for the given frame (a canvas showing sRGB pixels). strength scales
   * the glow; threshold is the linear brightness where glow starts. */
  render(source: TexImageSource, strength: number, threshold: number): void;
  resize(width: number, height: number): void;
  clear(): void;
  dispose(): void;
}

export type BloomFactory = (width: number, height: number) => Bloom | null;

const MAX_LEVELS = 6;

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// sRGB pixels in, linear light with a soft-knee threshold out
const PREFILTER = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uThreshold;
vec3 decode(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 tap(vec2 o) { return decode(texture(uSrc, vUv + o * uTexel).rgb); }
void main() {
  // 4 taps around the target texel: a cheap box downsample on the way in
  vec3 c = (tap(vec2(-1.0, -1.0)) + tap(vec2(1.0, -1.0)) + tap(vec2(-1.0, 1.0)) + tap(vec2(1.0, 1.0))) * 0.25;
  float b = max(c.r, max(c.g, c.b));
  float knee = uThreshold * 0.5;
  float soft = clamp(b - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-4);
  float w = max(soft, b - uThreshold) / max(b, 1e-4);
  fragColor = vec4(c * w, 1.0);
}`;

// dual-filter downsample (Marius Bjørge, "Bandwidth-efficient rendering")
const DOWN = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uTexel;
void main() {
  vec2 h = uTexel * 0.5;
  vec3 c = texture(uSrc, vUv).rgb * 4.0;
  c += texture(uSrc, vUv - h).rgb;
  c += texture(uSrc, vUv + h).rgb;
  c += texture(uSrc, vUv + vec2(h.x, -h.y)).rgb;
  c += texture(uSrc, vUv - vec2(h.x, -h.y)).rgb;
  fragColor = vec4(c / 8.0, 1.0);
}`;

const UP = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uTexel;
void main() {
  vec2 h = uTexel * 0.5;
  vec3 c = texture(uSrc, vUv + vec2(-h.x * 2.0, 0.0)).rgb;
  c += texture(uSrc, vUv + vec2(-h.x, h.y)).rgb * 2.0;
  c += texture(uSrc, vUv + vec2(0.0, h.y * 2.0)).rgb;
  c += texture(uSrc, vUv + vec2(h.x, h.y)).rgb * 2.0;
  c += texture(uSrc, vUv + vec2(h.x * 2.0, 0.0)).rgb;
  c += texture(uSrc, vUv + vec2(h.x, -h.y)).rgb * 2.0;
  c += texture(uSrc, vUv + vec2(0.0, -h.y * 2.0)).rgb;
  c += texture(uSrc, vUv + vec2(-h.x, -h.y)).rgb * 2.0;
  fragColor = vec4(c / 12.0, 1.0);
}`;

// glow only, re-encoded for the sRGB compositor
const COMPOSITE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform float uStrength;
vec3 encode(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
void main() {
  fragColor = vec4(encode(texture(uSrc, vUv).rgb * uStrength), 1.0);
}`;

interface Level { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number }

/** Returns null without WebGL2 or if the shaders don't build on this driver. */
export function createBloom(width: number, height: number): Bloom | null {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('webgl2', {
    alpha: false, depth: false, stencil: false, antialias: false, premultipliedAlpha: false,
  });
  if (!ctx) return null;
  const gl: WebGL2RenderingContext = ctx;
  // half-float levels keep the summed glow from clipping; RGBA8 still works
  // (the input is clipped sRGB anyway), just with a harder ceiling
  const halfFloat = !!gl.getExtension('EXT_color_buffer_float');

  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`ray-color bloom shader: ${gl.getShaderInfoLog(sh)}`);
    return sh;
  };
  let vert: WebGLShader;
  const link = (frag: string) => {
    const p = gl.createProgram()!;
    gl.attachShader(p, vert);
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, frag));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`ray-color bloom link: ${gl.getProgramInfoLog(p)}`);
    return p;
  };
  let prefilter: WebGLProgram, down: WebGLProgram, up: WebGLProgram, composite: WebGLProgram;
  try {
    vert = compile(gl.VERTEX_SHADER, VERT);
    prefilter = link(PREFILTER);
    down = link(DOWN);
    up = link(UP);
    composite = link(COMPOSITE);
  } catch (err) {
    console.warn(err);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return null;
  }

  // one oversized triangle covers the viewport
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const makeTex = () => {
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  const srcTex = makeTex();
  let levels: Level[] = [];
  let srcW = 0, srcH = 0;

  function resize(w: number, h: number) {
    for (const l of levels) { gl.deleteTexture(l.tex); gl.deleteFramebuffer(l.fbo); }
    levels = [];
    srcW = w; srcH = h;
    // the glow is soft by nature: half resolution is plenty for the output
    let lw = Math.max(1, w >> 1), lh = Math.max(1, h >> 1);
    canvas.width = lw;
    canvas.height = lh;
    while (levels.length < MAX_LEVELS && lw >= 4 && lh >= 4) {
      const tex = makeTex();
      if (halfFloat) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, lw, lh, 0, gl.RGBA, gl.HALF_FLOAT, null);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, lw, lh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      levels.push({ tex, fbo, w: lw, h: lh });
      lw >>= 1; lh >>= 1;
    }
  }

  const pass = (program: WebGLProgram, src: WebGLTexture, srcTexelW: number, srcTexelH: number, target: Level | null) => {
    gl.useProgram(program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, target ? target.w : canvas.width, target ? target.h : canvas.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src);
    gl.uniform1i(gl.getUniformLocation(program, 'uSrc'), 0);
    gl.uniform2f(gl.getUniformLocation(program, 'uTexel'), 1 / srcTexelW, 1 / srcTexelH);
    return program;
  };
  const draw = () => gl.drawArrays(gl.TRIANGLES, 0, 3);

  function render(source: TexImageSource, strength: number, threshold: number) {
    if (!levels.length) return;
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    // canvases are top-down; flip so uv (0,0) is bottom-left like the output
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.disable(gl.BLEND);

    const p = pass(prefilter, srcTex, srcW, srcH, levels[0]);
    gl.uniform1f(gl.getUniformLocation(p, 'uThreshold'), Math.max(0.001, threshold));
    draw();
    for (let i = 1; i < levels.length; i++) {
      pass(down, levels[i - 1].tex, levels[i - 1].w, levels[i - 1].h, levels[i]);
      draw();
    }
    // walk back up, adding each blurrier level onto the sharper one
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = levels.length - 1; i > 0; i--) {
      pass(up, levels[i].tex, levels[i].w, levels[i].h, levels[i - 1]);
      draw();
    }
    gl.disable(gl.BLEND);
    const c = pass(composite, levels[0].tex, levels[0].w, levels[0].h, null);
    gl.uniform1f(gl.getUniformLocation(c, 'uStrength'), strength / levels.length);
    draw();
  }

  function clear() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  function dispose() {
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  resize(width, height);
  return { canvas, render, resize, clear, dispose };
}
