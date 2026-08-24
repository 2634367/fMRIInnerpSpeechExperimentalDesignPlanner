/* Scanner parameter card editor.
 *
 * Every parameter in every JSON card is editable.  Edits update the in-memory
 * card immediately, re-derive the acquisition values the design solver depends
 * on (TR, TE, slices, matrix, series duration) and re-solve the whole design.
 * Saving writes the JSON back to disk with a timestamped backup. */

(function (global) {
  'use strict';

  var App, H, M;

  var DERIVED_PARAMETERS = ['dyn scans', 'dummy scans', 'total scan duration'];

  /* Philips console page order; anything unrecognised is appended. */
  var SECTION_ORDER = ['INFO PAGE', 'GEOMETRY', 'CONTRAST', 'POST/PROC', 'MOTION', 'DYN/ANG'];

  function orderedSections(data) {
    var known = SECTION_ORDER.filter(function (section) {
      return Array.isArray(data[section]);
    });
    var extra = Object.keys(data).filter(function (section) {
      return Array.isArray(data[section]) && SECTION_ORDER.indexOf(section) < 0;
    });
    return known.concat(extra);
  }

  var state = {
    active: null,
    filter: '',
    dirty: {},
    collapsed: {},
    listHost: null,
    editorHost: null
  };

  /* ------------------------------------------------------------- parsing */

  function findRow(data, parameter) {
    var target = String(parameter).trim().toLowerCase();
    var found = null;
    Object.keys(data || {}).forEach(function (section) {
      if (found || !Array.isArray(data[section])) return;
      data[section].forEach(function (row) {
        if (!found && String(row.parameter || '').trim().toLowerCase() === target) found = row;
      });
    });
    return found;
  }

  function findValue(data, parameter) {
    var row = findRow(data, parameter);
    return row ? String(row.value) : '';
  }

  function parseDurationSeconds(text) {
    var parts = String(text || '').trim().split(':');
    if (!parts.length || parts[0] === '') return 0;
    var seconds = 0;
    for (var i = 0; i < parts.length; i += 1) {
      var value = parseFloat(parts[i]);
      if (!isFinite(value)) return 0;
      seconds = seconds * 60 + value;
    }
    return seconds;
  }

  function formatDuration(seconds) {
    var value = Math.max(0, Number(seconds) || 0);
    var minutes = Math.floor(value / 60);
    var rest = value - minutes * 60;
    if (minutes >= 60) {
      var hours = Math.floor(minutes / 60);
      return pad(hours) + ':' + pad(minutes % 60) + ':' + (rest < 10 ? '0' : '') + rest.toFixed(1);
    }
    return pad(minutes) + ':' + (rest < 10 ? '0' : '') + rest.toFixed(1);
  }

  function pad(value) { return (value < 10 ? '0' : '') + Math.floor(value); }

  function numbersIn(text) {
    var matches = String(text || '').match(/[-+]?\d*\.?\d+/g);
    return (matches || []).map(Number);
  }

  function headlineFrom(data) {
    var trTe = numbersIn(findValue(data, 'Act. TR/TE (ms)'));
    return {
      duration: findValue(data, 'Total scan duration'),
      tr: trTe.length ? String(trTe[0]) : '',
      te: trTe.length > 1 ? String(trTe[1]) : '',
      voxel: findValue(data, 'ACQ voxel MPS (mm)'),
      slices: findValue(data, 'slices'),
      mbFactor: findValue(data, 'MB Factor'),
      senseP: findValue(data, 'P reduction (AP)'),
      flip: findValue(data, 'Flip angle (deg)'),
      dynScans: findValue(data, 'dyn scans'),
      dummyScans: findValue(data, 'dummy scans'),
      matrix: findValue(data, 'Reconstruction matrix'),
      technique: findValue(data, 'technique'),
      scanMode: findValue(data, 'Scan mode')
    };
  }

  function syncAcquisition(slug) {
    var data = App.protocols[slug];
    if (!data) return;
    var trTe = numbersIn(findValue(data, 'Act. TR/TE (ms)'));
    App.boot.acquisition[slug] = {
      trMs: trTe.length ? trTe[0] : 0,
      teMs: trTe.length > 1 ? trTe[1] : 0,
      durationSeconds: parseDurationSeconds(findValue(data, 'Total scan duration'))
    };
    (App.boot.manifest || []).forEach(function (entry) {
      if (entry.slug === slug) entry.headline = headlineFrom(data);
    });
  }

  /* ---------------------------------------------------------------- view */

  function boundAims(slug) {
    return M.AIM_IDS.filter(function (id) {
      return App.state.aims[id].enabled && App.state.aims[id].protocol === slug;
    });
  }

  function solvedUpdatesFor(slug) {
    var updates = {};
    boundAims(slug).forEach(function (id) {
      var aim = App.currentAim(id);
      if (!aim) return;
      updates['dyn scans'] = String(aim.acquisition.dynScansSolved);
      updates['dummy scans'] = String(aim.acquisition.dummyScansSolved);
      updates['Total scan duration'] = aim.acquisition.durationSolved;
    });
    return updates;
  }

  function renderList() {
    var host = state.listHost;
    App.clear(host);
    var groups = {};
    (App.boot.manifest || []).forEach(function (entry) {
      if (!groups[entry.role]) groups[entry.role] = [];
      groups[entry.role].push(entry);
    });
    var order = ['functional', 'reference', 'structural', 'other'];
    var labels = {
      functional: 'Functional EPI', reference: 'Reference and field maps',
      structural: 'Structural and localiser', other: 'Other'
    };

    order.forEach(function (role) {
      if (!groups[role]) return;
      host.appendChild(App.h('div', { class: 'rail-group', text: labels[role] || role }));
      groups[role].forEach(function (entry) {
        var bound = boundAims(entry.slug).map(function (id) { return App.state.aims[id].short; });
        var button = App.h('button', {
          class: 'proto-item' + (state.active === entry.slug ? ' active' : ''), type: 'button'
        }, [
          App.h('div', { class: 'name' }, [
            App.h('span', { text: entry.label }),
            state.dirty[entry.slug] ? App.h('span', { class: 'dirty', text: '  *' }) : null
          ]),
          App.h('div', {
            class: 'meta',
            text: (entry.headline.tr ? 'TR ' + entry.headline.tr + ' ms  ' : '')
              + (entry.headline.duration ? entry.headline.duration + '  ' : '')
              + entry.parameterCount + ' params'
          }),
          bound.length ? App.h('div', { class: 'meta' }, [
            App.h('span', { class: 'pill leaf', text: 'bound: ' + bound.join(', ') })
          ]) : null
        ]);
        button.addEventListener('click', function () { select(entry.slug); });
        host.appendChild(button);
      });
    });
  }

  function inputFor(row, slug, onEdit) {
    var raw = String(row.value);
    var lowered = raw.trim().toLowerCase();
    var input;

    if (lowered === 'yes' || lowered === 'no') {
      input = App.h('select', {}, [
        App.h('option', { value: 'yes', text: 'yes' }),
        App.h('option', { value: 'no', text: 'no' })
      ]);
      input.value = lowered;
    } else if (/^[-+]?\d*\.?\d+$/.test(raw.trim()) && raw.trim() !== '') {
      input = App.h('input', { type: 'number', step: 'any', value: raw.trim() });
    } else {
      input = App.h('input', { type: 'text', value: raw });
    }

    function commit() {
      var value = String(input.value);
      if (value === String(row.value)) return;
      row.value = value;
      state.dirty[slug] = true;
      onEdit();
    }
    input.addEventListener('change', commit);
    if (input.tagName !== 'SELECT') input.addEventListener('blur', commit);
    return input;
  }

  function renderEditor() {
    var host = state.editorHost;
    App.clear(host);
    if (!state.active) {
      host.appendChild(App.h('div', { class: 'notice', text: 'Select a protocol card to edit.' }));
      return;
    }

    var slug = state.active;
    var data = App.protocols[slug];
    var entry = (App.boot.manifest || []).filter(function (item) { return item.slug === slug; })[0] || {};
    var headline = headlineFrom(data);
    var updates = solvedUpdatesFor(slug);
    var bound = boundAims(slug);

    function onEdit() {
      syncAcquisition(slug);
      renderList();
      App.refresh();
      renderHeadline();
    }

    var headlineHost = App.h('div', { class: 'readout' });
    function renderHeadline() {
      App.clear(headlineHost);
      var current = headlineFrom(App.protocols[slug]);
      [
        ['Duration', current.duration], ['TR', current.tr + ' ms'], ['TE', current.te + ' ms'],
        ['Voxel', current.voxel], ['Slices', current.slices], ['Matrix', current.matrix],
        ['Multiband', current.mbFactor], ['In-plane', current.senseP], ['Flip', current.flip + ' deg'],
        ['Dynamics', current.dynScans || '-'], ['Dummies', current.dummyScans || '-'],
        ['Technique', current.technique + ' / ' + current.scanMode]
      ].forEach(function (pair) {
        headlineHost.appendChild(App.h('div', { class: 'cell' }, [
          App.h('div', { class: 'k', text: pair[0] }),
          App.h('div', { class: 'v', text: pair[1] || '-' })
        ]));
      });
    }
    renderHeadline();

    var search = App.h('input', { type: 'text', value: state.filter, placeholder: 'Filter parameters' });
    search.addEventListener('input', function () {
      state.filter = search.value.toLowerCase();
      renderSections();
    });

    var actions = App.h('div', { class: 'btn-row' }, [
      App.h('button', {
        class: 'btn sm', type: 'button', text: 'Save to disk',
        onclick: function () { save(slug); }
      }),
      App.h('button', {
        class: 'btn quiet sm', type: 'button', text: 'Reload from disk',
        onclick: function () { reload(slug); }
      }),
      Object.keys(updates).length ? App.h('button', {
        class: 'btn gold sm', type: 'button',
        text: 'Apply solved timing (' + bound.map(function (id) { return App.state.aims[id].short; }).join(', ') + ')',
        onclick: function () { applyDerived(bound[0]); }
      }) : null,
      App.h('button', {
        class: 'btn quiet sm', type: 'button', text: 'Copy card as Markdown',
        onclick: function () { App.copy(cardMarkdown(slug), 'Protocol card'); }
      }),
      App.h('button', {
        class: 'btn quiet sm', type: 'button', text: 'Backups',
        onclick: function () { showBackups(slug); }
      })
    ]);

    var sectionsHost = App.h('div', {});
    function renderSections() {
      App.clear(sectionsHost);
      orderedSections(data).forEach(function (section) {
        var rows = data[section].filter(function (row) {
          if (!state.filter) return true;
          return (String(row.parameter) + ' ' + String(row.value)).toLowerCase().indexOf(state.filter) >= 0;
        });
        if (!rows.length) return;

        var body = App.h('div', { class: 'section-body' });
        rows.forEach(function (row) {
          var key = String(row.parameter).trim().toLowerCase();
          var isDerived = DERIVED_PARAMETERS.indexOf(key) >= 0 && bound.length > 0;
          var input = inputFor(row, slug, onEdit);
          var solvedValue = updates[row.parameter] !== undefined
            ? updates[row.parameter]
            : updates[Object.keys(updates).filter(function (name) {
              return name.toLowerCase() === key;
            })[0]];
          var mismatch = isDerived && solvedValue !== undefined && String(solvedValue) !== String(row.value);
          body.appendChild(App.h('div', {
            class: 'param-row' + (isDerived ? ' derived' : '') + (mismatch ? ' changed' : ''),
            title: row.parameter
          }, [
            App.h('label', {
              text: row.parameter,
              style: 'padding-left:' + (Number(row.indent) || 0) * 14 + 'px'
            }),
            input,
            App.h('span', {
              class: 'flag',
              text: mismatch ? '!' : (isDerived ? '=' : ''),
              title: mismatch ? 'Solver says ' + solvedValue : (isDerived ? 'Derived from the design' : '')
            })
          ]));
        });

        var open = !state.collapsed[section];
        var head = App.h('button', { class: 'section-head', type: 'button' }, [
          App.h('span', { text: (open ? '\u2212  ' : '+  ') + section }),
          App.h('span', { class: 'flag', text: rows.length + ' parameters' })
        ]);
        head.addEventListener('click', function () {
          state.collapsed[section] = !state.collapsed[section];
          renderSections();
        });
        body.style.display = open ? '' : 'none';
        sectionsHost.appendChild(App.h('div', { class: 'section-block' }, [head, body]));
      });
    }
    renderSections();

    var card = App.flushCard(entry.label || slug, slug, [
      App.h('div', { style: 'padding:14px 14px 0' }, [headlineHost]),
      App.h('div', { style: 'padding:12px 14px', class: 'split-inline' }, [search, actions]),
      sectionsHost
    ]);
    host.appendChild(card);
  }

  function cardMarkdown(slug) {
    var data = App.protocols[slug];
    var entry = (App.boot.manifest || []).filter(function (item) { return item.slug === slug; })[0] || {};
    var lines = ['## ' + (entry.label || slug) + ' (' + slug + ')', ''];
    orderedSections(data).forEach(function (section) {
      lines.push('### ' + section, '');
      lines.push(M.mdTable(['Parameter', 'Value'], data[section].map(function (row) {
        var indent = Number(row.indent) || 0;
        return [(indent ? '&nbsp;'.repeat(indent * 4) + ' ' : '') + row.parameter, String(row.value)];
      })));
      lines.push('');
    });
    return lines.join('\n');
  }

  /* -------------------------------------------------------------- server */

  function save(slug) {
    fetch('/api/protocols/' + encodeURIComponent(slug), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: App.protocols[slug] })
    }).then(function (response) {
      if (!response.ok) return response.json().then(function (body) { throw new Error(body.error || 'save failed'); });
      return response.json();
    }).then(function (result) {
      delete state.dirty[slug];
      renderList();
      renderEditor();
      App.toast('Saved ' + slug + '.json' + (result.backup ? ' (backup ' + result.backup + ')' : ''), 'ok');
    }).catch(function (error) { App.toast(error.message, 'bad'); });
  }

  function reload(slug) {
    fetch('/api/protocols/' + encodeURIComponent(slug)).then(function (response) {
      return response.json();
    }).then(function (result) {
      App.protocols[slug] = result.data;
      delete state.dirty[slug];
      syncAcquisition(slug);
      renderList();
      renderEditor();
      App.refresh();
      App.toast('Reloaded ' + slug + '.json from disk');
    }).catch(function (error) { App.toast(error.message, 'bad'); });
  }

  function applyDerived(aimId) {
    if (!aimId) return;
    var aim = App.currentAim(aimId);
    if (!aim) return;
    var slug = aim.protocol;
    fetch('/api/apply-derived', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: slug,
        updates: {
          'dyn scans': String(aim.acquisition.dynScansSolved),
          'dummy scans': String(aim.acquisition.dummyScansSolved),
          'Total scan duration': aim.acquisition.durationSolved
        }
      })
    }).then(function (response) {
      if (!response.ok) return response.json().then(function (body) { throw new Error(body.error || 'apply failed'); });
      return response.json();
    }).then(function (result) {
      App.protocols[slug] = result.data;
      delete state.dirty[slug];
      syncAcquisition(slug);
      renderList();
      if (state.active === slug) renderEditor();
      App.refresh();
      App.toast('Wrote solved dynamics and duration into ' + slug + '.json', 'ok');
    }).catch(function (error) { App.toast(error.message, 'bad'); });
  }

  function showBackups(slug) {
    fetch('/api/protocols/' + encodeURIComponent(slug) + '/backups')
      .then(function (response) { return response.json(); })
      .then(function (result) {
        var host = state.editorHost;
        var rows = (result.backups || []).map(function (backup) {
          return [
            { text: backup.file },
            { text: (backup.size / 1024).toFixed(1) + ' kB', num: true },
            { text: new Date(backup.modified * 1000).toLocaleString(), num: true },
            {
              html: '<button class="btn quiet sm" data-restore="' + backup.file + '" type="button">Restore</button>'
            }
          ];
        });
        var card = App.card('Backups for ' + slug, rows.length + ' snapshots', [
          rows.length ? App.dataTable(
            [{ label: 'File' }, { label: 'Size', num: true }, { label: 'Saved', num: true }, { label: '' }],
            rows
          ) : App.h('div', { class: 'notice', text: 'No backups yet; one is written before every save.' }),
          App.h('div', { class: 'btn-row mt' }, [
            App.h('button', {
              class: 'btn quiet sm', type: 'button', text: 'Back to editor',
              onclick: function () { renderEditor(); }
            })
          ])
        ]);
        card.addEventListener('click', function (event) {
          var file = event.target.getAttribute && event.target.getAttribute('data-restore');
          if (!file) return;
          fetch('/api/protocols/' + encodeURIComponent(slug) + '/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file: file })
          }).then(function (response) { return response.json(); })
            .then(function (restored) {
              if (restored.error) throw new Error(restored.error);
              App.protocols[slug] = restored.data;
              syncAcquisition(slug);
              renderList();
              renderEditor();
              App.refresh();
              App.toast('Restored ' + file, 'ok');
            }).catch(function (error) { App.toast(error.message, 'bad'); });
        });
        App.clear(host);
        host.appendChild(card);
      });
  }

  function select(slug) {
    state.active = slug;
    state.filter = '';
    renderList();
    renderEditor();
  }

  /* --------------------------------------------------------------- build */

  function build() {
    App = global.PlannerApp;
    H = global.PlannerModel.helpers;
    M = global.PlannerModel;

    var panel = App.h('div', { class: 'panel' });
    panel.appendChild(App.h('div', { class: 'panel-head' }, [
      App.h('h2', { text: 'Scanner parameter cards' }),
      App.h('p', {
        text: 'Every parameter from every card in scanner-parameters is editable. Edits feed straight back '
          + 'into the design solver; saving writes the JSON file with a timestamped backup.'
      })
    ]));

    state.listHost = App.h('div', { class: 'proto-list' });
    state.editorHost = App.h('div', {});

    var listCard = App.flushCard('Protocol cards', null, [state.listHost]);
    panel.appendChild(App.h('div', { class: 'proto-layout' }, [listCard, state.editorHost]));

    App.registerView(function () {
      renderList();
      if (state.active) {
        var open = state.editorHost.querySelector('.card-head h3');
        if (!open) renderEditor();
      }
    });

    state.active = App.state ? App.state.aims.ts.protocol : null;
    renderList();
    renderEditor();
    return panel;
  }

  global.PlannerProtocols = {
    build: build,
    select: select,
    applyDerived: applyDerived,
    findValue: findValue,
    headlineFrom: headlineFrom,
    formatDuration: formatDuration,
    parseDurationSeconds: parseDurationSeconds,
    cardMarkdown: cardMarkdown
  };
}(window));
