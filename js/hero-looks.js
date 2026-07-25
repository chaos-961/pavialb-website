/* Hero look windows — the same model, five other outfits, seen through five
 * draggable panes cut into the campaign photo.
 *
 * How it works: assets/hero-look1..5 are the IDENTICAL frame to the hero shot
 * (same wall, same light, same pose to the pixel) with a different garment on
 * the model. Each one is stacked full-bleed over the hero at exactly the base
 * photo's geometry and then clipped down to a small rectangle, so all you see of
 * it is that window — and inside the window she's wearing another look. Drag a
 * window and it slides across her (the photo underneath stays put: the layer is
 * translated and its <img> is counter-translated by the same amount), then it
 * glides back to where it belongs.
 *
 * Everything lives inside [data-hero-frame], which is what app.js scales for the
 * scroll camera-push — so the windows, their borders and the photo zoom as one
 * piece and can never drift apart.
 *
 * Window placement is computed, not hardcoded in CSS: the hero photo is
 * object-fit:cover with a per-breakpoint object-position, so the same CSS
 * percentage lands somewhere different on the model at every viewport. FABRIC
 * says where her clothes are inside each SOURCE frame; this maps that through
 * the cover transform, intersects it with the part of the hero that's actually
 * on screen, and lays the windows out inside what's left.
 *
 * Decorative: the whole thing sits inside the aria-hidden backdrop, adds no
 * focusable nodes, and the hero is unchanged without it (no JS, reduced motion,
 * a viewport too small to hold the cluster, or the images failing to load).
 */
