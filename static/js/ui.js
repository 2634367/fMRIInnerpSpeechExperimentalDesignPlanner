/* fMRI Experimental Design Planner - interface layer.
 *
 * Controls are declarative: every slider, field and toggle names a dot-path
 * into the design state.  Editing any control writes the state, re-solves the
 * whole design and refreshes every registered control and view, so a change
 * anywhere propagates everywhere. */

(function (global) {
  'use strict';

  var M = global.PlannerModel;
  var H = M.helpers;

  var AIM_COLOURS = { glm: '#719949', mvpa: '#CBA052', ts: '#046A38' };

  var App = {
    boot: null,
    state: null,
    report: null,
    protocols: {},
    activePanel: 'overview',
    controls: [],
    views: [],
    panels: {},
    railItems: {},
    suspend: false
  };

  /* ------------------------------------------------------------ dom util */

  function h(tag, attrs, kids) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === null || value === undefined || value === false) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key === 'style') node.setAttribute('style', value);
        else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2).toLowerCase(), value);
        else node.setAttribute(key, value === true ? '' : value);
      });
    }
    (kids || []).forEach(function (kid) {
      if (kid === null || kid === undefined || kid === false) return;
      node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    });
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function getPath(root, path) {
    return path.split('.').reduce(function (acc, key) {
      return acc === undefined || acc === null ? undefined : acc[key];
    }, root);
  }

  function setPath(root, path, value) {
    var keys = path.split('.');
    var last = keys.pop();
    var target = keys.reduce(function (acc, key) {
      if (acc[key] === undefined || acc[key] === null) acc[key] = {};
      return acc[key];
    }, root);
    target[last] = value;
  }

  function toast(message, kind) {
    var host = document.getElementById('toasts');
    var node = h('div', { class: 'toast' + (kind ? ' ' + kind : ''), text: message });
    host.appendChild(node);
    setTimeout(function () {
      node.style.transition = 'opacity .25s';
      node.style.opacity = '0';
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 260);
    }, kind === 'bad' ? 5200 : 2600);
  }

  function copy(text, label) {
    function done() { toast((label || 'Copied') + ' to clipboard', 'ok'); }
    function fallback() {
      var area = h('textarea', { style: 'position:fixed;left:-9999px;top:0' });
      area.value = text;
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); done(); }
      catch (err) { toast('Copy failed; select the text manually.', 'bad'); }
      document.body.removeChild(area);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else { fallback(); }
  }

  /* ---------------------------------------------------------- registries */

  function registerControl(sync, owner) { App.controls.push({ sync: sync, owner: owner || null }); }
  function dropControls(owner) {
    App.controls = App.controls.filter(function (entry) { return entry.owner !== owner; });
  }
  function registerView(render) { App.views.push({ render: render }); return render; }

  /* ------------------------------------------------------------ controls */

  function paintRange(input) {
    var min = parseFloat(input.min) || 0;
    var max = parseFloat(input.max);
    var value = parseFloat(input.value);
    var pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
    input.style.setProperty('--fill', H.clamp(pct, 0, 100) + '%');
  }

  function slider(options) {
    var decimals = options.decimals === undefined ? 0 : options.decimals;
    var range = h('input', {
      type: 'range', min: options.min, max: options.max,
      step: options.step || 1, class: options.gold ? 'gold' : ''
    });
    var box = h('input', {
      type: 'number', min: options.min, max: options.max, step: options.step || 1
    });

    /* A slider either owns a dot-path into the state or, when the quantity is
     * derived (scanner hours per aim, solved session counts), a get/set pair. */
    function readValue() {
      return H.num(options.get ? options.get(App.state, App.report)
        : getPath(App.state, options.path));
    }

    function commit(raw) {
      var value = H.clamp(H.num(raw), options.min, options.max);
      if (decimals >= 0) value = H.round(value, decimals);
      if (options.set) options.set(value, App.state);
      else setPath(App.state, options.path, value);
      if (options.onChange) options.onChange(value);
      App.refresh();
    }

    range.addEventListener('input', function () { commit(range.value); });
    box.addEventListener('change', function () { commit(box.value); });
    box.addEventListener('blur', function () { commit(box.value); });

    var node = h('div', { class: 'control' }, [
      h('label', {}, [
        h('span', { text: options.label }),
        options.hint ? h('span', { class: 'hint', text: options.hint }) : null
      ]),
      range,
      h('div', { class: 'value-box' }, [
        box,
        options.unit ? h('span', { class: 'unit', text: options.unit }) : null
      ])
    ]);

    registerControl(function () {
      var value = readValue();
      if (document.activeElement !== range) range.value = value;
      if (document.activeElement !== box) box.value = H.round(value, Math.max(decimals, 0));
      paintRange(range);
      var off = options.disabledWhen ? options.disabledWhen(App.state) : false;
      range.disabled = !!off;
      box.disabled = !!off;
      node.style.opacity = off ? '.5' : '1';
      if (options.dynamicMax) {
        var top = options.dynamicMax(App.state, App.report);
        if (isFinite(top) && top > options.min) {
          range.max = top; box.max = top;
          paintRange(range);
        }
      }
    }, options.owner);
    return node;
  }

  function field(options) {
    var input;
    if (options.type === 'select') {
      input = h('select', {});
      (options.options || []).forEach(function (option) {
        input.appendChild(h('option', { value: option.value, text: option.label }));
      });
    } else if (options.type === 'textarea') {
      input = h('textarea', { rows: options.rows || 3 });
    } else {
      input = h('input', { type: options.type || 'text', step: options.step, min: options.min, max: options.max });
    }

    function commit() {
      var value = options.type === 'number' ? H.num(input.value) : input.value;
      setPath(App.state, options.path, value);
      if (options.onChange) options.onChange(value);
      App.refresh();
    }
    input.addEventListener('change', commit);
    if (options.type !== 'select') input.addEventListener('blur', commit);

    var node = h('div', { class: 'control' + (options.stack ? ' stack' : ' wide') }, [
      h('label', {}, [
        h('span', { text: options.label }),
        options.hint ? h('span', { class: 'hint', text: options.hint }) : null
      ]),
      input
    ]);

    registerControl(function () {
      var value = getPath(App.state, options.path);
      if (document.activeElement !== input) {
        input.value = value === undefined || value === null ? '' : value;
      }
      var off = options.disabledWhen ? options.disabledWhen(App.state) : false;
      input.disabled = !!off;
    }, options.owner);
    return node;
  }

  function checkbox(options) {
    var input = h('input', { type: 'checkbox' });
    input.addEventListener('change', function () {
      setPath(App.state, options.path, input.checked);
      if (options.onChange) options.onChange(input.checked);
      App.refresh();
    });
    registerControl(function () { input.checked = !!getPath(App.state, options.path); });
    return h('label', { class: 'checkline' }, [input, h('span', { text: options.label })]);
  }

  function segmented(options) {
    var buttons = options.options.map(function (option) {
      var button = h('button', { type: 'button', text: option.label, title: option.hint || '' });
      button.addEventListener('click', function () {
        setPath(App.state, options.path, option.value);
        if (options.onChange) options.onChange(option.value);
        App.refresh();
      });
      button.dataset.value = option.value;
      return button;
    });
    var wrap = h('div', { class: 'seg' }, buttons);
    registerControl(function () {
      var value = getPath(App.state, options.path);
      buttons.forEach(function (button) {
        button.classList.toggle('active', button.dataset.value === String(value));
      });
    });
    return h('div', { class: 'control wide' }, [
      h('label', {}, [
        h('span', { text: options.label }),
        options.hint ? h('span', { class: 'hint', text: options.hint }) : null
      ]),
      wrap
    ]);
  }

  function card(title, note, body, headExtra) {
    return h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h3', { text: title }),
        headExtra || (note ? h('span', { class: 'head-note', text: note }) : null)
      ]),
      h('div', { class: 'card-body' }, body)
    ]);
  }

  function flushCard(title, note, body, headExtra) {
    var node = card(title, note, [], headExtra);
    node.classList.add('flush');
    var holder = node.querySelector('.card-body');
    (body || []).forEach(function (kid) { holder.appendChild(kid); });
    return node;
  }

  function readoutCell(key, value, modifier) {
    return h('div', { class: 'cell' + (modifier ? ' ' + modifier : '') }, [
      h('div', { class: 'k', text: key }),
      h('div', { class: 'v', html: value })
    ]);
  }

  function dataTable(headers, rows, options) {
    options = options || {};
    var thead = h('thead', {}, [h('tr', {}, headers.map(function (header) {
      return h('th', { class: header.num ? 'num' : '', text: header.label || header });
    }))]);
    var body = h('tbody', {}, rows.map(function (row) {
      return h('tr', { class: row.className || '' }, (row.cells || row).map(function (cell) {
        var content = cell && typeof cell === 'object' ? cell : { text: cell };
        return h('td', {
          class: (content.num ? 'num ' : '') + (content.className || ''),
          html: content.html,
          text: content.html ? null : (content.text === undefined ? '' : String(content.text))
        });
      }));
    }));
    var table = h('table', { class: 'data' }, [thead, body]);
    return options.scroll === false ? table : h('div', { class: 'table-scroll' }, [table]);
  }

  /* --------------------------------------------------------------- plots */

  function sizeCanvas(canvas, height) {
    var ratio = global.devicePixelRatio || 1;
    var width = canvas.parentNode.clientWidth || 640;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.height = height + 'px';
    var context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { context: context, width: width, height: height };
  }

  var TICK_STEPS = [1, 2, 5, 10, 15, 20, 30, 60, 120, 180, 300, 600, 900, 1800];

  function niceStep(span, target) {
    for (var i = 0; i < TICK_STEPS.length; i += 1) {
      if (span / TICK_STEPS[i] <= target) return TICK_STEPS[i];
    }
    return TICK_STEPS[TICK_STEPS.length - 1];
  }

  /* HRF regressor trace.  `view` carries the visible window so the same draw
   * routine serves the fitted plot and any zoomed or panned state. */
  function drawRegressors(canvas, efficiency, view) {
    var height = view.height || 300;
    var box = sizeCanvas(canvas, height);
    var context = box.context;
    context.clearRect(0, 0, box.width, height);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, box.width, height);

    var series = efficiency && efficiency.series;
    if (!series || !series.t.length) {
      context.fillStyle = '#6b767b';
      context.font = '12px ' + '"Inter", sans-serif';
      context.fillText('No simulated run to plot', 14, height / 2);
      return null;
    }

    var total = series.t[series.t.length - 1] || 1;
    var minSpan = Math.min(total, 12);
    var span = H.clamp(view.span || total, minSpan, total);
    var start = H.clamp(view.start || 0, 0, Math.max(0, total - span));
    var stop = start + span;

    var padLeft = 46, padRight = 14, padTop = 30, padBottom = 26;
    var plotWidth = Math.max(10, box.width - padLeft - padRight);
    var plotHeight = Math.max(10, height - padTop - padBottom);

    function xAt(t) { return padLeft + ((t - start) / span) * plotWidth; }

    /* Only the visible window sets the vertical scale, so zooming in on a
     * quiet stretch actually shows what is happening there. */
    var first = 0, last = series.t.length - 1;
    while (first < last && series.t[first + 1] < start) first += 1;
    while (last > first && series.t[last - 1] > stop) last -= 1;

    var maxValue = 0;
    for (var i = first; i <= last; i += 1) {
      maxValue = Math.max(maxValue, Math.abs(series.question[i]),
        Math.abs(series.answerYes[i]), Math.abs(series.answerNo[i]));
    }
    if (!(maxValue > 0)) maxValue = 1;
    maxValue *= 1.08;

    function yAt(value) { return padTop + plotHeight / 2 - (value / maxValue) * (plotHeight / 2); }

    /* Event bands: where the prompt and the answer windows actually sit. */
    var events = efficiency.events || {};
    function band(list, colour) {
      if (!list) return;
      context.fillStyle = colour;
      list.forEach(function (event) {
        if (event.onset > stop || event.onset + event.duration < start) return;
        var x1 = xAt(Math.max(start, event.onset));
        var x2 = xAt(Math.min(stop, event.onset + event.duration));
        context.fillRect(x1, padTop, Math.max(1.2, x2 - x1), plotHeight);
      });
    }
    band(events.question, 'rgba(0, 72, 43, .10)');
    band(events.answerYes, 'rgba(203, 160, 82, .22)');
    band(events.answerNo, 'rgba(113, 153, 73, .20)');

    /* Horizontal gridlines and value labels. */
    context.font = '9.5px "SF Mono", Menlo, monospace';
    [-1, -0.5, 0, 0.5, 1].forEach(function (level) {
      var y = yAt(level * maxValue);
      context.strokeStyle = level === 0 ? '#b9c0b4' : '#EFEEE9';
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(padLeft, y);
      context.lineTo(padLeft + plotWidth, y);
      context.stroke();
      context.fillStyle = '#6b767b';
      context.fillText(H.round(level * maxValue, 2).toString(), 3, y + 3);
    });

    /* Time axis. */
    var step = niceStep(span, 9);
    var tick = Math.ceil(start / step) * step;
    context.textAlign = 'center';
    for (; tick <= stop + 0.001; tick += step) {
      var x = xAt(tick);
      context.strokeStyle = '#F2F1F0';
      context.beginPath();
      context.moveTo(x, padTop);
      context.lineTo(x, padTop + plotHeight);
      context.stroke();
      context.fillStyle = '#6b767b';
      context.fillText(H.round(tick, tick < 10 ? 1 : 0) + 's', x, height - 8);
    }
    context.textAlign = 'left';

    context.strokeStyle = '#d8dcd5';
    context.strokeRect(padLeft + 0.5, padTop + 0.5, plotWidth, plotHeight);

    function line(values, colour, width) {
      context.strokeStyle = colour;
      context.lineWidth = width;
      context.lineJoin = 'round';
      context.beginPath();
      var started = false;
      for (var k = first; k <= last; k += 1) {
        var px = xAt(series.t[k]);
        var py = yAt(values[k]);
        if (!started) { context.moveTo(px, py); started = true; } else context.lineTo(px, py);
      }
      context.stroke();
    }
    line(series.question, '#00482B', 1.4);
    line(series.answerNo, '#719949', 1.8);
    line(series.answerYes, '#CBA052', 1.8);

    /* Legend. */
    var legend = [
      ['Question', '#00482B'],
      ['Answer yes', '#CBA052'],
      ['Answer no', '#719949']
    ];
    var lx = padLeft;
    context.font = '10px "Inter", sans-serif';
    legend.forEach(function (item) {
      context.strokeStyle = item[1];
      context.lineWidth = 2.4;
      context.beginPath();
      context.moveTo(lx, 14);
      context.lineTo(lx + 16, 14);
      context.stroke();
      context.fillStyle = '#3d4a4f';
      context.fillText(item[0], lx + 21, 17);
      lx += 26 + context.measureText(item[0]).width + 16;
    });
    context.fillStyle = '#6b767b';
    context.font = '9.5px "SF Mono", Menlo, monospace';
    context.textAlign = 'right';
    context.fillText(H.round(start, 1) + ' - ' + H.round(stop, 1) + ' s of '
      + H.round(total, 0) + ' s', box.width - padRight, 17);
    context.textAlign = 'left';

    /* Hover crosshair. */
    var hover = null;
    if (view.hoverX !== null && view.hoverX !== undefined
      && view.hoverX >= padLeft && view.hoverX <= padLeft + plotWidth) {
      var time = start + ((view.hoverX - padLeft) / plotWidth) * span;
      var index = first;
      var best = Infinity;
      for (var j = first; j <= last; j += 1) {
        var distance = Math.abs(series.t[j] - time);
        if (distance < best) { best = distance; index = j; }
      }
      var hx = xAt(series.t[index]);
      context.strokeStyle = 'rgba(16, 24, 32, .35)';
      context.lineWidth = 1;
      context.setLineDash([3, 3]);
      context.beginPath();
      context.moveTo(hx, padTop);
      context.lineTo(hx, padTop + plotHeight);
      context.stroke();
      context.setLineDash([]);
      [[series.question[index], '#00482B'], [series.answerYes[index], '#CBA052'],
        [series.answerNo[index], '#719949']].forEach(function (pair) {
        context.fillStyle = pair[1];
        context.beginPath();
        context.arc(hx, yAt(pair[0]), 3, 0, Math.PI * 2);
        context.fill();
      });
      hover = {
        t: series.t[index],
        question: series.question[index],
        answerYes: series.answerYes[index],
        answerNo: series.answerNo[index],
        x: hx
      };
    }

    return {
      start: start, span: span, total: total, hover: hover,
      padLeft: padLeft, plotWidth: plotWidth, minSpan: minSpan
    };
  }

  /* A pannable, zoomable regressor plot. */
  function regressorPlot() {
    var view = { start: 0, span: null, hoverX: null, height: 300 };
    var canvas = h('canvas', { class: 'zoomable' });
    var last = null;
    var efficiency = null;

    var reading = h('div', { class: 'plot-reading' });
    var zoomRange = h('input', { type: 'range', min: 1, max: 60, step: 0.5, value: 1 });

    function currentZoom() {
      if (!last || !last.total || !last.span) return 1;
      return last.total / last.span;
    }

    function paint() {
      last = drawRegressors(canvas, efficiency, view);
      if (last) {
        view.start = last.start;
        view.span = last.span;
        if (document.activeElement !== zoomRange) zoomRange.value = H.round(currentZoom(), 2);
        paintRange(zoomRange);
      }
      clear(reading);
      if (last && last.hover) {
        reading.appendChild(h('span', { class: 'mono', text: 't = ' + H.round(last.hover.t, 1) + ' s' }));
        reading.appendChild(h('span', { style: 'color:#00482B', text: 'question ' + H.round(last.hover.question, 3) }));
        reading.appendChild(h('span', { style: 'color:#AE8643', text: 'answer yes ' + H.round(last.hover.answerYes, 3) }));
        reading.appendChild(h('span', { style: 'color:#719949', text: 'answer no ' + H.round(last.hover.answerNo, 3) }));
      } else {
        reading.appendChild(h('span', {
          class: 'muted',
          text: 'Scroll to zoom, drag to pan, double-click to fit. Shaded bands are the question '
            + 'and answer windows.'
        }));
      }
    }

    function setZoom(factor, anchorTime) {
      if (!last) return;
      var span = H.clamp(last.total / Math.max(1, factor), last.minSpan, last.total);
      var anchor = anchorTime === undefined ? view.start + view.span / 2 : anchorTime;
      var fraction = view.span > 0 ? (anchor - view.start) / view.span : 0.5;
      view.span = span;
      view.start = H.clamp(anchor - fraction * span, 0, Math.max(0, last.total - span));
      paint();
    }

    function timeAt(clientX) {
      if (!last) return 0;
      var rect = canvas.getBoundingClientRect();
      var x = clientX - rect.left;
      return view.start + ((x - last.padLeft) / last.plotWidth) * view.span;
    }

    canvas.addEventListener('wheel', function (event) {
      if (!last) return;
      event.preventDefault();
      var direction = event.deltaY > 0 ? 1 / 1.18 : 1.18;
      setZoom(currentZoom() * direction, timeAt(event.clientX));
    }, { passive: false });

    var drag = null;
    canvas.addEventListener('mousedown', function (event) {
      if (!last) return;
      event.preventDefault();
      drag = { x: event.clientX, start: view.start };
      canvas.classList.add('grabbing');
    });
    canvas.addEventListener('mousemove', function (event) {
      if (drag || !last) return;
      view.hoverX = event.clientX - canvas.getBoundingClientRect().left;
      paint();
    });
    canvas.addEventListener('mouseleave', function () {
      if (view.hoverX === null) return;
      view.hoverX = null;
      paint();
    });
    /* Panning continues while the pointer is outside the canvas, so the drag
     * listeners - and only those - live on the window. */
    global.addEventListener('mousemove', function (event) {
      if (!drag || !last) return;
      var shift = (event.clientX - drag.x) / last.plotWidth * view.span;
      view.start = H.clamp(drag.start - shift, 0, Math.max(0, last.total - view.span));
      paint();
    });
    global.addEventListener('mouseup', function () {
      if (!drag) return;
      drag = null;
      canvas.classList.remove('grabbing');
    });
    canvas.addEventListener('dblclick', function () {
      view.start = 0;
      view.span = last ? last.total : null;
      paint();
    });
    zoomRange.addEventListener('input', function () {
      setZoom(H.num(zoomRange.value));
    });

    function button(label, title, action) {
      return h('button', { class: 'btn quiet sm', type: 'button', text: label, title: title, onclick: action });
    }

    var toolbar = h('div', { class: 'plot-toolbar' }, [
      h('span', { class: 'k', text: 'Zoom' }),
      zoomRange,
      button('-', 'Zoom out', function () { setZoom(currentZoom() / 1.6); }),
      button('+', 'Zoom in', function () { setZoom(currentZoom() * 1.6); }),
      button('Fit', 'Show the whole simulated run', function () {
        view.start = 0;
        view.span = last ? last.total : null;
        paint();
      }),
      button('First trial', 'Zoom to the opening trials', function () {
        if (!last) return;
        view.span = H.clamp(last.total / 8, last.minSpan, last.total);
        view.start = 0;
        paint();
      })
    ]);

    var node = h('div', {}, [
      toolbar,
      h('div', { class: 'plot-wrap tall' }, [canvas]),
      reading
    ]);

    return {
      node: node,
      render: function (nextEfficiency) {
        efficiency = nextEfficiency;
        paint();
      }
    };
  }

  function drawDesignMatrix(canvas, efficiency) {
    var view = sizeCanvas(canvas, 150);
    var context = view.context;
    context.clearRect(0, 0, view.width, view.height);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, view.width, view.height);
    var series = efficiency && efficiency.series;
    if (!series || !series.t.length) return;

    var columns = [series.question, series.answerYes, series.answerNo];
    var labels = ['Question', 'Answer yes', 'Answer no'];
    var padTop = 16, padBottom = 8;
    var gap = 14;
    var columnWidth = H.clamp((view.width - 24 - gap * (columns.length - 1)) / columns.length, 40, 190);
    var groupWidth = columnWidth * columns.length + gap * (columns.length - 1);
    var padLeft = Math.max(10, (view.width - groupWidth) / 2);
    var plotHeight = view.height - padTop - padBottom;
    var rows = series.t.length;

    columns.forEach(function (column, index) {
      var maxValue = Math.max.apply(null, column.map(Math.abs)) || 1;
      var x = padLeft + index * (columnWidth + gap);
      for (var r = 0; r < rows; r += 1) {
        var level = H.clamp(Math.abs(column[r]) / maxValue, 0, 1);
        var shade = Math.round(255 - level * 210);
        context.fillStyle = 'rgb(' + shade + ',' + Math.round(shade * 0.98) + ',' + Math.round(shade * 0.92) + ')';
        var y = padTop + (plotHeight * r) / rows;
        context.fillRect(x, y, columnWidth, Math.max(1, plotHeight / rows + 0.6));
      }
      context.strokeStyle = '#b9c0b4';
      context.lineWidth = 1;
      context.strokeRect(x + 0.5, padTop + 0.5, columnWidth, plotHeight);
      context.fillStyle = '#3d4a4f';
      context.font = '9.5px "SF Mono", Menlo, monospace';
      context.fillText(labels[index], x, 11);
    });

    context.fillStyle = '#6b767b';
    context.font = '9.5px "SF Mono", Menlo, monospace';
    context.fillText(rows + ' sampled volumes, time runs downwards', padLeft, view.height - 1);
  }

  /* --------------------------------------------------- allocation units */

  /* The three aim sliders can be driven in whichever unit the user is actually
   * thinking in: share of scanner time, hours of scanner time, or number of
   * sessions.  All three write the same underlying allocation. */

  function usableHours(state) {
    return H.num(state.budget.totalScannerHours)
      * (1 - H.clamp(H.num(state.budget.contingencyPct), 0, 90) / 100);
  }

  function allocationUnit() { return App.state.budget.allocationUnit || 'percent'; }

  function solvedSessions(id) {
    if (!App.report) return 0;
    var record = (App.report.totals.byAim || []).filter(function (a) { return a.id === id; })[0];
    return record ? record.sessions : 0;
  }

  /* Session sliders only mean anything when the solver is taking session counts
   * as given, so adopting that unit seeds the counts from the solved plan and
   * switches the solve mode across. */
  function adoptSessionUnit() {
    M.AIM_IDS.forEach(function (id) {
      if (App.state.budget.solveMode !== 'manual') {
        App.state.aims[id].sessions = solvedSessions(id);
      }
    });
    if (App.state.budget.solveMode !== 'manual') {
      App.state.budget.solveMode = 'manual';
      toast('Session sliders set the plan directly, so the solver moved to session-count mode', 'ok');
    }
  }

  function allocationUnitToggle(label) {
    return segmented({
      label: label || 'Slider units',
      hint: 'Share of scanner time, hours of scanner time, or number of sessions',
      path: 'budget.allocationUnit',
      options: M.ALLOCATION_UNITS.map(function (item) {
        return { value: item.id, label: item.label };
      }),
      onChange: function (value) { if (value === 'sessions') adoptSessionUnit(); }
    });
  }

  function allocationSlider(id, owner) {
    var aim = App.state.aims[id];
    var unit = allocationUnit();

    if (unit === 'hours') {
      return slider({
        owner: owner,
        label: aim.short,
        hint: 'Scanner hours for ' + aim.name + ', after contingency',
        min: 0, max: Math.max(1, H.round(usableHours(App.state), 1)), step: 0.5, decimals: 1, unit: 'h',
        gold: id === 'mvpa',
        get: function (state) {
          return H.num(state.aims[id].requestedPct) / 100 * usableHours(state);
        },
        set: function (value, state) {
          var pool = usableHours(state);
          state.aims[id].requestedPct = pool > 0 ? H.clamp(value / pool * 100, 0, 100) : 0;
          M.normaliseAllocation(state, id);
        },
        dynamicMax: function (state) { return Math.max(1, H.round(usableHours(state), 1)); },
        disabledWhen: function (state) { return !state.aims[id].enabled; }
      });
    }

    if (unit === 'sessions') {
      return slider({
        owner: owner,
        label: aim.short,
        hint: 'Sessions of ' + aim.name,
        min: 0, max: Math.max(1, Math.round(H.num(App.state.caps.maxSessionsTotal, 100))),
        step: 1, unit: 'sess',
        gold: id === 'mvpa',
        get: function (state) {
          return state.budget.solveMode === 'manual'
            ? H.num(state.aims[id].sessions) : solvedSessions(id);
        },
        set: function (value, state) {
          if (state.budget.solveMode !== 'manual') {
            M.AIM_IDS.forEach(function (other) {
              if (other !== id) state.aims[other].sessions = solvedSessions(other);
            });
            state.budget.solveMode = 'manual';
          }
          state.aims[id].sessions = Math.round(value);
        },
        dynamicMax: function (state) {
          return Math.max(1, Math.round(H.num(state.caps.maxSessionsTotal, 100)));
        },
        disabledWhen: function (state) { return !state.aims[id].enabled; }
      });
    }

    return slider({
      owner: owner,
      label: aim.short,
      hint: aim.name,
      path: 'aims.' + id + '.requestedPct',
      min: 0, max: 100, step: 0.5, decimals: 2, unit: '%',
      gold: id === 'mvpa',
      onChange: function () { M.normaliseAllocation(App.state, id); },
      disabledWhen: function (state) { return !state.aims[id].enabled; }
    });
  }

  /* Rebuilds the whole row set whenever the unit changes, so each slider is
   * built for the unit it is showing. */
  function allocationRows(owner, decorate) {
    var host = h('div', {});
    var signature = '';
    function render() {
      dropControls(owner);
      signature = allocationUnit();
      clear(host);
      M.AIM_IDS.forEach(function (id) {
        var row = allocationSlider(id, owner);
        if (decorate) decorate(id, row, owner);
        host.appendChild(row);
      });
    }
    /* Only the unit rebuilds the rows; the sliders read the solve mode live, so
     * a mode change mid-drag never pulls the input out from under the pointer. */
    registerView(function () {
      if (allocationUnit() !== signature) render();
    });
    render();
    return host;
  }

  function allocationBar() {
    var bar = h('div', { class: 'bar' });
    var legend = h('div', { class: 'bar-legend' });
    registerView(function (report) {
      clear(bar);
      clear(legend);
      report.aims.forEach(function (aim) {
        bar.appendChild(h('span', {
          style: 'width:' + H.clamp(aim.derived.sharePct, 0, 100) + '%;background:' + AIM_COLOURS[aim.id],
          title: aim.name + ': ' + H.round(aim.derived.sharePct, 1) + '% realised'
        }));
        legend.appendChild(h('span', {}, [
          h('i', { style: 'background:' + AIM_COLOURS[aim.id] }),
          h('span', {
            text: aim.short + '  ' + H.round(aim.derived.totalHours, 1) + ' h  '
              + aim.derived.sessions + ' sess  ' + H.round(aim.derived.sharePct, 1) + '%'
          })
        ]));
      });
    });
    return h('div', { class: 'mt' }, [bar, legend]);
  }

  /* ------------------------------------------------------------- metrics */

  function buildMetrics() {
    var host = document.getElementById('metrics');
    var definitions = [
      {
        key: 'Sessions',
        get: function (r) { return H.fmtNumber(r.totals.sessions); },
        sub: function (r) { return r.totals.weeks + ' wk'; }
      },
      {
        key: 'Questions',
        className: 'total',
        get: function (r) { return H.fmtNumber(r.totals.primaryQuestions); },
        sub: function (r) { return H.fmtNumber(r.totals.trials) + ' trials'; }
      }
    ];

    M.AIM_IDS.forEach(function (id) {
      definitions.push({
        key: App.state.aims[id].short,
        className: 'aim',
        colour: AIM_COLOURS[id],
        get: function (r) {
          var record = (r.totals.byAim || []).filter(function (a) { return a.id === id; })[0];
          return record ? H.fmtNumber(record.primaryQuestions) : '0';
        },
        sub: function (r) {
          var record = (r.totals.byAim || []).filter(function (a) { return a.id === id; })[0];
          if (!record) return 'not scheduled';
          return record.sessions + ' sess  ' + H.round(record.sharePct, 0) + '%';
        },
        flag: function (r) {
          var record = (r.totals.byAim || []).filter(function (a) { return a.id === id; })[0];
          if (!record) return 'warn';
          if (record.targetQuestions > 0
            && record.primaryQuestions < record.targetQuestions * 0.98) return 'warn';
          return '';
        }
      });
    });

    definitions.push(
      {
        key: 'Scanner hours',
        get: function (r) { return H.round(r.totals.hours, 1); },
        sub: function (r) { return 'of ' + H.round(r.budget.usableHours, 1) + ' usable'; },
        flag: function (r) {
          return r.totals.utilisationPct > 100 ? 'bad' : (r.totals.utilisationPct > 92 ? 'warn' : '');
        }
      },
      {
        key: 'Utilisation',
        get: function (r) { return H.round(r.totals.utilisationPct, 0) + '%'; },
        sub: function (r) { return H.round(r.totals.hoursRemaining, 1) + ' h left'; },
        flag: function (r) { return r.totals.utilisationPct > 100 ? 'bad' : ''; }
      },
      {
        key: 'Raw data',
        get: function (r) { return H.round(r.totals.dataGB, 0) + ' GB'; },
        sub: function (r) { return H.fmtNumber(r.totals.runs) + ' runs'; }
      },
      {
        key: 'Flags',
        get: function (r) { return r.warnings.length; },
        sub: function () { return 'constraints'; },
        flag: function (r) { return r.warnings.length ? 'warn' : ''; }
      }
    );

    var nodes = definitions.map(function (definition) {
      var value = h('div', { class: 'value' });
      var sub = h('div', { class: 'sub' });
      var chip = h('div', { class: 'metric' + (definition.className ? ' ' + definition.className : '') }, [
        h('div', { class: 'label', text: definition.key }), value, sub
      ]);
      if (definition.colour) chip.style.borderLeftColor = definition.colour;
      host.appendChild(chip);
      return { definition: definition, value: value, sub: sub };
    });

    registerView(function (report) {
      nodes.forEach(function (node) {
        node.value.textContent = node.definition.get(report);
        node.sub.textContent = node.definition.sub ? node.definition.sub(report) : '';
        node.value.className = 'value ' + (node.definition.flag ? node.definition.flag(report) : '');
      });
    });
  }

  /* -------------------------------------------------- simplified overview */

  function modalityTiles() {
    var host = h('div', { class: 'tile-row' });
    registerView(function (report) {
      clear(host);
      (report.totals.byAim || []).forEach(function (record) {
        var colour = AIM_COLOURS[record.id];
        var tile = h('div', { class: 'tile' }, [
          h('div', { class: 'name', text: record.short }),
          h('div', { class: 'objective', text: record.objective }),
          h('div', { class: 'big', html: H.fmtNumber(record.primaryQuestions) + ' <small>questions</small>' }),
          h('div', { class: 'rows' }, [
            h('div', { class: 'row' }, [h('span', { text: 'Total trials' }),
              h('b', { text: H.fmtNumber(record.trials) })]),
            h('div', { class: 'row' }, [h('span', { text: 'Control trials' }),
              h('b', { text: H.fmtNumber(record.controlTrials) })]),
            h('div', { class: 'row' }, [h('span', { text: 'Per session' }),
              h('b', { text: H.fmtNumber(record.questionsPerSession) })]),
            h('div', { class: 'row' }, [h('span', { text: 'Sessions' }),
              h('b', { text: record.sessions })]),
            h('div', { class: 'row' }, [h('span', { text: 'Scanner time' }),
              h('b', { text: H.round(record.hours, 1) + ' h' })]),
            h('div', { class: 'row' }, [h('span', { text: 'Share of time' }),
              h('b', { text: H.round(record.sharePct, 1) + ' %' })]),
            h('div', { class: 'row' }, [h('span', { text: 'Raw data' }),
              h('b', { text: H.round(record.dataGB, 0) + ' GB' })])
          ]),
          record.targetQuestions > 0 ? h('div', { class: 'progress' }, [
            h('span', {
              style: 'width:' + H.clamp(record.targetProgressPct, 0, 100) + '%;background:' + colour
            })
          ]) : null,
          record.targetQuestions > 0 ? h('div', {
            class: 'row', style: 'font-size:10.5px;margin-top:4px',
            html: '<span>Goal ' + H.fmtNumber(record.targetQuestions) + ' questions</span><b>'
              + H.round(record.targetProgressPct, 0) + '%</b>'
          }) : null
        ]);
        tile.style.borderTopColor = colour;
        host.appendChild(tile);
      });
    });
    return host;
  }

  function buildSimpleOverview() {
    var panel = h('div', { class: 'panel' });
    panel.appendChild(h('div', { class: 'panel-head' }, [
      h('h2', { text: 'Overview' }),
      h('p', {
        text: 'The numbers that decide the study, and the handful of controls that move them. '
          + 'Open Budget and allocation, the aim panels or the parameter cards for the full detail.'
      })
    ]));

    var headline = h('div', { class: 'headline' });
    registerView(function (report) {
      clear(headline);
      headline.appendChild(h('div', { class: 'title', text: report.meta.studyTitle || 'Untitled design' }));
      [
        ['Questions', H.fmtNumber(report.totals.primaryQuestions)],
        ['Trials', H.fmtNumber(report.totals.trials)],
        ['Sessions', H.fmtNumber(report.totals.sessions)],
        ['Scanner time', H.round(report.totals.hours, 1) + ' h of ' + H.round(report.budget.usableHours, 1) + ' h'],
        ['Calendar', report.totals.weeks + ' weeks'],
        ['Session length', H.round(report.session.sessionMeanMinutes, 0) + ' min']
      ].forEach(function (pair) {
        headline.appendChild(h('div', {
          class: 'stat', html: pair[0] + ' <b>' + pair[1] + '</b>'
        }));
      });
    });
    panel.appendChild(headline);

    var tiles = card('Questions recorded by modality',
      'One prompted question per primary trial', [modalityTiles()]);

    var status = h('div', {});
    var statusCard = card('Budget status', null, [status]);
    registerView(function (report) {
      clear(status);
      var over = report.totals.utilisationPct > 100;
      status.appendChild(h('div', { class: 'meter' + (over ? ' over' : '') }, [
        h('span', { style: 'width:' + H.clamp(report.totals.utilisationPct, 0, 100) + '%' })
      ]));
      status.appendChild(h('div', {
        class: 'bar-legend',
        html: '<span><b>' + H.round(report.totals.utilisationPct, 1) + '%</b> of the usable budget used, '
          + H.round(report.totals.hoursRemaining, 1) + ' h remaining, '
          + H.round(report.totals.functionalHours, 1) + ' h of that on task and '
          + H.round(report.totals.overheadHours, 1) + ' h on setup, structurals and breaks.</span>'
      }));
      if (!report.warnings.length) {
        status.appendChild(h('div', {
          class: 'notice ok mt', text: 'All constraints satisfied. No structure was clamped.'
        }));
      } else {
        var list = h('ul', { class: 'warnings mt' });
        report.warnings.slice(0, 3).forEach(function (text, index) {
          list.appendChild(h('li', { 'data-index': index + 1, text: text }));
        });
        status.appendChild(list);
        if (report.warnings.length > 3) {
          status.appendChild(h('div', {
            class: 'muted', style: 'padding:6px 12px;font-size:11.5px',
            text: (report.warnings.length - 3) + ' further constraint messages in Budget and allocation.'
          }));
        }
      }
    });

    var goalFill = h('div', { class: 'notice mt' });
    registerView(function (report) {
      var goal = H.num(report.budget.targetQuestionsTotal);
      var recorded = H.num(report.totals.primaryQuestions);
      var pct = goal > 0 ? H.clamp(recorded / goal * 100, 0, 100) : 0;
      clear(goalFill);
      if (report.budget.solveMode !== 'fill') {
        goalFill.className = 'notice mt';
        goalFill.textContent = 'The question goal drives the plan in Question goal mode. '
          + 'Currently solving for: '
          + (M.SOLVE_MODES.filter(function (m) { return m.id === report.budget.solveMode; })[0]
            || { label: report.budget.solveMode }).label + '.';
        return;
      }
      goalFill.className = 'notice mt' + (goal > 0 && recorded < goal * 0.995 ? '' : ' ok');
      goalFill.textContent = H.fmtNumber(recorded) + ' of ' + H.fmtNumber(goal)
        + ' questions scheduled (' + H.round(pct, 0) + '% of the goal) using '
        + H.round(report.totals.hours, 1) + ' of ' + H.round(report.budget.usableHours, 1)
        + ' usable hours across ' + report.totals.sessions + ' sessions.'
        + (goal > 0 && recorded < goal * 0.995
          ? ' Add hours, weeks or sessions - or shorten the trials - to reach the rest.'
          : ' The goal fits inside the budget.');
    });

    var masters = card('Master controls', 'Everything else follows from these', [
      segmented({
        label: 'What do you want to fix?',
        hint: 'The quantity you set; everything else is solved from it',
        path: 'budget.solveMode',
        options: M.SOLVE_MODES.map(function (mode) {
          return { value: mode.id, label: mode.label, hint: mode.blurb };
        })
      }),
      slider({
        label: 'Total questions to collect',
        hint: 'The whole study. The planner fills as much of this as the hours allow',
        path: 'budget.targetQuestionsTotal', min: 0, max: 30000, step: 25, unit: 'q', gold: true,
        onChange: function () {
          if (App.state.budget.solveMode === 'budget' || App.state.budget.solveMode === 'manual') {
            App.state.budget.solveMode = 'fill';
            toast('Solving for the question goal, capped by the hours available', 'ok');
          }
        }
      }),
      slider({
        label: 'Scanner hours available', hint: 'Whole study, including setup and breaks',
        path: 'budget.totalScannerHours', min: 2, max: 400, step: 1, decimals: 1, unit: 'h'
      }),
      slider({
        label: 'Sessions per week', path: 'budget.sessionsPerWeek', min: 1, max: 7, step: 0.5, decimals: 1
      }),
      slider({
        label: 'Weeks available', path: 'budget.weeksAvailable', min: 1, max: 78, step: 1, unit: 'wk'
      }),
      slider({
        label: 'Longest session allowed', hint: 'Participant tolerance and scanner slot length',
        path: 'caps.maxSessionMinutes', min: 20, max: 240, step: 5, unit: 'min', gold: true
      }),
      goalFill
    ]);

    var targets = h('div', {});
    targets.appendChild(allocationUnitToggle('Distribute by'));
    targets.appendChild(allocationRows('overview-alloc'));
    targets.appendChild(allocationBar());
    targets.appendChild(h('div', { class: 'mt' }));
    M.AIM_IDS.forEach(function (id) {
      targets.appendChild(slider({
        label: App.state.aims[id].short + ' question goal',
        hint: 'Questions to collect for ' + App.state.aims[id].name,
        path: 'aims.' + id + '.targetQuestions', min: 0, max: 20000, step: 25, unit: 'q',
        disabledWhen: function (state) {
          return state.budget.solveMode !== 'target' || !state.aims[id].enabled;
        }
      }));
    });

    var targetCard = card('How the scanner time is divided',
      'Drag in percent, hours or sessions', [targets]);

    var actions = card('Quick actions', null, [
      h('div', { class: 'btn-row' }, [
        h('button', {
          class: 'btn gold', type: 'button', text: 'Optimise every aim',
          title: 'Optimise each modality against its own decoding objective',
          onclick: function () {
            M.AIM_IDS.forEach(function (id) {
              if (App.state.aims[id].enabled) {
                App.state = M.optimiseStructure(App.state, App.boot, id, 'auto');
              }
            });
            App.refresh();
            toast('Every aim optimised against its own decoding objective', 'ok');
          }
        }),
        h('button', {
          class: 'btn', type: 'button', text: 'Export XLSX report',
          onclick: function () { global.PlannerExport.downloadXlsx(); }
        }),
        h('button', {
          class: 'btn quiet', type: 'button', text: 'Copy methods text',
          onclick: function () { copy(App.report.methodsText, 'Methods text'); }
        }),
        h('button', {
          class: 'btn quiet', type: 'button', text: 'Copy question summary',
          onclick: function () {
            copy(App.report.markdownTables['Questions recorded by modality'] || '',
              'Question summary');
          }
        }),
        h('button', {
          class: 'btn quiet', type: 'button', text: 'Full budget panel',
          onclick: function () { App.show('overview'); }
        })
      ])
    ]);

    panel.appendChild(tiles);
    panel.appendChild(h('div', { class: 'grid split' }, [
      h('div', {}, [masters, targetCard]),
      h('div', {}, [statusCard, actions])
    ]));
    panel.appendChild(buildAimToggleCard());
    panel.appendChild(buildStudyFigureCard());
    return panel;
  }

  /* ------------------------------------------------------- overview panel */

  function buildOverview() {
    var panel = h('div', { class: 'panel' });
    panel.appendChild(h('div', { class: 'panel-head' }, [
      h('h2', { text: 'Budget and allocation' }),
      h('p', {
        text: 'Set the scanner-hour envelope and how it is divided between the three specific aims. '
          + 'Every other panel re-solves against these numbers.'
      })
    ]));

    var left = h('div', {});
    var right = h('div', {});

    left.appendChild(card('Scanner-hour budget', null, [
      slider({
        label: 'Total scanner hours', hint: 'Whole-study budget including setup',
        path: 'budget.totalScannerHours', min: 2, max: 250, step: 0.5, decimals: 1, unit: 'h'
      }),
      slider({
        label: 'Contingency reserve', hint: 'Held back for reacquisition and downtime',
        path: 'budget.contingencyPct', min: 0, max: 40, step: 1, unit: '%', gold: true
      }),
      segmented({
        label: 'Solve mode',
        hint: 'What the solver derives from what you fix',
        path: 'budget.solveMode',
        options: M.SOLVE_MODES.map(function (mode) {
          return { value: mode.id, label: mode.label, hint: mode.blurb };
        })
      }),
      segmented({
        label: 'Session model',
        hint: 'Dedicated: one aim per session. Pooled: runs mixed within a session.',
        path: 'budget.sessionModel',
        options: [
          { value: 'dedicated', label: 'Dedicated' },
          { value: 'pooled', label: 'Pooled' }
        ]
      }),
      slider({
        label: 'Total question goal',
        hint: 'Question goal mode fills as much of this as the hours allow',
        path: 'budget.targetQuestionsTotal', min: 0, max: 30000, step: 25, unit: 'q', gold: true,
        disabledWhen: function (state) {
          if (state.budget.solveMode === 'fill') return false;
          return !(state.budget.solveMode === 'target' && state.budget.sessionModel === 'pooled');
        }
      }),
      h('div', { class: 'btn-row' }, [
        h('button', {
          class: 'btn quiet sm', type: 'button', text: 'Split goal across aims',
          title: 'Distribute the total question goal over the aims in proportion to their allocation',
          onclick: function () {
            var total = H.num(App.state.budget.targetQuestionsTotal);
            var active = M.AIM_IDS.filter(function (id) { return App.state.aims[id].enabled; });
            var pool = H.sum(active, function (id) { return H.num(App.state.aims[id].requestedPct); });
            active.forEach(function (id) {
              var share = pool > 0 ? H.num(App.state.aims[id].requestedPct) / pool : 1 / active.length;
              App.state.aims[id].targetQuestions = Math.round(total * share);
            });
            App.refresh();
            toast('Question goal split across the aims by allocation', 'ok');
          }
        }),
        h('button', {
          class: 'btn quiet sm', type: 'button', text: 'Sum aim goals into total',
          onclick: function () {
            App.state.budget.targetQuestionsTotal = Math.round(H.sum(M.AIM_IDS, function (id) {
              return App.state.aims[id].enabled ? H.num(App.state.aims[id].targetQuestions) : 0;
            }));
            App.refresh();
          }
        })
      ]),
      slider({ label: 'Sessions per week', path: 'budget.sessionsPerWeek', min: 1, max: 7, step: 0.5, decimals: 1 }),
      slider({ label: 'Calendar weeks available', path: 'budget.weeksAvailable', min: 1, max: 78, step: 1, unit: 'wk' }),
      checkbox({ label: 'Count setup, structurals and breaks against the scanner budget', path: 'budget.countOverheadAgainstBudget' }),
      checkbox({ label: 'Auto-clamp run and session structure to the constraint envelope', path: 'budget.autoClamp' })
    ]));

    left.appendChild(buildAllocationCard());

    left.appendChild(card('Constraint envelope', 'Hard limits the solver respects', [
      segmented({
        label: 'Apply caps to',
        hint: 'Expected uses the mean of the jitter range; longest uses the worst case',
        path: 'caps.applyTo',
        options: [
          { value: 'expected', label: 'Expected duration' },
          { value: 'longest', label: 'Longest duration' }
        ]
      }),
      slider({ label: 'Max run duration', path: 'caps.maxRunMinutes', min: 2, max: 45, step: 0.5, decimals: 1, unit: 'min' }),
      slider({ label: 'Max session duration', path: 'caps.maxSessionMinutes', min: 20, max: 240, step: 5, unit: 'min' }),
      slider({ label: 'Max runs per session', path: 'caps.maxRunsPerSession', min: 1, max: 14, step: 1 }),
      slider({ label: 'Max sessions in study', path: 'caps.maxSessionsTotal', min: 1, max: 120, step: 1 }),
      slider({ label: 'Continuous scanning comfort limit', path: 'caps.maxContinuousMinutes', min: 5, max: 60, step: 1, unit: 'min', gold: true }),
      slider({ label: 'Minimum questions per aim', path: 'caps.minQuestionsPerAim', min: 0, max: 2000, step: 10, unit: 'q', gold: true })
    ]));

    right.appendChild(buildSummaryCard());
    right.appendChild(buildWarningsCard());

    right.appendChild(card('Study identification', null, [
      field({ label: 'Study title', path: 'meta.studyTitle', stack: true }),
      field({ label: 'Principal investigator', path: 'meta.investigator' }),
      field({ label: 'Institution', path: 'meta.institution' }),
      field({ label: 'Participant identifier', path: 'meta.participantId' }),
      field({ label: 'Design identifier', path: 'meta.designId' }),
      field({ label: 'Notes', path: 'meta.notes', type: 'textarea', stack: true, rows: 3 })
    ]));

    panel.appendChild(h('div', { class: 'grid split' }, [left, right]));
    return panel;
  }

  function buildAllocationCard() {
    /* Enable box and lock button ride along with whichever unit slider is on
     * screen, so the row keeps working when the unit changes. */
    function decorate(id, control, owner) {
      var aim = App.state.aims[id];
      var lock = h('button', { class: 'lock-btn', type: 'button', title: 'Hold this share fixed', text: 'L' });
      lock.addEventListener('click', function () {
        App.state.aims[id].locked = !App.state.aims[id].locked;
        App.refresh();
      });
      registerControl(function () {
        lock.classList.toggle('on', !!App.state.aims[id].locked);
        lock.style.visibility = allocationUnit() === 'percent' ? 'visible' : 'hidden';
      }, owner);

      var enable = h('input', {
        type: 'checkbox', title: 'Include ' + aim.name + ' in the design',
        'aria-label': 'Include ' + aim.name
      });
      enable.addEventListener('change', function () {
        App.state.aims[id].enabled = enable.checked;
        M.normaliseAllocation(App.state, null);
        App.refresh();
      });
      registerControl(function () { enable.checked = !!App.state.aims[id].enabled; }, owner);

      control.insertBefore(enable, control.firstChild);
      control.querySelector('.value-box').appendChild(lock);
      control.style.gridTemplateColumns = '14px minmax(120px, 1.2fr) minmax(80px, 2fr) 118px';
    }

    var note = h('div', { class: 'muted', style: 'font-size:11px;margin-top:8px' });
    registerView(function (report) {
      var unit = allocationUnit();
      if (unit === 'sessions') {
        note.textContent = 'Session sliders are read directly by the solver in session-count mode. '
          + 'Total ' + report.totals.sessions + ' sessions, '
          + H.round(report.totals.hours, 1) + ' h committed.';
      } else if (unit === 'hours') {
        note.textContent = 'Hours are requested shares of the '
          + H.round(report.budget.usableHours, 1)
          + ' usable hours; the legend shows what each aim actually lands on once '
          + 'whole sessions are counted.';
      } else {
        note.textContent = 'Shares always total 100 percent; unlocked aims absorb the remainder.';
      }
    });

    var actions = h('div', { class: 'btn-row mt' }, [
      h('button', {
        class: 'btn quiet sm', type: 'button', text: 'Equal split',
        onclick: function () {
          var active = M.AIM_IDS.filter(function (id) { return App.state.aims[id].enabled; });
          active.forEach(function (id) { App.state.aims[id].requestedPct = H.round(100 / active.length, 2); });
          App.refresh();
        }
      }),
      h('button', {
        class: 'btn quiet sm', type: 'button', text: 'Derive from question goals',
        title: 'Set shares so each aim reaches its own question goal',
        onclick: function () {
          App.state = M.balanceToTarget(App.state, App.boot);
          App.refresh();
          toast('Allocation derived from the per-aim question goals', 'ok');
        }
      }),
      h('button', {
        class: 'btn quiet sm', type: 'button', text: 'Normalise to 100',
        onclick: function () { M.normaliseAllocation(App.state, null); App.refresh(); }
      }),
      h('button', {
        class: 'btn gold sm', type: 'button', text: 'Optimise every aim',
        title: 'Optimise each aim against its own decoding objective',
        onclick: function () {
          M.AIM_IDS.forEach(function (id) {
            if (App.state.aims[id].enabled) {
              App.state = M.optimiseStructure(App.state, App.boot, id, 'auto');
            }
          });
          App.refresh();
          toast('Every aim optimised against its own decoding objective', 'ok');
        }
      })
    ]);

    return card('Aim allocation', 'Percent, hours or sessions', [
      allocationUnitToggle('Slider units'),
      allocationRows('budget-alloc', decorate),
      allocationBar(),
      note,
      actions
    ]);
  }

  function buildSummaryCard() {
    var readout = h('div', { class: 'readout' });
    var meterWrap = h('div', {});
    var tableHost = h('div', { class: 'mt' });

    registerView(function (report) {
      clear(readout);
      readout.appendChild(readoutCell('Sessions', H.fmtNumber(report.totals.sessions)));
      readout.appendChild(readoutCell('Questions', H.fmtNumber(report.totals.primaryQuestions), 'accent'));
      readout.appendChild(readoutCell('Total trials', H.fmtNumber(report.totals.trials)));
      readout.appendChild(readoutCell('Committed', H.round(report.totals.hours, 1) + ' <small>h</small>'));
      readout.appendChild(readoutCell('Functional', H.round(report.totals.functionalHours, 1) + ' <small>h</small>'));
      readout.appendChild(readoutCell('Overhead', H.round(report.totals.overheadHours, 1) + ' <small>h</small>'));
      readout.appendChild(readoutCell('Session length',
        H.round(report.session.sessionMeanMinutes, 0) + ' <small>min</small>'));
      readout.appendChild(readoutCell('Remaining', H.round(report.totals.hoursRemaining, 1) + ' <small>h</small>',
        report.totals.hoursRemaining < 0 ? 'alert' : ''));
      readout.appendChild(readoutCell('Raw data', H.round(report.totals.dataGB, 0) + ' <small>GB</small>'));

      clear(meterWrap);
      var over = report.totals.utilisationPct > 100;
      meterWrap.appendChild(h('div', { class: 'meter' + (over ? ' over' : '') }, [
        h('span', { style: 'width:' + H.clamp(report.totals.utilisationPct, 0, 100) + '%' })
      ]));
      meterWrap.appendChild(h('div', {
        class: 'bar-legend',
        html: '<span>' + H.round(report.totals.utilisationPct, 1) + ' percent of the usable budget ('
          + H.round(report.budget.usableHours, 1) + ' h after a ' + report.budget.contingencyPct
          + ' percent contingency reserve)</span>'
      }));

      clear(tableHost);
      var rows = report.aims.map(function (aim) {
        return [
          { text: aim.short },
          { text: H.round(aim.requestedPct, 1), num: true },
          { text: H.round(aim.derived.sharePct, 1), num: true },
          { text: aim.derived.sessions, num: true },
          { text: aim.derived.totalRuns, num: true },
          { text: H.fmtNumber(aim.derived.primaryQuestions), num: true },
          { text: H.fmtNumber(aim.derived.totalTrials), num: true },
          { text: H.round(aim.derived.totalHours, 1), num: true },
          { text: H.round(aim.derived.questionsPerHour, 1), num: true }
        ];
      });
      rows.push({
        className: 'total',
        cells: [
          { text: 'Total' }, { text: '100.0', num: true }, { text: '100.0', num: true },
          { text: report.totals.sessions, num: true },
          { text: report.totals.runs, num: true },
          { text: H.fmtNumber(report.totals.primaryQuestions), num: true },
          { text: H.fmtNumber(report.totals.trials), num: true },
          { text: H.round(report.totals.hours, 1), num: true },
          {
            text: report.totals.hours > 0
              ? H.round(report.totals.primaryQuestions / report.totals.hours, 1) : 0,
            num: true
          }
        ]
      });
      tableHost.appendChild(dataTable(
        [{ label: 'Aim' }, { label: 'Req %', num: true }, { label: 'Real %', num: true },
          { label: 'Sessions', num: true }, { label: 'Runs', num: true },
          { label: 'Questions', num: true }, { label: 'Trials', num: true },
          { label: 'Hours', num: true }, { label: 'Questions/h', num: true }],
        rows
      ));
    });

    return card('Solved design', 'Recomputed on every edit', [readout, h('div', { class: 'mt' }, [meterWrap]), tableHost]);
  }

  function buildWarningsCard() {
    var host = h('div', {});
    var node = flushCard('Constraint report', null, [host]);
    registerView(function (report) {
      clear(host);
      if (!report.warnings.length) {
        host.appendChild(h('div', { class: 'notice ok', text: 'All constraints satisfied. No structure was clamped.' }));
        return;
      }
      var list = h('ul', { class: 'warnings' });
      report.warnings.forEach(function (text, index) {
        list.appendChild(h('li', { 'data-index': index + 1, text: text }));
      });
      host.appendChild(list);
    });
    return node;
  }

  /* ------------------------------------------------------------ aim panel */

  function buildAimPanel(id) {
    var aim = App.state.aims[id];
    var panel = h('div', { class: 'panel' });
    panel.appendChild(h('div', { class: 'panel-head' }, [
      h('h2', { text: aim.name }),
      h('p', {
        text: 'Every phase bound, block, run and session parameter is editable. '
          + 'Changes re-solve the budget, the trial totals and the design-efficiency estimate immediately.'
      })
    ]));

    panel.appendChild(buildDecodeCard(id));

    /* The regressor trace gets the full width of the panel: it is the plot the
     * timing decisions are actually read off. */
    panel.appendChild(buildEfficiencyCard(id));

    panel.appendChild(h('div', { class: 'grid even' }, [
      h('div', {}, [buildPhaseCard(id)]),
      h('div', {}, [buildStructureCard(id)])
    ]));

    panel.appendChild(buildAimReadoutCard(id));
    panel.appendChild(buildDesignTableCard(id));
    panel.appendChild(buildTrialTimelineCard(id));
    panel.appendChild(buildAimMatrixFigureCard(id));
    return panel;
  }

  function buildDecodeCard(id) {
    var blurb = h('div', { class: 'notice mb' });
    registerView(function () {
      var objective = M.aimObjective(App.state.aims[id]);
      var record = M.OBJECTIVES.filter(function (item) { return item.id === objective; })[0];
      blurb.textContent = record ? record.blurb : '';
    });

    var body = [
      blurb,
      segmented({
        label: 'Decoding objective',
        hint: 'What the optimiser maximises for this aim',
        path: 'aims.' + id + '.decode.objective',
        options: M.OBJECTIVES.map(function (item) {
          return { value: item.id, label: item.label, hint: item.blurb };
        }),
        onChange: function () {
          App.state = M.applyObjectiveDefaults(App.state, id);
          setTimeout(function () {
            App.refresh();
            toast('Adopted the recommended timing and label ordering for this objective', 'ok');
          }, 0);
        }
      }),
      segmented({
        label: 'Label ordering',
        hint: 'Blocked runs let same-label responses summate; intermixed keeps trials independent',
        path: 'aims.' + id + '.decode.labelOrder',
        options: M.LABEL_ORDERS.map(function (item) {
          return { value: item.id, label: item.label };
        })
      }),
      slider({
        label: 'Same-label run length',
        hint: 'Consecutive questions sharing an answer before the label flips',
        path: 'aims.' + id + '.decode.labelRunLength', min: 1, max: 40, step: 1, unit: 'q', gold: true,
        disabledWhen: function (state) { return state.aims[id].decode.labelOrder !== 'blocked'; }
      }),
      h('div', { class: 'btn-row mt' }, [
        h('button', {
          class: 'btn gold sm', type: 'button', text: 'Optimise this aim for its objective',
          title: 'Search trial timing, then block and run structure, against this aim objective',
          onclick: function () {
            App.state = M.optimiseTiming(App.state, App.boot, id, 'auto');
            App.state = M.optimiseStructure(App.state, App.boot, id, 'auto');
            App.refresh();
            toast('Timing and structure optimised for '
              + M.aimObjective(App.state.aims[id]) + ' decode quality', 'ok');
          }
        }),
        h('button', {
          class: 'btn quiet sm', type: 'button', text: 'Reset to recommended timing',
          onclick: function () {
            App.state = M.applyRecommendedTiming(App.state, id);
            App.refresh();
            toast('Recommended timing restored');
          }
        })
      ])
    ];

    return card('Decode quality objective', 'Drives every optimiser on this panel', body);
  }

  function buildSeparationSolver(id) {
    var readout = h('div', { class: 'readout' });

    var control = slider({
      label: 'Allowed residual at the next event',
      hint: 'One knob: lower is cleaner HRF separation and longer trials',
      path: 'aims.' + id + '.separationTolerancePct',
      min: 0.5, max: 50, step: 0.5, decimals: 1, unit: '%', gold: true,
      onChange: function (value) {
        App.state = M.applySeparationTiming(App.state, id, value);
      }
    });

    function preset(label, value, title) {
      return h('button', {
        class: 'btn quiet sm', type: 'button', text: label, title: title,
        onclick: function () {
          App.state = M.applySeparationTiming(App.state, id, value);
          App.refresh();
          toast('Rest and fixation ranges solved for ' + value + ' percent residual', 'ok');
        }
      });
    }

    registerView(function () {
      var stateAim = App.state.aims[id];
      var solved = M.separationTiming(stateAim, stateAim.separationTolerancePct);
      clear(readout);
      if (!solved) {
        readout.appendChild(h('div', { class: 'cell' }, [
          h('div', { class: 'k', text: 'Solver' }),
          h('div', { class: 'v', text: 'Needs a question and an answer phase' })
        ]));
        return;
      }
      var ctx = M.protocolContext(App.boot, stateAim.protocol);
      var geometry = M.aimGeometry(stateAim, ctx.trSeconds);

      var restPhase = solved.restIndex >= 0 ? stateAim.phases[solved.restIndex] : null;
      var tailPhase = solved.tailIndex >= 0 ? stateAim.phases[solved.tailIndex] : null;
      var inSync = (!restPhase || (Math.abs(H.num(restPhase.min) - solved.restMin) < 0.05
          && Math.abs(H.num(restPhase.max) - solved.restMax) < 0.05))
        && (!tailPhase || (Math.abs(H.num(tailPhase.min) - solved.tailMin) < 0.05
          && Math.abs(H.num(tailPhase.max) - solved.tailMax) < 0.05));
      readout.appendChild(readoutCell('Status',
        inSync ? 'Applied' : 'Preview only', inSync ? '' : 'alert'));

      readout.appendChild(readoutCell('Prompt clear after',
        H.round(solved.questionDecay, 1) + ' <small>s</small>'));
      readout.appendChild(readoutCell('Answer clear after',
        H.round(solved.answerDecay, 1) + ' <small>s</small>'));
      readout.appendChild(readoutCell('Solved delay',
        H.round(solved.restMin, 1) + ' - ' + H.round(solved.restMax, 1) + ' <small>s</small>', 'accent'));
      readout.appendChild(readoutCell('Solved fixation',
        H.round(solved.tailMin, 1) + ' - ' + H.round(solved.tailMax, 1) + ' <small>s</small>', 'accent'));
      readout.appendChild(readoutCell('Predicted prompt bleed',
        H.round(solved.promptResidualPct, 2) + ' <small>%</small>'));
      readout.appendChild(readoutCell('Predicted carryover',
        H.round(solved.carryResidualPct, 2) + ' <small>%</small>'));
      readout.appendChild(readoutCell('Trial length',
        H.round(geometry.trial.min, 1) + ' - ' + H.round(geometry.trial.max, 1) + ' <small>s</small>'));
      readout.appendChild(readoutCell('Cost per question',
        H.round(geometry.trial.mean, 1) + ' <small>s</small>'));
    });

    return h('div', { class: 'solver' }, [
      h('div', { class: 'solver-head' }, [
        h('span', { text: 'HRF separation solver' }),
        h('span', { class: 'muted', text: 'Moves the delay and fixation ranges for you' })
      ]),
      control,
      readout,
      h('div', { class: 'btn-row mt' }, [
        preset('Cleanest 1%', 1, 'Prompt and previous trial fully resolved before the next event'),
        preset('Clean 4%', 4, 'Standard separation for event-related decoding'),
        preset('Balanced 10%', 10, 'Shorter trials, modest overlap'),
        preset('Saturating 45%', 45, 'Deliberate overlap for a detection design'),
        h('button', {
          class: 'btn sm', type: 'button', text: 'Re-apply',
          title: 'Re-solve the ranges at the current tolerance',
          onclick: function () {
            App.state = M.applySeparationTiming(App.state, id,
              App.state.aims[id].separationTolerancePct);
            App.refresh();
            toast('Delay and fixation ranges re-solved', 'ok');
          }
        })
      ])
    ]);
  }

  function buildPhaseCard(id) {
    var host = h('div', {});
    var owner = 'phase-' + id;
    var signature = '';

    function phaseSignature() {
      var aim = App.state.aims[id];
      return aim.phases.length + ':' + aim.phases.map(function (phase) { return phase.role; }).join(',');
    }

    function renderRows() {
      dropControls(owner);
      signature = phaseSignature();
      clear(host);
      var aim = App.state.aims[id];
      var table = h('table', { class: 'phase-grid' });
      table.appendChild(h('thead', {}, [h('tr', {}, [
        h('th', { text: '' }),
        h('th', { text: 'Phase' }),
        h('th', { text: 'Model role' }),
        h('th', { text: 'Minimum (s)' }),
        h('th', { text: 'Maximum (s)' }),
        h('th', { text: 'Jitter' }),
        h('th', { text: 'Exp.' }),
        h('th', { text: '' })
      ])]));
      var body = h('tbody', {});

      aim.phases.forEach(function (phase, index) {
        var base = 'aims.' + id + '.phases.' + index;

        var name = h('input', { type: 'text', value: phase.name });
        name.addEventListener('change', function () {
          App.state.aims[id].phases[index].name = name.value;
          App.refresh();
        });

        var role = h('select', {});
        M.PHASE_ROLES.forEach(function (option) {
          role.appendChild(h('option', { value: option.id, text: option.label }));
        });
        role.value = phase.role || 'other';
        role.addEventListener('change', function () {
          App.state.aims[id].phases[index].role = role.value;
          App.refresh();
        });

        function bound(key, colour) {
          var box = h('input', { type: 'number', step: 0.1, min: 0, max: 90 });
          var range = h('input', { type: 'range', min: 0, max: 40, step: 0.1, class: colour ? 'gold' : '' });
          function commit(raw) {
            var value = Math.max(0, H.round(H.num(raw), 2));
            var target = App.state.aims[id].phases[index];
            target[key] = value;
            if (key === 'min' && target.max < value) target.max = value;
            if (key === 'max' && target.min > value) target.min = value;
            target.jitter = target.max > target.min;
            App.refresh();
          }
          box.addEventListener('change', function () { commit(box.value); });
          box.addEventListener('blur', function () { commit(box.value); });
          range.addEventListener('input', function () { commit(range.value); });
          registerControl(function () {
            var value = H.num(getPath(App.state, base + '.' + key));
            if (document.activeElement !== box) box.value = H.round(value, 2);
            if (document.activeElement !== range) range.value = value;
            paintRange(range);
          }, owner);
          return h('div', { class: 'rangecell' }, [box, range]);
        }

        var jitter = h('input', { type: 'checkbox' });
        jitter.addEventListener('change', function () {
          App.state.aims[id].phases[index].jitter = jitter.checked;
          App.refresh();
        });

        var expected = h('td', { class: 'expected' });
        registerControl(function () {
          var phaseNow = App.state.aims[id].phases[index];
          if (!phaseNow) return;
          jitter.checked = !!phaseNow.jitter;
          expected.textContent = H.round((H.num(phaseNow.min) + H.num(phaseNow.max)) / 2, 2);
        }, owner);

        var remove = h('button', {
          class: 'btn danger sm', type: 'button', text: 'x', title: 'Remove phase',
          onclick: function () {
            App.state.aims[id].phases.splice(index, 1);
            App.refresh(true);
          }
        });

        body.appendChild(h('tr', {}, [
          h('td', { class: 'handle', text: String(index + 1) }),
          h('td', {}, [name]),
          h('td', {}, [role]),
          h('td', {}, [bound('min')]),
          h('td', {}, [bound('max', true)]),
          h('td', {}, [jitter]),
          expected,
          h('td', {}, [remove])
        ]));
      });

      var totalMin = h('td', { class: 'expected' });
      var totalMax = h('td', { class: 'expected' });
      var totalMean = h('td', { class: 'expected' });
      registerControl(function () {
        var current = App.state.aims[id];
        var lo = 0, hi = 0;
        current.phases.forEach(function (phase) {
          lo += H.num(phase.min);
          hi += Math.max(H.num(phase.min), H.num(phase.max));
        });
        totalMin.textContent = H.round(lo, 2);
        totalMax.textContent = H.round(hi, 2);
        totalMean.textContent = H.round((lo + hi) / 2, 2);
      }, owner);
      body.appendChild(h('tr', { class: 'phase-total' }, [
        h('td', {}), h('td', { text: 'Trial total' }), h('td', {}),
        totalMin, totalMax, h('td', {}), totalMean, h('td', {})
      ]));

      table.appendChild(body);
      host.appendChild(h('div', { class: 'phase-scroll' }, [table]));

      host.appendChild(h('div', { class: 'btn-row mt' }, [
        h('button', {
          class: 'btn quiet sm', type: 'button', text: 'Add phase',
          onclick: function () {
            App.state.aims[id].phases.push({ name: 'New phase', min: 2, max: 2, jitter: false, role: 'other' });
            App.refresh(true);
          }
        }),
        h('button', {
          class: 'btn gold sm', type: 'button', text: 'Optimise jitter for decode objective',
          title: 'Search delay and post-answer fixation bounds against this aim decode objective',
          onclick: function () {
            App.state = M.optimiseTiming(App.state, App.boot, id, 'auto');
            App.refresh();
            toast('Trial timing optimised for '
              + M.aimObjective(App.state.aims[id]) + ' decode quality', 'ok');
          }
        }),
        h('button', {
          class: 'btn quiet sm', type: 'button', text: 'Copy trial sequence',
          onclick: function () {
            var aimReport = currentAim(id);
            copy(aimReport ? aimReport.table[0].sequence : '', 'Trial sequence');
          }
        })
      ]));
    }

    var node = card('Trial phase structure',
      'Second-level ranges drive jitter, trial length and efficiency',
      [host, buildSeparationSolver(id)]);

    registerView(function () {
      if (phaseSignature() !== signature) renderRows();
    });

    renderRows();
    return node;
  }

  function buildStructureCard(id) {
    var body = [
      slider({ label: 'Trials per block', path: 'aims.' + id + '.structure.trialsPerBlock', min: 1, max: 40, step: 1 }),
      slider({ label: 'Inter-trial gap', path: 'aims.' + id + '.structure.interTrialGap', min: 0, max: 30, step: 0.5, decimals: 1, unit: 's' }),
      slider({ label: 'Blocks per run', path: 'aims.' + id + '.structure.blocksPerRun', min: 1, max: 20, step: 1 }),
      slider({ label: 'Inter-block rest', path: 'aims.' + id + '.structure.interBlockRest', min: 0, max: 120, step: 1, unit: 's', gold: true }),
      slider({ label: 'Dummy volumes', hint: 'Discarded for T1 equilibration', path: 'aims.' + id + '.structure.dummyVolumes', min: 0, max: 40, step: 1 }),
      slider({ label: 'Lead-in', path: 'aims.' + id + '.structure.leadIn', min: 0, max: 60, step: 1, unit: 's' }),
      slider({ label: 'Lead-out', path: 'aims.' + id + '.structure.leadOut', min: 0, max: 60, step: 1, unit: 's' }),
      slider({ label: 'Runs per session', path: 'aims.' + id + '.structure.runsPerSession', min: 1, max: 14, step: 1 }),
      slider({
        label: 'Question goal for this aim', hint: 'Drives sessions in per-aim goal mode',
        path: 'aims.' + id + '.targetQuestions', min: 0, max: 20000, step: 25, unit: 'q', gold: true,
        disabledWhen: function (state) { return state.budget.solveMode !== 'target'; }
      }),
      slider({
        label: 'Sessions for this aim', hint: 'Editable in manual mode',
        path: 'aims.' + id + '.sessions', min: 0, max: 120, step: 1,
        disabledWhen: function (state) { return state.budget.solveMode !== 'manual'; }
      }),
      field({
        label: 'Bound protocol card', path: 'aims.' + id + '.protocol', type: 'select',
        options: (App.boot.manifest || []).map(function (entry) {
          return { value: entry.slug, label: entry.label + '  (' + entry.slug + ')' };
        })
      }),
      field({
        label: 'Randomisation seed', hint: 'Fixes the simulated trial order used for efficiency',
        path: 'aims.' + id + '.seed', type: 'number', step: 1
      })
    ];

    var actions = h('div', { class: 'btn-row mt' }, [
      h('button', {
        class: 'btn gold sm', type: 'button', text: 'Optimise for decode objective',
        onclick: function () {
          App.state = M.optimiseStructure(App.state, App.boot, id, 'auto');
          App.refresh();
          toast('Structure optimised for ' + M.aimObjective(App.state.aims[id]) + ' decode quality', 'ok');
        }
      }),
      h('button', {
        class: 'btn quiet sm', type: 'button', text: 'Maximise questions per hour',
        onclick: function () {
          App.state = M.optimiseStructure(App.state, App.boot, id, 'trials');
          App.refresh();
          toast('Structure optimised for question throughput', 'ok');
        }
      }),
      h('button', {
        class: 'btn quiet sm', type: 'button', text: 'Balanced',
        onclick: function () {
          App.state = M.optimiseStructure(App.state, App.boot, id, 'balanced');
          App.refresh();
          toast('Structure optimised on the balanced objective', 'ok');
        }
      }),
      h('button', {
        class: 'btn quiet sm', type: 'button', text: 'Reseed order',
        title: 'Draw a new randomised trial order for the efficiency estimate',
        onclick: function () {
          App.state.aims[id].seed = Math.floor(Math.random() * 900000) + 1000;
          App.refresh();
        }
      })
    ]);

    body.push(actions);
    return card('Block, run and session assembly', null, body);
  }

  function currentAim(id) {
    if (!App.report) return null;
    return App.report.aims.filter(function (aim) { return aim.id === id; })[0] || null;
  }

  function buildAimReadoutCard(id) {
    var readout = h('div', { class: 'readout' });
    var acquisition = h('div', { class: 'mt' });
    var node = card('Solved geometry', null, [readout, acquisition]);

    registerView(function () {
      var aim = currentAim(id);
      clear(readout);
      clear(acquisition);
      if (!aim) {
        readout.appendChild(h('div', { class: 'cell' }, [h('div', { class: 'k', text: 'Status' }),
          h('div', { class: 'v', text: 'Disabled' })]));
        return;
      }
      var d = aim.derived;
      readout.appendChild(readoutCell('Trial', d.trialMin + ' - ' + d.trialMax + ' <small>s</small>'));
      readout.appendChild(readoutCell('Block', H.round(d.blockMin / 60, 1) + ' - ' + H.round(d.blockMax / 60, 1) + ' <small>min</small>'));
      readout.appendChild(readoutCell('Run', H.round(d.runMin / 60, 1) + ' - ' + H.round(d.runMax / 60, 1) + ' <small>min</small>', 'accent'));
      readout.appendChild(readoutCell('Session', H.round(d.sessionMinMinutes, 1) + ' - ' + H.round(d.sessionMaxMinutes, 1) + ' <small>min</small>'));
      readout.appendChild(readoutCell('Trials / run', d.trialsPerRun));
      readout.appendChild(readoutCell('Trials / session', d.trialsPerSession));
      readout.appendChild(readoutCell('Sessions', d.sessions));
      readout.appendChild(readoutCell('Total trials', H.fmtNumber(d.totalTrials), 'accent'));
      readout.appendChild(readoutCell('Dynamics / run', d.volumesPerRun));
      readout.appendChild(readoutCell('Functional', H.round(d.functionalHours, 1) + ' <small>h</small>'));
      readout.appendChild(readoutCell('Realised share', H.round(d.sharePct, 1) + ' <small>%</small>'));
      readout.appendChild(readoutCell('Seconds / trial', d.secondsPerTrial));
      readout.appendChild(readoutCell('Raw data', H.round(aim.dataVolume.gbTotal, 1) + ' <small>GB</small>'));
      readout.appendChild(readoutCell('Per session', H.round(aim.dataVolume.gbPerSession, 2) + ' <small>GB</small>'));

      acquisition.appendChild(dataTable(
        [{ label: 'Acquisition' }, { label: 'Value', num: true }],
        [
          [{ text: 'Protocol card' }, { text: aim.protocolLabel, num: true }],
          [{ text: 'TR / TE' }, { text: aim.acquisition.trMs + ' / ' + aim.acquisition.teMs + ' ms', num: true }],
          [{ text: 'Voxel (mm)' }, { text: aim.acquisition.voxel, num: true }],
          [{ text: 'Slices' }, { text: aim.acquisition.slices, num: true }],
          [{ text: 'Multiband / in-plane' }, { text: aim.acquisition.mbFactor + ' / ' + aim.acquisition.senseP, num: true }],
          [{ text: 'Flip angle' }, { text: aim.acquisition.flip + ' deg', num: true }],
          [{ text: 'Dynamics on card' }, { text: aim.acquisition.dynScansCurrent, num: true }],
          [{ text: 'Dynamics solved' }, { text: aim.acquisition.dynScansSolved, num: true }],
          [{ text: 'Run duration solved' }, { text: aim.acquisition.durationSolved, num: true }]
        ]
      ));

      var mismatch = Number(aim.acquisition.dynScansCurrent) !== Number(aim.acquisition.dynScansSolved);
      acquisition.appendChild(h('div', { class: 'btn-row mt' }, [
        h('button', {
          class: mismatch ? 'btn gold sm' : 'btn quiet sm', type: 'button',
          text: mismatch ? 'Push solved timing to protocol card' : 'Protocol card is in sync',
          onclick: function () { global.PlannerProtocols.applyDerived(id); }
        }),
        h('button', {
          class: 'btn quiet sm', type: 'button', text: 'Open protocol card',
          onclick: function () {
            App.show('protocols');
            global.PlannerProtocols.select(App.state.aims[id].protocol);
          }
        })
      ]));
    });

    return node;
  }

  function buildDesignTableCard(id) {
    var host = h('div', {});
    var node = flushCard('Design matrix', null, [host], h('div', { class: 'btn-row' }, [
      h('button', {
        class: 'btn quiet sm', type: 'button', text: 'Copy as Markdown',
        onclick: function () {
          var aim = currentAim(id);
          if (!aim) return;
          copy(App.report.markdownTables[aim.name] || '', 'Design matrix');
        }
      })
    ]));

    registerView(function () {
      var aim = currentAim(id);
      clear(host);
      if (!aim) {
        host.appendChild(h('div', { class: 'notice', text: 'This aim is disabled in the allocation panel.' }));
        return;
      }
      host.appendChild(dataTable(
        [{ label: 'Level' }, { label: 'Sequence' }, { label: 'Trials', num: true }, { label: 'Approx duration', num: true }],
        aim.table.map(function (row) {
          return [
            { text: row.level, className: 'level' },
            { text: row.sequence, className: 'seq' },
            { text: H.fmtNumber(row.trials), num: true },
            { text: row.duration, num: true }
          ];
        })
      ));
    });
    return node;
  }


  /* --------------------------------------------------------- trial figure */

  /* A publication-style schematic of one trial: a strip of stimulus screens,
   * the phase names and their second bounds, an arrow timeline carrying the
   * cumulative onsets, and a to-scale bar underneath so the reader can see
   * how the real proportions differ from the equal-width schematic. */

  var TIMELINE_SANS = 'Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
  var TIMELINE_MONO = 'SF Mono, IBM Plex Mono, JetBrains Mono, Menlo, Consolas, monospace';

  var TIMELINE_ROLE_FILL = {
    fixation: '#DCD59A',
    question: '#046A38',
    rest: '#E7E3C6',
    answer: '#CBA052',
    cue: '#719949',
    other: '#B9C0B4',
    gap: '#D8DCD5'
  };
  var TIMELINE_ROLE_DARK = { question: true, cue: true };

  function timelineEscape(text) {
    return String(text === null || text === undefined ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function timelineClip(text, budget) {
    var value = String(text || '');
    if (budget < 4 || value.length <= budget) return value;
    return value.slice(0, budget - 1).replace(/\s+$/, '') + '\u2026';
  }

  function timelineSeconds(value) {
    return String(H.round(H.num(value), 2));
  }

  /* The dark stimulus screen and whatever the participant sees on it. */
  function timelineScreen(x, y, size, role) {
    var cx = x + size / 2;
    var cy = y + size / 2;
    var parts = ['<rect x="' + x + '" y="' + y + '" width="' + size + '" height="' + size
      + '" rx="3" fill="#101820" stroke="#00482B" stroke-width="1.5"/>'];

    if (role === 'question') {
      var inset = Math.round(size * 0.17);
      var lineX = x + inset;
      var usable = size - inset * 2;
      parts.push('<rect x="' + lineX + '" y="' + (y + inset) + '" width="' + usable
        + '" height="' + usable + '" rx="2" fill="none" stroke="#ffffff" stroke-width="1.4"/>');
      [0.74, 0.92, 0.52].forEach(function (fraction, index) {
        var lineY = y + inset + usable * (0.3 + index * 0.2);
        parts.push('<rect x="' + (lineX + usable * 0.08) + '" y="' + lineY + '" width="'
          + H.round(usable * 0.84 * fraction, 1) + '" height="3" rx="1.5" fill="#F2F1F0"/>');
      });
    } else if (role === 'answer') {
      parts.push('<circle cx="' + cx + '" cy="' + (cy - 6) + '" r="8" fill="#CBA052"/>');
      parts.push('<text x="' + cx + '" y="' + (cy + 20)
        + '" text-anchor="middle" font-family="' + TIMELINE_MONO
        + '" font-size="11" fill="#DCD59A">yes / no</text>');
    } else if (role === 'rest') {
      parts.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + H.round(size * 0.24, 1)
        + '" fill="none" stroke="#3d4a4f" stroke-width="1.2" stroke-dasharray="3 4"/>');
      parts.push('<circle cx="' + cx + '" cy="' + cy + '" r="5" fill="#ffffff"/>');
    } else if (role === 'cue') {
      var arm = Math.round(size * 0.2);
      parts.push('<polygon points="' + cx + ',' + (cy - arm) + ' ' + (cx + arm) + ','
        + (cy + arm) + ' ' + (cx - arm) + ',' + (cy + arm)
        + '" fill="none" stroke="#ffffff" stroke-width="1.8"/>');
      parts.push('<circle cx="' + cx + '" cy="' + (cy + arm * 0.25) + '" r="2.5" fill="#ffffff"/>');
    } else if (role === 'fixation') {
      parts.push('<circle cx="' + cx + '" cy="' + cy + '" r="7" fill="#ffffff"/>');
    } else {
      var side = Math.round(size * 0.3);
      parts.push('<rect x="' + (cx - side / 2) + '" y="' + (cy - side / 2) + '" width="' + side
        + '" height="' + side + '" fill="none" stroke="#ffffff" stroke-width="1.6"/>');
    }
    return parts.join('');
  }

  /* Steps that keep the to-scale ruler to a handful of round labels. */
  function timelineTickStep(total) {
    var candidates = [1, 2, 5, 10, 15, 20, 30, 60, 120];
    for (var i = 0; i < candidates.length; i += 1) {
      if (total / candidates[i] <= 9) return candidates[i];
    }
    return candidates[candidates.length - 1];
  }

  function timelineMarkup(id) {
    var aim = App.state.aims[id];
    var ctx = M.protocolContext(App.boot, aim.protocol);
    var geometry = M.aimGeometry(aim, ctx.trSeconds);

    var steps = aim.phases.map(function (phase) {
      var min = H.num(phase.min);
      var max = Math.max(min, H.num(phase.max));
      return {
        name: phase.name || 'Phase',
        role: phase.role || 'other',
        min: min,
        max: max,
        mean: (min + max) / 2
      };
    });
    if (geometry.interTrialGap > 0) {
      steps.push({
        name: 'Inter-trial gap',
        role: 'gap',
        min: geometry.interTrialGap,
        max: geometry.interTrialGap,
        mean: geometry.interTrialGap
      });
    }
    if (!steps.length) return '';

    var spanMin = H.sum(steps, function (step) { return step.min; });
    var spanMax = H.sum(steps, function (step) { return step.max; });

    var count = steps.length;
    var colWidth = count > 7 ? 148 : (count > 5 ? 168 : 196);
    var padLeft = 30;
    var padRight = 48;
    var width = padLeft + padRight + colWidth * count;
    var inner = width - padLeft - padRight;
    var screen = Math.min(colWidth - 34, 116);

    var screenTop = 16;
    var screenBottom = screenTop + screen;
    var nameY = screenBottom + 24;
    var durationY = nameY + 17;
    var meanY = durationY + 15;
    var axisY = meanY + 26;
    var tickY = axisY + 20;
    var scaleTitleY = tickY + 36;
    var barTop = scaleTitleY + 10;
    var barHeight = 26;
    var barBottom = barTop + barHeight;
    var rulerY = barBottom + 13;
    var legendY = rulerY + 26;
    var height = legendY + 14;

    var svg = [];
    svg.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + ' ' + height
      + '" width="' + width + '" height="' + height + '" role="img">');
    svg.push('<title>' + timelineEscape(aim.name) + ' trial timeline</title>');
    svg.push('<defs><pattern id="tl-jitter-' + id + '" width="7" height="7" '
      + 'patternTransform="rotate(45)" patternUnits="userSpaceOnUse">'
      + '<rect width="7" height="7" fill="#ffffff" fill-opacity="0"/>'
      + '<line x1="0" y1="0" x2="0" y2="7" stroke="#101820" stroke-opacity="0.22" stroke-width="2.5"/>'
      + '</pattern></defs>');
    svg.push('<rect width="' + width + '" height="' + height + '" fill="#ffffff"/>');

    /* Row one: the screens, their names and their second bounds. */
    steps.forEach(function (step, index) {
      var colX = padLeft + colWidth * index;
      var centre = colX + colWidth / 2;
      svg.push(timelineScreen(H.round(centre - screen / 2, 1), screenTop, screen, step.role));
      var label = timelineClip(step.name, Math.floor(colWidth / 7.2));
      svg.push('<text x="' + centre + '" y="' + nameY + '" text-anchor="middle" font-family="'
        + TIMELINE_SANS + '" font-size="13" font-weight="600" fill="#101820">'
        + '<title>' + timelineEscape(step.name) + '</title>'
        + timelineEscape(label) + '</text>');

      var bounds = step.min === step.max
        ? timelineSeconds(step.min) + ' s'
        : timelineSeconds(step.min) + ' – ' + timelineSeconds(step.max) + ' s';
      svg.push('<text x="' + centre + '" y="' + durationY + '" text-anchor="middle" font-family="'
        + TIMELINE_MONO + '" font-size="12.5" fill="#00482B">' + bounds + '</text>');
      if (step.min !== step.max) {
        svg.push('<text x="' + centre + '" y="' + meanY + '" text-anchor="middle" font-family="'
          + TIMELINE_SANS + '" font-size="10.5" fill="#6b767b">jittered, mean '
          + timelineSeconds(step.mean) + ' s</text>');
      }
    });

    /* Row two: the arrow axis carrying the cumulative mean onsets. */
    svg.push('<line x1="' + padLeft + '" y1="' + axisY + '" x2="' + (width - padRight + 12)
      + '" y2="' + axisY + '" stroke="#101820" stroke-width="2.4"/>');
    svg.push('<polygon points="' + (width - padRight + 12) + ',' + (axisY - 6) + ' '
      + (width - padRight + 26) + ',' + axisY + ' ' + (width - padRight + 12) + ',' + (axisY + 6)
      + '" fill="#101820"/>');

    var onset = 0;
    for (var boundary = 0; boundary <= count; boundary += 1) {
      var markX = padLeft + colWidth * boundary;
      if (boundary === count) markX -= 2;
      svg.push('<line x1="' + markX + '" y1="' + axisY + '" x2="' + markX + '" y2="'
        + (axisY - 22) + '" stroke="#046A38" stroke-width="1.6"/>');
      svg.push('<polygon points="' + markX + ',' + (axisY - 28) + ' ' + (markX - 4.5) + ','
        + (axisY - 19) + ' ' + (markX + 4.5) + ',' + (axisY - 19) + '" fill="#046A38"/>');
      svg.push('<text x="' + markX + '" y="' + tickY + '" text-anchor="middle" font-family="'
        + TIMELINE_MONO + '" font-size="11.5" fill="#101820">t = ' + timelineSeconds(onset)
        + ' s</text>');
      if (boundary < count) onset += steps[boundary].mean;
    }

    /* Row three: the same trial drawn to scale. */
    var total = onset || 1;
    svg.push('<text x="' + padLeft + '" y="' + scaleTitleY + '" font-family="' + TIMELINE_SANS
      + '" font-size="10.5" letter-spacing="1.4" fill="#6b767b">DRAWN TO SCALE '
      + '— MEAN TRIAL ' + timelineSeconds(total) + ' S'
      + (spanMin === spanMax ? ''
        : ' (' + timelineSeconds(spanMin) + '–' + timelineSeconds(spanMax) + ' S)')
      + '</text>');

    var cursor = padLeft;
    steps.forEach(function (step) {
      var segment = inner * (step.mean / total);
      var fill = TIMELINE_ROLE_FILL[step.role] || TIMELINE_ROLE_FILL.other;
      svg.push('<rect x="' + H.round(cursor, 2) + '" y="' + barTop + '" width="'
        + H.round(segment, 2) + '" height="' + barHeight + '" fill="' + fill
        + '" stroke="#ffffff" stroke-width="1"/>');
      if (step.min !== step.max) {
        svg.push('<rect x="' + H.round(cursor, 2) + '" y="' + barTop + '" width="'
          + H.round(segment, 2) + '" height="' + barHeight + '" fill="url(#tl-jitter-' + id
          + ')" stroke="none"/>');
      }
      if (segment > 42) {
        svg.push('<text x="' + H.round(cursor + segment / 2, 2) + '" y="' + (barTop + 17)
          + '" text-anchor="middle" font-family="' + TIMELINE_MONO + '" font-size="11" fill="'
          + (TIMELINE_ROLE_DARK[step.role] ? '#F2F1F0' : '#101820') + '">'
          + timelineSeconds(step.mean) + ' s</text>');
      }
      cursor += segment;
    });
    svg.push('<rect x="' + padLeft + '" y="' + barTop + '" width="' + inner + '" height="'
      + barHeight + '" fill="none" stroke="#b9c0b4" stroke-width="1"/>');

    var tickStep = timelineTickStep(total);
    for (var mark = 0; mark <= total + 0.001; mark += tickStep) {
      var x = padLeft + inner * (mark / total);
      svg.push('<line x1="' + H.round(x, 2) + '" y1="' + barBottom + '" x2="' + H.round(x, 2)
        + '" y2="' + (barBottom + 5) + '" stroke="#6b767b" stroke-width="1"/>');
      svg.push('<text x="' + H.round(x, 2) + '" y="' + rulerY + '" text-anchor="middle" '
        + 'font-family="' + TIMELINE_MONO + '" font-size="10.5" fill="#6b767b">'
        + timelineSeconds(mark) + '</text>');
    }

    /* Legend: only the roles this aim actually uses. */
    var seen = {};
    var legendX = padLeft;
    steps.forEach(function (item) {
      if (seen[item.role]) return;
      seen[item.role] = true;
      var label = item.role === 'gap' ? 'inter-trial gap' : item.role;
      svg.push('<rect x="' + legendX + '" y="' + (legendY - 9) + '" width="11" height="11" fill="'
        + (TIMELINE_ROLE_FILL[item.role] || TIMELINE_ROLE_FILL.other)
        + '" stroke="#b9c0b4" stroke-width="1"/>');
      svg.push('<text x="' + (legendX + 16) + '" y="' + legendY + '" font-family="' + TIMELINE_SANS
        + '" font-size="10.5" fill="#3d4a4f">' + timelineEscape(label) + '</text>');
      legendX += 26 + label.length * 6.4;
    });
    svg.push('<rect x="' + legendX + '" y="' + (legendY - 9) + '" width="11" height="11" '
      + 'fill="#ffffff" stroke="#b9c0b4" stroke-width="1"/>');
    svg.push('<rect x="' + legendX + '" y="' + (legendY - 9) + '" width="11" height="11" fill="url(#tl-jitter-'
      + id + ')" stroke="none"/>');
    svg.push('<text x="' + (legendX + 16) + '" y="' + legendY + '" font-family="' + TIMELINE_SANS
      + '" font-size="10.5" fill="#3d4a4f">jittered phase</text>');

    svg.push('</svg>');
    return svg.join('');
  }

  function timelineFileStem(id) {
    return (App.state.aims[id].short || App.state.aims[id].name || 'aim')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-trial-timeline';
  }

  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var anchor = h('a', { href: url, download: filename, style: 'display:none' });
    document.body.appendChild(anchor);
    anchor.click();
    setTimeout(function () {
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
    }, 400);
  }

  function downloadFigureSvg(markup, stem) {
    if (!markup) return;
    saveBlob(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }), stem + '.svg');
    toast('Figure SVG downloaded', 'ok');
  }

  /* PNG goes through an <img> of the serialised SVG, drawn at three times the
   * nominal size so the figure stays sharp in a slide or a grant page. */
  function downloadFigurePng(markup, stem) {
    if (!markup) return;
    var image = new Image();
    image.onload = function () {
      var scale = 3;
      var canvas = h('canvas');
      canvas.width = image.width * scale;
      canvas.height = image.height * scale;
      var pen = canvas.getContext('2d');
      pen.fillStyle = '#ffffff';
      pen.fillRect(0, 0, canvas.width, canvas.height);
      pen.drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(function (blob) {
        if (!blob) { toast('PNG export failed; use the SVG instead.', 'bad'); return; }
        saveBlob(blob, stem + '.png');
        toast('Figure PNG downloaded', 'ok');
      }, 'image/png');
    };
    image.onerror = function () { toast('PNG export failed; use the SVG instead.', 'bad'); };
    image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
  }

  function buildTrialTimelineCard(id) {
    var host = h('div', { class: 'timeline-figure' });
    var caption = h('div', { class: 'plot-caption' });
    var markup = '';

    var node = card('Trial timeline',
      'One trial as the participant experiences it',
      [host, caption, h('div', { class: 'btn-row mt' }, [
        h('button', {
          class: 'btn quiet sm', type: 'button', text: 'Download SVG',
          title: 'Vector figure for a manuscript or a grant page',
          onclick: function () { downloadFigureSvg(markup, timelineFileStem(id)); }
        }),
        h('button', {
          class: 'btn quiet sm', type: 'button', text: 'Download PNG',
          title: 'Raster figure at three times nominal size',
          onclick: function () { downloadFigurePng(markup, timelineFileStem(id)); }
        }),
        h('button', {
          class: 'btn quiet sm', type: 'button', text: 'Copy trial sequence',
          onclick: function () {
            var aimReport = currentAim(id);
            copy(aimReport ? aimReport.table[0].sequence : '', 'Trial sequence');
          }
        })
      ])]);

    registerView(function () {
      markup = timelineMarkup(id);
      host.innerHTML = markup || '';
      if (!markup) {
        clear(host);
        host.appendChild(h('div', {
          class: 'notice',
          text: 'Add at least one trial phase above to draw the timeline.'
        }));
        caption.textContent = '';
        return;
      }
      var aim = App.state.aims[id];
      var ctx = M.protocolContext(App.boot, aim.protocol);
      var geometry = M.aimGeometry(aim, ctx.trSeconds);
      caption.textContent = 'Onsets are cumulative means; jittered phases vary trial to trial. '
        + geometry.trialsPerBlock + ' trials per block, ' + geometry.blocksPerRun
        + ' blocks per run, TR ' + H.round(ctx.trSeconds, 2) + ' s.';
    });

    return node;
  }


  /* -------------------------------------------------------- matrix figure */

  /* The design matrix table drawn as the figure it describes: trial, block,
   * run, session and experiment, each row to scale on its own axis, with the
   * element that the row above expands picked out and joined to it.  Same
   * palette as the trial timeline, so the two figures read as one pair. */

  var MATRIX_FILL = {
    trial: '#00482B',
    gap: '#D8DCD5',
    block: '#00482B',
    rest: '#E7E3C6',
    dummy: '#B9C0B4',
    lead: '#DCD59A',
    run: '#00482B',
    setup: '#CBA052',
    brk: '#F8E08E',
    session: '#00482B'
  };
  var MATRIX_DARK = { trial: true, block: true, run: true, session: true };
  var MATRIX_LEGEND = [
    { kind: 'trial', label: 'trial' },
    { kind: 'gap', label: 'inter-trial gap' },
    { kind: 'rest', label: 'inter-block rest' },
    { kind: 'dummy', label: 'dummy volumes' },
    { kind: 'lead', label: 'lead-in / lead-out' },
    { kind: 'setup', label: 'setup and anatomicals' },
    { kind: 'brk', label: 'in-scanner break' }
  ];

  function matrixCount(value, noun) {
    var count = H.round(H.num(value), 2);
    var text = Math.abs(count - Math.round(count)) < 0.005
      ? H.fmtNumber(Math.round(count))
      : H.trim(count, 2);
    return text + ' ' + noun + (Math.abs(count - 1) < 0.005 ? '' : 's');
  }

  function matrixMinutes(value) {
    var minutes = H.num(value);
    if (minutes >= 90) return H.round(minutes / 60, 2) + ' h';
    return H.round(minutes, 1) + ' min';
  }

  /* One repeating element, laid out `count` times with `gap` between; a
   * fractional count draws its remainder as a cut-off final element. */
  function matrixRepeat(parts, count, span, kind, gap, gapKind) {
    var whole = Math.floor(count + 1e-6);
    var remainder = count - whole;
    for (var index = 0; index < whole; index += 1) {
      parts.push({ span: span, kind: kind });
      if (gap > 0 && (index < whole - 1 || remainder > 0)) {
        parts.push({ span: gap, kind: gapKind });
      }
    }
    if (remainder > 0.01) parts.push({ span: span * remainder, kind: kind, cut: true });
    return parts;
  }

  function matrixRows(id) {
    var record = currentAim(id);
    if (!record) return null;
    var stateAim = App.state.aims[id];
    var structure = record.structure;
    var derived = record.derived;
    var weeks = H.num(App.state.budget.weeksAvailable);

    var trialParts = stateAim.phases.map(function (phase) {
      var min = H.num(phase.min);
      var max = Math.max(min, H.num(phase.max));
      return { span: (min + max) / 2, kind: phase.role || 'other', role: true, label: phase.name };
    });
    if (!trialParts.length) return null;

    var blockParts = matrixRepeat([], structure.trialsPerBlock, derived.trialMean,
      'trial', structure.interTrialGap, 'gap');

    var runParts = [];
    if (derived.dummySeconds > 0) runParts.push({ span: derived.dummySeconds, kind: 'dummy' });
    if (structure.leadIn > 0) runParts.push({ span: structure.leadIn, kind: 'lead' });
    matrixRepeat(runParts, structure.blocksPerRun, derived.blockMean,
      'block', structure.interBlockRest, 'rest');
    if (structure.leadOut > 0) runParts.push({ span: structure.leadOut, kind: 'lead' });

    var sessionParts = [];
    if (derived.sessionSetupMinutes > 0) {
      sessionParts.push({ span: derived.sessionSetupMinutes, kind: 'setup' });
    }
    matrixRepeat(sessionParts, structure.runsPerSession, derived.runMean / 60,
      'run', derived.sessionBreakMinutes, 'brk');

    var experimentParts = matrixRepeat([], derived.sessions, derived.sessionMeanMinutes,
      'session', 0, null);

    /* Where the row above lands inside this row: the first repeating element. */
    function offsetOf(parts, kind) {
      var at = 0;
      for (var index = 0; index < parts.length; index += 1) {
        if (parts[index].kind === kind) return { from: at, to: at + parts[index].span };
        at += parts[index].span;
      }
      return null;
    }

    return [
      {
        level: 'Trial', parts: trialParts, unit: 's',
        note: '1 trial · ' + record.table[0].duration
      },
      {
        level: 'Block', parts: blockParts, unit: 's',
        note: matrixCount(structure.trialsPerBlock, 'trial') + ' · '
          + matrixMinutes(derived.blockMean / 60),
        zoom: offsetOf(blockParts, 'trial')
      },
      {
        level: 'Run', parts: runParts, unit: 's',
        note: matrixCount(structure.blocksPerRun, 'block') + ' · '
          + matrixCount(derived.trialsPerRun, 'trial') + ' · '
          + matrixMinutes(derived.runMean / 60) + ' · '
          + H.fmtNumber(derived.volumesPerRun) + ' volumes',
        zoom: offsetOf(runParts, 'block')
      },
      {
        level: 'Session', parts: sessionParts, unit: 'min',
        note: matrixCount(structure.runsPerSession, 'run') + ' · '
          + matrixCount(derived.trialsPerSession, 'trial') + ' · '
          + matrixMinutes(derived.sessionMeanMinutes),
        zoom: offsetOf(sessionParts, 'run')
      },
      {
        level: 'Experiment', parts: experimentParts, unit: 'min',
        note: matrixCount(derived.sessions, 'session') + ' over '
          + matrixCount(weeks, 'week') + ' · '
          + matrixCount(derived.totalTrials, 'trial') + ' · '
          + H.round(derived.totalHours, 1) + ' h',
        zoom: offsetOf(experimentParts, 'session')
      }
    ];
  }

  function matrixFigureMarkup(id) {
    var rows = matrixRows(id);
    if (!rows) return '';

    var width = 1120;
    var padLeft = 26;
    var padRight = 26;
    var inner = width - padLeft - padRight;
    var barHeight = 32;
    var connector = 34;
    var rowPitch = 18 + barHeight + connector;
    var top = 20;

    var svg = [];
    var lastBottom = top + (rows.length - 1) * rowPitch + 18 + barHeight;
    svg.push('<defs><pattern id="mx-cut-' + id + '" width="6" height="6" '
      + 'patternTransform="rotate(45)" patternUnits="userSpaceOnUse">'
      + '<line x1="0" y1="0" x2="0" y2="6" stroke="#ffffff" stroke-opacity="0.75" stroke-width="2"/>'
      + '</pattern></defs>');

    rows.forEach(function (row, index) {
      var barTop = top + index * rowPitch + 18;
      var total = H.sum(row.parts, function (part) { return part.span; }) || 1;
      row.barTop = barTop;
      row.scale = function (value) { return padLeft + inner * (value / total); };

      svg.push('<text x="' + padLeft + '" y="' + (barTop - 7) + '" font-family="' + TIMELINE_SANS
        + '" font-size="10.5" letter-spacing="1.6" font-weight="600" fill="#00482B">'
        + row.level.toUpperCase() + '</text>');
      svg.push('<text x="' + (width - padRight) + '" y="' + (barTop - 7) + '" text-anchor="end" '
        + 'font-family="' + TIMELINE_SANS + '" font-size="11" fill="#3d4a4f">'
        + timelineEscape(row.note) + '</text>');

      var cursor = 0;
      var thin = row.parts.length > 1
        && inner / row.parts.length < 3.5;
      row.parts.forEach(function (part) {
        var x = row.scale(cursor);
        var segment = inner * (part.span / total);
        var fill = part.role
          ? (TIMELINE_ROLE_FILL[part.kind] || TIMELINE_ROLE_FILL.other)
          : (MATRIX_FILL[part.kind] || MATRIX_FILL.trial);
        svg.push('<rect x="' + H.round(x, 2) + '" y="' + barTop + '" width="'
          + H.round(Math.max(segment, 0.6), 2) + '" height="' + barHeight + '" fill="' + fill
          + (thin ? '"' : '" stroke="#ffffff" stroke-width="1"') + '/>');
        if (part.cut) {
          svg.push('<rect x="' + H.round(x, 2) + '" y="' + barTop + '" width="'
            + H.round(Math.max(segment, 0.6), 2) + '" height="' + barHeight
            + '" fill="url(#mx-cut-' + id + ')"/>');
        }
        if (segment > 46) {
          var text = row.unit === 'min'
            ? matrixMinutes(part.span)
            : (part.span >= 120 ? matrixMinutes(part.span / 60) : timelineSeconds(part.span) + ' s');
          svg.push('<text x="' + H.round(x + segment / 2, 2) + '" y="' + (barTop + 20)
            + '" text-anchor="middle" font-family="' + TIMELINE_MONO + '" font-size="10.5" fill="'
            + (MATRIX_DARK[part.kind] && !part.role ? '#F2F1F0'
              : (TIMELINE_ROLE_DARK[part.kind] && part.role ? '#F2F1F0' : '#101820'))
            + '">' + text + '</text>');
        }
        cursor += part.span;
      });
      svg.push('<rect x="' + padLeft + '" y="' + barTop + '" width="' + inner + '" height="'
        + barHeight + '" fill="none" stroke="#b9c0b4" stroke-width="1"/>');
    });

    /* Join each row to the element of the row below that contains it. */
    rows.forEach(function (row, index) {
      if (!row.zoom || index === 0) return;
      var above = rows[index - 1];
      var aboveBottom = above.barTop + barHeight;
      var left = row.scale(row.zoom.from);
      var right = Math.max(left + 1.2, row.scale(row.zoom.to));

      svg.push('<polygon points="' + padLeft + ',' + aboveBottom + ' ' + (width - padRight) + ','
        + aboveBottom + ' ' + H.round(right, 2) + ',' + row.barTop + ' ' + H.round(left, 2) + ','
        + row.barTop + '" fill="#CBA052" fill-opacity="0.12"/>');
      svg.push('<line x1="' + padLeft + '" y1="' + aboveBottom + '" x2="' + H.round(left, 2)
        + '" y2="' + row.barTop + '" stroke="#AE8643" stroke-width="1" stroke-dasharray="4 3"/>');
      svg.push('<line x1="' + (width - padRight) + '" y1="' + aboveBottom + '" x2="'
        + H.round(right, 2) + '" y2="' + row.barTop
        + '" stroke="#AE8643" stroke-width="1" stroke-dasharray="4 3"/>');
      svg.push('<rect x="' + H.round(left, 2) + '" y="' + row.barTop + '" width="'
        + H.round(right - left, 2) + '" height="' + barHeight
        + '" fill="none" stroke="#AE8643" stroke-width="1.6"/>');
    });

    /* Legend: trial phase roles first, then the structural elements. */
    var legendY = lastBottom + 26;
    var legendX = padLeft;
    var seen = {};
    var entries = [];
    rows[0].parts.forEach(function (part) {
      if (seen[part.kind]) return;
      seen[part.kind] = true;
      entries.push({ fill: TIMELINE_ROLE_FILL[part.kind] || TIMELINE_ROLE_FILL.other, label: part.kind });
    });
    MATRIX_LEGEND.forEach(function (entry) {
      var used = rows.some(function (row, index) {
        return index > 0 && row.parts.some(function (part) { return part.kind === entry.kind; });
      });
      if (used) entries.push({ fill: MATRIX_FILL[entry.kind], label: entry.label });
    });

    entries.forEach(function (entry) {
      var span = 26 + entry.label.length * 6.4;
      if (legendX + span > width - padRight) {
        legendX = padLeft;
        legendY += 18;
      }
      svg.push('<rect x="' + legendX + '" y="' + (legendY - 9) + '" width="11" height="11" fill="'
        + entry.fill + '" stroke="#b9c0b4" stroke-width="1"/>');
      svg.push('<text x="' + (legendX + 16) + '" y="' + legendY + '" font-family="' + TIMELINE_SANS
        + '" font-size="10.5" fill="#3d4a4f">' + timelineEscape(entry.label) + '</text>');
      legendX += span;
    });

    var height = legendY + 14;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + ' ' + height
      + '" width="' + width + '" height="' + height + '" role="img">'
      + '<title>' + timelineEscape(App.state.aims[id].name) + ' design matrix</title>'
      + '<rect width="' + width + '" height="' + height + '" fill="#ffffff"/>'
      + svg.join('') + '</svg>';
  }

  function buildAimMatrixFigureCard(id) {
    var host = h('div', { class: 'timeline-figure' });
    var caption = h('div', { class: 'plot-caption' });
    var markup = '';

    function stem() {
      return timelineFileStem(id).replace('-trial-timeline', '-design-matrix');
    }

    var node = card('Design matrix figure',
      [host, caption, h('div', { class: 'btn-row mt' }, [
        h('button', {
          class: 'btn quiet sm', type: 'button', text: 'Download SVG',
          title: 'Vector figure for a manuscript or a grant page',
          onclick: function () { downloadFigureSvg(markup, stem()); }
        }),
        h('button', {
          class: 'btn quiet sm', type: 'button', text: 'Download PNG',
          title: 'Raster figure at three times nominal size',
          onclick: function () { downloadFigurePng(markup, stem()); }
        }),
        h('button', {
          class: 'btn quiet sm', type: 'button', text: 'Copy as Markdown',
          onclick: function () {
            var aimReport = currentAim(id);
            if (!aimReport) return;
            copy(App.report.markdownTables[aimReport.name] || '', 'Design matrix');
          }
        })
      ])]);

    registerView(function () {
      markup = matrixFigureMarkup(id);
      host.innerHTML = markup || '';
      if (!markup) {
        clear(host);
        host.appendChild(h('div', {
          class: 'notice',
          text: 'This aim is disabled in the allocation panel, so it has no solved design matrix.'
        }));
        caption.textContent = '';
        return;
      }
      var record = currentAim(id);
      caption.textContent = 'Durations are means; jitter moves every level. '
        + record.protocolLabel + ', TR ' + H.round(record.trMs / 1000, 2) + ' s.';
    });

    return node;
  }



  /* ---------------------------------------------------------- aim toggles */

  /* Which aims the budget is spent on, on the overview rather than three
   * clicks away in the allocation panel: switching one off hands its share to
   * the aims that are left, so "all of it on Aim 3" is one click. */
  function buildAimToggleCard() {
    var strip = h('div', { class: 'seg' });
    var buttons = {};

    function apply(message) {
      M.normaliseAllocation(App.state, null);
      App.refresh();
      toast(message, 'ok');
    }

    M.AIM_IDS.forEach(function (id) {
      var button = h('button', { type: 'button' });
      button.addEventListener('click', function () {
        var aim = App.state.aims[id];
        aim.enabled = !aim.enabled;
        apply(aim.name + (aim.enabled ? ' is back in the budget' : ' dropped; its hours go to the rest'));
      });
      buttons[id] = button;
      strip.appendChild(button);
    });

    function only(id) {
      M.AIM_IDS.forEach(function (other) {
        App.state.aims[other].enabled = other === id;
        App.state.aims[other].locked = false;
      });
      App.state.aims[id].requestedPct = 100;
      apply('Every usable hour is on ' + App.state.aims[id].name);
    }

    var presets = h('div', { class: 'btn-row mt' }, [
      h('button', {
        class: 'btn quiet sm', type: 'button', text: 'All aims',
        title: 'Put every aim back in the budget',
        onclick: function () {
          M.AIM_IDS.forEach(function (id) { App.state.aims[id].enabled = true; });
          apply('Every aim is back in the budget');
        }
      })
    ].concat(M.AIM_IDS.map(function (id) {
      return h('button', {
        class: 'btn quiet sm', type: 'button', text: 'Only ' + App.state.aims[id].short,
        title: 'Spend the whole envelope on ' + App.state.aims[id].name,
        onclick: function () { only(id); }
      });
    })).concat([
      h('button', {
        class: 'btn quiet sm', type: 'button', text: 'Equal split',
        title: 'Divide the envelope evenly between the aims that are on',
        onclick: function () {
          var active = M.AIM_IDS.filter(function (id) { return App.state.aims[id].enabled; });
          if (!active.length) { toast('No aims are enabled', 'bad'); return; }
          active.forEach(function (id) {
            App.state.aims[id].locked = false;
            App.state.aims[id].requestedPct = H.round(100 / active.length, 2);
          });
          apply('Envelope split evenly across ' + matrixCount(active.length, 'aim'));
        }
      })
    ]));

    var note = h('div', { class: 'muted', style: 'font-size:11px;margin-top:8px' });

    registerView(function (report) {
      M.AIM_IDS.forEach(function (id) {
        var aim = App.state.aims[id];
        var solved = report.totals.byAim.filter(function (entry) { return entry.id === id; })[0];
        buttons[id].classList.toggle('active', !!aim.enabled);
        buttons[id].textContent = aim.short + (aim.enabled
          ? ' · ' + H.round(H.num(aim.requestedPct), 1) + '%'
          : ' · off');
        buttons[id].title = aim.enabled
          ? 'Drop ' + aim.name + ' and hand its hours to the other aims'
          + (solved ? ' (currently ' + H.round(solved.hours, 1) + ' h)' : '')
          : 'Put ' + aim.name + ' back in the budget';
      });

      var on = report.totals.byAim;
      if (!on.length) {
        note.textContent = 'No aims are enabled, so nothing is scheduled and the whole '
          + H.round(report.budget.usableHours, 1) + ' h envelope is unspent.';
        return;
      }
      note.textContent = on.map(function (entry) {
        return entry.short + ' ' + H.round(entry.hours, 1) + ' h / '
          + H.fmtNumber(entry.primaryQuestions) + ' questions';
      }).join(' · ') + ' — ' + H.round(report.totals.hours, 1) + ' h of '
        + H.round(report.budget.usableHours, 1) + ' h usable, '
        + matrixCount(report.totals.sessions, 'session') + ' over '
        + report.totals.weeks + ' weeks.';
    });

    return card('Aims in play', 'Switch an aim out and its hours go to the others',
      [strip, presets, note]);
  }

  /* --------------------------------------------------------- study figure */

  /* Everything the three aims commit to, on three shared axes: one trial, one
   * session and the whole scanner-hour envelope.  Because the rows share a
   * scale, the comparison the aim panels cannot make - a Time-Series trial
   * against a GLM trial - is the thing you see first. */

  function studyBarText(fill) {
    return fill === '#046A38' || fill === '#00482B' ? '#F2F1F0' : '#101820';
  }

  function studyRuler(svg, x0, span, total, y, unit) {
    var step = timelineTickStep(total);
    for (var mark = 0; mark <= total + 0.001; mark += step) {
      var x = x0 + span * (mark / total);
      svg.push('<line x1="' + H.round(x, 2) + '" y1="' + (y - 5) + '" x2="' + H.round(x, 2)
        + '" y2="' + y + '" stroke="#6b767b" stroke-width="1"/>');
      svg.push('<text x="' + H.round(x, 2) + '" y="' + (y + 12) + '" text-anchor="middle" '
        + 'font-family="' + TIMELINE_MONO + '" font-size="10" fill="#6b767b">'
        + timelineSeconds(mark) + '</text>');
    }
    svg.push('<text x="' + (x0 - 10) + '" y="' + (y + 12) + '" text-anchor="end" font-family="'
      + TIMELINE_SANS + '" font-size="10" fill="#6b767b">' + unit + '</text>');
  }

  function studyFigureMarkup() {
    var report = App.report;
    if (!report) return '';
    var aims = report.aims.filter(function (aim) { return aim.enabled; });
    if (!aims.length) return '';

    var width = 1180;
    var gutter = 116;
    var padLeft = 22;
    var padRight = 22;
    var trail = 148;
    var barSpan = width - padRight - padLeft - gutter - trail;
    var x0 = padLeft + gutter;
    var barHeight = 24;
    var rowPitch = 34;

    var svg = [];
    var y = 30;

    function heading(text, y) {
      svg.push('<text x="' + padLeft + '" y="' + y + '" font-family="' + TIMELINE_SANS
        + '" font-size="10.5" letter-spacing="1.6" font-weight="600" fill="#00482B">'
        + text.toUpperCase() + '</text>');
    }

    function rowLabel(text, y) {
      svg.push('<text x="' + (x0 - 12) + '" y="' + y + '" text-anchor="end" font-family="'
        + TIMELINE_SANS + '" font-size="12" font-weight="600" fill="#101820">'
        + timelineEscape(text) + '</text>');
    }

    function trailing(x, y, text) {
      svg.push('<text x="' + H.round(x + 10, 2) + '" y="' + y + '" font-family="' + TIMELINE_MONO
        + '" font-size="10.5" fill="#3d4a4f">' + timelineEscape(text) + '</text>');
    }

    /* ---- one trial per aim, all on the same seconds scale */
    heading('Trial · same seconds scale for every aim', y);
    y += 12;
    var trialScale = Math.max.apply(null, aims.map(function (aim) {
      return H.num(aim.derived.trialMean);
    })) || 1;

    aims.forEach(function (aim) {
      var cursor = x0;
      rowLabel(aim.short, y + 16);
      aim.phases.forEach(function (phase) {
        var mean = (H.num(phase.min) + Math.max(H.num(phase.min), H.num(phase.max))) / 2;
        var segment = barSpan * (mean / trialScale);
        svg.push('<rect x="' + H.round(cursor, 2) + '" y="' + y + '" width="'
          + H.round(Math.max(segment, 0.6), 2) + '" height="' + barHeight + '" fill="'
          + (TIMELINE_ROLE_FILL[phase.role] || TIMELINE_ROLE_FILL.other)
          + '" stroke="#ffffff" stroke-width="0.8"/>');
        cursor += segment;
      });
      svg.push('<rect x="' + x0 + '" y="' + y + '" width="'
        + H.round(cursor - x0, 2) + '" height="' + barHeight
        + '" fill="none" stroke="#b9c0b4" stroke-width="1"/>');
      trailing(cursor, y + 16, H.round(aim.derived.trialMean, 1) + ' s · '
        + H.fmtNumber(aim.derived.totalTrials) + ' trials');
      y += rowPitch;
    });
    studyRuler(svg, x0, barSpan, trialScale, y - 4, 'seconds');
    y += 30;

    /* ---- one session per aim, all on the same minutes scale */
    heading('Session · same minutes scale for every aim', y);
    y += 12;
    var sessionScale = Math.max.apply(null, aims.map(function (aim) {
      return H.num(aim.derived.sessionMeanMinutes);
    })) || 1;

    aims.forEach(function (aim) {
      var colour = AIM_COLOURS[aim.id] || '#046A38';
      var parts = [];
      if (aim.derived.sessionSetupMinutes > 0) {
        parts.push({ span: aim.derived.sessionSetupMinutes, fill: '#B9C0B4' });
      }
      matrixRepeat(parts, aim.structure.runsPerSession, aim.derived.runMean / 60,
        'run', aim.derived.sessionBreakMinutes, 'brk')
        .forEach(function (part) {
          if (part.fill) return;
          part.fill = part.kind === 'run' ? colour : '#F8E08E';
        });

      var cursor = x0;
      rowLabel(aim.short, y + 16);
      parts.forEach(function (part) {
        var segment = barSpan * (part.span / sessionScale);
        svg.push('<rect x="' + H.round(cursor, 2) + '" y="' + y + '" width="'
          + H.round(Math.max(segment, 0.6), 2) + '" height="' + barHeight + '" fill="' + part.fill
          + '" stroke="#ffffff" stroke-width="0.8"/>');
        cursor += segment;
      });
      svg.push('<rect x="' + x0 + '" y="' + y + '" width="' + H.round(cursor - x0, 2)
        + '" height="' + barHeight + '" fill="none" stroke="#b9c0b4" stroke-width="1"/>');
      trailing(cursor, y + 16, H.round(aim.derived.sessionMeanMinutes, 0) + ' min · '
        + matrixCount(aim.derived.sessions, 'session'));
      y += rowPitch;
    });
    studyRuler(svg, x0, barSpan, sessionScale, y - 4, 'minutes');
    y += 34;

    /* ---- the whole envelope, stacked by aim */
    var usable = Math.max(0.01, H.num(report.budget.usableHours));
    var committed = H.num(report.totals.hours);
    var scale = Math.max(usable, committed);
    var envelopeSpan = width - padRight - x0;
    heading('Scanner-hour budget · ' + H.round(committed, 1) + ' h committed of '
      + H.round(usable, 1) + ' h usable', y);
    y += 12;

    var envelopeTop = y;
    var cursor = x0;
    rowLabel('Total', envelopeTop + 21);
    aims.forEach(function (aim) {
      var segment = envelopeSpan * (H.num(aim.derived.totalHours) / scale);
      var fill = AIM_COLOURS[aim.id] || '#046A38';
      svg.push('<rect x="' + H.round(cursor, 2) + '" y="' + envelopeTop + '" width="'
        + H.round(Math.max(segment, 0.6), 2) + '" height="34" fill="' + fill
        + '" stroke="#ffffff" stroke-width="1"/>');
      if (segment > 62) {
        svg.push('<text x="' + H.round(cursor + segment / 2, 2) + '" y="' + (envelopeTop + 21)
          + '" text-anchor="middle" font-family="' + TIMELINE_MONO + '" font-size="11" fill="'
          + studyBarText(fill) + '">' + timelineEscape(aim.short) + ' · '
          + H.round(aim.derived.totalHours, 1) + ' h</text>');
      }
      cursor += segment;
    });
    if (committed < usable) {
      var spare = x0 + envelopeSpan - cursor;
      svg.push('<rect x="' + H.round(cursor, 2) + '" y="' + envelopeTop + '" width="'
        + H.round(spare, 2) + '" height="34" fill="#F2F1F0" stroke="#b9c0b4" stroke-width="1"/>');
      if (spare > 96) {
        svg.push('<text x="' + H.round(cursor + spare / 2, 2) + '" y="' + (envelopeTop + 21)
          + '" text-anchor="middle" font-family="' + TIMELINE_MONO + '" font-size="11" '
          + 'fill="#6b767b">' + H.round(usable - committed, 1) + ' h unallocated</text>');
      }
    }
    svg.push('<rect x="' + x0 + '" y="' + envelopeTop + '" width="' + envelopeSpan
      + '" height="34" fill="none" stroke="#b9c0b4" stroke-width="1"/>');

    /* The cap only needs marking when the aims have run past it. */
    if (committed > usable) {
      var capX = x0 + envelopeSpan * (usable / scale);
      svg.push('<line x1="' + H.round(capX, 2) + '" y1="' + (envelopeTop - 6) + '" x2="'
        + H.round(capX, 2) + '" y2="' + (envelopeTop + 40)
        + '" stroke="#a8422b" stroke-width="2"/>');
      svg.push('<text x="' + H.round(capX + 6, 2) + '" y="' + (envelopeTop + 50)
        + '" font-family="' + TIMELINE_SANS + '" font-size="10.5" fill="#a8422b">budget cap '
        + H.round(usable, 1) + ' h · over by ' + H.round(committed - usable, 1) + ' h</text>');
      y += 14;
    }
    y += 34;
    studyRuler(svg, x0, envelopeSpan, scale, y + 2, 'hours');
    y += 30;

    /* ---- what each aim buys with its share */
    aims.forEach(function (aim) {
      var fill = AIM_COLOURS[aim.id] || '#046A38';
      svg.push('<rect x="' + padLeft + '" y="' + (y - 9) + '" width="11" height="11" fill="' + fill
        + '" stroke="#b9c0b4" stroke-width="1"/>');
      svg.push('<text x="' + (padLeft + 18) + '" y="' + y + '" font-family="' + TIMELINE_SANS
        + '" font-size="11" fill="#101820" font-weight="600">' + timelineEscape(aim.name)
        + '</text>');
      svg.push('<text x="' + (width - padRight) + '" y="' + y + '" text-anchor="end" font-family="'
        + TIMELINE_MONO + '" font-size="10.5" fill="#3d4a4f">'
        + H.round(aim.derived.totalHours, 1) + ' h · ' + H.round(aim.derived.sharePct, 1) + '% · '
        + matrixCount(aim.derived.sessions, 'session') + ' · '
        + H.fmtNumber(aim.derived.totalTrials) + ' trials · '
        + H.fmtNumber(aim.derived.primaryQuestions) + ' questions · '
        + H.round(aim.derived.trialMean, 1) + ' s trial</text>');
      y += 17;
    });

    /* ---- trial phase roles, shared with the per-aim figures */
    y += 12;
    var legendX = padLeft;
    var seen = {};
    aims.forEach(function (aim) {
      aim.phases.forEach(function (phase) {
        var role = phase.role || 'other';
        if (seen[role]) return;
        seen[role] = true;
        var span = 26 + role.length * 6.4;
        if (legendX + span > width - padRight) { legendX = padLeft; y += 18; }
        svg.push('<rect x="' + legendX + '" y="' + (y - 9) + '" width="11" height="11" fill="'
          + (TIMELINE_ROLE_FILL[role] || TIMELINE_ROLE_FILL.other)
          + '" stroke="#b9c0b4" stroke-width="1"/>');
        svg.push('<text x="' + (legendX + 16) + '" y="' + y + '" font-family="' + TIMELINE_SANS
          + '" font-size="10.5" fill="#3d4a4f">' + timelineEscape(role) + '</text>');
        legendX += span;
      });
    });
    [['#B9C0B4', 'setup and anatomicals'], ['#F8E08E', 'in-scanner break']].forEach(function (pair) {
      var span = 26 + pair[1].length * 6.4;
      if (legendX + span > width - padRight) { legendX = padLeft; y += 18; }
      svg.push('<rect x="' + legendX + '" y="' + (y - 9) + '" width="11" height="11" fill="'
        + pair[0] + '" stroke="#b9c0b4" stroke-width="1"/>');
      svg.push('<text x="' + (legendX + 16) + '" y="' + y + '" font-family="' + TIMELINE_SANS
        + '" font-size="10.5" fill="#3d4a4f">' + pair[1] + '</text>');
      legendX += span;
    });

    var height = y + 16;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + ' ' + height
      + '" width="' + width + '" height="' + height + '" role="img">'
      + '<title>' + timelineEscape(report.meta.studyTitle || 'Study') + ' - every aim on one scale</title>'
      + '<rect width="' + width + '" height="' + height + '" fill="#ffffff"/>'
      + svg.join('') + '</svg>';
  }

  function buildStudyFigureCard() {
    var host = h('div', { class: 'timeline-figure' });
    var caption = h('div', { class: 'plot-caption' });
    var markup = '';

    var node = card('Every aim on one scale',
      'Trial, session and scanner-hour budget across the whole study',
      [host, caption, h('div', { class: 'btn-row mt' }, [
        h('button', {
          class: 'btn quiet sm', type: 'button', text: 'Download SVG',
          title: 'Vector figure for a manuscript or a grant page',
          onclick: function () { downloadFigureSvg(markup, 'study-all-aims'); }
        }),
        h('button', {
          class: 'btn quiet sm', type: 'button', text: 'Download PNG',
          title: 'Raster figure at three times nominal size',
          onclick: function () { downloadFigurePng(markup, 'study-all-aims'); }
        }),
        h('button', {
          class: 'btn quiet sm', type: 'button', text: 'Copy budget table',
          onclick: function () {
            copy(App.report.markdownTables['Budget and allocation'] || '', 'Budget and allocation');
          }
        })
      ])]);

    registerView(function (report) {
      markup = studyFigureMarkup();
      host.innerHTML = markup || '';
      if (!markup) {
        clear(host);
        host.appendChild(h('div', {
          class: 'notice',
          text: 'Enable at least one aim in the allocation panel to draw the study figure.'
        }));
        caption.textContent = '';
        return;
      }
      caption.textContent = 'Trial and session rows share one scale each, so the aims are directly '
        + 'comparable; durations are means. ' + H.fmtNumber(report.totals.trials) + ' trials over '
        + matrixCount(report.totals.sessions, 'session') + ', '
        + H.round(report.totals.hours, 1) + ' h of scanner time at '
        + H.round(report.totals.utilisationPct, 1) + '% of the usable budget.';
    });

    return node;
  }

  function buildEfficiencyCard(id) {
    var readout = h('div', { class: 'readout' });
    var plot = regressorPlot();
    var matrix = h('canvas');
    var node = card('Design efficiency', 'Simulated single run at the bound TR', [
      readout,
      h('div', { class: 'mt' }, [plot.node]),
      h('div', { class: 'plot-wrap mt' }, [matrix,
        h('div', {
          class: 'plot-caption',
          text: 'Design matrix columns, darker is higher predicted signal'
        })])
    ]);

    registerView(function () {
      var aim = currentAim(id);
      clear(readout);
      if (!aim) return;
      var stateAim = App.state.aims[id];
      var ctx = M.protocolContext(App.boot, stateAim.protocol);
      var geometry = M.aimGeometry(stateAim, ctx.trSeconds);
      var efficiency = global.PlannerEfficiency.evaluate(stateAim, ctx.trSeconds, geometry, { series: true });

      var objective = M.aimObjective(stateAim);
      function mark(key) { return objective === key ? 'accent' : ''; }

      readout.appendChild(readoutCell('Duty cycle (never settles)',
        H.round(efficiency.sustainPct, 1) + ' <small>%</small>', mark('detection')));
      readout.appendChild(readoutCell('Stacking gain', H.round(efficiency.saturationIndex, 2),
        mark('detection')));
      readout.appendChild(readoutCell('Single-trial eff.', H.round(efficiency.singleTrialEff, 3),
        mark('estimation')));
      readout.appendChild(readoutCell('Carryover at next prompt',
        H.round(efficiency.carryoverPct, 1) + ' <small>%</small>',
        objective === 'separation' && efficiency.carryoverPct > 10 ? 'alert' : mark('separation')));
      readout.appendChild(readoutCell('Prompt bleed into answer',
        H.round(efficiency.promptBleedPct, 1) + ' <small>%</small>',
        objective === 'separation' && efficiency.promptBleedPct > 20 ? 'alert' : mark('separation')));
      readout.appendChild(readoutCell('r (question, answer)', H.round(efficiency.corrQuestionAnswer, 3),
        Math.abs(efficiency.corrQuestionAnswer) > 0.6 ? 'alert' : ''));
      readout.appendChild(readoutCell('Eff. yes vs no', H.round(efficiency.effYesVsNo, 1)));
      readout.appendChild(readoutCell('Eff. answer vs base', H.round(efficiency.effAnswerVsBaseline, 1)));
      readout.appendChild(readoutCell('Eff. question vs answer', H.round(efficiency.effQuestionVsAnswer, 1)));
      readout.appendChild(readoutCell('Max VIF', H.round(efficiency.maxVif, 2),
        efficiency.maxVif > 5 ? 'alert' : ''));
      readout.appendChild(readoutCell('Volumes', efficiency.volumes));
      readout.appendChild(readoutCell('Eff. per minute',
        H.round(efficiency.effYesVsNo / Math.max(0.01, efficiency.runSeconds / 60), 1)));
      readout.appendChild(readoutCell('Run simulated', H.round(efficiency.runSeconds / 60, 1) + ' <small>min</small>'));

      plot.render(efficiency);
      drawDesignMatrix(matrix, efficiency);
    });

    return node;
  }

  /* -------------------------------------------------------- session panel */

  /* A tab strip that swaps between pre-built views. */
  function tabStrip(entries, onSelect) {
    var buttons = {};
    var strip = h('div', { class: 'tabs' });
    entries.forEach(function (entry) {
      var button = h('button', {
        class: 'tab', type: 'button', title: entry.title || '',
        onclick: function () { onSelect(entry.id); }
      }, [
        h('span', { text: entry.label }),
        entry.badge ? h('span', { class: 'tab-badge', text: entry.badge }) : null
      ]);
      if (entry.colour) button.style.setProperty('--tab-colour', entry.colour);
      buttons[entry.id] = button;
      strip.appendChild(button);
    });
    return { node: strip, buttons: buttons };
  }

  function buildSessionPanel() {
    var panel = h('div', { class: 'panel' });
    panel.appendChild(h('div', { class: 'panel-head' }, [
      h('h2', { text: 'Session composition' }),
      h('p', {
        text: 'Non-acquisition overhead, structural and reference series, and the console-order '
          + 'timeline each aim actually runs. Every aim can keep the shared composition or take '
          + 'its own.'
      })
    ]));

    var entries = [{ id: 'shared', label: 'Shared defaults', title: 'Applied to every aim that has no composition of its own' }];
    M.AIM_IDS.forEach(function (id) {
      entries.push({
        id: id, label: App.state.aims[id].short, colour: AIM_COLOURS[id],
        title: App.state.aims[id].name
      });
    });

    var views = {};
    var active = 'shared';
    var strip = tabStrip(entries, function (id) { select(id); });

    function select(id) {
      active = id;
      Object.keys(views).forEach(function (key) {
        views[key].classList.toggle('active', key === id);
      });
      Object.keys(strip.buttons).forEach(function (key) {
        strip.buttons[key].classList.toggle('active', key === id);
      });
      if (App.report) App.views.forEach(function (view) { view.render(App.report); });
    }

    views.shared = buildSharedSessionView();
    M.AIM_IDS.forEach(function (id) { views[id] = buildAimSessionView(id); });

    panel.appendChild(strip.node);
    Object.keys(views).forEach(function (key) { panel.appendChild(views[key]); });

    /* Mark the tabs whose aim runs a composition of its own. */
    registerView(function (report) {
      (report.session.perAimComposition || []).forEach(function (record) {
        var button = strip.buttons[record.id];
        if (!button) return;
        button.classList.toggle('custom', !!record.custom);
        button.title = record.name + (record.custom
          ? ' - custom session composition' : ' - shared session composition');
      });
    });

    select('shared');
    return panel;
  }

  function overheadControls(base, owner, disabledWhen) {
    return [
      slider({
        owner: owner, label: 'Safety screening and consent',
        path: base + '.screeningMinutes', min: 0, max: 30, step: 1, unit: 'min',
        disabledWhen: disabledWhen
      }),
      slider({
        owner: owner, label: 'Positioning and stabilisation',
        path: base + '.positioningMinutes', min: 0, max: 30, step: 1, unit: 'min',
        disabledWhen: disabledWhen
      }),
      slider({
        owner: owner, label: 'Task refresher and practice',
        path: base + '.practiceMinutes', min: 0, max: 30, step: 1, unit: 'min',
        disabledWhen: disabledWhen
      }),
      slider({
        owner: owner, label: 'Break between runs',
        path: base + '.breakMinutes', min: 0, max: 20, step: 0.5, decimals: 1, unit: 'min',
        gold: true, disabledWhen: disabledWhen
      })
    ];
  }

  function buildSharedSessionView() {
    var view = h('div', { class: 'tabview' });
    var left = h('div', {});
    left.appendChild(card('Non-acquisition overhead', 'Occupies the scanner slot',
      overheadControls('session', 'session-shared', null).concat([
        segmented({
          label: 'Dynamics written to protocol cards',
          hint: 'Longest run guarantees the paradigm never outlasts the acquisition',
          path: 'dynScansFrom',
          options: [
            { value: 'max', label: 'Longest run' },
            { value: 'mean', label: 'Expected run' }
          ]
        })
      ])));
    left.appendChild(buildStructuralCard('session.structurals', 'structurals-shared',
      'Structural and reference series', 'Durations read from the protocol cards', null));

    var right = h('div', {});
    right.appendChild(buildCompositionSummaryCard());

    view.appendChild(h('div', { class: 'grid split' }, [left, right]));
    view.appendChild(buildTimelineCard('primary'));
    return view;
  }

  function buildCompositionSummaryCard() {
    var host = h('div', {});
    registerView(function (report) {
      clear(host);
      host.appendChild(dataTable(
        [{ label: 'Aim' }, { label: 'Composition' }, { label: 'Setup', num: true },
          { label: 'Structurals', num: true }, { label: 'Break', num: true },
          { label: 'Session', num: true }],
        (report.session.perAimComposition || []).map(function (record) {
          var timeline = (report.session.timelines || []).filter(function (entry) {
            return entry.id === record.id;
          })[0];
          return [
            { text: record.short },
            {
              html: '<span class="pill ' + (record.custom ? 'gold' : 'grey') + '">'
                + (record.custom ? 'Custom' : 'Shared') + '</span>'
            },
            { text: H.round(record.setupMinutes, 1) + ' min', num: true },
            { text: H.round(record.structuralMinutes, 1) + ' min', num: true },
            { text: H.round(record.breakMinutes, 1) + ' min', num: true },
            { text: timeline ? H.round(timeline.meanMinutes, 1) + ' min' : '-', num: true }
          ];
        })
      ));
      if (report.budget.sessionModel === 'pooled') {
        host.appendChild(h('div', {
          class: 'notice mt',
          text: 'Pooled session model: every aim shares one session, so the shared composition '
            + 'is the one that runs. Switch to the dedicated model for per-aim sessions.'
        }));
      }
    });
    return card('Who runs what', 'Per-aim session composition', [host]);
  }

  function buildAimSessionView(id) {
    var view = h('div', { class: 'tabview' });
    var base = 'session.perAim.' + id;
    var owner = 'session-' + id;
    function locked(state) { return !(state.session.perAim[id] || {}).custom; }

    var left = h('div', {});
    left.appendChild(card('Session composition for ' + App.state.aims[id].short,
      App.state.aims[id].name, [
        checkbox({
          label: 'Give this aim its own session composition',
          path: base + '.custom',
          onChange: function (on) {
            toast(on
              ? App.state.aims[id].short + ' now runs its own session composition'
              : App.state.aims[id].short + ' is back on the shared composition', 'ok');
          }
        }),
        h('div', { class: 'btn-row mb' }, [
          h('button', {
            class: 'btn quiet sm', type: 'button', text: 'Copy shared defaults in',
            title: 'Overwrite this composition with the shared one',
            onclick: function () {
              var shared = App.state.session;
              var target = App.state.session.perAim[id];
              target.screeningMinutes = shared.screeningMinutes;
              target.positioningMinutes = shared.positioningMinutes;
              target.practiceMinutes = shared.practiceMinutes;
              target.breakMinutes = shared.breakMinutes;
              target.structurals = H.deepCopy(shared.structurals);
              App.refresh(true);
              toast('Shared composition copied into ' + App.state.aims[id].short, 'ok');
            }
          }),
          h('button', {
            class: 'btn quiet sm', type: 'button', text: 'Open the aim panel',
            onclick: function () { App.show('aim-' + id); }
          })
        ])
      ].concat(overheadControls(base, owner, locked))));

    left.appendChild(buildStructuralCard(base + '.structurals', 'structurals-' + id,
      'Structural and reference series', 'Runs before this aim\'s functional runs', locked));

    var right = h('div', {});
    right.appendChild(buildCompositionSummaryCard());

    view.appendChild(h('div', { class: 'grid split' }, [left, right]));
    view.appendChild(buildTimelineCard(id));
    return view;
  }

  function buildStructuralCard(path, owner, title, note, disabledWhen) {
    var host = h('div', {});
    var signature = '';

    function list() { return getPath(App.state, path) || []; }
    function structuralSignature() {
      return list().map(function (entry) { return entry.protocol; }).join('|')
        + '#' + (disabledWhen ? String(!!disabledWhen(App.state)) : '');
    }

    function render() {
      dropControls(owner);
      signature = structuralSignature();
      clear(host);
      var off = disabledWhen ? !!disabledWhen(App.state) : false;
      var table = h('table', { class: 'phase-grid' });
      table.appendChild(h('thead', {}, [h('tr', {}, [
        h('th', { text: 'On' }), h('th', { text: 'Protocol card' }),
        h('th', { text: 'Repeats' }), h('th', { text: 'Each' }),
        h('th', { text: 'Total' }), h('th', { text: '' })
      ])]));
      var body = h('tbody', {});

      list().forEach(function (entry, index) {
        var enable = h('input', { type: 'checkbox', disabled: off });
        enable.checked = !!entry.enabled;
        enable.addEventListener('change', function () {
          list()[index].enabled = enable.checked;
          App.refresh();
        });

        var select = h('select', { disabled: off });
        (App.boot.manifest || []).forEach(function (option) {
          select.appendChild(h('option', { value: option.slug, text: option.label }));
        });
        select.value = entry.protocol;
        select.addEventListener('change', function () {
          list()[index].protocol = select.value;
          App.refresh(true);
        });

        var count = h('input', { type: 'number', min: 0, max: 10, step: 1, value: entry.count, disabled: off });
        count.addEventListener('change', function () {
          list()[index].count = Math.max(0, Math.round(H.num(count.value)));
          App.refresh();
        });

        var each = h('td', { class: 'expected' });
        var total = h('td', { class: 'expected' });
        registerControl(function () {
          var record = list()[index];
          if (!record) return;
          var ctx = M.protocolContext(App.boot, record.protocol);
          each.textContent = H.round(ctx.durationSeconds / 60, 2) + ' min';
          total.textContent = H.round(ctx.durationSeconds / 60 * H.num(record.count), 2) + ' min';
        }, owner);

        body.appendChild(h('tr', {}, [
          h('td', {}, [enable]),
          h('td', {}, [select]),
          h('td', {}, [count]),
          each, total,
          h('td', {}, [h('button', {
            class: 'btn danger sm', type: 'button', text: 'x', disabled: off,
            onclick: function () {
              list().splice(index, 1);
              App.refresh(true);
            }
          })])
        ]));
      });

      var totalCell = h('td', { class: 'expected' });
      registerControl(function () {
        var minutes = 0;
        list().forEach(function (record) {
          if (!record.enabled) return;
          var ctx = M.protocolContext(App.boot, record.protocol);
          minutes += ctx.durationSeconds / 60 * H.num(record.count);
        });
        totalCell.textContent = H.round(minutes, 2) + ' min';
      }, owner);
      body.appendChild(h('tr', { class: 'phase-total' }, [
        h('td', {}), h('td', { text: 'Structural block' }), h('td', {}), h('td', {}), totalCell, h('td', {})
      ]));

      table.appendChild(body);
      host.appendChild(h('div', { class: 'phase-scroll' }, [table]));
      host.appendChild(h('div', { class: 'btn-row mt' }, [
        h('button', {
          class: 'btn quiet sm', type: 'button', text: 'Add series', disabled: off,
          onclick: function () {
            list().push({ protocol: (App.boot.manifest[0] || {}).slug, enabled: true, count: 1 });
            App.refresh(true);
          }
        })
      ]));
      if (off) {
        host.appendChild(h('div', {
          class: 'notice mt',
          text: 'Following the shared composition. Tick "Give this aim its own session '
            + 'composition" above to edit these series.'
        }));
      }
    }

    registerView(function () {
      if (structuralSignature() !== signature) render();
    });
    render();

    return card(title, note, [host]);
  }

  /* One timeline per aim: in the dedicated model each aim runs a different
   * session, so there is no single representative one. */
  function buildTimelineCard(id) {
    var host = h('div', {});
    var readout = h('div', { class: 'readout' });

    function pick(report) {
      var list = report.session.timelines || [];
      if (id === 'primary') {
        return list.filter(function (record) { return record.primary; })[0] || list[0] || null;
      }
      return list.filter(function (record) { return record.id === id; })[0] || null;
    }

    var node = flushCard('Session timeline', null, [readout, host],
      h('button', {
        class: 'btn quiet sm', type: 'button', text: 'Copy as Markdown',
        onclick: function () {
          var record = pick(App.report);
          var key = record && record.id !== 'pooled' && id !== 'primary'
            ? 'Session timeline - ' + record.short : 'Session timeline';
          copy(App.report.markdownTables[key] || '', 'Session timeline');
        }
      }));

    var heading = node.querySelector('.card-head h3');

    registerView(function (report) {
      clear(readout);
      clear(host);
      var record = pick(report);
      if (!record) {
        heading.textContent = 'Session timeline';
        host.appendChild(h('div', {
          class: 'notice',
          text: report.budget.sessionModel === 'pooled'
            ? 'Pooled sessions mix runs from every aim, so there is one shared timeline. '
              + 'See the Shared defaults tab.'
            : 'This aim is disabled in the allocation panel.'
        }));
        return;
      }

      heading.textContent = record.pooled
        ? 'Pooled session timeline'
        : record.short + ' session timeline';

      readout.appendChild(readoutCell('Setup block', H.round(record.setupMinutes, 1) + ' <small>min</small>'));
      readout.appendChild(readoutCell('Runs / session', record.runsPerSession));
      readout.appendChild(readoutCell('Mean session', H.round(record.meanMinutes, 1) + ' <small>min</small>', 'accent'));
      readout.appendChild(readoutCell('Shortest', H.round(record.minMinutes, 1) + ' <small>min</small>'));
      readout.appendChild(readoutCell('Longest', H.round(record.maxMinutes, 1) + ' <small>min</small>',
        record.maxMinutes > report.caps.maxSessionMinutes ? 'alert' : ''));
      readout.appendChild(readoutCell('Sessions', record.sessions));
      if (!record.pooled) {
        readout.appendChild(readoutCell('Trials / session', H.fmtNumber(record.trialsPerSession)));
        readout.appendChild(readoutCell('Composition', record.custom ? 'Custom' : 'Shared',
          record.custom ? 'accent' : ''));
      }

      host.appendChild(dataTable(
        [{ label: '#', num: true }, { label: 'Series' }, { label: 'Protocol card' },
          { label: 'Minutes', num: true }, { label: 'Cumulative', num: true }, { label: 'Category' }],
        record.rows.map(function (row) {
          return [
            { text: row.order, num: true },
            { text: row.item },
            { text: row.protocolLabel || '-', className: 'seq' },
            { text: H.round(row.minutes, 2), num: true },
            { text: H.round(row.cumulative, 2), num: true },
            { html: '<span class="pill ' + (row.category === 'Functional' ? 'leaf' : 'grey') + '">' + row.category + '</span>' }
          ];
        })
      ));
    });
    return node;
  }

  /* ------------------------------------------------------ questions panel */

  function buildQuestionPanel() {
    var panel = h('div', { class: 'panel' });
    panel.appendChild(h('div', { class: 'panel-head' }, [
      h('h2', { text: 'Question bank' }),
      h('p', { text: 'Item supply, label balance, control-trial share and family composition checked against the solved trial demand.' })
    ]));

    var left = h('div', {});
    left.appendChild(card('Bank parameters', null, [
      slider({ label: 'Maximum questions in bank', path: 'questionBank.size', min: 50, max: 12000, step: 25, unit: 'q' }),
      slider({ label: 'Maximum repeats per item', path: 'questionBank.maxRepeats', min: 1, max: 40, step: 1, gold: true }),
      slider({ label: 'Yes label share', path: 'questionBank.yesPct', min: 0, max: 100, step: 1, unit: '%' }),
      slider({ label: 'Embedded control-trial share', path: 'questionBank.controlPct', min: 0, max: 60, step: 1, unit: '%', gold: true })
    ]));
    left.appendChild(buildBankReadout());

    var right = h('div', {});
    right.appendChild(buildFamilyCard());

    panel.appendChild(h('div', { class: 'grid split' }, [left, right]));
    return panel;
  }

  function buildBankReadout() {
    var readout = h('div', { class: 'readout' });
    var notice = h('div', { class: 'mt' });
    registerView(function (report) {
      var bank = report.questionBank;
      clear(readout);
      clear(notice);
      readout.appendChild(readoutCell('Bank size', H.fmtNumber(bank.size)));
      readout.appendChild(readoutCell('Presentations available', H.fmtNumber(bank.supply)));
      readout.appendChild(readoutCell('Trials demanded', H.fmtNumber(bank.demand), 'accent'));
      readout.appendChild(readoutCell('Headroom', H.fmtNumber(bank.headroom), bank.headroom < 0 ? 'alert' : ''));
      readout.appendChild(readoutCell('Mean repeats / item', H.round(bank.meanRepeats, 2)));
      readout.appendChild(readoutCell('Primary trials', H.fmtNumber(bank.primaryTrials)));
      readout.appendChild(readoutCell('Control trials', H.fmtNumber(bank.controlTrials)));
      readout.appendChild(readoutCell('Yes / no', bank.yesPct + ' / ' + H.round(100 - bank.yesPct, 0)));

      if (bank.headroom < 0) {
        notice.appendChild(h('div', {
          class: 'notice bad',
          text: 'The bank is short by ' + H.fmtNumber(-bank.headroom)
            + ' presentations. Increase bank size, raise the repeat limit, or reduce trials.'
        }));
      } else {
        notice.appendChild(h('div', {
          class: 'notice ok',
          text: 'Supply covers demand with ' + H.fmtNumber(bank.headroom) + ' presentations to spare.'
        }));
      }
    });
    return card('Supply against demand', null, [readout, notice]);
  }

  function buildFamilyCard() {
    var host = h('div', {});
    var owner = 'families';
    var signature = '';

    function render() {
      dropControls(owner);
      signature = String(App.state.questionBank.families.length);
      clear(host);
      var table = h('table', { class: 'phase-grid' });
      table.appendChild(h('thead', {}, [h('tr', {}, [
        h('th', { text: 'Family' }), h('th', { text: 'Share' }),
        h('th', { text: 'Trials' }), h('th', { text: 'Items' }), h('th', { text: '' })
      ])]));
      var body = h('tbody', {});

      App.state.questionBank.families.forEach(function (family, index) {
        var name = h('input', { type: 'text', value: family.name });
        name.addEventListener('change', function () {
          App.state.questionBank.families[index].name = name.value;
          App.refresh();
        });

        var pct = h('input', { type: 'number', min: 0, max: 100, step: 0.5, value: family.pct });
        var pctRange = h('input', { type: 'range', min: 0, max: 100, step: 0.5 });
        function commit(raw) {
          App.state.questionBank.families[index].pct = H.clamp(H.round(H.num(raw), 2), 0, 100);
          App.refresh();
        }
        pct.addEventListener('change', function () { commit(pct.value); });
        pctRange.addEventListener('input', function () { commit(pctRange.value); });

        var trials = h('td', { class: 'expected' });
        var items = h('td', { class: 'expected' });
        registerControl(function () {
          var record = App.state.questionBank.families[index];
          if (!record) return;
          if (document.activeElement !== pct) pct.value = H.round(H.num(record.pct), 2);
          if (document.activeElement !== pctRange) pctRange.value = H.num(record.pct);
          paintRange(pctRange);
          var report = App.report;
          if (report && report.questionBank.families[index]) {
            trials.textContent = H.fmtNumber(report.questionBank.families[index].trials);
            items.textContent = H.fmtNumber(report.questionBank.families[index].items);
          }
        }, owner);

        body.appendChild(h('tr', {}, [
          h('td', {}, [name]),
          h('td', {}, [h('div', { class: 'rangecell' }, [pct, pctRange])]),
          trials, items,
          h('td', {}, [h('button', {
            class: 'btn danger sm', type: 'button', text: 'x',
            onclick: function () {
              App.state.questionBank.families.splice(index, 1);
              App.refresh(true);
            }
          })])
        ]));
      });

      var totalCell = h('td', { class: 'expected' });
      registerControl(function () {
        totalCell.textContent = H.round(H.sum(App.state.questionBank.families,
          function (family) { return H.num(family.pct); }), 2) + ' %';
      }, owner);
      body.appendChild(h('tr', { class: 'phase-total' }, [
        h('td', { text: 'Total share' }), totalCell, h('td', {}), h('td', {}), h('td', {})
      ]));
      table.appendChild(body);
      host.appendChild(h('div', { class: 'phase-scroll' }, [table]));

      host.appendChild(h('div', { class: 'btn-row mt' }, [
        h('button', {
          class: 'btn quiet sm', type: 'button', text: 'Add family',
          onclick: function () {
            App.state.questionBank.families.push({ name: 'New family', pct: 0, role: '' });
            App.refresh(true);
          }
        }),
        h('button', {
          class: 'btn quiet sm', type: 'button', text: 'Normalise to 100',
          onclick: function () {
            var families = App.state.questionBank.families;
            var total = H.sum(families, function (family) { return H.num(family.pct); });
            if (total > 0) {
              families.forEach(function (family) {
                family.pct = H.round(H.num(family.pct) / total * 100, 2);
              });
            }
            App.refresh();
          }
        }),
        h('button', {
          class: 'btn quiet sm', type: 'button', text: 'Equalise',
          onclick: function () {
            var families = App.state.questionBank.families;
            families.forEach(function (family) { family.pct = H.round(100 / families.length, 2); });
            App.refresh();
          }
        })
      ]));
    }

    registerView(function () {
      if (String(App.state.questionBank.families.length) !== signature) render();
    });
    render();
    return card('Question families', 'Shares of the total trial demand', [host]);
  }

  /* ---------------------------------------------------------------- shell */

  function buildRail() {
    var rail = document.getElementById('rail');
    var groups = [
      { label: 'Design', items: [
        { id: 'summary', label: 'Overview', tag: 'O' },
        { id: 'overview', label: 'Budget and allocation', tag: 'B' },
        { id: 'session', label: 'Session composition', tag: 'S' },
        { id: 'questions', label: 'Question bank', tag: 'Q' }
      ] },
      { label: 'Specific aims', items: M.AIM_IDS.map(function (id) {
        return { id: 'aim-' + id, label: App.state.aims[id].name, tag: App.state.aims[id].short.slice(0, 4) };
      }) },
      { label: 'Acquisition', items: [
        { id: 'protocols', label: 'Scanner parameter cards', tag: 'P' }
      ] },
      { label: 'Output', items: [
        { id: 'export', label: 'Report and export', tag: 'X' }
      ] }
    ];

    groups.forEach(function (group) {
      rail.appendChild(h('div', { class: 'rail-group', text: group.label }));
      group.items.forEach(function (item) {
        var button = h('button', { class: 'rail-item', type: 'button' }, [
          h('span', { text: item.label }),
          h('span', { class: 'tag', text: item.tag })
        ]);
        button.addEventListener('click', function () { App.show(item.id); });
        App.railItems[item.id] = button;
        rail.appendChild(button);
      });
    });
  }

  function show(id) {
    App.activePanel = id;
    Object.keys(App.panels).forEach(function (key) {
      App.panels[key].classList.toggle('active', key === id);
    });
    Object.keys(App.railItems).forEach(function (key) {
      App.railItems[key].classList.toggle('active', key === id);
    });
    if (App.report) App.views.forEach(function (view) { view.render(App.report); });
    global.scrollTo(0, 0);
  }

  /* ------------------------------------------------------------ autosave */

  var saveTimer = null;
  function scheduleAutosave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      fetch('/api/design', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'current', design: App.state })
      }).catch(function () { /* offline autosave is non-fatal */ });
    }, 1500);
  }

  function syncControls() {
    App.controls.slice().forEach(function (control) {
      try { control.sync(); } catch (err) { console.error('control sync failed', err); }
    });
  }

  function refresh() {
    if (App.suspend) return;
    App.report = M.solve(App.state, App.boot);
    syncControls();
    App.views.forEach(function (view) {
      try { view.render(App.report); } catch (err) { console.error('view render failed', err); }
    });
    // Views may rebuild whole control groups (phase rows, structural rows,
    // question families); those fresh widgets need their first sync.
    syncControls();
    scheduleAutosave();
  }

  /* --------------------------------------------------------------- start */

  function mergeState(saved) {
    var base = M.defaultState();
    if (!saved || typeof saved !== 'object') return base;
    M.migrateState(saved);
    function merge(target, source) {
      Object.keys(source || {}).forEach(function (key) {
        var value = source[key];
        if (Array.isArray(value)) target[key] = value;
        else if (value && typeof value === 'object') {
          if (!target[key] || typeof target[key] !== 'object') target[key] = {};
          merge(target[key], value);
        } else if (value !== undefined) target[key] = value;
      });
      return target;
    }
    return M.migrateState(merge(base, saved));
  }

  function start() {
    fetch('/api/bootstrap').then(function (response) {
      if (!response.ok) throw new Error('bootstrap failed');
      return response.json();
    }).then(function (boot) {
      App.boot = boot;
      App.protocols = boot.protocols || {};
      App.state = mergeState(boot.design);

      buildRail();
      buildMetrics();

      var workspace = document.getElementById('workspace');
      App.panels.summary = buildSimpleOverview();
      App.panels.overview = buildOverview();
      App.panels.session = buildSessionPanel();
      App.panels.questions = buildQuestionPanel();
      M.AIM_IDS.forEach(function (id) { App.panels['aim-' + id] = buildAimPanel(id); });
      App.panels.protocols = global.PlannerProtocols.build();
      App.panels.export = global.PlannerExport.build();

      Object.keys(App.panels).forEach(function (key) { workspace.appendChild(App.panels[key]); });

      show('summary');
      refresh();

      document.getElementById('veil').remove();

      document.getElementById('btn-export-xlsx')
        .addEventListener('click', function () { global.PlannerExport.downloadXlsx(); });
      document.getElementById('btn-save-design')
        .addEventListener('click', function () { global.PlannerExport.saveDesign(); });

      global.addEventListener('resize', function () {
        if (App.report) App.views.forEach(function (view) { view.render(App.report); });
      });
    }).catch(function (error) {
      var veil = document.getElementById('veil');
      if (veil) veil.textContent = 'Startup failed: ' + error.message;
      console.error(error);
    });
  }

  App.show = show;
  App.refresh = refresh;
  App.toast = toast;
  App.copy = copy;
  App.h = h;
  App.clear = clear;
  App.card = card;
  App.flushCard = flushCard;
  App.dataTable = dataTable;
  App.registerView = registerView;
  App.registerControl = registerControl;
  App.dropControls = dropControls;
  App.start = start;
  App.currentAim = currentAim;
  App.mergeState = mergeState;

  global.PlannerApp = App;
}(window));
