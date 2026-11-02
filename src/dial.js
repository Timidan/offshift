// The hero: a twelve-hour dial drawn in points. The rim is gold from now to the end time you set, and
// the rest of it, the hours you are off, blows away as dust. Change the end time and the gold follows.
function startDial(canvas, stage) {
  const gl = canvas.getContext('webgl', { alpha: true, antialias: false, premultipliedAlpha: false });
  if (!gl) return () => {};
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const TAU = Math.PI * 2;
  const HOURS = 12 * 3_600_000;

  let state = 524287;
  const rnd = () => (state = (state * 16807) % 2147483647) / 2147483647;

  // Kinds: 0 face and case, 1 gold seam, 2 hour tick, 3 hour hand, 4 end-time hand, 5 rim.
  // Angles run clockwise from twelve; the hands are built pointing at twelve and turned in the shader.
  function build(count) {
    const out = new Float32Array(count * 12);
    const put = (i, p, n, drift, kind, theta) => out.set([...p, ...n, ...drift, kind, theta, rnd()], i * 12);
    const none = [0, 0, 0], flat = [0, 0, 1];
    for (let i = 0; i < count; i++) {
      const part = rnd(), theta = rnd() * TAU, s = Math.sin(theta), c = Math.cos(theta);
      if (part < 0.42) {
        const r = Math.sqrt(rnd()) * 0.97;
        put(i, [r * s, r * c, -0.16 * (1 - r * r)], [0.8 * r * s, 0.8 * r * c, 1], none, 0, theta);
      } else if (part < 0.54) {
        put(i, [1.06 * s, 1.06 * c, -rnd() * 0.26], [s, c, 0], none, 0, theta);
      } else if (part < 0.96) {
        const f = rnd(), reach = 0.4 + 1.9 * f * f, drift = [(s * 0.35 + 1.15) * reach, (c * 0.35 + 0.5) * reach, -0.5 - (0.5 + rnd()) * reach]; // behind the face, so it never crosses the clock
        if (part < 0.885) {
          const a = rnd() * TAU, r = 1 + 0.06 * Math.cos(a);
          put(i, [r * s, r * c, 0.06 * Math.sin(a)], [Math.cos(a) * s, Math.cos(a) * c, Math.sin(a)], drift, 5, theta);
        } else {
          const r = 0.93 + (rnd() - 0.5) * 0.022;
          put(i, [r * s, r * c, 0.055], flat, drift, 1, theta);
        }
      } else if (part < 0.982) {
        const h = Math.floor(rnd() * 12), at = (h / 12) * TAU, major = h % 3 === 0;
        const r = 0.88 - rnd() * (major ? 0.14 : 0.07), w = (rnd() - 0.5) * (major ? 0.028 : 0.014);
        put(i, [r * Math.sin(at) + w * Math.cos(at), r * Math.cos(at) - w * Math.sin(at), -0.03], flat, none, 2, at);
      } else if (part < 0.992) {
        const y = rnd() * 0.84;
        put(i, [(rnd() - 0.5) * 0.018 * (1 - y * 0.6), y, 0.05], flat, none, 4, 0);
      } else {
        const y = rnd() * 0.52;
        put(i, [(rnd() - 0.5) * 0.034 * (1 - y), y, 0.04], flat, none, 3, 0);
      }
    }
    return out;
  }

  const vertex = `
attribute vec3 aPos, aNormal, aDrift, aMeta;
uniform float uYaw, uPitch, uScale, uSize, uTime, uFrom, uSpan;
uniform vec2 uCentre, uRes;
varying vec4 vColor;
const float TAU = 6.2831853;
void main() {
  float kind = aMeta.x, grain = aMeta.z;
  vec3 p = aPos;
  if (kind > 2.5 && kind < 4.5) {
    float a = kind > 3.5 ? uFrom + uSpan : uFrom;
    p.xy = vec2(p.x * cos(a) + p.y * sin(a), p.y * cos(a) - p.x * sin(a));
  }
  bool seam = kind > 0.5 && kind < 1.5, rim = kind > 4.5;
  float k = seam || rim ? smoothstep(uSpan, uSpan + 0.18 + grain * 0.5, mod(aMeta.y - uFrom, TAU)) : 0.0;
  p += aDrift * k * k + 0.025 * k * vec3(sin(uTime * 0.7 + grain * 40.0), cos(uTime * 0.5 + grain * 60.0), sin(uTime * 0.4 + grain * 90.0));
  float ca = cos(uYaw), sa = sin(uYaw), cb = cos(uPitch), sb = sin(uPitch);
  vec3 q = vec3(ca * p.x + sa * p.z, p.y, -sa * p.x + ca * p.z);
  q = vec3(q.x, cb * q.y - sb * q.z, sb * q.y + cb * q.z);
  vec3 n = vec3(ca * aNormal.x + sa * aNormal.z, aNormal.y, -sa * aNormal.x + ca * aNormal.z);
  n = vec3(n.x, cb * n.y - sb * n.z, sb * n.y + cb * n.z);
  float light = pow(max(dot(normalize(n), normalize(vec3(-0.5, 0.7, 0.55))), 0.0), 1.5);
  float depth = 1.0 / (1.0 - q.z * 0.1);
  vec2 s = uCentre + uScale * q.xy * depth;
  gl_Position = vec4(s / uRes * 2.0 - 1.0, -q.z * 0.4, 1.0);
  vec3 gold = vec3(0.89, 0.72, 0.38) + (grain - 0.5) * 0.2;
  vec3 c = mix(vec3(0.03, 0.08, 0.095), vec3(0.2, 0.33, 0.35), light) + (grain - 0.5) * 0.07;
  if (rim) c = mix(mix(vec3(0.08, 0.17, 0.19), vec3(0.56, 0.72, 0.73), light) + (grain - 0.5) * 0.09, mix(vec3(0.22, 0.36, 0.38), gold, step(0.86, grain)), k);
  else if (seam || kind > 3.5 && kind < 4.5) c = gold;
  else if (kind > 1.5 && kind < 3.5) c = vec3(0.92, 0.91, 0.86) + (grain - 0.5) * 0.12;
  gl_PointSize = uSize * depth * (seam || kind > 3.5 && kind < 4.5 ? 1.35 : 1.0);
  vColor = vec4(c, 1.0 - k * 0.45);
}`;

  const fragment = `
precision mediump float;
varying vec4 vColor;
void main() {
  if (length(gl_PointCoord - 0.5) > 0.5) discard;
  gl_FragColor = vColor;
}`;

  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  gl.useProgram(program);

  const count = innerWidth < 720 ? 70000 : 180000;
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, build(count), gl.STATIC_DRAW);
  ['aPos', 'aNormal', 'aDrift', 'aMeta'].forEach((name, i) => {
    const at = gl.getAttribLocation(program, name);
    gl.enableVertexAttribArray(at);
    gl.vertexAttribPointer(at, 3, gl.FLOAT, false, 48, i * 12);
  });
  const u = Object.fromEntries(['uYaw', 'uPitch', 'uScale', 'uSize', 'uTime', 'uFrom', 'uSpan', 'uCentre', 'uRes'].map((n) => [n, gl.getUniformLocation(program, n)]));
  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);
  gl.uniform1f(u.uPitch, -0.5);

  let from = 0, span = TAU, goal = TAU, frame = 0, last = 0;

  const layout = () => {
    const dpr = Math.min(devicePixelRatio, 2), box = canvas.getBoundingClientRect(), area = stage.getBoundingClientRect();
    canvas.width = box.width * dpr;
    canvas.height = box.height * dpr;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(u.uRes, canvas.width, canvas.height);
    gl.uniform2f(u.uCentre, (area.left - box.left + area.width / 2) * dpr, (box.bottom - area.top - area.height * 0.5) * dpr);
    gl.uniform1f(u.uScale, Math.min(area.width * 0.3, area.height * 0.42) * dpr);
    gl.uniform1f(u.uSize, 1.7 * dpr);
  };
  const draw = (ms) => {
    gl.uniform1f(u.uTime, ms / 1000);
    gl.uniform1f(u.uFrom, from);
    gl.uniform1f(u.uSpan, span);
    gl.uniform1f(u.uYaw, reduced ? -0.3 : -0.3 + 0.14 * Math.sin(ms * 0.00017));
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.drawArrays(gl.POINTS, 0, count);
  };
  const loop = (ms) => {
    span += (goal - span) * (1 - Math.exp(-Math.min(ms - last, 100) * 0.0035));
    last = ms;
    draw(ms);
    frame = requestAnimationFrame(loop);
  };
  const refresh = () => {
    layout();
    if (reduced) draw(0);
  };
  addEventListener('resize', refresh);
  document.fonts?.ready.then(refresh);
  layout();
  if (!reduced) {
    new IntersectionObserver(([entry]) => {
      cancelAnimationFrame(frame);
      if (entry.isIntersecting) frame = requestAnimationFrame(loop);
    }).observe(canvas);
  }

  return (end) => {
    const d = new Date();
    from = (((d.getHours() % 12) + d.getMinutes() / 60) / 12) * TAU;
    goal = Math.min((end - Date.now()) / HOURS, 1) * TAU;
    if (!reduced) return;
    span = goal;
    draw(0);
  };
}