(function () {
  'use strict';

  var LOOKS = [1, 2, 3, 4, 5];

  /* Where the garment sits inside each source frame, as fractions of that frame.
     landscape = assets/hero-look*-1920 (1920x1280, model on the right);
     portrait  = assets/hero-look*-mobile (the 956x1707 crop of the same frame,
     where she fills most of the width). Measured from the pixels: the union of
     |look(n) - base| over all five looks is exactly her clothes, since nothing
     else in the frame changes. */
  var FABRIC = {
    landscape: { x: 0.725, y: 0.360, w: 0.205, h: 0.640 },
    // Tighter than the full silhouette on purpose: on the portrait crop her
    // widest points are the raised arms and the flare of the skirt, and a rect
    // that reached those would hang windows out over bare wall — where a look
    // pane shows nothing at all, since the wall is identical in all six frames.
    portrait: { x: 0.415, y: 0.360, w: 0.545, h: 0.640 },
  };

  /* Window layout, in fractions of the usable canvas (see canvasFor). Tall
     panes, not wide ones — a vertical cut follows the line of a dress far better
     than a horizontal band, which reads as a stripe laid across her. They're
     scattered rather than aligned: widths vary, each hangs from its own height,
     and they overlap, so the five together read as one collage of the same woman
     in five outfits. */
  var WINDOWS = {
    landscape: [
      { x: 0.00, y: 0.02, w: 0.40, h: 0.50 },
      { x: 0.30, y: 0.00, w: 0.40, h: 0.44 },
      { x: 0.60, y: 0.08, w: 0.40, h: 0.52 },
      { x: 0.12, y: 0.46, w: 0.42, h: 0.54 },
      { x: 0.50, y: 0.52, w: 0.44, h: 0.48 },
    ],
    // Phone: the clear ground is the band between the last line of copy and the
    // CTAs — wide but short — so the tall panes stand side by side across her
    // hips, each dropped to its own height, like swatches hung in a row.
    portrait: [
      { x: 0.00, y: 0.04, w: 0.30, h: 0.88 },
      { x: 0.19, y: 0.00, w: 0.28, h: 0.82 },
      { x: 0.37, y: 0.10, w: 0.30, h: 0.90 },
      { x: 0.56, y: 0.02, w: 0.28, h: 0.84 },
      { x: 0.72, y: 0.12, w: 0.28, h: 0.88 },
    ],
  };

  /* Insets that keep the cluster inside the part of the hero a visitor can see
     and won't fight with. Landscape only has to clear the sticky header and the
     seam where the page sheet slides up. Portrait sets `band`: on a phone she
     fills the frame, so instead of a fixed inset the canvas is squeezed into the
     gap the copy leaves — measured live off .hero-text and .hero-actions, which
     move with the headline's length and the viewport's height. */
  var MARGIN = {
    landscape: { top: 80, right: 16, bottom: 44, left: 0 },
    portrait: { top: 12, right: 10, bottom: 76, left: 8, band: true },
  };

  var MIN_CANVAS = 130;   // below this the cluster reads as confetti — stay out

  /* Feel. Ported from the bssaub perk-field bubbles, minus the physics engine:
     a grab that follows with a little lag, a hard ceiling on how far a window
     can travel, and a fixed-duration glide home from wherever you let go (a
     spring would land fast from far and slow from near — this lands the same
     every time, which is what "it goes back" should feel like). */
  var GRAB_FOLLOW = 0.34;   // fraction of the pointer gap closed per 60fps step
  var CLAMP = { fine: 96, coarse: 58 };  // max travel from home, px
  var RETURN_MS = 760;
  var DRIFT_PX = 3.5;       // idle breathing so they read as grabbable
  var DRIFT_MS = 9000;
  var TOUCH_SLOP = 7;       // px of horizontal intent before a touch drag starts

  var hero = document.querySelector('[data-hero]');
  var frame = document.querySelector('[data-hero-frame]');
  if (!hero || !frame || !window.matchMedia) return;

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  var portraitQ = window.matchMedia('(max-width: 959px) and (orientation: portrait)');
  var coarseQ = window.matchMedia('(pointer: coarse)');

  var paneWrap = document.createElement('div');
  paneWrap.className = 'hero-looks';
  var edgeWrap = document.createElement('div');
  edgeWrap.className = 'hero-look-edges';

  // Panes go under the wash (so the warm scrim falls on them exactly as it falls
  // on the base photo — otherwise a window's fill would read a shade brighter
  // than the wall around it); the borders go over it, and they're the hit target.
  frame.appendChild(paneWrap);
  frame.appendChild(edgeWrap);

  var panes = LOOKS.map(function (n, i) {
    var pane = document.createElement('div');
    pane.className = 'hero-look';
    pane.innerHTML =
      '<picture>' +
        '<source type="image/webp" media="(max-width: 959px) and (orientation: portrait)"' +
        ' data-srcset="assets/hero-look' + n + '-mobile.webp">' +
        '<source type="image/avif" data-srcset="assets/hero-look' + n + '-1920.avif">' +
        '<source type="image/webp" data-srcset="assets/hero-look' + n + '-1920.webp">' +
        '<img alt="" decoding="async" fetchpriority="low"' +
        ' data-src="assets/hero-look' + n + '-1920.webp">' +
      '</picture>';
    paneWrap.appendChild(pane);

    var edge = document.createElement('div');
    edge.className = 'hero-look-edge';
    edge.style.setProperty('--i', String(i));
    edgeWrap.appendChild(edge);

    return {
      pane: pane,
      img: pane.querySelector('img'),
      edge: edge,
      rect: null,          // home window in frame-local px
      dx: 0, dy: 0,        // current offset from home
      grab: null,          // { id, px, py, tx, ty }
      ret: null,           // { fx, fy, t0 }
      phase: i * 1.7,      // idle drift offset, so they don't breathe in unison
    };
  });

  /* ---------- geometry ---------- */

  // Where an (u, v) point of the SOURCE image lands inside the frame, given
  // object-fit:cover and the object-position CSS resolves to. Returns a mapper
  // rather than a matrix so callers can map rects in one pass.
  function coverMapper(nat, box, pos) {
    var s = Math.max(box.w / nat.w, box.h / nat.h);
    var dw = nat.w * s;
    var dh = nat.h * s;
    var ox = (box.w - dw) * pos.x;
    var oy = (box.h - dh) * pos.y;
    return function (u, v) { return { x: ox + u * dw, y: oy + v * dh }; };
  }

  // object-position for the hero photo, mirroring css/styles.css. Read off the
  // element instead of duplicating the breakpoints, so retuning the crop there
  // moves the windows with it.
  function objectPosition(img) {
    var raw = window.getComputedStyle(img).objectPosition.split(' ');
    var pct = function (v) {
      var n = parseFloat(v);
      return v.indexOf('%') >= 0 && isFinite(n) ? n / 100 : 0.5;
    };
    return { x: pct(raw[0] || '50%'), y: pct(raw[1] || raw[0] || '50%') };
  }

  // The horizontal band the copy leaves free on a phone: under the paragraph,
  // above the CTAs. Measured rather than assumed — the copy column is sized in
  // vw, the headline wraps to two or three lines depending on the word, and the
  // CTAs are bottom-anchored, so a hardcoded inset would be wrong on half the
  // phones out there.
  function copyBand(boxH) {
    var h = hero.getBoundingClientRect();
    var text = hero.querySelector('.hero-text');
    var acts = hero.querySelector('.hero-actions');
    return {
      top: text ? text.getBoundingClientRect().bottom - h.top + 14 : 0,
      bottom: acts ? acts.getBoundingClientRect().top - h.top - 14 : boxH,
    };
  }

  // The canvas: her clothes, cropped to what's on screen and clear of the copy.
  function canvasFor(baseImg) {
    var box = { w: frame.offsetWidth, h: frame.offsetHeight };
    if (!box.w || !box.h || !baseImg.naturalWidth) return null;

    // Which crop is on screen comes from the IMAGE, not from re-running the
    // <source> media query: after a resize some engines keep the crop they
    // already picked, and guessing wrong here would map her clothes to the wrong
    // half of the frame. The two crops are 1.50 and 0.56 aspect, so the picture
    // itself is unambiguous — and the panes carry the same <source> list as the
    // base, so whatever it resolved to, they resolved to as well.
    var portrait = baseImg.naturalWidth < baseImg.naturalHeight;
    var fab = portrait ? FABRIC.portrait : FABRIC.landscape;
    var m = portrait ? MARGIN.portrait : MARGIN.landscape;
    var map = coverMapper(
      { w: baseImg.naturalWidth, h: baseImg.naturalHeight },
      box,
      objectPosition(baseImg),
    );

    var a = map(fab.x, fab.y);
    var b = map(fab.x + fab.w, fab.y + fab.h);
    var band = m.band ? copyBand(box.h) : null;
    var left = Math.max(a.x, m.left);
    var top = Math.max(a.y, m.top, band ? band.top : 0);
    var right = Math.min(b.x, box.w - m.right);
    var bottom = Math.min(b.y, box.h - m.bottom, band ? band.bottom : Infinity);
    var c = { x: left, y: top, w: right - left, h: bottom - top };
    return c.w >= MIN_CANVAS && c.h >= MIN_CANVAS ? c : null;
  }

  function layout(baseImg) {
    var c = canvasFor(baseImg);
    hero.classList.toggle('has-looks', !!c);
    if (!c) return false;
    var spec = baseImg.naturalWidth < baseImg.naturalHeight ? WINDOWS.portrait : WINDOWS.landscape;
    panes.forEach(function (p, i) {
      var w = spec[i];
      p.rect = {
        x: Math.round(c.x + w.x * c.w),
        y: Math.round(c.y + w.y * c.h),
        w: Math.round(w.w * c.w),
        h: Math.round(w.h * c.h),
      };
      writeRect(p);
      writeOffset(p);
    });
    return true;
  }

  // The window's home box — the clip rectangle and the border that traces it.
  // Only changes on layout, so it's kept out of the animation loop.
  function writeRect(p) {
    var r = p.rect;
    if (!r) return;
    [p.pane.style, p.edge.style].forEach(function (s) {
      s.setProperty('--wx', r.x + 'px');
      s.setProperty('--wy', r.y + 'px');
      s.setProperty('--ww', r.w + 'px');
      s.setProperty('--wh', r.h + 'px');
    });
  }

  // The per-frame part: how far the window has slid from home. Four property
  // writes, and only when the whole-pixel value actually moved — the idle drift
  // runs for as long as the hero is on screen, so this is the one thing in here
  // that has to stay cheap. The pane's <img> takes the inverse slide (in CSS),
  // which is what keeps the photograph nailed down while its window travels.
  function writeOffset(p) {
    var dx = Math.round(p.dx);
    var dy = Math.round(p.dy);
    if (dx === p.lastX && dy === p.lastY) return;
    p.lastX = dx;
    p.lastY = dy;
    p.pane.style.setProperty('--dx', dx + 'px');
    p.pane.style.setProperty('--dy', dy + 'px');
    p.edge.style.setProperty('--dx', dx + 'px');
    p.edge.style.setProperty('--dy', dy + 'px');
  }

  /* ---------- motion ---------- */

  var running = false;
  var onScreen = true;    // hero intersecting the viewport
  var tabVisible = !document.hidden;
  var last = 0;
  var t = 0;

  function clampRadius() { return coarseQ.matches ? CLAMP.coarse : CLAMP.fine; }

  function clampOffset(p) {
    var r = clampRadius();
    var d = Math.hypot(p.dx, p.dy);
    if (d > r) {
      p.dx = (p.dx / d) * r;
      p.dy = (p.dy / d) * r;
    }
  }

  function smoothstep(x) { return x * x * (3 - 2 * x); }

  function tick(now) {
    if (!running) return;
    var dt = last ? Math.min(64, now - last) : 16;
    last = now;
    t += dt;
    var step = dt / 16.6667;      // grab easing is per-60fps-step, not per-ms
    var busy = false;

    panes.forEach(function (p) {
      if (!p.rect) return;
      // Where this window would be sitting if nobody had touched it: a slow
      // lissajous a few pixels wide. Enough to read as "this moves", small
      // enough that it never looks like a glitch.
      var a = (t / DRIFT_MS) * Math.PI * 2 + p.phase;
      var driftX = reduced.matches ? 0 : Math.cos(a) * DRIFT_PX;
      var driftY = reduced.matches ? 0 : Math.sin(a * 0.7) * DRIFT_PX * 0.6;

      if (p.grab) {
        var k = 1 - Math.pow(1 - GRAB_FOLLOW, step);
        p.dx += (p.grab.tx - p.dx) * k;
        p.dy += (p.grab.ty - p.dy) * k;
        clampOffset(p);
        busy = true;
      } else if (p.ret) {
        // Home is the DRIFT position, not zero: landing on a hard zero and then
        // handing back to a drift that's mid-swing puts a visible hop at the end
        // of every release.
        var e = smoothstep(Math.min(1, (now - p.ret.t0) / RETURN_MS));
        p.dx = p.ret.fx + (driftX - p.ret.fx) * e;
        p.dy = p.ret.fy + (driftY - p.ret.fy) * e;
        if (e >= 1) p.ret = null;
        busy = true;
      } else if (!reduced.matches) {
        p.dx = driftX;
        p.dy = driftY;
        busy = true;
      }
      writeOffset(p);
    });

    if (busy) requestAnimationFrame(tick);
    else running = false;
  }

  function start() {
    if (running || !onScreen || !tabVisible) return;
    if (!panes.some(function (p) { return p.rect; })) return;
    running = true;
    last = 0;
    requestAnimationFrame(tick);
  }

  /* ---------- drag ---------- */

  function release(p) {
    if (!p.grab) return;
    p.grab = null;
    p.edge.classList.remove('is-held');
    if (reduced.matches) { p.dx = 0; p.dy = 0; writeOffset(p); return; }
    p.ret = { fx: p.dx, fy: p.dy, t0: performance.now() };
    start();
  }

  function bind(p) {
    var pending = null;   // touch: waiting to see if this is a drag or a scroll

    function begin(ev) {
      p.ret = null;
      p.grab = { id: ev.pointerId, px: ev.clientX, py: ev.clientY, tx: p.dx, ty: p.dy };
      p.edge.classList.add('is-held');
      start();
    }

    p.edge.addEventListener('pointerdown', function (ev) {
      if (reduced.matches || !p.rect || ev.button > 0) return;
      // Capture from the first contact either way, so the moves that decide
      // "drag or scroll?" still reach us if the finger slides off the box.
      // Capturing does NOT claim the gesture — touch-action does — so the page
      // can still take it and send us a pointercancel.
      try { p.edge.setPointerCapture(ev.pointerId); } catch (err) { /* not capturable */ }
      if (ev.pointerType === 'touch') {
        // Don't steal the gesture yet. touch-action:pan-y means a vertical swipe
        // still scrolls the page (this hero has form: two releases went to fixing
        // scroll dead zones), so a window only becomes a drag once the finger has
        // committed sideways.
        pending = { id: ev.pointerId, x: ev.clientX, y: ev.clientY };
        return;
      }
      ev.preventDefault();
      begin(ev);
    });

    p.edge.addEventListener('pointermove', function (ev) {
      if (pending && ev.pointerId === pending.id) {
        var mx = ev.clientX - pending.x;
        var my = ev.clientY - pending.y;
        if (Math.abs(mx) > TOUCH_SLOP && Math.abs(mx) > Math.abs(my)) {
          pending = null;
          begin(ev);
        } else if (Math.abs(my) > TOUCH_SLOP) {
          // It's a scroll — hands off, and give the capture back so nothing
          // about this gesture is ours any more.
          pending = null;
          try { p.edge.releasePointerCapture(ev.pointerId); } catch (err) { /* gone */ }
        }
        return;
      }
      if (!p.grab || ev.pointerId !== p.grab.id) return;
      ev.preventDefault();
      // Pointer deltas are in screen px; the frame is scaled by the scroll
      // camera-push, so divide back into frame-local px or the window lags the
      // finger once the visitor has scrolled.
      var scale = frame.getBoundingClientRect().width / (frame.offsetWidth || 1);
      p.grab.tx += (ev.clientX - p.grab.px) / (scale || 1);
      p.grab.ty += (ev.clientY - p.grab.py) / (scale || 1);
      p.grab.px = ev.clientX;
      p.grab.py = ev.clientY;
      start();
    });

    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (type) {
      p.edge.addEventListener(type, function (ev) {
        if (pending && ev.pointerId === pending.id) {
          pending = null;
          try { p.edge.releasePointerCapture(ev.pointerId); } catch (err) { /* gone */ }
        }
        if (p.grab && ev.pointerId === p.grab.id) release(p);
      });
    });
  }

  /* ---------- wiring ---------- */

  var baseImg = frame.querySelector('[data-hero-bg]');
  if (!baseImg) return;

  function relayout() {
    if (layout(baseImg)) start();
  }

  var resizeTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(relayout, 150);
  });
  window.addEventListener('orientationchange', function () { setTimeout(relayout, 250); });
  if (portraitQ.addEventListener) portraitQ.addEventListener('change', relayout);
  // A crop swap (rotate a phone, resize past 959px) re-fires load on the base
  // <img> with a new intrinsic size — the windows have to be re-measured against
  // the new frame or they'd still be sitting where the old one put her.
  baseImg.addEventListener('load', relayout);
  // The phone band is measured off the copy, and the copy reflows when the web
  // fonts land — measure again once they have.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayout).catch(function () {});

  // Only animate while the hero is on screen and the tab is in front — the idle
  // drift never finishes on its own, and a rAF running behind the shop grid (or
  // in a background tab) is pure battery.
  if (window.IntersectionObserver) {
    new IntersectionObserver(function (entries) {
      onScreen = entries[0].isIntersecting;
      start();
    }, { threshold: 0 }).observe(hero);
  }
  document.addEventListener('visibilitychange', function () {
    tabVisible = !document.hidden;
    start();
  });

  // Load the look frames only after everything else has landed: they're five
  // extra copies of the hero photo and must never compete with the real one for
  // the LCP. ~16-27 KB each as AVIF, so this is a cheap tail, not a second hero.
  var loaded = false;
  function loadPanes() {
    if (loaded) return;
    loaded = true;
    panes.forEach(function (p, i) {
      p.pane.querySelectorAll('source').forEach(function (s) {
        s.srcset = s.dataset.srcset;
        s.removeAttribute('data-srcset');
      });
      // Stagger the fade-in so the five looks arrive as a sequence rather than
      // all blinking on together.
      p.img.addEventListener('load', function () {
        setTimeout(function () { p.pane.classList.add('is-in'); p.edge.classList.add('is-in'); }, i * 110);
      });
      p.img.addEventListener('error', function () {
        p.pane.remove();
        p.edge.remove();
        p.rect = null;
      });
      p.img.src = p.img.dataset.src;
      p.img.removeAttribute('data-src');
    });
  }

  function boot() {
    panes.forEach(bind);
    relayout();
  }

  if (baseImg.complete && baseImg.naturalWidth) boot();
  else baseImg.addEventListener('load', boot, { once: true });

  // The hero photo is the LCP; the look frames wait for it and everything else.
  if (document.readyState === 'complete') setTimeout(function () { relayout(); loadPanes(); }, 0);
  else window.addEventListener('load', function () { setTimeout(function () { relayout(); loadPanes(); }, 0); });
})();
