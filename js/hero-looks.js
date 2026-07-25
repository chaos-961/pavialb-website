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
 * the figure, then glides back to its seat the moment you let go.
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
 * part of the hero on screen and clear of the copy, and the five panes are laid
 * into what's left — on her, never touching each other, and in a fresh
 * arrangement every visit.
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

  /* Windows are packed at runtime, not hand-placed: fresh positions every visit,
     never touching each other, always on her at every viewport. Mostly tall
     panes — a vertical cut follows the line of a dress — with two turned
     horizontal for the collage rhythm; the wide ones are dealt to the roomiest
     cells, where a squat rectangle still shows a real stretch of the outfit. */
  var ASPECT = { landscape: 1.60, portrait: 1.50 };  // tall shape used for grid scoring
  var WIDE = 0.68;        // the horizontal panes' height / width cap
  var TALL_MIN = 1.1;     // a vertical pane is at least this much taller than wide
  var N_WIDE = 2;         // how many go horizontal (1 when only three panes fit)
  var GAP = 8;            // clear space kept between neighbours, px
  var OUTGROW = 26;       // a cell may overhang her outline by this much per side —
                          //   a pane that's mostly fabric still reads as her
                          //   outfit, and the slack is worth a visibly bigger box
  // Below MIN a pane shows a smear rather than an outfit and is not worth
  // placing. Everything above it is fair game — planFor packs as many panes as
  // fit and the grid search maximises their size within that.
  var MIN = { landscape: { w: 40, h: 64 }, portrait: { w: 34, h: 54 } };
  var LEAST = 3;          // never bother with fewer than this

  /* Insets that keep the panes inside the part of the hero a visitor can see.
     Landscape only has to clear the sticky header and the seam where the page
     sheet slides up; portrait's real constraint is the copy, and that's measured
     live rather than guessed (see regionsFor). */
  var MARGIN = {
    // The hero already begins below the sticky header, so the top inset is just
    // breathing room — her shoulders (SILHOUETTE's first band) are what actually
    // sets the ceiling at almost every size. Keeping it small is what leaves a
    // rotated phone, whose hero is barely 320px tall, enough height to work with.
    landscape: { top: 12, right: 6, bottom: 22 },
    portrait: { top: 8, right: 6, bottom: 22 },
  };

  /* Feel. Ported from the bssaub perk-field bubbles, minus the physics engine:
     a grab that follows with a little lag, a hard ceiling on how far a pane can
     travel, and a glide home that begins the moment you let go. Fixed duration
     rather than a spring, so it lands the same way from far and from near. */
  var GRAB_FOLLOW = 0.34;   // fraction of the pointer gap closed per 60fps step
  var ROAM = 44;            // how far past her outline a dragged pane may go, px
  var RETURN_MS = 2080;     // release -> home, starting the moment you let go
  var DRIFT_PX = 3.5;       // idle breathing so they read as grabbable
  var DRIFT_MS = 9000;
  var TOUCH_SLOP = 7;       // px of horizontal intent before a touch drag starts

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
    return {
      box: box,
      portrait: portrait,
      aspect: portrait ? ASPECT.portrait : ASPECT.landscape,
      min: portrait ? MIN.portrait : MIN.landscape,
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

     Horizontal bounds are loose here on purpose; the packer clips every cell to
     her outline at that cell's own height, which is what actually keeps panes on
     fabric instead of on wall. */
  function regionsFor(ctx) {
    var box = ctx.box;
    var m = ctx.portrait ? MARGIN.portrait : MARGIN.landscape;
    var wide = { l: 1, r: 0 };
    SILHOUETTE.forEach(function (b) {
      wide.l = Math.min(wide.l, b[1]);
      wide.r = Math.max(wide.r, b[2]);
    });
    var gL = Math.max(ctx.map.x(fromMasterX(wide.l, ctx.portrait)), 4);
    var gR = Math.min(ctx.map.x(fromMasterX(wide.r, ctx.portrait)), box.w - m.right);
    var gT = Math.max(ctx.map.y(fromMasterY(SILHOUETTE[0][0], ctx.portrait)), m.top);
    var gB = Math.min(ctx.map.y(fromMasterY(1, ctx.portrait)), box.h - m.bottom);

    // The drag range: anywhere on her, and a little beyond — the pane may leave
    // its seat entirely and ride the whole figure, it just can't wander off into
    // the empty wall (where it would show nothing) or off screen.
    roam = {
      l: Math.max(gL - ROAM, 2),
      t: Math.max(gT - ROAM, 2),
      r: Math.min(gR + ROAM, box.w - 2),
      b: Math.min(gB + ROAM, box.h - 2),
    };

    var out = [];
    var push = function (x, y, w, h) {
      if (w >= ctx.min.w + GAP && h >= ctx.min.h + GAP) out.push({ x: x, y: y, w: w, h: h });
    };

    if (ctx.portrait) {
      // Three strips, stacked and disjoint — the packer grids each one on its own,
      // so they must never overlap each other.
      var textB = Math.max(gT, bottomOf('.hero-text') + 12);
      var actT = Math.max(textB, Math.min(gB, topOf('.hero-actions', gB) - 10));
      var copyR = Math.max(gL, rightOf('.hero-text, .hero-copy h1') + 12);
      var actR = Math.max(gL, rightOf('.hero-actions .btn') + 12);
      push(copyR, gT, gR - copyR, textB - gT);
      push(gL, textB, gR - gL, actT - textB);
      push(actR, actT, gR - actR, gB - actT);
    } else {
      // Landscape phones and small tablets put the copy over the same half of the
      // frame she stands in; desktops don't (her column starts well right of the
      // headline's 760px cap).
      var left = box.w < 960
        ? Math.max(gL, rightOf('.hero-text, .hero-actions .btn') + 12)
        : gL;
      push(left, gT, gR - left, gB - gT);
    }
    return out;
  }

  var roam = null;   // her on-screen bounds + ROAM, refreshed on every relayout

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

  /* One cell of a strip's grid, clipped to her outline at that cell's height.
     Null when what's left is too narrow to hold a pane — those cells sit over
     bare wall and simply never get used. */
  function cellFor(ctx, reg, g, col, row) {
    var y = reg.y + row * g.ch + GAP / 2;
    var h = g.ch - GAP;
    var band = outlineOver(
      toMasterV(ctx.map.v(y), ctx.portrait),
      toMasterV(ctx.map.v(y + h), ctx.portrait),
    );
    if (!band) return null;
    var x = Math.max(reg.x + col * g.cw + GAP / 2,
                     ctx.map.x(fromMasterX(band.l, ctx.portrait)) - OUTGROW);
    var right = Math.min(reg.x + (col + 1) * g.cw - GAP / 2,
                         ctx.map.x(fromMasterX(band.r, ctx.portrait)) + OUTGROW);
    return right - x >= ctx.min.w ? { x: x, y: y, w: right - x, h: h } : null;
  }

  /* Best grid for k panes in one strip. Every (cols, rows) that holds k is tried;
     the pane size a grid affords is the k-th largest of its usable cells, since
     that is the smallest pane it would actually place; the biggest wins, with
     spare cells only breaking ties. Scatter comes from the random cell draw and
     the in-cell jitter, not from paying pane size for empties. */
  function gridFor(ctx, reg, k, aspect) {
    var all = [];
    var top = 0;
    for (var cols = 1; cols <= k; cols++) {
      var need = Math.ceil(k / cols);
      for (var rows = need; rows <= need + 1; rows++) {
        var g = { cols: cols, rows: rows, cw: reg.w / cols, ch: reg.h / rows };
        if (g.cw - GAP < ctx.min.w || g.ch - GAP < ctx.min.h) continue;
        var cells = [];
        for (var r = 0; r < rows; r++) {
          for (var c = 0; c < cols; c++) {
            var cell = cellFor(ctx, reg, g, c, r);
            if (cell) cells.push(cell);
          }
        }
        if (cells.length < k) continue;
        var sizes = cells.map(function (cell) {
          return Math.min(cell.w, cell.h / aspect);
        }).sort(function (a, b) { return b - a; });
        var pw = sizes[k - 1];
        if (pw < ctx.min.w || pw * aspect < ctx.min.h) continue;
        g.cells = cells;
        g.pw = pw;
        g.spare = cells.length - k;
        all.push(g);
        top = Math.max(top, pw);
      }
    }
    // Size wins outright; spare cells only break ties. (An earlier version let a
    // near-size grid win on scatter, and it kept costing a fifth of the pane.)
    var best = null;
    all.forEach(function (g) {
      if (!best || g.pw > best.pw || (g.pw === best.pw && g.spare > best.spare)) best = g;
    });
    return best;
  }

  /* How to split n panes across the strips. Brute force — three strips and five
     panes is 21 combinations — scored on the SMALLEST pane it produces, so the
     five come out as a set rather than one hero and four crumbs. */
  function allocate(ctx, regions, n, aspect) {
    var best = null;
    var counts = [];
    (function walk(idx, left) {
      if (idx === regions.length) {
        if (left) return;
        var grids = [];
        var minPw = Infinity;
        for (var j = 0; j < regions.length; j++) {
          if (!counts[j]) { grids.push(null); continue; }
          var g = gridFor(ctx, regions[j], counts[j], aspect);
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

  /* How many panes the room can actually carry: as many as will FIT, full stop.
     allocate() already refuses anything under MIN, so the first k that packs is
     five readable panes whenever five are possible, and only a genuinely cramped
     fold steps down to four or three. (An earlier version preferred fewer-but-
     bigger; on a mid-size phone that quietly turned five outfits into three,
     which read as broken rather than generous.) */
  function planFor(ctx, regions, n) {
    for (var k = n; k >= LEAST; k--) {
      var plan = allocate(ctx, regions, k, ctx.aspect);
      if (plan) { plan.n = k; return plan; }
    }
    return null;
  }

  function pack(ctx, regions, n) {
    var plan = regions.length ? planFor(ctx, regions, n) : null;
    if (!plan) return [];

    seed = SEED;
    var out = [];
    var wideLeft = plan.n >= 4 ? N_WIDE : 1;
    regions.forEach(function (reg, j) {
      var k = plan.counts[j];
      var g = plan.grids[j];
      if (!k || !g) return;
      // Roomiest cells first, then shuffled among them: panes land where there is
      // most of her, but not in the same arrangement twice.
      var pool = g.cells.slice().sort(function (a, b) { return b.w - a.w; });
      var chosen = shuffle(pool.slice(0, k + g.spare)).slice(0, k);
      // The horizontal panes go to the widest cells picked — with a floor on the
      // height they'd come out at, because a squat rectangle in a small cell is
      // a sliver, not a window.
      var wide = chosen.filter(function (c) {
        return Math.min(c.w, c.h / WIDE) * WIDE >= ctx.min.h * 0.8;
      }).sort(function (a, b) { return b.w - a.w; }).slice(0, Math.max(0, wideLeft));
      wideLeft -= wide.length;
      chosen.forEach(function (cell) {
        // The pane IS its cell — the gap between neighbours is already carved
        // out of the grid, so every pixel of cell is pane. Only the shape is
        // constrained: a horizontal pane is capped squat (WIDE), a vertical one
        // must stay taller than wide (TALL_MIN), and the trim that enforces the
        // shape is what leaves the sliver of jitter room.
        var pw, ph;
        if (wide.indexOf(cell) >= 0) {
          pw = cell.w;
          ph = Math.min(cell.h, pw * WIDE);
        } else {
          ph = cell.h;
          pw = Math.min(cell.w, ph / TALL_MIN);
        }
        out.push({
          x: Math.round(cell.x + centred() * Math.max(0, cell.w - pw)),
          y: Math.round(cell.y + rnd() * Math.max(0, cell.h - ph)),
          w: Math.round(pw),
          h: Math.round(ph),
        });
      });
    });
    // Shuffle so the five outfits are not grouped strip by strip.
    return shuffle(out);
  }

  function layout(baseImg) {
    var ctx = contextFor(baseImg);
    var rects = ctx ? pack(ctx, regionsFor(ctx), panes.length) : [];
    hero.classList.toggle('has-looks', rects.length > 0);
    panes.forEach(function (p, i) {
      p.rect = rects[i] || null;
      p.pane.classList.toggle('is-out', !p.rect);
      p.edge.classList.toggle('is-out', !p.rect);
      if (!p.rect) return;
      writeRect(p);
      writeOffset(p);
    });
    return rects.length > 0;
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

  // Keep the dragged pane inside her figure (plus ROAM): the box, not the
  // pointer, is what stops at the edge, so it never slides out onto bare wall.
  function clampOffset(p) {
    if (!roam || !p.rect) return;
    p.dx = Math.min(Math.max(p.dx, roam.l - p.rect.x), roam.r - (p.rect.x + p.rect.w));
    p.dy = Math.min(Math.max(p.dy, roam.t - p.rect.y), roam.b - (p.rect.y + p.rect.h));
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
        // Starts home the moment you let go, at an unhurried glide. Home is the
        // DRIFT position, not zero: landing on a hard zero and then handing back
        // to a drift that's mid-swing puts a visible hop at the end of every
        // release.
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
