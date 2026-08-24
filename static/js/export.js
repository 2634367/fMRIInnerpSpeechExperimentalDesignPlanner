/* Report generation, clipboard handoff and workbook export. */

(function (global) {
  'use strict';

  var App, M, H;
  var methodsBox, markdownBox, markdownPicker, presetHost, presetName;
  var psychopyButtons, psychopyPicker, psychopyBox;

  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var anchor = App.h('a', { href: url, download: filename, style: 'display:none' });
    document.body.appendChild(anchor);
    anchor.click();
    setTimeout(function () {
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
    }, 400);
  }

  function downloadXlsx() {
    App.toast('Building workbook...');
    fetch('/api/export/xlsx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ report: App.report, protocols: App.protocols })
    }).then(function (response) {
      if (!response.ok) {
        return response.json().then(function (body) { throw new Error(body.error || 'export failed'); });
      }
      var name = response.headers.get('X-Planner-Archive') || 'fmri-design.xlsx';
      return response.blob().then(function (blob) { download(blob, name); return name; });
    }).then(function (name) {
      App.toast('Workbook exported: ' + name, 'ok');
    }).catch(function (error) { App.toast(error.message, 'bad'); });
  }

  function downloadJson() {
    var blob = new Blob([JSON.stringify({
      design: App.state, report: App.report
    }, null, 2)], { type: 'application/json' });
    download(blob, 'fmri-design-' + new Date().toISOString().slice(0, 10) + '.json');
    App.toast('Design JSON downloaded', 'ok');
  }

  function downloadMarkdown() {
    var blob = new Blob([M.allMarkdown(App.report)], { type: 'text/markdown' });
    download(blob, 'fmri-design-' + new Date().toISOString().slice(0, 10) + '.md');
    App.toast('Markdown downloaded', 'ok');
  }

  /* One PsychoPy experiment.yaml per aim: same template every time, with the
   * scanner, run, trial and conditions blocks taken from that aim's solved
   * design. */
  function downloadPsychopy(aim) {
    var name = M.psychopyFileName(aim);
    var blob = new Blob([M.psychopyYaml(App.report, aim)], { type: 'text/yaml;charset=utf-8' });
    download(blob, name);
    App.toast('PsychoPy config downloaded: ' + name, 'ok');
  }

  function refreshPsychopy() {
    if (!App.report || !psychopyButtons) return;
    var aims = App.report.aims || [];

    App.clear(psychopyButtons);
    if (!aims.length) {
      psychopyButtons.appendChild(App.h('span', {
        class: 'muted', text: 'No aims are enabled, so there is nothing to export.'
      }));
    }
    aims.forEach(function (aim) {
      var button = App.h('button', {
        class: 'btn sm', type: 'button', text: aim.name,
        title: 'Download ' + M.psychopyFileName(aim) + ' for ' + aim.name
      });
      button.addEventListener('click', function () { downloadPsychopy(aim); });
      psychopyButtons.appendChild(button);
    });

    var previous = psychopyPicker.value;
    App.clear(psychopyPicker);
    aims.forEach(function (aim) {
      psychopyPicker.appendChild(App.h('option', { value: aim.id, text: aim.name }));
    });
    if (previous && aims.some(function (aim) { return aim.id === previous; })) {
      psychopyPicker.value = previous;
    }
    renderPsychopyPreview();
  }

  function currentPsychopyAim() {
    var aims = (App.report && App.report.aims) || [];
    return aims.filter(function (aim) {
      return aim.id === psychopyPicker.value;
    })[0] || aims[0] || null;
  }

  function renderPsychopyPreview() {
    if (!psychopyBox) return;
    var aim = currentPsychopyAim();
    psychopyBox.textContent = aim ? M.psychopyYaml(App.report, aim) : '';
  }

  function saveDesign(name) {
    var target = name || 'current';
    fetch('/api/design', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: target, design: App.state })
    }).then(function (response) { return response.json(); })
      .then(function (result) {
        App.boot.presets = result.presets || App.boot.presets;
        renderPresets();
        App.toast('Design saved as "' + target + '"', 'ok');
      }).catch(function (error) { App.toast(error.message, 'bad'); });
  }

  /* Accepts either a bare design object or a downloaded {design, report}
   * envelope, and fills anything the file is missing from the defaults so an
   * older or hand-edited file still loads. */
  function adopt(payload) {
    var design = payload && payload.design ? payload.design : payload;
    if (!design || typeof design !== 'object' || !design.aims) {
      throw new Error('That file does not contain a planner design.');
    }
    var merged = App.mergeState(design);
    Object.keys(App.state).forEach(function (key) {
      if (!(key in merged)) delete App.state[key];
    });
    Object.keys(merged).forEach(function (key) { App.state[key] = merged[key]; });
    App.refresh(true);
    return design;
  }

  function loadDesign(name) {
    fetch('/api/design?name=' + encodeURIComponent(name))
      .then(function (response) { return response.json(); })
      .then(function (result) {
        if (result.error) throw new Error(result.error);
        adopt(result.design);
        App.toast('Loaded design "' + name + '"', 'ok');
      }).catch(function (error) { App.toast(error.message, 'bad'); });
  }

  function fileStem(name) {
    return 'fmri-design-' + String(name || 'design')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  /* Pull a saved preset straight from the server and write it to disk, so a
   * design can leave this machine without going through the working state. */
  function downloadPreset(name) {
    fetch('/api/design?name=' + encodeURIComponent(name))
      .then(function (response) { return response.json(); })
      .then(function (result) {
        if (result.error) throw new Error(result.error);
        var blob = new Blob([JSON.stringify(result.design, null, 2)], { type: 'application/json' });
        download(blob, fileStem(name) + '.json');
        App.toast('Downloaded "' + name + '" as JSON', 'ok');
      }).catch(function (error) { App.toast(error.message, 'bad'); });
  }

  function importDesign(file, saveAs) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        adopt(JSON.parse(String(reader.result)));
      } catch (error) {
        App.toast('Import failed: ' + error.message, 'bad');
        return;
      }
      var target = (saveAs || '').trim();
      if (target) {
        saveDesign(target);
        App.toast('Imported ' + file.name + ' and saved as "' + target + '"', 'ok');
      } else {
        App.toast('Imported ' + file.name + ' into the working design', 'ok');
      }
    };
    reader.onerror = function () { App.toast('Could not read ' + file.name, 'bad'); };
    reader.readAsText(file);
  }

  function deleteDesign(name) {
    fetch('/api/design/' + encodeURIComponent(name), { method: 'DELETE' })
      .then(function (response) { return response.json(); })
      .then(function (result) {
        if (result.error) throw new Error(result.error);
        App.boot.presets = result.presets || [];
        renderPresets();
        App.toast('Deleted "' + name + '"');
      }).catch(function (error) { App.toast(error.message, 'bad'); });
  }

  function renderPresets() {
    if (!presetHost) return;
    App.clear(presetHost);
    var presets = App.boot.presets || [];
    if (!presets.length) {
      presetHost.appendChild(App.h('div', { class: 'notice', text: 'No saved designs yet.' }));
      return;
    }

    var table = App.dataTable(
      [{ label: 'Name' }, { label: 'Study title' }, { label: 'Saved', num: true }, { label: 'Actions' }],
      presets.map(function (preset) {
        return [
          { text: preset.name },
          { text: preset.title, className: 'seq' },
          { text: new Date(preset.modified * 1000).toLocaleString(), num: true },
          { text: '' }
        ];
      })
    );
    presetHost.appendChild(table);

    var rows = presetHost.querySelectorAll('tbody tr');
    presets.forEach(function (preset, index) {
      var row = rows[index];
      if (!row) return;
      var cell = row.children[3];
      App.clear(cell);
      var actions = App.h('div', { class: 'btn-row' }, []);
      var load = App.h('button', { class: 'btn quiet sm', type: 'button', text: 'Load' });
      load.addEventListener('click', function () { loadDesign(preset.name); });
      actions.appendChild(load);
      var save = App.h('button', {
        class: 'btn quiet sm', type: 'button', text: 'Download',
        title: 'Write this saved design out as a JSON file'
      });
      save.addEventListener('click', function () { downloadPreset(preset.name); });
      actions.appendChild(save);
      if (preset.name !== 'current') {
        var remove = App.h('button', { class: 'btn danger sm', type: 'button', text: 'Delete' });
        remove.addEventListener('click', function () { deleteDesign(preset.name); });
        actions.appendChild(remove);
      }
      cell.appendChild(actions);
    });
  }

  function refreshMarkdown() {
    if (!App.report || !markdownPicker) return;
    var choice = markdownPicker.value;
    var text = choice === '__all__'
      ? M.allMarkdown(App.report)
      : (App.report.markdownTables[choice] || '');
    markdownBox.textContent = text;
  }

  function rebuildPicker() {
    if (!markdownPicker || !App.report) return;
    var previous = markdownPicker.value;
    App.clear(markdownPicker);
    markdownPicker.appendChild(App.h('option', { value: '__all__', text: 'All tables (full report)' }));
    Object.keys(App.report.markdownTables).forEach(function (key) {
      markdownPicker.appendChild(App.h('option', { value: key, text: key }));
    });
    if (previous && Array.prototype.some.call(markdownPicker.options, function (option) {
      return option.value === previous;
    })) markdownPicker.value = previous;
  }

  function build() {
    App = global.PlannerApp;
    M = global.PlannerModel;
    H = M.helpers;

    var panel = App.h('div', { class: 'panel' });
    panel.appendChild(App.h('div', { class: 'panel-head' }, [
      App.h('h2', { text: 'Report and export' }),
      App.h('p', {
        text: 'Generated methods narrative, Markdown design matrices and the full XLSX workbook with the '
          + 'scanner parameter cards baked in.'
      })
    ]));

    methodsBox = App.h('textarea', { class: 'prose-box', spellcheck: 'false' });
    var methodsCard = App.card('Methods text', 'Regenerated from the solved design', [
      methodsBox,
      App.h('div', { class: 'btn-row mt' }, [
        App.h('button', {
          class: 'btn', type: 'button', text: 'Copy methods text',
          onclick: function () { App.copy(methodsBox.value, 'Methods text'); }
        }),
        App.h('button', {
          class: 'btn quiet sm', type: 'button', text: 'Regenerate',
          onclick: function () { methodsBox.value = App.report.methodsText; App.toast('Methods text regenerated'); }
        }),
        App.h('span', { class: 'muted', text: 'Edits here are for copying only and are not saved with the design.' })
      ])
    ]);

    markdownPicker = App.h('select', {});
    markdownPicker.addEventListener('change', refreshMarkdown);
    markdownBox = App.h('pre', { class: 'code-box' });
    var markdownCard = App.card('Markdown export', 'GitHub-flavoured tables', [
      App.h('div', { class: 'split-inline mb' }, [
        markdownPicker,
        App.h('button', {
          class: 'btn', type: 'button', text: 'Copy Markdown',
          onclick: function () { App.copy(markdownBox.textContent, 'Markdown table'); }
        }),
        App.h('button', {
          class: 'btn quiet', type: 'button', text: 'Copy every table',
          onclick: function () { App.copy(M.allMarkdown(App.report), 'Full Markdown report'); }
        }),
        App.h('button', {
          class: 'btn quiet', type: 'button', text: 'Download .md',
          onclick: downloadMarkdown
        })
      ]),
      markdownBox
    ]);

    var exportCard = App.card('Workbook export', 'XLSX with scanner settings baked in', [
      App.h('div', {
        class: 'notice',
        text: 'The workbook contains: summary, design matrix per aim, trial structure, budget and allocation, '
          + 'a session timeline per aim, efficiency diagnostics, question bank, data volume, methods text, Markdown '
          + 'tables, and one sheet per scanner parameter card with every parameter as saved.'
      }),
      App.h('div', { class: 'btn-row mt' }, [
        App.h('button', { class: 'btn gold', type: 'button', text: 'Download XLSX report', onclick: downloadXlsx }),
        App.h('button', { class: 'btn quiet', type: 'button', text: 'Download design JSON', onclick: downloadJson }),
        App.h('button', {
          class: 'btn quiet', type: 'button', text: 'Copy design matrix (all aims)',
          onclick: function () {
            var blocks = App.report.aims.map(function (aim) {
              return '### ' + aim.name + '\n\n' + App.report.markdownTables[aim.name];
            });
            App.copy(blocks.join('\n\n'), 'Design matrices');
          }
        })
      ])
    ]);

    psychopyButtons = App.h('div', { class: 'btn-row' });
    psychopyPicker = App.h('select', {});
    psychopyPicker.addEventListener('change', renderPsychopyPreview);
    psychopyBox = App.h('pre', { class: 'code-box', style: 'max-height:360px' });

    var psychopyCard = App.card('PsychoPy task config', 'One experiment.yaml per aim', [
      App.h('div', {
        class: 'notice',
        text: 'Each file is the lab experiment.yaml template with the scanner block (TR, dummy '
          + 'volumes), run: (lead-in and lead-out, blocks per run, trials per block, inter-block '
          + 'rest, label ordering), trial.phases: (the aim\'s phase list, durations and jitter) '
          + 'and conditions: (per_run counts split between the primary and the control conditions '
          + 'by the question bank\'s control share) filled in from that aim. Window, text, keys '
          + 'and instructions are passed through unchanged.'
      }),
      psychopyButtons,
      App.h('div', { class: 'split-inline mt mb' }, [
        psychopyPicker,
        App.h('button', {
          class: 'btn quiet', type: 'button', text: 'Copy YAML',
          onclick: function () { App.copy(psychopyBox.textContent, 'PsychoPy config'); }
        }),
        App.h('button', {
          class: 'btn quiet', type: 'button', text: 'Download shown',
          onclick: function () {
            var aim = currentPsychopyAim();
            if (aim) downloadPsychopy(aim);
          }
        })
      ]),
      psychopyBox
    ]);

    presetName = App.h('input', { type: 'text', placeholder: 'preset name' });
    presetHost = App.h('div', { class: 'mt' });

    /* The file input stays out of the layout; the visible button drives it. */
    var importPicker = App.h('input', {
      type: 'file', accept: '.json,application/json', style: 'display:none'
    });
    importPicker.addEventListener('change', function () {
      var file = importPicker.files && importPicker.files[0];
      if (file) importDesign(file, presetName.value);
      importPicker.value = '';
    });

    var presetCard = App.card('Saved designs', 'Stored server-side in presets/', [
      App.h('div', { class: 'split-inline' }, [
        presetName,
        App.h('button', {
          class: 'btn sm', type: 'button', text: 'Save as preset',
          onclick: function () {
            if (!presetName.value.trim()) { App.toast('Give the preset a name first', 'bad'); return; }
            saveDesign(presetName.value.trim());
          }
        }),
        App.h('button', {
          class: 'btn quiet sm', type: 'button', text: 'Save working design',
          onclick: function () { saveDesign('current'); }
        }),
        App.h('button', {
          class: 'btn quiet sm', type: 'button', text: 'Reset to defaults',
          onclick: function () {
            var fresh = M.defaultState();
            Object.keys(fresh).forEach(function (key) { App.state[key] = fresh[key]; });
            App.refresh(true);
            App.toast('Design reset to the built-in defaults');
          }
        })
      ]),
      App.h('div', { class: 'btn-row mt' }, [
        App.h('button', {
          class: 'btn quiet sm', type: 'button', text: 'Import JSON file',
          title: 'Load a design file into the working design; name it above to save it as a preset too',
          onclick: function () { importPicker.click(); }
        }),
        App.h('button', {
          class: 'btn quiet sm', type: 'button', text: 'Download working design',
          title: 'Write the design as it stands to a JSON file',
          onclick: function () {
            var blob = new Blob([JSON.stringify(App.state, null, 2)], { type: 'application/json' });
            download(blob, fileStem(presetName.value || 'current') + '.json');
            App.toast('Working design downloaded', 'ok');
          }
        }),
        importPicker,
        App.h('span', {
          class: 'muted',
          text: 'Import replaces the working design; anything the file omits falls back to the defaults.'
        })
      ]),
      presetHost
    ]);

    panel.appendChild(App.h('div', { class: 'grid split' }, [
      App.h('div', {}, [methodsCard, exportCard, psychopyCard]),
      App.h('div', {}, [markdownCard, presetCard])
    ]));

    App.registerView(function (report) {
      if (document.activeElement !== methodsBox) methodsBox.value = report.methodsText;
      rebuildPicker();
      refreshMarkdown();
      refreshPsychopy();
    });

    renderPresets();
    return panel;
  }

  global.PlannerExport = {
    build: build,
    downloadXlsx: downloadXlsx,
    downloadJson: downloadJson,
    saveDesign: function () { saveDesign('current'); },
    loadDesign: loadDesign,
    downloadPreset: downloadPreset,
    downloadPsychopy: downloadPsychopy,
    importDesign: importDesign
  };
}(window));
