// MTG Deck Tools Agent Bench: small progressive enhancements. The pages work without it.
(function () {
  'use strict';
  var root = document.documentElement;

  // ---- Theme toggle -------------------------------------------------------
  var toggle = document.querySelector('.theme-toggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var current = root.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
      var next = current === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      try { localStorage.setItem('theme', next); } catch (e) { /* private mode */ }
    });
  }

  // ---- Tooltips: card images (lazy, on demand) and chart tips --------------
  var tip = document.getElementById('card-tip');
  var dataEl = document.getElementById('card-data');
  var cards = {};
  try { cards = dataEl ? JSON.parse(dataEl.textContent || '{}') : {}; } catch (e) { cards = {}; }
  var imgCache = {};
  var current = null;

  function scryfall(name) {
    return 'https://api.scryfall.com/cards/named?exact=' + encodeURIComponent(name.split(' // ')[0]) + '&format=image&version=normal';
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }

  function cardInfo(name) {
    var c = cards[name];
    if (!c) return '<div class="tip-name">' + esc(name) + '</div>';
    var stats = [];
    if (c[4] != null) stats.push('GIH WR <b>' + (c[4] * 100).toFixed(1) + '%</b>');
    if (c[5] != null) stats.push('ATA <b>' + c[5].toFixed(1) + '</b>');
    return '<div class="tip-name">' + esc(name) + (c[0] ? ' <span class="tip-cost">' + esc(c[0]) + '</span>' : '') + '</div>' +
      (stats.length ? '<div class="tip-stats">' + stats.join(' · ') + ' <span class="tip-src">17Lands</span></div>' : '');
  }

  function oracle(name) {
    var c = cards[name];
    if (!c || !(c[1] || c[3])) return '<div class="tip-oracle muted">No card text available.</div>';
    return '<div class="tip-oracle"><div class="tip-type">' + esc(c[1]) + (c[2] ? ' · ' + esc(c[2]) : '') + '</div>' + esc(c[3]).replace(/\n/g, '<br>') + '</div>';
  }

  function place(x, y) {
    var r = tip.getBoundingClientRect();
    var vw = window.innerWidth, vh = window.innerHeight;
    var left = x + 16, top = y + 16;
    if (left + r.width > vw - 8) left = Math.max(8, x - r.width - 16);
    if (top + r.height > vh - 8) top = Math.max(8, vh - r.height - 8);
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  function showCard(el, x, y) {
    var name = el.getAttribute('data-card');
    if (!name) return;
    current = el;
    tip.className = 'card-tip card-mode';
    tip.innerHTML = '';
    var img = imgCache[name];
    if (!img) {
      img = new Image();
      img.alt = name;
      img.width = 244;
      img.height = 340;
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.onerror = function () { img.dataset.failed = '1'; if (current && current.getAttribute('data-card') === name) showCard(current, lastX, lastY); };
      img.src = scryfall(name);
      imgCache[name] = img;
    }
    if (!img.dataset.failed) tip.appendChild(img);
    var info = document.createElement('div');
    info.className = 'tip-info';
    info.innerHTML = cardInfo(name) + (img.dataset.failed ? oracle(name) : '');
    tip.appendChild(info);
    tip.hidden = false;
    place(x, y);
  }

  function showText(el, x, y) {
    current = el;
    tip.className = 'card-tip text-mode';
    tip.textContent = el.getAttribute('data-tip');
    tip.hidden = false;
    place(x, y);
  }

  function hide() { current = null; if (tip) tip.hidden = true; }

  var lastX = 0, lastY = 0;
  if (tip) {
    document.addEventListener('mouseover', function (e) {
      var t = e.target;
      if (!(t instanceof Element)) return;
      var c = t.closest('[data-card]');
      if (c) { if (c !== current) showCard(c, e.clientX, e.clientY); return; }
      var d = t.closest('[data-tip]');
      if (d) { if (d !== current) showText(d, e.clientX, e.clientY); return; }
      if (current) hide();
    });
    document.addEventListener('mousemove', function (e) {
      lastX = e.clientX; lastY = e.clientY;
      if (current && !tip.hidden) place(e.clientX, e.clientY);
    });
    document.addEventListener('focusin', function (e) {
      var t = e.target;
      if (t instanceof Element && t.matches('[data-card]')) {
        var r = t.getBoundingClientRect();
        showCard(t, r.left, r.bottom);
      }
    });
    document.addEventListener('focusout', hide);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });
    window.addEventListener('scroll', function () { if (current && current.hasAttribute('data-tip')) hide(); }, { passive: true });
    // Touch: tap a card name to toggle its image.
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!(t instanceof Element)) return;
      var c = t.closest('[data-card]');
      if (c && matchMedia('(hover: none)').matches) {
        e.preventDefault();
        if (current === c && !tip.hidden) hide(); else { var r = c.getBoundingClientRect(); showCard(c, r.left, r.bottom); }
        return;
      }
      var j = t.closest('[data-jump]');
      if (j) {
        var target = document.getElementById(j.getAttribute('data-jump'));
        if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); history.replaceState(null, '', '#' + target.id); }
        return;
      }
      if (!c && current && !t.closest('#card-tip')) hide();
    });
  }

  // ---- Sortable tables ------------------------------------------------------
  document.querySelectorAll('table.sortable').forEach(function (table) {
    var ths = table.querySelectorAll('thead th');
    ths.forEach(function (th, idx) {
      if (!th.dataset.sort) return;
      function sort() {
        var tbody = table.tBodies[0];
        var rows = Array.prototype.slice.call(tbody.rows);
        var dir = th.getAttribute('aria-sort') === 'descending' ? 1 : -1; // first click: descending for numbers
        if (!th.getAttribute('aria-sort') && th.dataset.sort === 'text') dir = 1;
        var numeric = th.dataset.sort === 'num';
        rows.sort(function (a, b) {
          var ca = a.cells[idx], cb = b.cells[idx];
          var va = ca ? (ca.dataset.v !== undefined ? ca.dataset.v : ca.textContent) : '';
          var vb = cb ? (cb.dataset.v !== undefined ? cb.dataset.v : cb.textContent) : '';
          if (numeric) {
            var na = va === '' ? NaN : Number(va), nb = vb === '' ? NaN : Number(vb);
            if (isNaN(na) && isNaN(nb)) return 0;
            if (isNaN(na)) return 1; // blanks last
            if (isNaN(nb)) return -1;
            return (na - nb) * dir;
          }
          return String(va).localeCompare(String(vb)) * dir;
        });
        ths.forEach(function (o) { o.removeAttribute('aria-sort'); });
        th.setAttribute('aria-sort', dir === 1 ? 'ascending' : 'descending');
        rows.forEach(function (r) { tbody.appendChild(r); });
      }
      th.addEventListener('click', sort);
      th.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sort(); } });
    });
  });

  // ---- Table filter --------------------------------------------------------
  document.querySelectorAll('.table-filter').forEach(function (input) {
    var table = document.getElementById(input.dataset.for);
    if (!table) return;
    input.addEventListener('input', function () {
      var q = input.value.trim().toLowerCase();
      Array.prototype.forEach.call(table.tBodies[0].rows, function (r) {
        r.hidden = q !== '' && r.textContent.toLowerCase().indexOf(q) === -1;
      });
    });
  });

  // ---- Segmented controls --------------------------------------------------
  function activate(btn) {
    var group = btn.closest('.seg');
    if (!group) return;
    group.querySelectorAll('[data-filter-picks],[data-filter-seat]').forEach(function (b) { b.classList.remove('active'); });
    btn.classList.add('active');
  }
  document.querySelectorAll('[data-filter-picks]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      activate(btn);
      var picks = document.getElementById('picks');
      if (picks) picks.classList.toggle('only-disagree', btn.dataset.filterPicks === 'disagree');
    });
  });
  document.querySelectorAll('[data-filter-seat]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      activate(btn);
      var seat = btn.dataset.filterSeat;
      document.querySelectorAll('.pbp .dec').forEach(function (d) { d.hidden = !!seat && d.dataset.seat !== seat; });
    });
  });
  document.querySelectorAll('[data-toggle-views]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var open = btn.classList.toggle('active');
      btn.textContent = open ? 'Collapse views' : 'Expand views';
      document.querySelectorAll('.pbp details.view').forEach(function (d) { d.open = open; });
    });
  });
})();
