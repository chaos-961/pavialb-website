/* Hero look windows — the same model, five other outfits, seen through five
 * draggable panes cut into the campaign photo.
 *
 * How it works: assets/hero-look1..5 are the IDENTICAL frame to the hero shot
 * (same wall, same light, same pose to the pixel) with a different garment on
 * the model. Each one is stacked full-bleed over the hero at exactly the base
 * photo's geometry and then clipped down to a small rectangle, so all you see of
 * it is that window — and inside the window she's wearing another look. Drag a
 * window and it slides across her (the photo underneath stays put: the layer is
 * translated and its <img> is counter-translated by the same amount) anywhere on
 * the figure, then springs back to its seat the moment you let go.
 *
 * Left alone, the collage keeps rearranging itself: every SWAP_WAIT the windows
 * trade seats, gliding along a shallow arc into each other's rectangle over
 * SWAP_MS. Because a swap is a PERMUTATION of a fixed set of seats, the resting
 * layout is always the one the packer validated — the choreography can never
 * deal a bad arrangement, only re-deal which look sits where.
 *
 * Everything lives inside [data-hero-frame], which is what app.js scales for the
 * scroll camera-push — so the windows, their borders and the photo zoom as one
 * piece and can never drift apart.
 *
 * Placement is packed at runtime, not hardcoded: the hero photo is
 * object-fit:cover with a per-breakpoint object-position, so one fixed CSS
 * percentage lands somewhere different on the model at every viewport. Instead,
 * SILHOUETTE (measured off the pixels) says where her clothes are in the master
 * frame; that's mapped through the live cover transform, intersected with the
 * part of the hero on screen and clear of the copy, and the panes are laid into
 * what's left — on her, overlapping like stacked prints, in a fresh arrangement
 * every visit, and never in a shape too thin to read as a window (see SHAPE).
 *
 * Decorative: the whole thing sits inside the aria-hidden backdrop, adds no
 * focusable nodes, and the hero is unchanged without it (no JS, reduced motion,
 * a viewport too small to hold the cluster, or the images failing to load).
 */
