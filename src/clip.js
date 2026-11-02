// A short walkthrough of real dreamDEX screens: a cursor moves to what you need, presses it and the
// caption says what happened. It plays while on screen, stops when paused, and with reduced motion
// each screen is shown still, one press at a time.
function startClips() {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  for (const clip of document.querySelectorAll('.clip')) {
    const scenes = JSON.parse(clip.dataset.scenes);
    const screen = clip.querySelector('.clip__screen'), img = clip.querySelector('img'), cursor = clip.querySelector('.clip__cursor');
    const ring = clip.querySelector('.clip__ring'), caption = clip.querySelector('.clip__caption'), toggle = clip.querySelector('button');
    let index = 0, paused = reduced, seen = false, x = 70, y = 92;
    for (const s of new Set(scenes.map((s) => s.src))) new Image().src = s;
    const place = (px, py) => { cursor.style.left = px + '%'; cursor.style.top = py + '%'; };
    const mark = (s) => { ring.style.left = s.x + '%'; ring.style.top = s.y + '%'; };
    const show = async (s, instant) => {
      ring.classList.remove('on');
      if (!instant) await img.animate({ opacity: [1, 0] }, { duration: 120, fill: 'forwards' }).finished;
      img.src = s.src;
      screen.style.setProperty('--ar', s.ar);
      caption.textContent = s.text;
      if (!instant) img.animate({ opacity: [0, 1] }, { duration: 180, fill: 'forwards' });
    };
    // Eased, and bowed slightly so the cursor travels on an arc like a hand does.
    const move = (s) => {
      const box = screen.getBoundingClientRect(), dx = ((s.x - x) / 100) * box.width, dy = ((s.y - y) / 100) * box.height;
      const bow = 0.12 * Math.hypot(dx, dy);
      return cursor.animate([{ transform: 'translate(0, 0)' }, { transform: `translate(${dx * 0.55 + bow * 0.4}px, ${dy * 0.55 - bow}px)`, offset: 0.55 }, { transform: `translate(${dx}px, ${dy}px)` }], { duration: 800, easing: 'cubic-bezier(.45, 0, .2, 1)', fill: 'forwards' }).finished.then((a) => { place(s.x, s.y); x = s.x; y = s.y; a.cancel(); });
    };
    const press = async (s) => {
      mark(s);
      await cursor.animate({ scale: [1, 0.82, 1] }, { duration: 200, easing: 'ease-out' }).finished;
      ring.classList.add('on');
    };
    const ready = async () => { while (paused || !seen) await sleep(120); };
    async function play() {
      await show(scenes[0], true);
      place(x, y);
      for (;;) {
        await ready();
        const s = scenes[index];
        await sleep(350);
        await ready();
        await move(s);
        await sleep(160); // a beat before the press, so the eye gets there first
        await press(s);
        await sleep(s.hold ?? 1300);
        await ready();
        index = (index + 1) % scenes.length;
        if (index === 0) {
          await sleep(900);
          x = 70;
          y = 92;
          place(x, y);
        }
        await show(scenes[index]);
      }
    }
    new IntersectionObserver(([e]) => (seen = e.isIntersecting)).observe(clip);
    if (reduced) {
      const still = () => { const s = scenes[index]; show(s, true); place(s.x, s.y); mark(s); ring.classList.add('on'); };
      toggle.textContent = 'Next';
      toggle.onclick = () => { index = (index + 1) % scenes.length; still(); };
      still();
    } else {
      toggle.onclick = () => { paused = !paused; toggle.textContent = paused ? 'Play' : 'Pause'; };
      play();
    }
  }
}
startClips();