(function () {
  'use strict';

  var LOOKS = [1, 2, 3, 4, 5];

  /* Her outline, measured off the pixels rather than guessed: for each horizontal
     band of the master frame, the left and right edge of the garment. Taken from
     |look(n) - base| across all five looks (3rd/97th percentile of the pixels
     that changed in at least two of them) — nothing in these frames differs
     except her clothes, so the diff IS the silhouette.

     This is why a single rectangle wasn't enough: she is 0.755-0.887 wide at the
     chest and 0.661-0.869 at the hem, so a box sized for one height hangs over
     bare wall at another — and a pane over bare wall shows nothing at all, since
     the wall is identical in all six frames. Cells get clipped to these bounds at
     their own height instead.
     Reprint this table with `py scripts/gen-look-images.py --silhouette` — it
     reads the shipped derivatives, so it still works after the masters are gone,
     and it MUST be rerun if the campaign photo is ever replaced. */
  var BAND = 0.03;   // each row spans this much of the master's height
  var SILHOUETTE = [
    [0.340, 0.623, 0.840], [0.370, 0.755, 0.887], [0.400, 0.752, 0.889],
    [0.430, 0.748, 0.858], [0.460, 0.744, 0.861], [0.490, 0.741, 0.863],
    [0.520, 0.729, 0.863], [0.550, 0.755, 0.857], [0.580, 0.753, 0.864],
    [0.610, 0.749, 0.874], [0.640, 0.744, 0.882], [0.670, 0.740, 0.888],
    [0.700, 0.733, 0.895], [0.730, 0.723, 0.893], [0.760, 0.710, 0.885],
    [0.790, 0.697, 0.881], [0.820, 0.686, 0.877], [0.850, 0.675, 0.875],
    [0.880, 0.666, 0.873], [0.910, 0.661, 0.869], [0.940, 0.661, 0.866],
    [0.970, 0.661, 0.863],
  ];

  /* The portrait derivative is this rect of the master, in master pixels — the
     numbers scripts/gen-look-images.py cuts hero-look*-mobile.webp with. Both
     crops therefore share one coordinate system, so SILHOUETTE is stated once. */
  var PORTRAIT_CROP = { x: 1058.73, y: -3.36, w: 719.28, h: 1284.32 };
  var MASTER = { w: 1920, h: 1280 };

  /* ---------- what makes a window worth showing ----------
     Every rule below exists because breaking it produced a box that showed
     nothing: a sliver, a letterbox, a stamp, or a rectangle sitting on the bare
     wall (where all six frames are identical, so the window is invisible).

     Aspect is bounded on BOTH sides. An earlier version only had a "taller than
     wide" floor, so a narrow-tall grid cell produced a 50x210 splinter — that
     was the phone bug where two of the five read as thin rectangles showing
     nothing. A window now always sits inside one of two shape bands. */
  var TALL = { min: 1.26, max: 1.78 };   // h/w — an upright cut, follows a dress
  var WIDE = { min: 0.58, max: 0.76 };   // h/w — a landscape cut, for rhythm
  var WIDE_CELL = 1.25;   // only cells at least this flat are dealt a wide pane —
                          //   forcing one into a tall cell is how you get a
                          //   letterbox sliver instead of a window
  var N_WIDE = 2;         // at most this many go horizontal

  /* Size floor, stated as SHORT and LONG side so it holds for both orientations
     at once (a "min width x min height" pair only ever constrains one of them).
     Below this a pane is a smear of fabric rather than an outfit.

     It is a FRACTION OF HER, capped and floored, not a number of pixels tied to
     a breakpoint. Viewport width is the wrong axis and measurably so: the
     landscape crop is zoomed further out on a 1024px tablet than the portrait
     crop is on a 390px phone, so she lands the same ~243x435 on both — yet a
     `box.w < 960` rule handed the tablet the bigger floor and squeezed it down
     to two windows. What a window has to clear is a share of the figure it is
     cut from; measure her, not the browser.

     CAP is what a window is worth on a roomy desktop and never more. BOTTOM is
     where it stops shrinking: below that it's a stamp at any size. Between them
     it just tracks her. Shape is guaranteed separately (TALL/WIDE), so a small
     window is still a window — proportionate, on her, showing a real piece of
     the outfit, just smaller because she is. */
  var SHARE = { w: 0.26, h: 0.21 };      // of her on-screen figure
  var CAP = { short: 78, long: 106 };
  var BOTTOM = { short: 58, long: 78 };
  var NARROW = 260;       // a figure thinner than this gets no landscape cuts.
                          //   Phones land ~244 and tablets ~283, so the split is
                          //   clear of both rather than sitting on either.
  /* Fewer seats than this and it isn't a collage. Two is the floor rather than
     three because a benched look now takes its turn in a seat every few swaps
     (see rotateIn): on a rotated phone, where the hero is ~320px tall and only
     two honest windows fit, those two still show all five outfits over a minute.
     That's worth having. Filling the same space with four slivers, which is what
     a lower size floor bought, is not. */
  var LEAST = 2;

  var GAP = 12;           // clear space between the underlying grid cells, px
  /* Panes outgrow their cells a little, so neighbours just kiss rather than sit
     in a tidy grid. Kept gentle on purpose: a big overgrowth buys size but
     stacks the windows on top of each other, and five boxes crowded into her
     narrow figure read as one busy mass instead of five separate looks. Tried in
     order — if the roomiest setting can't be relaxed into a clean arrangement,
     the panes give up a little size before the collage gives up a whole look. */
  var GROWS = [1.18, 1.10, 1.03, 0.96];
  var CROSS = 16;         // how deep two frames may cross at rest, px …
  var CROSS_FRAC = 0.17;  //   … or this fraction of the smaller box, whichever is
                          //   less. "16px" means something very different to a
                          //   300px pane and to a 90px one, so it's both.
  var BURIED = 0.20;      // …and no pane may end up with more than this much of
                          //   its area under a single neighbour. A box mostly
                          //   under its neighbour isn't a collage, it's a
                          //   missing box (on phones it read as "only 3 of 5").
  var SPILL = 26;         // how far a pane may grow out of its own strip. Keeps
                          //   the overgrowth from wandering onto the copy, which
                          //   the strips were carved to avoid in the first place.
  var OUTGROW = 26;       // a pane may overhang her outline by this much per side…
  var OUT_FRAC = 0.18;    //   …but never by more than this fraction of its width,
                          //   so at least ~64% of every window is fabric. A big
                          //   pane can afford the slack; a small one cannot.

  /* Insets that keep the panes inside the part of the hero a visitor can see.
     Landscape only has to clear the sticky header and the seam where the page
     sheet slides up; portrait's real constraint is the copy, and that's measured
     live rather than guessed (see groundFor). */
  var MARGIN = {
    // The hero already begins below the sticky header, so the top inset is just
    // breathing room — her shoulders (SILHOUETTE's first band) are what actually
    // sets the ceiling at almost every size. Keeping it small is what leaves a
    // rotated phone, whose hero is barely 320px tall, enough height to work with.
    landscape: { top: 12, right: 6, bottom: 22 },
    portrait: { top: 8, right: 6, bottom: 22 },
  };

  /* ---------- feel ----------
     Ported from the bssaub perk-field bubbles, minus the physics engine: a grab
     that follows with a little lag, a hard ceiling on how far a pane can travel,
     and a glide home that begins the moment you let go. */
  var GRAB_FOLLOW = 0.36;   // fraction of the pointer gap closed per 60fps step
  var ROAM = 44;            // how far past her outline a dragged pane may go, px
  /* Home is a critically damped spring rather than a fixed-duration tween: it
     inherits the speed the pane had when you let go (so a throw keeps flowing
     instead of stopping dead and restarting), it never overshoots, and it can
     chase a target that is itself moving — which is what the idle drift and the
     shove from a held neighbour both are. Stiffness is blended by distance: far
     from home it's an unhurried glide, close to home it's crisp enough to react
     to a neighbour being dragged into it. */
  var SPRING_HOME = 3.4;    // rad/s, used far from home
  var SPRING_NEAR = 8.0;    // rad/s, used at rest
  var SPRING_FADE = 70;     // px over which one blends into the other
  var THROW_MAX = 1500;     // px/s cap on the velocity a release may carry
  var REPEL_PAD = 10;       // a dragged box starts shoving neighbours this far out
  var REPEL_MAX = 96;       // and can displace them at most this far
  var DRIFT_PX = 3.5;       // idle breathing so they read as grabbable
  var DRIFT_MS = 9000;
  var TOUCH_SLOP = 7;       // px of horizontal intent before a touch drag starts

  /* ---------- choreography ---------- */
  var SWAP_WAIT = 4000;     // still, between swaps. Paused while a pane is held.
  var SWAP_MS = 2000;       // seat -> seat. Runs to completion regardless.
  var SWAP_LEAD = 1600;     // quiet beat after the panes have faded in
  var ARC = 0.17;           // how far a flight bows off the straight line …
  var ARC_MAX = 34;         //   … in px, capped. Two panes swapping bow opposite
                            //   ways, so they pass each other instead of colliding.
  var TRIPLE = 4;           // every Nth swap is a three-way instead of a pair
  var BENCH = 3;            // every Nth swap brings a benched look on (when the
                            //   fold could only seat three or four of the five)

  var hero = document.querySelector('[data-hero]');
  var frame = document.querySelector('[data-hero-frame]');
  if (!hero || !frame || !window.matchMedia) return;

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  var portraitQ = window.matchMedia('(max-width: 959px) and (orientation: portrait)');

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
      id: i,
      pane: pane,
      img: pane.querySelector('img'),
      edge: edge,
      slot: -1,            // which seat this look currently holds, -1 = benched
      rect: { x: 0, y: 0, w: 0, h: 0 },   // live window, frame-local px
      fly: null,           // in-flight seat change
      dx: 0, dy: 0,        // current offset from the seat
      ox: 0, oy: 0,        // …of which this much is spring (the rest is drift)
      svx: 0, svy: 0,      // spring velocity, px/s
      vx: 0, vy: 0,        // measured pane velocity, handed to the spring on release
      grab: null,          // { id, px, py, tx, ty }
      shown: false,        // its image has loaded and faded in
      dead: false,         // its image failed — never seat it again
      phase: i * 1.7,      // idle drift offset, so they don't breathe in unison
    };
  });

  var slots = [];          // the validated seats; panes hold indices into this
  var ground = null;       // { regions, home, roam } for the frame as it is now

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
    return {
      to: function (u, v) { return { x: ox + u * dw, y: oy + v * dh }; },
      x: function (u) { return ox + u * dw; },
      y: function (v) { return oy + v * dh; },
      u: function (x) { return (x - ox) / dw; },
      v: function (y) { return (y - oy) / dh; },
    };
  }

  // Crop-local fractions <-> master-frame fractions, so SILHOUETTE reads the same
  // on the landscape frame and on the portrait cut of it.
  function toMasterV(v, portrait) {
    return portrait ? (v * PORTRAIT_CROP.h + PORTRAIT_CROP.y) / MASTER.h : v;
  }
  function fromMasterX(u, portrait) {
    return portrait ? (u * MASTER.w - PORTRAIT_CROP.x) / PORTRAIT_CROP.w : u;
  }
  function fromMasterY(v, portrait) {
    return portrait ? (v * MASTER.h - PORTRAIT_CROP.y) / PORTRAIT_CROP.h : v;
  }

  /* Where her garment starts and ends across a vertical slice, as master
     fractions. The INTERSECTION over the bands the slice touches, not the union:
     a pane has to be on fabric for its whole height, not just somewhere in it. */
  function outlineOver(v0, v1) {
    var l = 0, r = 1, found = false;
    for (var i = 0; i < SILHOUETTE.length; i++) {
      var b = SILHOUETTE[i];
      if (b[0] + BAND <= v0 || b[0] >= v1) continue;
      l = found ? Math.max(l, b[1]) : b[1];
      r = found ? Math.min(r, b[2]) : b[2];
      found = true;
    }
    return found && r - l > 0.02 ? { l: l, r: r } : null;
  }

  // The same thing in frame-local px: the horizontal run of her outfit that a
  // box of this height, seated at this y, would sit on for its whole height.
  function spanAt(ctx, y, h) {
    if (h <= 0) return null;
    var band = outlineOver(
      toMasterV(ctx.map.v(y), ctx.portrait),
      toMasterV(ctx.map.v(y + h), ctx.portrait),
    );
    if (!band) return null;
    var l = ctx.map.x(fromMasterX(band.l, ctx.portrait));
    var r = ctx.map.x(fromMasterX(band.r, ctx.portrait));
    return r - l > 1 ? { l: l, r: r } : null;
  }

  // The widest box that may sit on a run of fabric this wide — her span plus the
  // slack OUTGROW/OUT_FRAC allow. Solved rather than iterated: the slack is a
  // fraction of the very width we're solving for, so guessing it converges
  // slowly and this doesn't. (Continuous at the crossover: OUTGROW/OUT_FRAC.)
  function widestOn(span) {
    var w = span / (1 - 2 * OUT_FRAC);
    return w * OUT_FRAC > OUTGROW ? span + 2 * OUTGROW : w;
  }

  // A box is worth showing when its short side and its long side both clear the
  // floor — one test that holds for upright and landscape cuts alike.
  function fits(min, w, h) {
    return Math.min(w, h) >= min.short - 0.5 && Math.max(w, h) >= min.long - 0.5;
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

  // Rightmost edge of a set of elements, in frame-local px. Used to find where
  // the copy actually ends — the column is sized in vw, the headline wraps to two
  // or three lines depending on the word, and the CTA buttons hug their labels
  // inside a much wider column, so measuring beats assuming.
  function rightOf(sel) {
    var h = hero.getBoundingClientRect();
    var out = 0;
    hero.querySelectorAll(sel).forEach(function (el) {
      out = Math.max(out, el.getBoundingClientRect().right - h.left);
    });
    return out;
  }

  function bottomOf(sel) {
    var el = hero.querySelector(sel);
    if (!el) return 0;
    return el.getBoundingClientRect().bottom - hero.getBoundingClientRect().top;
  }

  function topOf(sel, fallback) {
    var el = hero.querySelector(sel);
    if (!el) return fallback;
    return el.getBoundingClientRect().top - hero.getBoundingClientRect().top;
  }

  /* Everything the layout needs about the frame as it is right now: how big it
     is, which crop the browser picked, and how that crop maps onto it. */
  function contextFor(baseImg) {
    var box = { w: frame.offsetWidth, h: frame.offsetHeight };
    if (!box.w || !box.h || !baseImg.naturalWidth) return null;
    // Which crop is on screen comes from the IMAGE, not from re-running the
    // <source> media query: after a resize some engines keep the crop they
    // already picked, and guessing wrong would map her clothes to the wrong half
    // of the frame. The two crops are 1.50 and 0.56 aspect, so the picture itself
    // is unambiguous — and the panes carry the same <source> list as the base, so
    // whatever it resolved to, they resolved to as well.
    var portrait = baseImg.naturalWidth < baseImg.naturalHeight;
    // Which crop is loaded and how the PAGE is laid out are two different
    // questions, and conflating them switched the whole feature off: shrink a
    // desktop window to phone width and Chrome keeps the landscape crop it
    // already has, so the crop said "landscape" (copy beside her) while the CSS
    // had gone one-column (copy across her). The carve then measured a
    // negative-width region and nothing was placed at all. `portrait` answers
    // only "where are her clothes in this image"; the carve measures the copy.
    return {
      box: box,
      portrait: portrait,
      small: box.w < 960,
      // min / cellMin are filled in by groundFor, which is the first place her
      // on-screen size is known — the floor is a share of it, see SHARE above.
      min: null,
      cellMin: null,
      map: coverMapper(
        { w: baseImg.naturalWidth, h: baseImg.naturalHeight },
        box,
        objectPosition(baseImg),
      ),
    };
  }

  /* The free ground: the part of the hero a pane may sit in — on screen, and not
     already spoken for by the copy. A LIST of rects, because on a phone what is
     left is an L and not a rectangle: she fills the frame there, so the panes get
     the column beside the headline, the full width of her under the paragraph,
     and the column beside the buttons down to the floor. Squeezing that into one
     rect is what broke the phone layout before — on a real handset 100svh is
     ~100px shorter than a desktop emulator's, the middle strip alone collapsed
     under the minimum, and the feature switched itself off.

     Also returns `home` — her on-screen bounds, which is what a RESTING pane is
     clamped to — and `roam`, the looser box a DRAGGED pane may travel in. Those
     two were once the same value, and that was a real bug: the relaxation pass
     clamped to roam, so it could shove a seated pane 44px out onto bare wall,
     where all six frames are identical and the window shows nothing at all.

     Horizontal bounds are loose here on purpose; the packer clips every cell and
     every finished pane to her outline at that box's own height, which is what
     actually keeps panes on fabric instead of on wall. */
  function groundFor(ctx) {
    var box = ctx.box;
    var m = ctx.small ? MARGIN.portrait : MARGIN.landscape;
    var wide = { l: 1, r: 0 };
    SILHOUETTE.forEach(function (b) {
      wide.l = Math.min(wide.l, b[1]);
      wide.r = Math.max(wide.r, b[2]);
    });
    var gL = Math.max(ctx.map.x(fromMasterX(wide.l, ctx.portrait)), 4);
    var gR = Math.min(ctx.map.x(fromMasterX(wide.r, ctx.portrait)), box.w - m.right);
    var gT = Math.max(ctx.map.y(fromMasterY(SILHOUETTE[0][0], ctx.portrait)), m.top);
    var gB = Math.min(ctx.map.y(fromMasterY(1, ctx.portrait)), box.h - m.bottom);

    // Her on-screen size is only known here, so this is where the size floor
    // settles (see SHARE/CAP/BOTTOM above) — as a share of the figure itself.
    ctx.figure = { w: gR - gL, h: gB - gT };
    ctx.narrow = ctx.figure.w < NARROW;
    ctx.min = {
      short: Math.min(CAP.short, Math.max(BOTTOM.short, ctx.figure.w * SHARE.w)),
      long: Math.min(CAP.long, Math.max(BOTTOM.long, ctx.figure.h * SHARE.h)),
    };
    // Grid cells are measured as "could an upright pane live here?", so the cell
    // floor is the short side by the long side.
    ctx.cellMin = { w: ctx.min.short, h: ctx.min.long };

    /* TWO candidate carves, and the packer is left to decide — which beats any
       breakpoint rule, because the two are better in different places for
       reasons no single threshold captures.

         column: the block of her clear to the right of the widest line of copy.
                 One region, so the packer has the most freedom. Wins on every
                 desktop, where the headline's 760px cap leaves her whole figure
                 clear.
         strips: the L that's left when the copy runs across her — beside the
                 headline, the full width of her under the paragraph, and beside
                 the buttons down to the floor. Wins on phones, where `column` is
                 a single file of windows and this is two abreast.

       Trying both costs a couple of milliseconds and removes the guess: layout()
       keeps whichever actually seats more looks. Squeezing the phone case into
       one rect is what broke it before — on a real handset 100svh is ~100px
       shorter than a desktop emulator's, the middle strip alone collapsed under
       the minimum, and the feature switched itself off. */
    // A region too small to hold even one pane is not a region.
    var add = function (list, x, y, w, h) {
      if (w >= ctx.cellMin.w + GAP && h >= ctx.cellMin.h + GAP) {
        list.push({ x: x, y: y, w: w, h: h });
      }
    };

    var column = [];
    var copyR = Math.max(gL, rightOf('.hero-text, .hero-copy h1, .hero-actions .btn') + 12);
    add(column, copyR, gT, gR - copyR, gB - gT);

    // Three strips, stacked and disjoint — the packer grids each one on its own,
    // so they must never overlap each other.
    var strips = [];
    var textB = Math.max(gT, bottomOf('.hero-text') + 12);
    var actT = Math.max(textB, Math.min(gB, topOf('.hero-actions', gB) - 10));
    var textR = Math.max(gL, rightOf('.hero-text, .hero-copy h1') + 12);
    var actR = Math.max(gL, rightOf('.hero-actions .btn') + 12);
    add(strips, textR, gT, gR - textR, textB - gT);
    add(strips, gL, textB, gR - gL, actT - textB);
    add(strips, actR, actT, gR - actR, gB - actT);

    return {
      carves: [column, strips],
      home: { l: gL, t: gT, r: gR, b: gB },
      // The drag range: anywhere on her, and a little beyond — the pane may leave
      // its seat entirely and ride the whole figure, it just can't wander off into
      // the empty wall (where it would show nothing) or off screen.
      roam: {
        l: Math.max(gL - ROAM, 2),
        t: Math.max(gT - ROAM, 2),
        r: Math.min(gR + ROAM, box.w - 2),
        b: Math.min(gB + ROAM, box.h - 2),
      },
    };
  }

  /* Deterministic-per-visit randomness: a fresh seed each page load, but the SAME
     seed replayed on every relayout, so a resize or an orientation flip re-packs
     into the new shape instead of reshuffling under the visitor's eyes. */
  var SEED = (Math.random() * 4294967296) >>> 0;
  var seed = SEED;
  function rnd() {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  }
  // Triangular, peaked in the middle — nudges a pane toward the centre of the
  // room it has rather than hugging an edge.
  function centred() { return (rnd() + rnd()) / 2; }
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }
  /* The choreography draws from its OWN stream. Sharing the layout's would make
     which panes swap depend on how many packing attempts a viewport happened to
     need, and would desync the replay that keeps a resize from reshuffling. */
  var pseed = (Math.random() * 4294967296) >>> 0;
  function pick() {
    pseed = (pseed * 1664525 + 1013904223) >>> 0;
    return pseed / 4294967296;
  }

  /* The biggest upright pane a cell can hold. Aspect follows the CELL (clamped
     into the shape band) rather than a fixed number, so a square-ish cell yields
     a pane that actually fills it instead of a tall pane with slack on both
     sides — that slack was the whole reason panes came out small. */
  function uprightIn(cell) {
    var ar = Math.min(TALL.max, Math.max(TALL.min, cell.h / cell.w));
    var w = Math.min(cell.w, cell.h / ar);
    return { w: w, h: w * ar, ar: ar };
  }

  /* One ROW of a strip's grid. The columns are laid across the fabric that
     actually exists at this height — not across the strip — which is the whole
     difference between a usable cell and a wasted one.

     She is not a rectangle: 0.755-0.840 wide at the chest, 0.661-0.881 at the
     hem. A grid laid over her full extent therefore drops a column onto bare
     wall at chest height, that column's cells fail, the grid comes up short of
     k cells and gets thrown away — and the packer settles for a coarser grid
     with visibly smaller windows. Fitting each row to its own span keeps every
     cell on her and hands the panes the room that was being thrown away. */
  function rowCells(ctx, reg, g, row) {
    var y = reg.y + row * g.ch + GAP / 2;
    var h = g.ch - GAP;
    var s = spanAt(ctx, y, h);
    if (!s) return [];
    var l = Math.max(reg.x, s.l - OUTGROW);
    var r = Math.min(reg.x + reg.w, s.r + OUTGROW);
    var cw = (r - l) / g.cols;
    if (cw - GAP < ctx.min.short) return [];
    var out = [];
    for (var c = 0; c < g.cols; c++) {
      var cell = { x: l + c * cw + GAP / 2, y: y, w: cw - GAP, h: h };
      var up = uprightIn(cell);
      if (!fits(ctx.min, up.w, up.h)) continue;
      cell.score = Math.sqrt(up.w * up.h);   // how big a window it really affords
      out.push(cell);
    }
    return out;
  }

  /* Best grid for k panes in one strip. Every (cols, rows) that holds k is tried;
     the pane size a grid affords is the k-th largest of its usable cells, since
     that is the smallest pane it would actually place; the biggest wins, with
     spare cells only breaking ties. Scatter comes from the random cell draw and
     the in-cell jitter, not from paying pane size for empties. */
  function gridFor(ctx, reg, k) {
    var best = null;
    for (var cols = 1; cols <= k; cols++) {
      var need = Math.ceil(k / cols);
      for (var rows = need; rows <= need + 1; rows++) {
        var g = { cols: cols, rows: rows, cw: reg.w / cols, ch: reg.h / rows };
        // Cheap early-out: a row is never wider than the strip, so a strip too
        // narrow for `cols` columns can't be saved by fitting rows to her.
        if (g.cw - GAP < ctx.cellMin.w || g.ch - GAP < ctx.cellMin.h) continue;
        var cells = [];
        for (var r = 0; r < rows; r++) cells = cells.concat(rowCells(ctx, reg, g, r));
        if (cells.length < k) continue;
        var ranked = cells.slice().sort(function (a, b) { return b.score - a.score; });
        g.cells = cells;
        g.pw = ranked[k - 1].score;
        g.spare = cells.length - k;
        // Size wins outright; spare cells only break ties. (An earlier version let
        // a near-size grid win on scatter, and it kept costing a fifth of the pane.)
        if (!best || g.pw > best.pw || (g.pw === best.pw && g.spare > best.spare)) best = g;
      }
    }
    return best;
  }

  /* How to split n panes across the strips. Brute force — three strips and five
     panes is 21 combinations — scored on the SMALLEST pane it produces, so the
     five come out as a set rather than one hero and four crumbs. */
  function allocate(ctx, regions, n) {
    var best = null;
    var counts = [];
    (function walk(idx, left) {
      if (idx === regions.length) {
        if (left) return;
        var grids = [];
        var minPw = Infinity;
        for (var j = 0; j < regions.length; j++) {
          if (!counts[j]) { grids.push(null); continue; }
          var g = gridFor(ctx, regions[j], counts[j]);
          if (!g) return;
          grids.push(g);
          minPw = Math.min(minPw, g.pw);
        }
        if (minPw !== Infinity && (!best || minPw > best.minPw)) {
          best = { counts: counts.slice(), grids: grids, minPw: minPw };
        }
        return;
      }
      for (var c = 0; c <= left; c++) {
        counts[idx] = c;
        walk(idx + 1, left - c);
      }
      counts[idx] = 0;
    })(0, n);
    return best;
  }

  // Resize about the centre, holding the shape band this pane was dealt.
  function setWidth(r, w) {
    var cx = r.x + r.w / 2;
    var cy = r.y + r.h / 2;
    r.w = w;
    r.h = w * r.ar;
    r.x = cx - r.w / 2;
    r.y = cy - r.h / 2;
  }

  /* Pull one pane back onto her, in place: inside its strip (plus SPILL), inside
     her outline at its OWN height (plus the OUTGROW slack), shrinking along its
     shape band if that's what it takes. False when no honest box is left.

     Iterated because the two constraints feed each other — shortening a pane
     widens the run of fabric it may sit on, since the outline is intersected over
     the bands it covers — but it converges in two or three passes. */
  function refit(ctx, r) {
    var b = r.bounds;
    for (var pass = 0; pass < 6; pass++) {
      var last = pass === 5;
      if (r.h > b.b - b.t) {
        if (!fits(ctx.min, (b.b - b.t) / r.ar, b.b - b.t)) return false;
        setWidth(r, (b.b - b.t) / r.ar);
      }
      r.y = Math.min(Math.max(r.y, b.t), Math.max(b.t, b.b - r.h));

      var s = spanAt(ctx, r.y, r.h);
      if (!s) {
        // Nothing is fabric across this whole height (it straddles a pinch in her
        // outline) — shorten and look again.
        if (last || !fits(ctx.min, r.w * 0.86, r.h * 0.86)) return false;
        setWidth(r, r.w * 0.86);
        continue;
      }

      var slack = Math.min(OUTGROW, r.w * OUT_FRAC);
      var lo = Math.max(b.l, s.l - slack);
      var hi = Math.min(b.r, s.r + slack);
      if (hi - lo < r.w) {
        var room = Math.min(hi - lo, widestOn(s.r - s.l));
        if (last || room <= 0 || !fits(ctx.min, room, room * r.ar)) return false;
        setWidth(r, room);
        continue;    // the height moved with it, so the span has to be re-read
      }
      r.x = Math.min(Math.max(r.x, lo), hi - r.w);
      return fits(ctx.min, r.w, r.h);
    }
    return false;
  }

  // How deep two frames may cross before the lower one stops reading as a box.
  function crossOn(a, b) { return Math.min(CROSS, Math.min(a, b) * CROSS_FRAC); }

  /* One relaxation pass: shove any pair that crosses too deep apart along the
     axis of least penetration, half each. Returns whether anything moved. */
  function separateStep(rects) {
    var moved = false;
    for (var i = 0; i < rects.length; i++) {
      for (var j = i + 1; j < rects.length; j++) {
        var a = rects[i];
        var b = rects[j];
        var ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        var oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        var cx = crossOn(a.w, b.w);
        var cy = crossOn(a.h, b.h);
        if (ox <= cx || oy <= cy) continue;
        if (ox - cx < oy - cy) {
          var sx = (ox - cx) / 2 + 0.5;
          if (a.x < b.x) { a.x -= sx; b.x += sx; } else { a.x += sx; b.x -= sx; }
        } else {
          var sy = (oy - cy) / 2 + 0.5;
          if (a.y < b.y) { a.y -= sy; b.y += sy; } else { a.y += sy; b.y -= sy; }
        }
        moved = true;
      }
    }
    return moved;
  }

  // Did any pane end up mostly underneath a single neighbour? That's not a
  // collage, that's a missing box.
  function anyBuried(rects) {
    for (var i = 0; i < rects.length; i++) {
      for (var j = i + 1; j < rects.length; j++) {
        var a = rects[i];
        var b = rects[j];
        var ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        var oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox <= 0 || oy <= 0) continue;
        if (ox * oy > BURIED * Math.min(a.w * a.h, b.w * b.h)) return true;
      }
    }
    return false;
  }

  /* The pane a cell is dealt: the cell grown past its own edges (so neighbours
     overlap like stacked prints), in one of the two shape bands, with the aspect
     following the cell so the box actually fills the room it was given. */
  function shapeIn(cell, grow, wide) {
    var band = wide ? WIDE : TALL;
    var ar = Math.min(band.max, Math.max(band.min, cell.h / cell.w));
    ar = Math.min(band.max, Math.max(band.min, ar * cell.jar));
    var w = Math.min(cell.w * grow, (cell.h * grow) / ar) * cell.jsc;
    return { w: w, h: w * ar, ar: ar };
  }

  /* Lay k panes out at one overgrowth setting, then relax the result until it is
     honest: nothing crossing too deep, nothing off her, nothing under the floor.
     Null if this setting can't get there — the caller then tries a tighter one
     before it gives up a whole look. */
  function place(ctx, regions, plan, k, grow) {
    seed = SEED;
    var out = [];
    /* No landscape cuts across a narrow figure. Where she is only ~110px wide
       and several hundred tall, a horizontal window has to buy its width out of
       its height and comes out a third shorter than every other box — the runt
       of the set. Upright suits a dress anyway; the wide/tall rhythm is a luxury
       of a roomy frame, paid for with width a phone doesn't have. */
    var wideLeft = ctx.narrow ? 0 : (k >= 4 ? N_WIDE : (k >= 3 ? 1 : 0));

    for (var j = 0; j < regions.length; j++) {
      var reg = regions[j];
      var n = plan.counts[j];
      var g = plan.grids[j];
      if (!n || !g) continue;

      // Roomiest cells first, then shuffled among them: panes land where there is
      // most of her, but not in the same arrangement twice.
      var pool = g.cells.slice().sort(function (a, b) { return b.score - a.score; });
      var chosen = shuffle(pool.slice(0, n + g.spare)).slice(0, n);
      // Every draw a cell needs is taken NOW, in a fixed order, so that trying a
      // shape doesn't consume randomness and shift what the next cell gets.
      chosen.forEach(function (cell) {
        cell.jar = 0.94 + rnd() * 0.12;
        cell.jsc = 0.94 + rnd() * 0.06;
        cell.jx = centred();
        cell.jy = rnd();
      });

      // The horizontal panes go to the FLATTEST cells that can actually carry
      // one. Forcing a landscape cut into an upright cell is how you get a
      // letterbox sliver, so a strip with no flat cell simply keeps all uprights.
      var wide = [];
      chosen.slice()
        .filter(function (c) { return c.h / c.w <= WIDE_CELL; })
        .sort(function (a, b) { return a.h / a.w - b.h / b.w; })
        .forEach(function (c) {
          if (wide.length >= wideLeft) return;
          var s = shapeIn(c, grow, true);
          if (fits(ctx.min, s.w, s.h)) wide.push(c);
        });
      wideLeft -= wide.length;

      // A pane may spill out of its strip — that's what makes neighbouring boxes
      // overlap — but only this far, so the overgrowth never lands on the copy
      // the strips were carved around.
      var bounds = {
        l: Math.max(ground.home.l, reg.x - SPILL),
        t: Math.max(ground.home.t, reg.y - SPILL),
        r: Math.min(ground.home.r, reg.x + reg.w + SPILL),
        b: Math.min(ground.home.b, reg.y + reg.h + SPILL),
      };

      for (var c = 0; c < chosen.length; c++) {
        var cell = chosen[c];
        var s = shapeIn(cell, grow, wide.indexOf(cell) >= 0);
        var r = {
          ar: s.ar, w: s.w, h: s.h, bounds: bounds,
          // Centred on the cell (plus jitter), so the overgrowth spreads onto
          // both neighbours instead of piling up one side.
          x: cell.x + (cell.w - s.w) / 2 + (cell.jx - 0.5) * GAP * 2,
          y: cell.y + (cell.h - s.h) / 2 + (cell.jy - 0.5) * GAP * 2,
        };
        if (!refit(ctx, r)) return null;
        out.push(r);
      }
    }
    if (out.length !== k) return null;

    // Shuffle so the looks are not grouped strip by strip, then settle.
    shuffle(out);
    for (var it = 0; it < 40; it++) {
      var moved = separateStep(out);
      for (var i = 0; i < out.length; i++) if (!refit(ctx, out[i])) return null;
      if (!moved) break;
    }
    if (anyBuried(out)) return null;

    return out.map(function (r) {
      return {
        x: Math.round(r.x), y: Math.round(r.y),
        w: Math.round(r.w), h: Math.round(r.h),
      };
    });
  }

  /* How many panes the room can carry, and how big. As many as will FIT, at the
     roomiest overgrowth that still relaxes into an honest arrangement — panes
     give up size before the collage gives up a look. (An earlier version
     preferred fewer-but-bigger; on a mid-size phone that quietly turned five
     outfits into three, which read as broken rather than generous.) */
  function pack(ctx, regions, n) {
    for (var k = n; k >= LEAST; k--) {
      var plan = allocate(ctx, regions, k);
      if (!plan) continue;
      for (var i = 0; i < GROWS.length; i++) {
        var rects = place(ctx, regions, plan, k, GROWS[i]);
        if (rects) return rects;
      }
    }
    return [];
  }

  /* Pack every candidate carve and keep the best result. More looks seated wins
     outright — five windows of decent size beat four large ones — and total area
     breaks the tie. Both carves replay from the same seed, so the winner is
     stable across relayouts and a resize doesn't reshuffle the collage. */
  function packBest(ctx, n) {
    var best = null;
    for (var i = 0; i < ground.carves.length; i++) {
      if (!ground.carves[i].length) continue;
      var rects = pack(ctx, ground.carves[i], n);
      if (!rects.length) continue;
      var area = 0;
      rects.forEach(function (r) { area += r.w * r.h; });
      if (!best || rects.length > best.n || (rects.length === best.n && area > best.area)) {
        best = { rects: rects, n: rects.length, area: area };
      }
    }
    return best ? best.rects : [];
  }

  /* ---------- seating ---------- */

  function seated(p) { return !p.dead && p.slot >= 0 && p.slot < slots.length; }

  /* Hand out the seats. Panes KEEP the seat they're holding whenever it still
     exists, so a resize re-packs the collage under them instead of re-dealing
     which look sits where; only genuinely new or orphaned panes are dealt. */
  function assignSlots() {
    var live = panes.filter(function (p) { return !p.dead; });
    var n = Math.min(slots.length, live.length);
    var taken = new Array(n);
    var need = [];
    live.forEach(function (p) {
      if (p.slot >= 0 && p.slot < n && !taken[p.slot]) taken[p.slot] = p;
      else { p.slot = -1; need.push(p); }
    });
    for (var i = 0; i < n && need.length; i++) {
      if (!taken[i]) { taken[i] = need.shift(); taken[i].slot = i; }
    }
    need.forEach(function (p) { p.slot = -1; });

    panes.forEach(function (p) {
      if (p.dead) return;
      var out = p.slot < 0;
      p.pane.classList.toggle('is-out', out);
      p.edge.classList.toggle('is-out', out);
      if (out) { endFlight(p); return; }
      // A look that was benched (or is arriving on this fold for the first time)
      // needs its fade-in the moment it gets a seat.
      if (p.shown) {
        p.pane.classList.add('is-in');
        p.edge.classList.add('is-in');
      }
      if (p.fly) retarget(p);
      else { copyRect(slots[p.slot], p.rect); writeRect(p); }
      writeOffset(p);
    });
  }

  function copyRect(from, to) {
    to.x = from.x; to.y = from.y; to.w = from.w; to.h = from.h;
    return to;
  }

  function layout(baseImg) {
    var ctx = contextFor(baseImg);
    ground = ctx ? groundFor(ctx) : null;
    slots = ctx && ground ? packBest(ctx, panes.filter(function (p) { return !p.dead; }).length) : [];
    hero.classList.toggle('has-looks', slots.length > 0);
    assignSlots();
    return slots.length > 0;
  }

  // The window's box — the clip rectangle and the border that traces it. Static
  // between swaps, so it stays out of the animation loop except while flying.
  function writeRect(p) {
    var r = p.rect;
    if (r.x === p.wroteX && r.y === p.wroteY && r.w === p.wroteW && r.h === p.wroteH) return;
    p.wroteX = r.x; p.wroteY = r.y; p.wroteW = r.w; p.wroteH = r.h;
    var st = [p.pane.style, p.edge.style];
    for (var i = 0; i < 2; i++) {
      st[i].setProperty('--wx', r.x + 'px');
      st[i].setProperty('--wy', r.y + 'px');
      st[i].setProperty('--ww', r.w + 'px');
      st[i].setProperty('--wh', r.h + 'px');
    }
  }

  // The per-frame part: how far the window has slid from its seat. Four property
  // writes, and only when the value actually moved — the idle drift runs for as
  // long as the hero is on screen, so this is the one thing in here that has to
  // stay cheap. Kept to 1/20 px rather than whole pixels: the drift is only 3.5px
  // wide, and rounding a motion that small to integers is what made it step
  // instead of breathe. The pane's <img> takes the inverse slide (in CSS), which
  // is what keeps the photograph nailed down while its window travels.
  function writeOffset(p) {
    var dx = Math.round(p.dx * 20) / 20;
    var dy = Math.round(p.dy * 20) / 20;
    if (dx === p.lastX && dy === p.lastY) return;
    p.lastX = dx;
    p.lastY = dy;
    p.pane.style.setProperty('--dx', dx + 'px');
    p.pane.style.setProperty('--dy', dy + 'px');
    p.edge.style.setProperty('--dx', dx + 'px');
    p.edge.style.setProperty('--dy', dy + 'px');
  }

  /* ---------- stacking ----------
     Whatever the visitor is touching is the top of the pile — its window has to
     win wherever it crosses a neighbour, or dragging a box over another one
     shows you the OTHER one's outfit through the box you're holding. It also
     keeps the hit target honest: the pane you can see is the pane you can grab. */
  var zTop = 0;
  function raise(p) {
    zTop += 1;
    p.pane.style.zIndex = String(zTop);
    p.edge.style.zIndex = String(zTop);
  }
  // A held pane outranks everything, including a swap that started later.
  function keepHeldOnTop() {
    panes.forEach(function (p) { if (p.grab) raise(p); });
  }

  /* ---------- motion ---------- */

  var running = false;
  var onScreen = true;    // hero intersecting the viewport
  var tabVisible = !document.hidden;
  var last = 0;
  var t = 0;
  var scale = 1;          // frame px -> screen px, read once per frame

  // Keep the dragged pane inside her figure (plus ROAM): the box, not the
  // pointer, is what stops at the edge, so it never slides out onto bare wall.
  // Returns whether it actually had to bite, so the spring can drop the velocity
  // it was pressing into the wall with instead of straining against it.
  function clampOffset(p) {
    if (!ground) return 0;
    var r = ground.roam;
    var dx = Math.min(Math.max(p.dx, r.l - p.rect.x), r.r - (p.rect.x + p.rect.w));
    var dy = Math.min(Math.max(p.dy, r.t - p.rect.y), r.b - (p.rect.y + p.rect.h));
    var hit = (dx !== p.dx ? 1 : 0) | (dy !== p.dy ? 2 : 0);
    p.dx = dx;
    p.dy = dy;
    return hit;
  }

  // Zero velocity and zero acceleration at both ends — the flight starts and
  // lands without a visible kink, which smoothstep (used for the old return)
  // does not manage.
  function smoother(x) { return x * x * x * (x * (x * 6 - 15) + 10); }

  /* Critically damped: never overshoots, and it inherits whatever speed the pane
     already had, so a throw flows into its glide home instead of stopping dead.
     Substepped so a dropped frame can't make it explode. */
  function spring(p, tx, ty, sec) {
    var d = Math.sqrt((p.ox - tx) * (p.ox - tx) + (p.oy - ty) * (p.oy - ty));
    var w = SPRING_NEAR + (SPRING_HOME - SPRING_NEAR) * Math.min(1, d / SPRING_FADE);
    var n = Math.min(6, Math.max(1, Math.ceil(sec / 0.017)));
    var h = sec / n;
    var k = w * w;
    var c = 2 * w;
    for (var i = 0; i < n; i++) {
      p.svx += (-k * (p.ox - tx) - c * p.svx) * h;
      p.svy += (-k * (p.oy - ty) - c * p.svy) * h;
      p.ox += p.svx * h;
      p.oy += p.svy * h;
    }
  }

  function tick(now) {
    if (!running) return;
    var dt = last ? Math.min(64, now - last) : 16;
    last = now;
    t += dt;
    var sec = dt / 1000;
    var step = dt / 16.6667;      // grab easing is per-60fps-step, not per-ms
    var calm = reduced.matches;
    var busy = false;

    // One layout read per frame, before any style writes — the scroll
    // camera-push scales the frame, and reading this inside pointermove instead
    // forced a synchronous layout on every single move event.
    scale = frame.getBoundingClientRect().width / (frame.offsetWidth || 1) || 1;

    // Positions as of last frame, for the repulsion pass: every pane the
    // visitor is holding is an obstacle the idle ones scoot away from.
    var held = panes.filter(function (g) { return seated(g) && g.grab; });

    busy = advanceFlights(sec) || busy;
    if (!held.length) schedule(dt);

    panes.forEach(function (p) {
      if (!seated(p)) return;
      // Where this window would be sitting if nobody had touched it: a slow
      // lissajous a few pixels wide. Enough to read as "this moves", small
      // enough that it never looks like a glitch. It's added on TOP of the
      // spring rather than being the spring's target, so it lands exactly and
      // the pane never lags its own breathing.
      var a = (t / DRIFT_MS) * Math.PI * 2 + p.phase;
      var driftX = calm ? 0 : Math.cos(a) * DRIFT_PX;
      var driftY = calm ? 0 : Math.sin(a * 0.7) * DRIFT_PX * 0.6;

      if (p.grab) {
        var k = 1 - Math.pow(1 - GRAB_FOLLOW, step);
        var px = p.dx + (p.grab.tx - p.dx) * k;
        var py = p.dy + (p.grab.ty - p.dy) * k;
        var wasX = p.dx, wasY = p.dy;
        p.dx = px;
        p.dy = py;
        clampOffset(p);
        // The pane's own velocity, not the pointer's — smoothed by the follow
        // and already clipped by the roam box, so the release inherits exactly
        // the motion that was on screen.
        p.vx = (p.dx - wasX) / Math.max(sec, 0.001);
        p.vy = (p.dy - wasY) / Math.max(sec, 0.001);
        p.ox = p.dx - driftX;
        p.oy = p.dy - driftY;
        busy = true;
      } else {
        // Home is zero — plus a shove for every held box that has been dragged
        // into this one. The push is along the axis of least penetration (the
        // shortest way out from under it), grows with how deep the held box is,
        // and vanishes from the target the moment the drag moves away — so the
        // box glides back by itself, no bookkeeping.
        var tx = 0;
        var ty = 0;
        for (var hi = 0; hi < held.length; hi++) {
          var g = held[hi];
          if (g === p) continue;
          var ax = p.rect.x + p.dx;
          var ay = p.rect.y + p.dy;
          var bx = g.rect.x + g.dx;
          var by = g.rect.y + g.dy;
          var ox = Math.min(ax + p.rect.w, bx + g.rect.w) - Math.max(ax, bx) + REPEL_PAD;
          var oy = Math.min(ay + p.rect.h, by + g.rect.h) - Math.max(ay, by) + REPEL_PAD;
          if (ox <= 0 || oy <= 0) continue;
          if (ox < oy) {
            tx += (ax + p.rect.w / 2 < bx + g.rect.w / 2 ? -1 : 1) * Math.min(ox, REPEL_MAX);
          } else {
            ty += (ay + p.rect.h / 2 < by + g.rect.h / 2 ? -1 : 1) * Math.min(oy, REPEL_MAX);
          }
        }
        if (calm) {
          p.ox = 0; p.oy = 0; p.svx = 0; p.svy = 0;
        } else {
          spring(p, tx, ty, sec);
        }
        p.dx = p.ox + driftX;
        p.dy = p.oy + driftY;
        var hit = clampOffset(p);
        if (hit) {
          // Pressed into the edge of her figure: absorb the clamp rather than
          // letting the spring wind up against it and snap when it's released.
          if (hit & 1) p.svx = 0;
          if (hit & 2) p.svy = 0;
          p.ox = p.dx - driftX;
          p.oy = p.dy - driftY;
        }
        if (!calm) busy = true;
      }
      writeOffset(p);
    });

    if (busy) requestAnimationFrame(tick);
    else { running = false; last = 0; }
  }

  function start() {
    if (running || !onScreen || !tabVisible) return;
    if (!panes.some(seated)) return;
    running = true;
    last = 0;
    requestAnimationFrame(tick);
  }

  /* ---------- choreography ----------
     Left alone, the collage re-deals itself: SWAP_WAIT of stillness, then the
     windows glide into each other's seats over SWAP_MS, then stillness again.
     Because a swap only permutes WHICH look holds which seat, and the seats came
     out of the packer already validated, no swap can ever produce an arrangement
     the packer wouldn't have accepted. */

  var waited = 0;
  var swaps = 0;
  var lastPair = '';
  var choreoOn = false;
  var quietUntil = 0;     // wall clock: a cross-dissolve is still finishing

  function flying() {
    for (var i = 0; i < panes.length; i++) if (panes[i].fly) return true;
    return false;
  }

  function schedule(dt) {
    // Held: the countdown stops (the visitor is busy with the collage, so the
    // collage doesn't rearrange itself under their hand). Mid-swap: it doesn't
    // count either — the 4s of stillness is measured between swaps, not across
    // one. Reduced motion: the collage never moves on its own at all.
    if (!choreoOn || reduced.matches || flying()) return;
    if (quietUntil && performance.now() < quietUntil) return;
    waited += dt;
    if (waited < SWAP_WAIT) return;
    waited = 0;
    swap();
  }

  // Nearby panes trade more often than distant ones — a swap you can take in at
  // a glance reads as an exchange; two boxes crossing the whole figure reads as
  // two unrelated things moving.
  function pickCycle(live, want) {
    var pairs = [];
    var total = 0;
    for (var i = 0; i < live.length; i++) {
      for (var j = i + 1; j < live.length; j++) {
        // Keyed on the LOOKS, not their seats: the point is that the same two
        // outfits don't trade back and forth while the other three sit still.
        var key = live[i].id + '-' + live[j].id;
        if (key === lastPair && live.length > 2) continue;
        var dx = centreX(live[i]) - centreX(live[j]);
        var dy = centreY(live[i]) - centreY(live[j]);
        var wt = 1 / (60 + Math.sqrt(dx * dx + dy * dy));
        total += wt;
        pairs.push({ a: live[i], b: live[j], wt: wt });
      }
    }
    if (!pairs.length) return null;
    var roll = pick() * total;
    var chosen = pairs[pairs.length - 1];
    for (var k = 0; k < pairs.length; k++) {
      roll -= pairs[k].wt;
      if (roll <= 0) { chosen = pairs[k]; break; }
    }
    lastPair = chosen.a.id + '-' + chosen.b.id;
    var cyc = [chosen.a, chosen.b];
    if (want > 2 && live.length > 2) {
      // A third, nearest the pair's midpoint, so the three-way still reads as
      // one gesture rather than a box wandering in from across the frame.
      var mx = (centreX(chosen.a) + centreX(chosen.b)) / 2;
      var my = (centreY(chosen.a) + centreY(chosen.b)) / 2;
      var third = null;
      var bestD = Infinity;
      live.forEach(function (p) {
        if (p === chosen.a || p === chosen.b) return;
        var d = Math.abs(centreX(p) - mx) + Math.abs(centreY(p) - my);
        if (d < bestD) { bestD = d; third = p; }
      });
      if (third) cyc.push(third);
    }
    return cyc;
  }

  function centreX(p) { return p.rect.x + p.rect.w / 2; }
  function centreY(p) { return p.rect.y + p.rect.h / 2; }

  function swap() {
    var live = panes.filter(seated);
    if (live.length < 2) return;
    swaps += 1;

    // Not every look got a seat on this fold — give a benched one its turn.
    var bench = panes.filter(function (p) {
      return !p.dead && p.shown && p.slot < 0;
    });
    if (bench.length && swaps % BENCH === 0) { rotateIn(live, bench); return; }

    var cyc = pickCycle(live, swaps % TRIPLE === 0 ? 3 : 2);
    if (!cyc) return;
    var was = cyc.map(function (p) { return p.slot; });
    cyc.forEach(function (p, i) { p.slot = was[(i + 1) % was.length]; });
    cyc.forEach(function (p, i) { beginFlight(p, i); });
    keepHeldOnTop();
    start();
  }

  function beginFlight(p, i) {
    var to = slots[p.slot];
    var from = copyRect(p.rect, {});
    var dx = (to.x + to.w / 2) - (from.x + from.w / 2);
    var dy = (to.y + to.h / 2) - (from.y + from.h / 2);
    var d = Math.sqrt(dx * dx + dy * dy) || 1;
    // Bow off the straight line, alternating sides down the cycle, so two
    // windows trading seats pass each other rather than sliding through.
    var side = i % 2 ? -1 : 1;
    p.fly = {
      a: from,
      b: copyRect(to, {}),
      e: 0,
      dur: SWAP_MS / 1000,
      nx: (-dy / d) * side,
      ny: (dx / d) * side,
      bow: Math.min(ARC_MAX, d * ARC),
    };
    p.pane.classList.add('is-flying');
    p.edge.classList.add('is-flying');
    raise(p);
  }

  function endFlight(p) {
    if (!p.fly) return;
    p.fly = null;
    p.pane.classList.remove('is-flying');
    p.edge.classList.remove('is-flying');
  }

  /* A relayout landed mid-flight (a resize, an orientation flip, the web fonts
     settling): keep flying, but toward the seat's NEW rectangle, from wherever
     the pane is right now and in whatever time it had left. Restarting the
     easing from the live position is what keeps it from jumping. */
  function retarget(p) {
    var f = p.fly;
    f.a = copyRect(p.rect, {});
    f.b = copyRect(slots[p.slot], {});
    f.dur = Math.max(0.35, f.dur - f.e);
    f.e = 0;
    f.bow = 0;   // no flourish on a correction — straight to the new seat
  }

  function advanceFlights(sec) {
    var any = false;
    panes.forEach(function (p) {
      var f = p.fly;
      if (!f) return;
      any = true;
      f.e += sec;
      var x = Math.min(1, f.e / f.dur);
      var e = smoother(x);
      var bow = Math.sin(Math.PI * x) * f.bow;
      p.rect.x = f.a.x + (f.b.x - f.a.x) * e + f.nx * bow;
      p.rect.y = f.a.y + (f.b.y - f.a.y) * e + f.ny * bow;
      p.rect.w = f.a.w + (f.b.w - f.a.w) * e;
      p.rect.h = f.a.h + (f.b.h - f.a.h) * e;
      writeRect(p);
      if (x >= 1) { copyRect(f.b, p.rect); writeRect(p); endFlight(p); }
    });
    return any;
  }

  /* Fewer seats than looks (a cramped fold seats three or four): rather than
     letting the same subset hold them forever, a benched look takes a seat by
     dissolving in on top of the one that's leaving. No flight — the two windows
     are the same rectangle, so there is nothing to travel — and the outgoing
     border is held at full opacity until the swap is over, so the frame never
     dips while the fabric inside it changes. */
  function rotateIn(live, bench) {
    var out = live[Math.floor(pick() * live.length) % live.length];
    var going = bench[Math.floor(pick() * bench.length) % bench.length];
    endFlight(out);
    // BOTH hold the seat while the dissolve runs, so the outgoing window keeps
    // breathing in lockstep with the incoming one underneath it. Benching it
    // early would freeze it, and the two would peel apart by a few pixels.
    going.slot = out.slot;
    quietUntil = performance.now() + SWAP_MS;
    copyRect(slots[going.slot], going.rect);
    // Inherit the outgoing pane's exact motion so the handover is seamless.
    going.dx = out.dx; going.dy = out.dy;
    going.ox = out.ox; going.oy = out.oy;
    going.svx = 0; going.svy = 0;
    going.phase = out.phase;
    going.lastX = going.lastY = null;
    writeRect(going);
    writeOffset(going);
    raise(going);
    keepHeldOnTop();

    going.pane.classList.add('is-dissolving');
    going.edge.classList.add('is-dissolving');
    going.pane.classList.remove('is-in');
    going.edge.classList.remove('is-in');
    going.pane.classList.remove('is-out');
    going.edge.classList.remove('is-out');
    void going.pane.offsetWidth;    // start the dissolve from 0, not from wherever
    going.pane.classList.add('is-in');
    going.edge.classList.add('is-in');

    setTimeout(function () {
      going.pane.classList.remove('is-dissolving');
      going.edge.classList.remove('is-dissolving');
      // A relayout may have re-dealt the seats in the meantime — never bench a
      // look that has since been given one of its own.
      if (out.dead || out.slot < 0 || out.slot !== going.slot) return;
      out.slot = -1;
      out.pane.classList.add('is-out');
      out.edge.classList.add('is-out');
    }, SWAP_MS);
    start();
  }

  /* ---------- drag ---------- */

  function release(p) {
    if (!p.grab) return;
    p.grab = null;
    p.edge.classList.remove('is-held');
    if (reduced.matches) {
      p.dx = 0; p.dy = 0; p.ox = 0; p.oy = 0;
      writeOffset(p);
      return;
    }
    // Hand the throw to the spring, capped so a flick can't rocket the window
    // across the figure.
    var v = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    var f = v > THROW_MAX ? THROW_MAX / v : 1;
    p.svx = p.vx * f;
    p.svy = p.vy * f;
    start();
  }

  function bind(p) {
    var pending = null;   // touch: waiting to see if this is a drag or a scroll

    function begin(ev) {
      p.grab = { id: ev.pointerId, px: ev.clientX, py: ev.clientY, tx: p.dx, ty: p.dy };
      p.vx = 0;
      p.vy = 0;
      p.edge.classList.add('is-held');
      raise(p);           // what you're holding is the top of the pile
      start();
    }

    p.edge.addEventListener('pointerdown', function (ev) {
      if (reduced.matches || !seated(p) || ev.button > 0) return;
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
      // finger once the visitor has scrolled. `scale` is sampled once a frame in
      // tick(), so this handler never forces a layout.
      p.grab.tx += (ev.clientX - p.grab.px) / scale;
      p.grab.ty += (ev.clientY - p.grab.py) / scale;
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
  // The phone regions are carved around the copy, and the copy is still moving
  // for the first ~1.8s: heroRise holds each line 26px low until its delay
  // elapses, and .hero-actions is the last to land. Re-measure when it settles —
  // and again on a couple of timers, because a cascade that was interrupted (a
  // fast scroll, a restored tab) may never fire animationend at all.
  var actions = hero.querySelector('.hero-actions');
  if (actions) actions.addEventListener('animationend', relayout);
  [700, 2000].forEach(function (ms) { setTimeout(relayout, ms); });
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
  // in a background tab) is pure battery. The swap countdown rides the same
  // clock, so a collage nobody can see doesn't rearrange itself either.
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
        setTimeout(function () {
          p.shown = true;
          if (p.slot < 0) return;      // benched: it fades in when its turn comes
          p.pane.classList.add('is-in');
          p.edge.classList.add('is-in');
        }, i * 110);
      });
      p.img.addEventListener('error', function () {
        // A look that will never render must also stop holding a seat, or the
        // collage keeps a hole where the packer thinks a window is.
        p.dead = true;
        p.slot = -1;
        p.pane.remove();
        p.edge.remove();
        relayout();
      });
      p.img.src = p.img.dataset.src;
      p.img.removeAttribute('data-src');
    });
    // Let the entrance finish before the collage starts rearranging itself.
    setTimeout(function () { choreoOn = true; start(); },
               panes.length * 110 + SWAP_LEAD);
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
