/* fMRI Experimental Design Planner - design model, constraint solver and
 * text generation.  Pure functions over a plain state object so that the same
 * state can be persisted, re-solved and exported without side effects. */

(function (global) {
  'use strict';

  var AIM_IDS = ['glm', 'mvpa', 'ts'];

  var PHASE_ROLES = [
    { id: 'fixation', label: 'Fixation / baseline' },
    { id: 'question', label: 'Question presentation' },
    { id: 'rest', label: 'Delay / retention' },
    { id: 'answer', label: 'Covert answer window' },
    { id: 'cue', label: 'Cue / instruction' },
    { id: 'other', label: 'Other' }
  ];

  var STRUCTURAL_DEFAULTS = [
    { protocol: 'fMRI-Survey-Parameters', enabled: true, count: 1 },
    { protocol: 'fMRI-SENSE-Reference-Parameters', enabled: true, count: 1 },
    { protocol: 'fMRI-T1-Anatomical-Parameters', enabled: true, count: 1 },
    { protocol: 'fMRI-T2-FLAIR-Parameters', enabled: false, count: 1 },
    { protocol: 'fMRI-SBRef-Parameters', enabled: true, count: 1 },
    { protocol: 'fMRI-FieldMap-RevPE-Parameters', enabled: true, count: 1 },
    { protocol: 'fMRI-Dummy-Parameters', enabled: false, count: 1 }
  ];

  var QUESTION_FAMILIES = [
    { name: 'Perceptual / relational', pct: 14, role: 'Controlled relations and matched predicate reversals' },
    { name: 'Arbitrarily learned facts', pct: 12, role: 'Reduces reliance on pre-existing semantic knowledge' },
    { name: 'Recognition / working memory', pct: 12, role: 'Separates retrieval demands from answer identity' },
    { name: 'Category / object property', pct: 13, role: 'Tests semantic category generalisation' },
    { name: 'Arithmetic / comparison', pct: 13, role: 'Objective, easily balanced answers' },
    { name: 'Logic / inference', pct: 12, role: 'Tests answer invariance across reasoning operations' },
    { name: 'Linguistic judgment', pct: 12, role: 'Phonological, orthographic and semantic overlap' },
    { name: 'General knowledge', pct: 12, role: 'Extends to familiar natural questions' }
  ];

  /* ------------------------------------------------------------ helpers */

  function num(value, fallback) {
    var parsed = typeof value === 'number' ? value : parseFloat(value);
    if (!isFinite(parsed)) return fallback === undefined ? 0 : fallback;
    return parsed;
  }

  function clamp(value, lo, hi) {
    return Math.min(hi, Math.max(lo, value));
  }

  function round(value, digits) {
    var factor = Math.pow(10, digits === undefined ? 2 : digits);
    return Math.round(value * factor) / factor;
  }

  function sum(list, pick) {
    var total = 0;
    for (var i = 0; i < list.length; i += 1) total += pick ? pick(list[i], i) : list[i];
    return total;
  }

  function fmtNumber(value, digits) {
    return num(value).toLocaleString('en-US', {
      minimumFractionDigits: digits || 0,
      maximumFractionDigits: digits === undefined ? 0 : digits
    });
  }

  function trim(value, digits) {
    var text = num(value).toFixed(digits === undefined ? 1 : digits);
    return text.indexOf('.') >= 0 ? text.replace(/\.?0+$/, '') : text;
  }

  function fmtSeconds(seconds) {
    var value = num(seconds);
    if (value < 90) return trim(value, 1) + ' s';
    return num(value / 60).toFixed(1) + ' min';
  }

  function fmtRange(minValue, maxValue) {
    var lo = num(minValue), hi = num(maxValue);
    if (Math.abs(hi - lo) < 0.05) return fmtSeconds(lo);
    if (hi < 90) return trim(lo, 1) + ' - ' + trim(hi, 1) + ' s';
    return (lo / 60).toFixed(1) + ' - ' + (hi / 60).toFixed(1) + ' min';
  }

  function fmtMinutes(minutes) {
    var value = num(minutes);
    if (value < 60) return round(value, 1) + ' min';
    var hours = Math.floor(value / 60);
    return hours + ' h ' + round(value - hours * 60, 0) + ' min';
  }

  function fmtClock(seconds) {
    var value = Math.max(0, num(seconds));
    var minutes = Math.floor(value / 60);
    var rest = value - minutes * 60;
    if (minutes >= 60) {
      var hours = Math.floor(minutes / 60);
      return hours + ':' + pad(minutes % 60) + ':' + pad(Math.round(rest));
    }
    return pad(minutes) + ':' + (rest < 10 ? '0' : '') + rest.toFixed(1);
  }

  function pad(value) {
    return (value < 10 ? '0' : '') + Math.floor(value);
  }

  function phaseLabel(phase) {
    var lo = round(num(phase.min), 1);
    var hi = round(num(phase.max), 1);
    if (Math.abs(hi - lo) < 0.001) return phase.name + ' (' + lo + 's)';
    if (phase.jitter) return phase.name + ' (jitter, ' + lo + '-' + hi + 's)';
    return phase.name + ' (' + lo + '-' + hi + 's)';
  }

  function deepCopy(value) {
    return JSON.parse(JSON.stringify(value));
  }

  /* ------------------------------------------------------- default state */

  /* Recommended trial timing per decoding objective.
   *   detection  - saturating: minimal rest so successive same-label responses
   *                stack instead of returning to baseline
   *   estimation - moderate separation so single-trial betas are estimable
   *   separation - full recovery: the prompt response and the previous trial
   *                are both back at baseline before the next answer window
   */
  var RECOMMENDED_TIMING = {
    detection: [
      { name: 'Fixation', min: 2, max: 6, jitter: true, role: 'fixation' },
      { name: 'Question', min: 4, max: 4, jitter: false, role: 'question' },
      { name: 'Rest', min: 1, max: 2, jitter: true, role: 'rest' },
      { name: 'Answer', min: 3, max: 3, jitter: false, role: 'answer' },
      { name: 'Fixation', min: 2, max: 6, jitter: true, role: 'fixation' }
    ],
    estimation: [
      { name: 'Fixation', min: 2, max: 6, jitter: true, role: 'fixation' },
      { name: 'Question', min: 4, max: 4, jitter: false, role: 'question' },
      { name: 'Rest', min: 6, max: 10, jitter: true, role: 'rest' },
      { name: 'Answer cue', min: 3, max: 3, jitter: false, role: 'answer' },
      { name: 'Fixation', min: 10, max: 14, jitter: true, role: 'fixation' }
    ],
    separation: [
      { name: 'Fixation', min: 2, max: 6, jitter: true, role: 'fixation' },
      { name: 'Question', min: 4, max: 4, jitter: false, role: 'question' },
      { name: 'Rest', min: 14, max: 16, jitter: true, role: 'rest' },
      { name: 'Answer cue', min: 3, max: 3, jitter: false, role: 'answer' },
      { name: 'Fixation', min: 24, max: 28, jitter: true, role: 'fixation' }
    ]
  };

  var OBJECTIVES = [
    {
      id: 'detection',
      label: 'Detection (saturating)',
      blurb: 'Stack same-label responses so the BOLD level never settles; maximises '
        + 'univariate contrast power per minute.'
    },
    {
      id: 'estimation',
      label: 'Single-trial estimation',
      blurb: 'Maximises the estimability of individual trial betas, which is what '
        + 'linear MVPA is actually trained on.'
    },
    {
      id: 'separation',
      label: 'Full HRF separation',
      blurb: 'Returns to baseline between trials and resolves the prompt response from '
        + 'the answer response, giving clean event-aligned clips.'
    }
  ];

  var SOLVE_MODES = [
    {
      id: 'budget', label: 'Hours available',
      blurb: 'Spend the whole scanner budget; the question count is whatever the hours buy.'
    },
    {
      id: 'fill', label: 'Question goal',
      blurb: 'Fill as much of one total question goal as the hours allow, keeping the '
        + 'per-aim split of scanner time.'
    },
    {
      id: 'target', label: 'Per-aim goals',
      blurb: 'Each aim runs until it reaches its own question goal, however many hours that takes.'
    },
    {
      id: 'manual', label: 'Session counts',
      blurb: 'You set the number of sessions per aim directly.'
    }
  ];

  var ALLOCATION_UNITS = [
    { id: 'percent', label: 'Percent', unit: '%' },
    { id: 'hours', label: 'Hours', unit: 'h' },
    { id: 'sessions', label: 'Sessions', unit: 'sess' }
  ];

  var LABEL_ORDERS = [
    { id: 'blocked', label: 'Blocked by label' },
    { id: 'alternating', label: 'Strict alternation' },
    { id: 'intermixed', label: 'Intermixed and balanced' }
  ];

  function defaultPhases(id) {
    if (id === 'glm') return deepCopy(RECOMMENDED_TIMING.detection);
    if (id === 'mvpa') return deepCopy(RECOMMENDED_TIMING.estimation);
    return deepCopy(RECOMMENDED_TIMING.separation);
  }

  function defaultAim(id) {
    var config = {
      glm: {
        name: 'Aim 1 - GLM / FIR',
        short: 'GLM',
        protocol: 'fMRI-GLM-Parameters',
        pct: 2,
        structure: {
          trialsPerBlock: 12, interTrialGap: 0, blocksPerRun: 4, interBlockRest: 20,
          dummyVolumes: 6, leadIn: 12, leadOut: 12, runsPerSession: 2
        },
        decode: { objective: 'detection', labelOrder: 'blocked', labelRunLength: 12 },
        targetQuestions: 400
      },
      mvpa: {
        name: 'Aim 2 - MVPA',
        short: 'MVPA',
        protocol: 'fMRI-MVPA-Parameters',
        pct: 15,
        structure: {
          trialsPerBlock: 10, interTrialGap: 0, blocksPerRun: 3, interBlockRest: 12,
          dummyVolumes: 12, leadIn: 12, leadOut: 12, runsPerSession: 3
        },
        decode: { objective: 'estimation', labelOrder: 'intermixed', labelRunLength: 1 },
        targetQuestions: 750
      },
      ts: {
        name: 'Aim 3 - Spatiotemporal',
        short: 'Time-Series',
        protocol: 'fMRI-Time-Series-Parameters-V3',
        pct: 83,
        structure: {
          trialsPerBlock: 10, interTrialGap: 0, blocksPerRun: 2, interBlockRest: 12,
          dummyVolumes: 12, leadIn: 12, leadOut: 12, runsPerSession: 4
        },
        decode: { objective: 'separation', labelOrder: 'intermixed', labelRunLength: 1 },
        targetQuestions: 5000
      }
    }[id];

    return {
      id: id,
      name: config.name,
      short: config.short,
      enabled: true,
      protocol: config.protocol,
      requestedPct: config.pct,
      locked: false,
      phases: defaultPhases(id),
      structure: config.structure,
      decode: config.decode,
      targetQuestions: config.targetQuestions,
      separationTolerancePct: id === 'glm' ? 45 : (id === 'mvpa' ? 12 : 4),
      sessions: 0,
      labelBalance: 50,
      seed: 20260823
    };
  }

  /* Every aim may run its own session composition - a different structural
   * block, a different setup allowance, a different break.  Until `custom` is
   * turned on the aim simply follows the shared defaults. */
  function defaultPerAimSession() {
    return {
      custom: false,
      screeningMinutes: 6,
      positioningMinutes: 5,
      practiceMinutes: 4,
      breakMinutes: 3,
      structurals: deepCopy(STRUCTURAL_DEFAULTS)
    };
  }

  function defaultPerAimSessions() {
    var out = {};
    AIM_IDS.forEach(function (id) { out[id] = defaultPerAimSession(); });
    return out;
  }

  function defaultState() {
    var aims = {};
    AIM_IDS.forEach(function (id) { aims[id] = defaultAim(id); });
    return {
      version: 1,
      meta: {
        studyTitle: 'Dense Single-Participant fMRI Decoding of Prompted Binary Inner Speech',
        investigator: '',
        institution: 'Wright State University',
        participantId: 'SUB-01',
        designId: 'DESIGN-001',
        notes: 'One healthy adult, age 18-60, native English speaker, no MRI contraindications.'
      },
      budget: {
        totalScannerHours: 165,
        contingencyPct: 8,
        solveMode: 'fill',
        sessionModel: 'dedicated',
        targetQuestionsTotal: 6000,
        allocationUnit: 'percent',
        sessionsPerWeek: 3,
        weeksAvailable: 30,
        countOverheadAgainstBudget: true,
        autoClamp: true
      },
      caps: {
        applyTo: 'expected',
        maxRunMinutes: 20,
        maxSessionMinutes: 120,
        maxRunsPerSession: 8,
        maxSessionsTotal: 100,
        maxContinuousMinutes: 25,
        minQuestionsPerAim: 50
      },
      session: {
        screeningMinutes: 6,
        positioningMinutes: 5,
        practiceMinutes: 4,
        breakMinutes: 3,
        structurals: deepCopy(STRUCTURAL_DEFAULTS),
        perAim: defaultPerAimSessions()
      },
      questionBank: {
        size: 1500,
        maxRepeats: 6,
        yesPct: 50,
        controlPct: 15,
        families: deepCopy(QUESTION_FAMILIES)
      },
      aims: aims,
      dynScansFrom: 'max'
    };
  }

  /* ------------------------------------------------------- normalisation */

  function normaliseAllocation(state, changedId) {
    var aims = state.aims;
    var active = AIM_IDS.filter(function (id) { return aims[id].enabled; });
    if (!active.length) return;
    if (active.length === 1) { aims[active[0]].requestedPct = 100; return; }

    var target = clamp(num(aims[changedId] && aims[changedId].requestedPct), 0, 100);
    if (changedId && aims[changedId] && aims[changedId].enabled) {
      aims[changedId].requestedPct = target;
    }

    var adjustable = active.filter(function (id) {
      return id !== changedId && !aims[id].locked;
    });
    var fixed = active.filter(function (id) {
      return id !== changedId && aims[id].locked;
    });
    var fixedTotal = sum(fixed, function (id) { return num(aims[id].requestedPct); });
    var anchor = changedId && aims[changedId] && aims[changedId].enabled ? target : 0;
    var remaining = 100 - anchor - fixedTotal;

    if (!adjustable.length) {
      var scale = active.filter(function (id) { return id !== changedId; });
      var total = sum(scale, function (id) { return num(aims[id].requestedPct); });
      if (total > 0) {
        scale.forEach(function (id) {
          aims[id].requestedPct = round(num(aims[id].requestedPct) / total * (100 - anchor), 2);
        });
      }
      return;
    }

    if (remaining < 0) remaining = 0;
    var pool = sum(adjustable, function (id) { return num(aims[id].requestedPct); });
    adjustable.forEach(function (id, index) {
      var share = pool > 0 ? num(aims[id].requestedPct) / pool : 1 / adjustable.length;
      aims[id].requestedPct = round(remaining * share, 2);
      if (index === adjustable.length - 1) {
        var running = sum(active, function (other) { return num(aims[other].requestedPct); });
        aims[id].requestedPct = round(num(aims[id].requestedPct) + (100 - running), 2);
      }
    });
    active.forEach(function (id) {
      aims[id].requestedPct = clamp(round(num(aims[id].requestedPct), 2), 0, 100);
    });
  }

  /* --------------------------------------------------- derived durations */

  function trialTiming(aim) {
    var minTotal = 0, maxTotal = 0;
    aim.phases.forEach(function (phase) {
      var lo = Math.max(0, num(phase.min));
      var hi = Math.max(lo, num(phase.max));
      minTotal += lo;
      maxTotal += hi;
    });
    return { min: minTotal, max: maxTotal, mean: (minTotal + maxTotal) / 2 };
  }

  function aimGeometry(aim, trSeconds) {
    var structure = aim.structure;
    var trial = trialTiming(aim);
    var trialsPerBlock = Math.max(1, Math.round(num(structure.trialsPerBlock, 1)));
    var blocksPerRun = Math.max(1, Math.round(num(structure.blocksPerRun, 1)));
    var gap = Math.max(0, num(structure.interTrialGap));
    var blockRest = Math.max(0, num(structure.interBlockRest));
    var dummyVolumes = Math.max(0, Math.round(num(structure.dummyVolumes)));
    var dummySeconds = dummyVolumes * trSeconds;
    var leadIn = Math.max(0, num(structure.leadIn));
    var leadOut = Math.max(0, num(structure.leadOut));

    var block = {
      min: trialsPerBlock * trial.min + (trialsPerBlock - 1) * gap,
      max: trialsPerBlock * trial.max + (trialsPerBlock - 1) * gap,
      mean: trialsPerBlock * trial.mean + (trialsPerBlock - 1) * gap
    };
    var fixed = dummySeconds + leadIn + leadOut + (blocksPerRun - 1) * blockRest;
    var run = {
      min: fixed + blocksPerRun * block.min,
      max: fixed + blocksPerRun * block.max,
      mean: fixed + blocksPerRun * block.mean
    };
    var functional = {
      min: run.min - dummySeconds,
      max: run.max - dummySeconds,
      mean: run.mean - dummySeconds
    };
    return {
      trial: trial,
      block: block,
      run: run,
      functional: functional,
      trialsPerBlock: trialsPerBlock,
      blocksPerRun: blocksPerRun,
      trialsPerRun: trialsPerBlock * blocksPerRun,
      dummyVolumes: dummyVolumes,
      dummySeconds: dummySeconds,
      leadIn: leadIn,
      leadOut: leadOut,
      interBlockRest: blockRest,
      interTrialGap: gap
    };
  }

  /* ------------------------------------------------------------- context */

  function protocolContext(boot, slug) {
    var acquisition = (boot.acquisition || {})[slug] || {};
    var manifest = (boot.manifest || []).filter(function (entry) {
      return entry.slug === slug;
    })[0] || {};
    var headline = manifest.headline || {};
    var trMs = num(acquisition.trMs, 2000);
    return {
      slug: slug,
      label: manifest.label || slug,
      trMs: trMs,
      trSeconds: trMs / 1000,
      teMs: num(acquisition.teMs, 0),
      durationSeconds: num(acquisition.durationSeconds, 0),
      slices: num(headline.slices, 0),
      matrix: num(headline.matrix, 0),
      voxel: headline.voxel || '',
      mbFactor: headline.mbFactor || '',
      senseP: headline.senseP || '',
      flip: headline.flip || '',
      dynScans: num(headline.dynScans, 0)
    };
  }

  function structuralMinutes(list, boot) {
    var rows = [];
    var total = 0;
    (list || []).forEach(function (entry) {
      var ctx = protocolContext(boot, entry.protocol);
      var count = Math.max(0, Math.round(num(entry.count, 1)));
      var minutes = (ctx.durationSeconds / 60) * count;
      if (entry.enabled) total += minutes;
      rows.push({
        protocol: entry.protocol,
        protocolLabel: ctx.label,
        enabled: !!entry.enabled,
        count: count,
        minutesEach: ctx.durationSeconds / 60,
        minutes: minutes
      });
    });
    return { rows: rows, minutes: total };
  }

  /* Resolve the session composition an aim actually runs: its own when the aim
   * has been given a custom composition, the shared defaults otherwise. */
  function sessionConfigFor(state, boot, aimId) {
    var shared = state.session || {};
    var perAim = (shared.perAim || {})[aimId];
    var custom = !!(perAim && perAim.custom);
    var source = custom ? perAim : shared;
    var structural = structuralMinutes(source.structurals, boot);
    var overhead = num(source.screeningMinutes) + num(source.positioningMinutes)
      + num(source.practiceMinutes);
    return {
      aimId: aimId,
      custom: custom,
      structural: structural,
      screeningMinutes: num(source.screeningMinutes),
      positioningMinutes: num(source.positioningMinutes),
      practiceMinutes: num(source.practiceMinutes),
      overheadMinutes: overhead,
      structuralMinutes: structural.minutes,
      setupMinutes: structural.minutes + overhead,
      breakMinutes: Math.max(0, num(source.breakMinutes))
    };
  }

  /* Carry an older saved design forward: trial-denominated targets became
   * question-denominated, and per-aim session composition is new. */
  function migrateState(state) {
    if (!state || typeof state !== 'object') return state;
    if (state.budget) {
      if (state.budget.targetQuestionsTotal === undefined
        && state.budget.targetTrialsTotal !== undefined) {
        state.budget.targetQuestionsTotal = state.budget.targetTrialsTotal;
      }
      delete state.budget.targetTrialsTotal;
    }
    if (state.caps) {
      if (state.caps.minQuestionsPerAim === undefined
        && state.caps.minTrialsPerAim !== undefined) {
        state.caps.minQuestionsPerAim = state.caps.minTrialsPerAim;
      }
      delete state.caps.minTrialsPerAim;
    }
    AIM_IDS.forEach(function (id) {
      var aim = state.aims && state.aims[id];
      if (!aim) return;
      if (aim.targetQuestions === undefined && aim.targetTrials !== undefined) {
        aim.targetQuestions = aim.targetTrials;
      }
      delete aim.targetTrials;
    });
    if (state.session) {
      if (!state.session.perAim || typeof state.session.perAim !== 'object') {
        state.session.perAim = defaultPerAimSessions();
      }
      AIM_IDS.forEach(function (id) {
        if (!state.session.perAim[id]) state.session.perAim[id] = defaultPerAimSession();
      });
    }
    return state;
  }

  /* -------------------------------------------------------------- solver */

  function solve(state, boot) {
    var warnings = [];
    var working = deepCopy(state);
    var aims = AIM_IDS.map(function (id) { return working.aims[id]; })
      .filter(function (aim) { return aim && aim.enabled; });

    migrateState(working);

    /* Shared composition drives the pooled model and the study-level summary;
     * each aim resolves its own, which may or may not be the shared one. */
    var structural = structuralMinutes(working.session.structurals, boot);
    var overheadMinutes = num(working.session.screeningMinutes)
      + num(working.session.positioningMinutes)
      + num(working.session.practiceMinutes);
    var setupMinutes = structural.minutes + overheadMinutes;
    var breakMinutes = Math.max(0, num(working.session.breakMinutes));
    var caps = working.caps;
    var controlFraction = 1 - clamp(num((working.questionBank || {}).controlPct), 0, 100) / 100;
    var pooledModel = working.budget.sessionModel === 'pooled';
    var sharedSession = {
      aimId: null,
      custom: false,
      structural: structural,
      screeningMinutes: num(working.session.screeningMinutes),
      positioningMinutes: num(working.session.positioningMinutes),
      practiceMinutes: num(working.session.practiceMinutes),
      overheadMinutes: overheadMinutes,
      structuralMinutes: structural.minutes,
      setupMinutes: setupMinutes,
      breakMinutes: breakMinutes
    };

    /* --- per-aim geometry with cap repair ------------------------------ */
    var basis = caps.applyTo === 'longest' ? 'max' : 'mean';
    var basisLabel = basis === 'max' ? 'longest' : 'expected';
    var solved = aims.map(function (aim) {
      var ctx = protocolContext(boot, aim.protocol);
      var geometry = aimGeometry(aim, ctx.trSeconds);
      /* Pooled sessions are shared by every aim, so a per-aim composition only
       * applies in the dedicated model. */
      var sessionCfg = pooledModel ? sharedSession : sessionConfigFor(working, boot, aim.id);
      var aimSetup = sessionCfg.setupMinutes;
      var aimBreak = sessionCfg.breakMinutes;

      if (working.budget.autoClamp) {
        var guard = 0;
        while (geometry.run[basis] / 60 > num(caps.maxRunMinutes) && geometry.blocksPerRun > 1 && guard < 40) {
          aim.structure.blocksPerRun = geometry.blocksPerRun - 1;
          geometry = aimGeometry(aim, ctx.trSeconds);
          guard += 1;
        }
        while (geometry.run[basis] / 60 > num(caps.maxRunMinutes) && geometry.trialsPerBlock > 1 && guard < 80) {
          aim.structure.trialsPerBlock = geometry.trialsPerBlock - 1;
          geometry = aimGeometry(aim, ctx.trSeconds);
          guard += 1;
        }
        if (guard > 0) {
          warnings.push(aim.name + ': run structure reduced to keep the ' + basisLabel
            + ' run within the ' + num(caps.maxRunMinutes) + ' min run cap (now '
            + round(geometry.run[basis] / 60, 1) + ' min ' + basisLabel + ', '
            + round(geometry.run.max / 60, 1) + ' min longest).');
        }
      } else if (geometry.run[basis] / 60 > num(caps.maxRunMinutes)) {
        warnings.push(aim.name + ': ' + basisLabel + ' run is ' + round(geometry.run[basis] / 60, 1)
          + ' min, over the ' + num(caps.maxRunMinutes) + ' min cap. Auto-clamp is off.');
      }

      if (geometry.run.max / 60 > num(caps.maxContinuousMinutes)) {
        warnings.push(aim.name + ': longest run (' + round(geometry.run.max / 60, 1)
          + ' min) exceeds the continuous-scanning comfort limit of '
          + num(caps.maxContinuousMinutes) + ' min.');
      }

      var runsPerSession = Math.max(1, Math.round(num(aim.structure.runsPerSession, 1)));
      runsPerSession = Math.min(runsPerSession, Math.max(1, Math.round(num(caps.maxRunsPerSession, 8))));
      if (working.budget.sessionModel === 'dedicated' && working.budget.autoClamp) {
        var attempts = 0;
        while (runsPerSession > 1 && attempts < 40
          && aimSetup + runsPerSession * geometry.run[basis] / 60
            + (runsPerSession - 1) * aimBreak > num(caps.maxSessionMinutes)) {
          runsPerSession -= 1;
          attempts += 1;
        }
        if (attempts > 0) {
          warnings.push(aim.name + ': runs per session reduced to ' + runsPerSession
            + ' so the ' + basisLabel + ' session stays within the '
            + num(caps.maxSessionMinutes) + ' min cap.');
        }
      }
      aim.structure.runsPerSession = runsPerSession;

      return {
        aim: aim, ctx: ctx, geometry: geometry, runsPerSession: runsPerSession,
        session: sessionCfg
      };
    });

    /* --- allocation ---------------------------------------------------- */
    var requestedTotal = sum(solved, function (entry) { return num(entry.aim.requestedPct); });
    if (requestedTotal <= 0) requestedTotal = 1;
    solved.forEach(function (entry) {
      entry.fraction = num(entry.aim.requestedPct) / requestedTotal;
    });

    var usableHours = num(working.budget.totalScannerHours)
      * (1 - clamp(num(working.budget.contingencyPct), 0, 90) / 100);
    var usableMinutes = usableHours * 60;
    var maxSessions = Math.max(1, Math.round(num(caps.maxSessionsTotal, 60)));
    var calendarSessions = Math.max(1, Math.floor(num(working.budget.sessionsPerWeek, 3)
      * num(working.budget.weeksAvailable, 12)));

    var mode = working.budget.solveMode;
    var pooled = working.budget.sessionModel === 'pooled';
    var totalSessions = 0;
    var pooledRunsPerSession = 0;
    var pooledSessionMinutes = 0;

    if (pooled) {
      var meanRunMinutes = sum(solved, function (entry) {
        return entry.fraction * entry.geometry.run.mean / 60;
      });
      if (meanRunMinutes <= 0) meanRunMinutes = 1;
      var capacity = num(caps.maxSessionMinutes) - setupMinutes + breakMinutes;
      if (basis === 'max') {
        meanRunMinutes = sum(solved, function (entry) {
          return entry.fraction * entry.geometry.run.max / 60;
        }) || meanRunMinutes;
      }
      pooledRunsPerSession = Math.floor(capacity / (meanRunMinutes + breakMinutes));
      pooledRunsPerSession = clamp(pooledRunsPerSession, 1, Math.round(num(caps.maxRunsPerSession, 8)));
      pooledSessionMinutes = setupMinutes + pooledRunsPerSession * meanRunMinutes
        + (pooledRunsPerSession - 1) * breakMinutes;

      var functionalPerSession = pooledRunsPerSession * meanRunMinutes;
      var trialsPerPooledSession = sum(solved, function (entry) {
        var runs = entry.fraction * functionalPerSession / (entry.geometry.run.mean / 60);
        return runs * entry.geometry.trialsPerRun;
      });

      var questionsPerPooledSession = trialsPerPooledSession * controlFraction;
      if (mode === 'target') {
        var pooledGoal = sum(solved, function (entry) { return num(entry.aim.targetQuestions); });
        totalSessions = questionsPerPooledSession > 0
          ? Math.ceil(pooledGoal / questionsPerPooledSession) : 0;
      } else if (mode === 'manual') {
        totalSessions = Math.max(0, Math.round(num(working.budget.manualSessions,
          Math.floor(usableMinutes / Math.max(1, pooledSessionMinutes)))));
      } else {
        totalSessions = Math.floor(usableMinutes / Math.max(1, pooledSessionMinutes));
        if (mode === 'fill' && questionsPerPooledSession > 0) {
          /* Fill mode buys as much of the question goal as the hours allow and
           * stops there rather than overshooting it. */
          var affordable = Math.round(totalSessions * questionsPerPooledSession);
          var goal = num(working.budget.targetQuestionsTotal);
          var neededSessions = Math.ceil(goal / questionsPerPooledSession);
          if (neededSessions < totalSessions) totalSessions = neededSessions;
          else if (goal > affordable) {
            warnings.push('Question goal of ' + fmtNumber(goal) + ' does not fit the budget: '
              + round(usableHours, 1) + ' usable hours buy about ' + fmtNumber(affordable)
              + ' questions. The plan fills what the hours allow.');
          }
        }
      }
      totalSessions = clamp(totalSessions, 0, maxSessions);
      if (totalSessions > calendarSessions) {
        warnings.push('Session count clamped from ' + totalSessions + ' to ' + calendarSessions
          + ' by the calendar (' + num(working.budget.sessionsPerWeek) + ' per week over '
          + num(working.budget.weeksAvailable) + ' weeks).');
        totalSessions = calendarSessions;
      }

      var totalRuns = totalSessions * pooledRunsPerSession;
      var wanted = solved.map(function (entry) {
        var minutes = entry.fraction * totalRuns * meanRunMinutes;
        return minutes / (entry.geometry.run.mean / 60);
      });
      var assigned = wanted.map(function (value) { return Math.floor(value); });
      var remainder = totalRuns - sum(assigned);
      var order = wanted.map(function (value, index) {
        return { index: index, frac: value - Math.floor(value) };
      }).sort(function (a, b) { return b.frac - a.frac; });
      for (var i = 0; i < order.length && remainder > 0; i += 1) {
        assigned[order[i].index] += 1;
        remainder -= 1;
      }
      solved.forEach(function (entry, index) {
        entry.totalRuns = Math.max(0, assigned[index]);
        entry.sessions = totalSessions;
        entry.runsPerSessionEffective = totalSessions > 0 ? entry.totalRuns / totalSessions : 0;
      });
    } else {
      solved.forEach(function (entry) {
        var runs = entry.runsPerSession;
        var sessionMean = entry.session.setupMinutes + runs * entry.geometry.run.mean / 60
          + (runs - 1) * entry.session.breakMinutes;
        entry.sessionMinutes = sessionMean;
        var trialsPerSession = runs * entry.geometry.trialsPerRun;
        entry.questionsPerSession = trialsPerSession * controlFraction;
        var sessions;
        if (mode === 'target') {
          sessions = entry.questionsPerSession > 0
            ? Math.ceil(num(entry.aim.targetQuestions) / entry.questionsPerSession) : 0;
        } else if (mode === 'manual') {
          sessions = Math.max(0, Math.round(num(entry.aim.sessions)));
        } else {
          sessions = Math.floor(entry.fraction * usableMinutes / Math.max(1, sessionMean));
          if (sessions === 0 && entry.fraction > 0 && sessionMean <= usableMinutes) {
            /* A small share still buys a session; round up rather than dropping
             * the aim, and say so. */
            sessions = 1;
            warnings.push(entry.aim.name + ': allocation of '
              + round(entry.fraction * 100, 1) + ' percent covers only '
              + round(entry.fraction * usableMinutes, 0) + ' min, less than one '
              + round(sessionMean, 0) + ' min session. Rounded up to a single session.');
          }
        }
        entry.sessions = Math.max(0, sessions);
        entry.totalRuns = entry.sessions * runs;
        entry.runsPerSessionEffective = runs;
      });

      if (mode === 'fill') {
        applyQuestionGoal(solved, num(working.budget.targetQuestionsTotal),
          usableHours, warnings);
      }

      totalSessions = clampSessions(solved, maxSessions, warnings,
        'the study maximum of ' + maxSessions + ' sessions');
      totalSessions = clampSessions(solved, calendarSessions, warnings,
        'the calendar (' + num(working.budget.sessionsPerWeek) + ' per week over '
        + num(working.budget.weeksAvailable) + ' weeks)');
    }

    /* --- totals -------------------------------------------------------- */
    var functionalMinutesTotal = sum(solved, function (entry) {
      return entry.totalRuns * entry.geometry.run.mean / 60;
    });

    solved.forEach(function (entry) {
      var runs = entry.totalRuns;
      entry.trials = Math.round(runs * entry.geometry.trialsPerRun);
      entry.functionalMinutes = runs * entry.geometry.run.mean / 60;
      entry.functionalMinutesMin = runs * entry.geometry.run.min / 60;
      entry.functionalMinutesMax = runs * entry.geometry.run.max / 60;
      entry.sharePct = functionalMinutesTotal > 0
        ? entry.functionalMinutes / functionalMinutesTotal * 100 : 0;
    });

    var overheadMinutesTotal;
    if (pooled) {
      overheadMinutesTotal = totalSessions * (setupMinutes
        + Math.max(0, pooledRunsPerSession - 1) * breakMinutes);
    } else {
      overheadMinutesTotal = sum(solved, function (entry) {
        return entry.sessions * (entry.session.setupMinutes
          + Math.max(0, entry.runsPerSessionEffective - 1) * entry.session.breakMinutes);
      });
    }
    solved.forEach(function (entry) {
      entry.overheadMinutes = pooled
        ? overheadMinutesTotal * (functionalMinutesTotal > 0
          ? entry.functionalMinutes / functionalMinutesTotal : 0)
        : entry.sessions * (entry.session.setupMinutes
          + Math.max(0, entry.runsPerSessionEffective - 1) * entry.session.breakMinutes);
      entry.totalMinutes = entry.functionalMinutes + entry.overheadMinutes;
    });

    var committedMinutes = working.budget.countOverheadAgainstBudget
      ? functionalMinutesTotal + overheadMinutesTotal
      : functionalMinutesTotal;
    var totalTrials = sum(solved, function (entry) { return entry.trials; });

    if (committedMinutes > usableMinutes + 0.01) {
      warnings.push('Committed scanner time (' + round(committedMinutes / 60, 2)
        + ' h) exceeds the usable budget (' + round(usableMinutes / 60, 2)
        + ' h after contingency). Reduce sessions, runs or the target trial count.');
    }
    solved.forEach(function (entry) {
      var entryQuestions = Math.round(entry.trials * controlFraction);
      if (entry.trials > 0 && entryQuestions < num(caps.minQuestionsPerAim)) {
        warnings.push(entry.aim.name + ' records only ' + fmtNumber(entryQuestions)
          + ' questions, below the ' + fmtNumber(num(caps.minQuestionsPerAim))
          + ' question floor. Raise its allocation or lower the floor.');
      }
      if (entry.trials === 0) {
        warnings.push(entry.aim.name + ' receives no scanner time at the current allocation.');
      }
    });

    /* --- session picture ----------------------------------------------- */
    var sessionMinutesMean, sessionMinutesMin, sessionMinutesMax, runsPerSessionDisplay;
    if (pooled) {
      sessionMinutesMean = pooledSessionMinutes;
      var runsHere = pooledRunsPerSession;
      var wMin = sum(solved, function (entry) { return entry.fraction * entry.geometry.run.min / 60; });
      var wMax = sum(solved, function (entry) { return entry.fraction * entry.geometry.run.max / 60; });
      sessionMinutesMin = setupMinutes + runsHere * wMin + (runsHere - 1) * breakMinutes;
      sessionMinutesMax = setupMinutes + runsHere * wMax + (runsHere - 1) * breakMinutes;
      runsPerSessionDisplay = runsHere;
    } else {
      var driver = solved.slice().sort(function (a, b) { return b.sessions - a.sessions; })[0] || solved[0];
      if (driver) {
        var runs2 = driver.runsPerSessionEffective;
        var driverSetup = driver.session.setupMinutes;
        var driverBreak = driver.session.breakMinutes;
        sessionMinutesMean = driverSetup + runs2 * driver.geometry.run.mean / 60 + (runs2 - 1) * driverBreak;
        sessionMinutesMin = driverSetup + runs2 * driver.geometry.run.min / 60 + (runs2 - 1) * driverBreak;
        sessionMinutesMax = driverSetup + runs2 * driver.geometry.run.max / 60 + (runs2 - 1) * driverBreak;
        runsPerSessionDisplay = runs2;
      } else {
        sessionMinutesMean = sessionMinutesMin = sessionMinutesMax = setupMinutes;
        runsPerSessionDisplay = 0;
      }
    }

    if (sessionMinutesMax > num(caps.maxSessionMinutes)) {
      warnings.push('Longest session reaches ' + round(sessionMinutesMax, 1)
        + ' min, over the ' + num(caps.maxSessionMinutes) + ' min session cap. Caps are currently '
        + 'applied to the ' + basisLabel + ' duration; switch to longest-duration caps to force a fit.');
    }

    var timelines = buildTimelines(solved, pooled, pooledRunsPerSession, sharedSession);
    var primaryTimeline = timelines.filter(function (record) { return record.primary; })[0]
      || timelines[0] || { rows: [] };
    var timeline = primaryTimeline.rows;

    /* --- question bank -------------------------------------------------- */
    var bank = working.questionBank;
    var demand = totalTrials;
    var supply = Math.max(0, Math.round(num(bank.size) * num(bank.maxRepeats)));
    var controlTrials = Math.round(demand * clamp(num(bank.controlPct), 0, 100) / 100);
    var bankSummary = {
      size: Math.round(num(bank.size)),
      maxRepeats: num(bank.maxRepeats),
      supply: supply,
      demand: demand,
      headroom: supply - demand,
      yesPct: num(bank.yesPct),
      controlPct: num(bank.controlPct),
      primaryTrials: demand - controlTrials,
      controlTrials: controlTrials,
      meanRepeats: num(bank.size) > 0 ? demand / num(bank.size) : 0,
      families: (bank.families || []).map(function (family) {
        var trials = Math.round(demand * num(family.pct) / 100);
        return {
          name: family.name,
          pct: num(family.pct),
          role: family.role,
          trials: trials,
          items: num(bank.maxRepeats) > 0 ? Math.ceil(trials / num(bank.maxRepeats)) : trials
        };
      })
    };
    if (bankSummary.headroom < 0) {
      warnings.push('Question bank supplies ' + fmtNumber(supply) + ' presentations but the design demands '
        + fmtNumber(demand) + '. Increase bank size or allowed repeats.');
    }

    /* --- assemble report ------------------------------------------------ */
    var aimReports = solved.map(function (entry) {
      return buildAimReport(entry, working, boot, pooled);
    });

    var dataGB = sum(aimReports, function (report) { return num(report.dataVolume.gbTotal); });
    var primaryQuestions = sum(aimReports, function (report) {
      return num(report.derived.primaryQuestions);
    });
    var controlTrialsTotal = sum(aimReports, function (report) {
      return num(report.derived.controlTrials);
    });
    var weeks = num(working.budget.sessionsPerWeek) > 0
      ? totalSessions / num(working.budget.sessionsPerWeek) : 0;

    var report = {
      meta: working.meta,
      generated: new Date().toISOString().slice(0, 16).replace('T', ' '),
      budget: {
        totalScannerHours: num(working.budget.totalScannerHours),
        contingencyPct: num(working.budget.contingencyPct),
        usableHours: round(usableHours, 3),
        solveMode: mode,
        sessionModel: working.budget.sessionModel,
        targetQuestionsTotal: num(working.budget.targetQuestionsTotal),
        allocationUnit: working.budget.allocationUnit || 'percent',
        sessionsPerWeek: num(working.budget.sessionsPerWeek),
        weeksAvailable: num(working.budget.weeksAvailable),
        countOverheadAgainstBudget: !!working.budget.countOverheadAgainstBudget
      },
      caps: working.caps,
      session: {
        screeningMinutes: num(working.session.screeningMinutes),
        positioningMinutes: num(working.session.positioningMinutes),
        practiceMinutes: num(working.session.practiceMinutes),
        breakMinutes: breakMinutes,
        setupMinutes: round(setupMinutes, 2),
        structuralMinutes: round(structural.minutes, 2),
        structurals: structural.rows,
        runsPerSession: runsPerSessionDisplay,
        sessionMeanMinutes: round(sessionMinutesMean, 2),
        sessionMinMinutes: round(sessionMinutesMin, 2),
        sessionMaxMinutes: round(sessionMinutesMax, 2),
        sessionsPlanned: totalSessions,
        timeline: timeline,
        timelines: timelines,
        perAimComposition: solved.map(function (entry) {
          return {
            id: entry.aim.id,
            short: entry.aim.short,
            name: entry.aim.name,
            custom: !!entry.session.custom,
            setupMinutes: round(entry.session.setupMinutes, 2),
            structuralMinutes: round(entry.session.structuralMinutes, 2),
            breakMinutes: round(entry.session.breakMinutes, 2)
          };
        })
      },
      questionBank: bankSummary,
      aims: aimReports,
      totals: {
        trials: totalTrials,
        primaryQuestions: primaryQuestions,
        controlTrials: controlTrialsTotal,
        byAim: aimReports.map(function (report) {
          return {
            id: report.id,
            short: report.short,
            name: report.name,
            objective: report.decode.objective,
            trials: report.derived.totalTrials,
            primaryQuestions: report.derived.primaryQuestions,
            controlTrials: report.derived.controlTrials,
            sessions: report.derived.sessions,
            runs: report.derived.totalRuns,
            hours: report.derived.totalHours,
            sharePct: report.derived.sharePct,
            targetQuestions: report.derived.targetQuestions,
            targetProgressPct: report.derived.targetProgressPct,
            questionsPerSession: report.derived.questionsPerSession,
            dataGB: report.dataVolume.gbTotal
          };
        }),
        targetQuestions: mode === 'target'
          ? sum(solved, function (entry) { return num(entry.aim.targetQuestions); })
          : num(working.budget.targetQuestionsTotal),
        questionGoal: num(working.budget.targetQuestionsTotal),
        sessions: totalSessions,
        hours: round(committedMinutes / 60, 3),
        functionalHours: round(functionalMinutesTotal / 60, 3),
        overheadHours: round(overheadMinutesTotal / 60, 3),
        hoursRemaining: round((usableMinutes - committedMinutes) / 60, 3),
        utilisationPct: usableMinutes > 0 ? round(committedMinutes / usableMinutes * 100, 1) : 0,
        dataGB: round(dataGB, 2),
        weeks: round(weeks, 1),
        runs: sum(solved, function (entry) { return entry.totalRuns; })
      },
      warnings: warnings,
      state: working
    };

    report.markdownTables = buildMarkdown(report);
    report.methodsText = buildMethods(report);
    return report;
  }

  /* Fill mode: spend the hour allocation, but stop once the study has bought
   * the number of questions asked for.  Sessions are scaled proportionally so
   * the per-aim split of scanner time is preserved as the plan shrinks. */
  function applyQuestionGoal(solved, goal, usableHours, warnings) {
    if (!(goal > 0) || !solved.length) return;
    var affordable = sum(solved, function (entry) {
      return entry.sessions * entry.questionsPerSession;
    });
    if (affordable <= goal + 0.5) {
      if (affordable < goal - 0.5) {
        warnings.push('Question goal of ' + fmtNumber(goal) + ' does not fit the budget: '
          + round(usableHours, 1) + ' usable hours buy about ' + fmtNumber(Math.round(affordable))
          + ' questions at the current allocation. The plan fills what the hours allow.');
      }
      return;
    }

    var scale = goal / affordable;
    var exact = solved.map(function (entry) { return entry.sessions * scale; });
    var scheduled = solved.map(function (entry) { return entry.sessions; });
    solved.forEach(function (entry, index) { entry.sessions = Math.floor(exact[index]); });

    /* Sessions are indivisible, so a small aim can round to nothing. Keeping it
     * alive at one session and overshooting the goal slightly beats dropping an
     * aim out of the study without saying so. */
    solved.forEach(function (entry, index) {
      if (entry.sessions === 0 && scheduled[index] > 0 && entry.questionsPerSession > 0) {
        entry.sessions = 1;
      }
    });

    var running = sum(solved, function (entry) {
      return entry.sessions * entry.questionsPerSession;
    });
    var order = exact.map(function (value, index) {
      return { index: index, frac: value - Math.floor(value) };
    }).sort(function (a, b) { return b.frac - a.frac; });
    order.forEach(function (record) {
      var entry = solved[record.index];
      if (entry.questionsPerSession <= 0) return;
      /* Sessions are indivisible, so take the extra one only while it lands
       * nearer the goal than stopping short of it does. */
      if (running + entry.questionsPerSession * 0.5 <= goal) {
        entry.sessions += 1;
        running += entry.questionsPerSession;
      }
    });

    solved.forEach(function (entry) {
      entry.totalRuns = entry.sessions * entry.runsPerSessionEffective;
    });
    warnings.push('Plan held at the ' + fmtNumber(goal) + ' question goal: '
      + fmtNumber(Math.round(running)) + ' questions across '
      + sum(solved, function (entry) { return entry.sessions; })
      + ' whole sessions, leaving the rest of the budget unspent.');
  }

  function clampSessions(solved, limit, warnings, reason) {
    var total = sum(solved, function (entry) { return entry.sessions; });
    if (total <= limit || total <= 0) return total;
    var scale = limit / total;
    var exact = solved.map(function (entry) { return entry.sessions * scale; });
    solved.forEach(function (entry, index) { entry.sessions = Math.floor(exact[index]); });
    var spare = limit - sum(solved, function (entry) { return entry.sessions; });
    var order = exact.map(function (value, index) {
      return { index: index, frac: value - Math.floor(value) };
    }).sort(function (a, b) { return b.frac - a.frac; });
    for (var i = 0; i < order.length && spare > 0; i += 1) {
      solved[order[i].index].sessions += 1;
      spare -= 1;
    }
    solved.forEach(function (entry) {
      entry.totalRuns = entry.sessions * entry.runsPerSessionEffective;
    });
    warnings.push('Total sessions reduced from ' + total + ' to '
      + sum(solved, function (entry) { return entry.sessions; }) + ' by ' + reason + '.');
    return sum(solved, function (entry) { return entry.sessions; });
  }

  /* Timelines are built per aim: in the dedicated model each aim runs its own
   * session, with its own setup block and its own runs, so a single
   * "representative" session was never representative of more than one of them. */
  function timelineBuilder() {
    var rows = [];
    var cumulative = 0;
    function push(item, protocol, protocolLabel, minutes, category) {
      var value = Math.max(0, num(minutes));
      cumulative += value;
      rows.push({
        order: rows.length + 1,
        item: item,
        protocol: protocol || '',
        protocolLabel: protocolLabel || '',
        minutes: round(value, 2),
        cumulative: round(cumulative, 2),
        category: category
      });
    }
    return {
      rows: rows,
      push: push,
      total: function () { return cumulative; }
    };
  }

  function pushSetup(builder, sessionCfg) {
    builder.push('MRI safety screening and consent check', '', '',
      sessionCfg.screeningMinutes, 'Non-acquisition');
    builder.push('Positioning, coil placement, stabilisation', '', '',
      sessionCfg.positioningMinutes, 'Non-acquisition');
    builder.push('Task refresher and cadence practice', '', '',
      sessionCfg.practiceMinutes, 'Non-acquisition');
    sessionCfg.structural.rows.forEach(function (row) {
      if (!row.enabled || row.count <= 0) return;
      builder.push(row.protocolLabel + (row.count > 1 ? ' x' + row.count : ''),
        row.protocol, row.protocolLabel, row.minutes, 'Structural / reference');
    });
  }

  function buildTimelines(solved, pooled, pooledRuns, sharedSession) {
    var out = [];

    if (pooled) {
      var builder = timelineBuilder();
      pushSetup(builder, sharedSession);
      var placed = 0;
      solved.forEach(function (entry) {
        var runs = Math.round(entry.runsPerSessionEffective);
        for (var i = 0; i < runs; i += 1) {
          if (placed > 0) builder.push('Break', '', '', sharedSession.breakMinutes, 'Break');
          builder.push(entry.aim.short + ' functional run ' + (i + 1),
            entry.aim.protocol, entry.ctx.label, entry.geometry.run.mean / 60, 'Functional');
          placed += 1;
        }
      });
      if (!placed && pooledRuns > 0 && solved.length) {
        builder.push(solved[0].aim.short + ' functional run 1', solved[0].aim.protocol,
          solved[0].ctx.label, solved[0].geometry.run.mean / 60, 'Functional');
        placed = 1;
      }
      out.push({
        id: 'pooled',
        short: 'Pooled',
        name: 'Pooled session (runs from every aim)',
        custom: false,
        pooled: true,
        primary: true,
        rows: builder.rows,
        runsPerSession: placed,
        setupMinutes: round(sharedSession.setupMinutes, 2),
        breakMinutes: round(sharedSession.breakMinutes, 2),
        sessions: solved.length ? solved[0].sessions : 0,
        meanMinutes: round(builder.total(), 2),
        minMinutes: round(builder.total(), 2),
        maxMinutes: round(builder.total(), 2)
      });
      return out;
    }

    var lead = solved.slice().sort(function (a, b) { return b.sessions - a.sessions; })[0];
    solved.forEach(function (entry) {
      var cfg = entry.session;
      var builder = timelineBuilder();
      pushSetup(builder, cfg);
      var runs = Math.max(0, Math.round(entry.runsPerSessionEffective));
      for (var r = 0; r < runs; r += 1) {
        if (r > 0) builder.push('Break', '', '', cfg.breakMinutes, 'Break');
        builder.push(entry.aim.short + ' functional run ' + (r + 1), entry.aim.protocol,
          entry.ctx.label, entry.geometry.run.mean / 60, 'Functional');
      }
      var fixed = cfg.setupMinutes + Math.max(0, runs - 1) * cfg.breakMinutes;
      out.push({
        id: entry.aim.id,
        short: entry.aim.short,
        name: entry.aim.name,
        custom: !!cfg.custom,
        pooled: false,
        primary: lead === entry,
        rows: builder.rows,
        runsPerSession: runs,
        setupMinutes: round(cfg.setupMinutes, 2),
        structuralMinutes: round(cfg.structuralMinutes, 2),
        breakMinutes: round(cfg.breakMinutes, 2),
        structurals: cfg.structural.rows,
        sessions: entry.sessions,
        trialsPerSession: Math.round(runs * entry.geometry.trialsPerRun),
        meanMinutes: round(builder.total(), 2),
        minMinutes: round(fixed + runs * entry.geometry.run.min / 60, 2),
        maxMinutes: round(fixed + runs * entry.geometry.run.max / 60, 2)
      });
    });
    return out;
  }

  function buildAimReport(entry, state, boot, pooled) {
    var aim = entry.aim;
    var setupMinutes = entry.session.setupMinutes;
    var breakMinutes = entry.session.breakMinutes;
    var bankConfig = state.questionBank || {};
    var controlPct = clamp(num(bankConfig.controlPct), 0, 100);
    var yesPct = clamp(num(bankConfig.yesPct, 50), 0, 100);
    var controlTrials = Math.round(entry.trials * controlPct / 100);
    var primaryTrials = Math.max(0, entry.trials - controlTrials);
    var geometry = entry.geometry;
    var ctx = entry.ctx;
    var runs = entry.runsPerSessionEffective;
    var sessions = entry.sessions;

    var dynSource = state.dynScansFrom === 'mean' ? geometry.functional.mean : geometry.functional.max;
    var volumesPerRun = ctx.trSeconds > 0 ? Math.ceil(dynSource / ctx.trSeconds) : 0;

    var voxelBytes = 2;
    var matrix = ctx.matrix || 0;
    var slices = ctx.slices || 0;
    var bytesPerVolume = matrix * matrix * slices * voxelBytes;
    var mbPerRun = bytesPerVolume * volumesPerRun / (1024 * 1024);
    var gbPerSession = mbPerRun * runs / 1024;
    var gbTotal = mbPerRun * entry.totalRuns / 1024;

    var decode = aim.decode || { objective: 'estimation', labelOrder: 'intermixed', labelRunLength: 1 };
    var blockWording;
    if (decode.labelOrder === 'blocked') {
      var runLength = Math.max(1, Math.round(num(decode.labelRunLength, 1)));
      blockWording = geometry.trialsPerBlock + ' trials in same-label runs of ' + runLength
        + ' (yes and no blocks alternate, no baseline recovery between them)';
    } else if (decode.labelOrder === 'alternating') {
      blockWording = geometry.trialsPerBlock + ' strictly alternating yes/no trials';
    } else {
      blockWording = geometry.trialsPerBlock + ' intermixed, label-balanced trials';
    }

    var sequence = {
      trial: aim.phases.map(phaseLabel).join(' -> '),
      block: blockWording
        + (geometry.interTrialGap > 0 ? ' with ' + round(geometry.interTrialGap, 1) + 's inter-trial gap' : ''),
      run: geometry.dummyVolumes + ' dummies (' + round(geometry.dummySeconds, 1) + 's) + '
        + round(geometry.leadIn, 0) + 's lead-in + ' + geometry.blocksPerRun + ' block'
        + (geometry.blocksPerRun === 1 ? '' : 's')
        + (geometry.interBlockRest > 0 ? ' (' + round(geometry.interBlockRest, 0) + 's inter-block rest)' : '')
        + ' + ' + round(geometry.leadOut, 0) + 's lead-out',
      session: 'Setup/T1 (' + round(setupMinutes, 0) + ' min) + ' + round(runs, 2) + ' run'
        + (Math.abs(runs - 1) < 0.01 ? '' : 's') + ' (with ' + round(breakMinutes, 0) + ' min breaks)',
      experiment: sessions + ' session' + (sessions === 1 ? '' : 's')
        + ' over ' + round(state.budget.weeksAvailable, 0) + ' weeks'
    };

    var sessionMean = setupMinutes + runs * geometry.run.mean / 60 + Math.max(0, runs - 1) * breakMinutes;
    var sessionMin = setupMinutes + runs * geometry.run.min / 60 + Math.max(0, runs - 1) * breakMinutes;
    var sessionMax = setupMinutes + runs * geometry.run.max / 60 + Math.max(0, runs - 1) * breakMinutes;

    var table = [
      {
        level: 'Trial', sequence: sequence.trial, trials: 1,
        duration: fmtRange(geometry.trial.min, geometry.trial.max)
      },
      {
        level: 'Block', sequence: sequence.block, trials: geometry.trialsPerBlock,
        duration: fmtRange(geometry.block.min, geometry.block.max)
      },
      {
        level: 'Run', sequence: sequence.run, trials: geometry.trialsPerRun,
        duration: fmtRange(geometry.run.min, geometry.run.max)
      },
      {
        level: 'Session', sequence: sequence.session,
        trials: Math.round(runs * geometry.trialsPerRun),
        duration: round(sessionMin, 1) + ' - ' + round(sessionMax, 1) + ' min'
      },
      {
        level: 'Experiment', sequence: sequence.experiment, trials: entry.trials,
        duration: sessions > 0
          ? round(entry.totalMinutes / 60, 1) + ' h total'
          : 'Not scheduled'
      }
    ];

    var efficiency = global.PlannerEfficiency
      ? global.PlannerEfficiency.evaluate(aim, ctx.trSeconds, geometry)
      : {};
    if (global.PlannerEfficiency && efficiency) {
      efficiency.objectiveScore = global.PlannerEfficiency.objectiveScore(
        decode.objective, efficiency, geometry.run.mean / 60,
        entry.totalMinutes > 0 ? entry.trials / (entry.totalMinutes / 60) : 0
      );
    }

    return {
      id: aim.id,
      name: aim.name,
      short: aim.short,
      enabled: true,
      protocol: aim.protocol,
      protocolLabel: ctx.label,
      trMs: ctx.trMs,
      teMs: ctx.teMs,
      requestedPct: num(aim.requestedPct),
      decode: decode,
      phases: aim.phases,
      structure: {
        trialsPerBlock: geometry.trialsPerBlock,
        interTrialGap: geometry.interTrialGap,
        blocksPerRun: geometry.blocksPerRun,
        interBlockRest: geometry.interBlockRest,
        dummyVolumes: geometry.dummyVolumes,
        leadIn: geometry.leadIn,
        leadOut: geometry.leadOut,
        runsPerSession: runs
      },
      derived: {
        trialMin: round(geometry.trial.min, 2),
        trialMax: round(geometry.trial.max, 2),
        trialMean: round(geometry.trial.mean, 2),
        blockMin: round(geometry.block.min, 2),
        blockMax: round(geometry.block.max, 2),
        blockMean: round(geometry.block.mean, 2),
        runMin: round(geometry.run.min, 2),
        runMax: round(geometry.run.max, 2),
        runMean: round(geometry.run.mean, 2),
        dummySeconds: round(geometry.dummySeconds, 2),
        trialsPerRun: geometry.trialsPerRun,
        trialsPerSession: Math.round(runs * geometry.trialsPerRun),
        volumesPerRun: volumesPerRun,
        sessionMeanMinutes: round(sessionMean, 2),
        sessionMinMinutes: round(sessionMin, 2),
        sessionMaxMinutes: round(sessionMax, 2),
        sessions: sessions,
        totalRuns: entry.totalRuns,
        totalTrials: entry.trials,
        functionalHours: round(entry.functionalMinutes / 60, 3),
        overheadHours: round(entry.overheadMinutes / 60, 3),
        totalHours: round(entry.totalMinutes / 60, 3),
        sharePct: round(entry.sharePct, 2),
        trialsPerHour: entry.totalMinutes > 0 ? round(entry.trials / (entry.totalMinutes / 60), 1) : 0,
        secondsPerTrial: entry.trials > 0 ? round(entry.totalMinutes * 60 / entry.trials, 1) : 0,
        primaryQuestions: primaryTrials,
        controlTrials: controlTrials,
        yesTrials: Math.round(primaryTrials * yesPct / 100),
        noTrials: primaryTrials - Math.round(primaryTrials * yesPct / 100),
        questionsPerSession: sessions > 0 ? Math.round(primaryTrials / sessions) : 0,
        questionsPerHour: entry.totalMinutes > 0
          ? round(primaryTrials / (entry.totalMinutes / 60), 1) : 0,
        targetQuestions: num(aim.targetQuestions),
        targetProgressPct: num(aim.targetQuestions) > 0
          ? round(primaryTrials / num(aim.targetQuestions) * 100, 1) : 0,
        sessionCustom: !!entry.session.custom,
        sessionSetupMinutes: round(setupMinutes, 2),
        sessionBreakMinutes: round(breakMinutes, 2)
      },
      dataVolume: {
        matrix: matrix ? matrix + ' x ' + matrix : '',
        slices: slices,
        voxel: ctx.voxel,
        volumesPerRun: volumesPerRun,
        mbPerRun: round(mbPerRun, 1),
        gbPerSession: round(gbPerSession, 3),
        gbTotal: round(gbTotal, 3)
      },
      acquisition: {
        trMs: ctx.trMs, teMs: ctx.teMs, voxel: ctx.voxel, slices: slices,
        mbFactor: ctx.mbFactor, senseP: ctx.senseP, flip: ctx.flip,
        dynScansCurrent: ctx.dynScans, dynScansSolved: volumesPerRun,
        dummyScansSolved: geometry.dummyVolumes,
        durationSolved: fmtClock(geometry.run.max)
      },
      table: table,
      efficiency: efficiency
    };
  }

  /* ------------------------------------------------------------ markdown */

  function mdTable(headers, rows, aligns) {
    var lines = [];
    lines.push('| ' + headers.join(' | ') + ' |');
    lines.push('| ' + headers.map(function (_, index) {
      var mode = aligns && aligns[index];
      if (mode === 'right') return '---:';
      if (mode === 'center') return ':---:';
      return ':---';
    }).join(' | ') + ' |');
    rows.forEach(function (row) {
      lines.push('| ' + row.map(function (cell) {
        return String(cell === undefined || cell === null ? '' : cell).replace(/\|/g, '\\|');
      }).join(' | ') + ' |');
    });
    return lines.join('\n');
  }

  function buildMarkdown(report) {
    var out = {};
    report.aims.forEach(function (aim) {
      out[aim.name] = mdTable(
        ['Level', 'Sequence', 'Trials', 'Approx duration'],
        aim.table.map(function (row) {
          return [row.level, row.sequence, fmtNumber(row.trials), row.duration];
        })
      );
    });

    out['Questions recorded by modality'] = mdTable(
      ['Modality', 'Objective', 'Questions recorded', 'Question goal', 'Control trials',
        'Total trials', 'Questions / session', 'Sessions', 'Hours', 'Share %'],
      report.totals.byAim.map(function (aim) {
        return [
          aim.name, aim.objective, fmtNumber(aim.primaryQuestions),
          aim.targetQuestions > 0 ? fmtNumber(aim.targetQuestions) : '-',
          fmtNumber(aim.controlTrials),
          fmtNumber(aim.trials), fmtNumber(aim.questionsPerSession), aim.sessions,
          round(aim.hours, 1), round(aim.sharePct, 1)
        ];
      }).concat([[
        '**Total**', '', fmtNumber(report.totals.primaryQuestions),
        report.totals.targetQuestions > 0 ? fmtNumber(report.totals.targetQuestions) : '-',
        fmtNumber(report.totals.controlTrials), fmtNumber(report.totals.trials), '',
        report.totals.sessions, round(report.totals.hours, 1), 100
      ]])
    );

    out['Budget and allocation'] = mdTable(
      ['Aim', 'Protocol', 'Requested %', 'Realised %', 'Sessions', 'Runs', 'Trials',
        'Questions', 'Hours'],
      report.aims.map(function (aim) {
        return [
          aim.name, aim.protocolLabel, round(aim.requestedPct, 1),
          round(aim.derived.sharePct, 1), aim.derived.sessions, aim.derived.totalRuns,
          fmtNumber(aim.derived.totalTrials), fmtNumber(aim.derived.primaryQuestions),
          round(aim.derived.totalHours, 2)
        ];
      }).concat([[
        '**Total**', '', 100, 100, report.totals.sessions, report.totals.runs,
        fmtNumber(report.totals.trials), fmtNumber(report.totals.primaryQuestions),
        round(report.totals.hours, 2)
      ]])
    );

    function timelineTable(rows) {
      return mdTable(
        ['#', 'Series', 'Protocol', 'Minutes', 'Cumulative'],
        rows.map(function (row) {
          return [row.order, row.item, row.protocolLabel || '-',
            round(row.minutes, 2), round(row.cumulative, 2)];
        })
      );
    }
    out['Session timeline'] = timelineTable(report.session.timeline);
    (report.session.timelines || []).forEach(function (record) {
      out['Session timeline - ' + record.short] = '**' + record.name + '** - '
        + record.runsPerSession + ' run' + (record.runsPerSession === 1 ? '' : 's')
        + ', ' + round(record.meanMinutes, 1) + ' min'
        + (record.custom ? ' (custom session composition)' : '') + '\n\n'
        + timelineTable(record.rows);
    });

    out['Trial phases'] = report.aims.map(function (aim) {
      return '**' + aim.name + '**\n\n' + mdTable(
        ['#', 'Phase', 'Min (s)', 'Max (s)', 'Expected (s)', 'Role'],
        aim.phases.map(function (phase, index) {
          return [index + 1, phase.name, round(num(phase.min), 2), round(num(phase.max), 2),
            round((num(phase.min) + num(phase.max)) / 2, 2), phase.role || 'other'];
        })
      );
    }).join('\n\n');

    out['Scanner settings'] = mdTable(
      ['Aim', 'Protocol card', 'TR (ms)', 'TE (ms)', 'Voxel (mm)', 'Slices', 'MB', 'SENSE', 'Flip', 'Dynamics'],
      report.aims.map(function (aim) {
        return [aim.name, aim.protocol, aim.acquisition.trMs, aim.acquisition.teMs,
          aim.acquisition.voxel, aim.acquisition.slices, aim.acquisition.mbFactor,
          aim.acquisition.senseP, aim.acquisition.flip, aim.acquisition.dynScansSolved];
      })
    );

    out['Efficiency'] = mdTable(
      ['Aim', 'Objective', 'Label order', 'Volumes', 'Duty cycle %', 'Stacking gain',
        'Single-trial eff.', 'Carryover %', 'Prompt bleed %', 'Eff. answer vs baseline',
        'Eff. yes vs no', 'r(question, answer)', 'Max VIF'],
      report.aims.map(function (aim) {
        var eff = aim.efficiency || {};
        return [aim.name, aim.decode.objective, aim.decode.labelOrder, eff.volumes || 0,
          round(num(eff.sustainPct), 1), round(num(eff.saturationIndex), 2),
          round(num(eff.singleTrialEff), 3),
          round(num(eff.carryoverPct), 1), round(num(eff.promptBleedPct), 1),
          round(num(eff.effAnswerVsBaseline), 2), round(num(eff.effYesVsNo), 2),
          round(num(eff.corrQuestionAnswer), 3), round(num(eff.maxVif), 2)];
      })
    );

    return out;
  }

  function allMarkdown(report) {
    var blocks = ['# ' + (report.meta.studyTitle || 'fMRI Experimental Design'),
      '', 'Generated ' + report.generated + ' | ' + (report.meta.institution || ''), ''];
    Object.keys(report.markdownTables).forEach(function (key) {
      blocks.push('## ' + key, '', report.markdownTables[key], '');
    });
    if (report.warnings.length) {
      blocks.push('## Constraint report', '');
      report.warnings.forEach(function (text, index) {
        blocks.push((index + 1) + '. ' + text);
      });
      blocks.push('');
    }
    return blocks.join('\n');
  }

  /* ------------------------------------------------------------- psychopy */

  /* PsychoPy task configuration.  The window, text, key map and instruction
   * wording come from the lab's experiment.yaml template and are passed
   * through unchanged; the planner fills in the parts the design actually
   * decides - the scanner block, the run geometry, the trial phase list and
   * the per-run condition counts - so the file that ships with an aim always
   * matches the plan that was costed. */

  /* Template blocks the design has no say in.  Held verbatim so that a diff
   * against the lab's own experiment.yaml stays empty here. */
  var PSYCHOPY_PRESENTATION = [
    'paths:',
    '  data_dir: data                 # the common JSON database lives here',
    '  bank: questions/bank.json',
    '  images_dir: questions/images',
    '',
    'window:',
    '  size: [1280, 800]',
    '  fullscreen: true',
    '  screen: 0',
    '  color: [-1, -1, -1]            # PsychoPy rgb, -1..1  (black)',
    '  units: height',
    '  mouse_visible: false',
    '',
    'text:',
    '  font: Arial',
    '  height: 0.06',
    '  wrap_width: 1.3',
    '  color: [1, 1, 1]',
    '  title_pos: [0, 0.30]           # where views that also show graphics put the text',
    '',
    'fixation:',
    '  text: "+"',
    '  height: 0.08',
    '  color: [1, 1, 1]',
    '',
    'cue:',
    '  height: 0.12',
    '  color: [1, 1, 1]'
  ];

  var PSYCHOPY_KEYS = [
    'keys:',
    '  quit: ["escape"]',
    '  advance: ["space"]'
  ];

  /* What the screen shows during a phase, by the phase's planner role. */
  var PSYCHOPY_SHOW = {
    fixation: 'fixation',
    question: 'question',
    rest: 'blank',
    answer: 'cue',
    cue: 'cue',
    other: 'blank'
  };

  /* The template's four control conditions.  They share whatever slice of the
   * run the question bank withholds from the primary condition. */
  var PSYCHOPY_CONTROLS = [
    { key: 'passive_read', cue: '○', showQuestion: true, response: 'none' },
    { key: 'cue_only', cue: '◆', showQuestion: false, response: 'answer', cueFromResponse: true },
    { key: 'constant_word', cue: '▲', showQuestion: true, response: 'ready' },
    { key: 'opposite', cue: '✖', showQuestion: true, response: 'opposite' }
  ];

  /* The template lines its comments up 31 characters past the indent. */
  var PSYCHOPY_COMMENT_COLUMN = 31;

  function padRight(text, width) {
    var out = String(text);
    while (out.length < width) out += ' ';
    return out;
  }

  function yamlSlug(text) {
    var slug = String(text === undefined || text === null ? '' : text)
      .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return slug || 'phase';
  }

  /* Anything interpolated into a comment has to stay on that one line. */
  function yamlComment(text) {
    return String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim();
  }

  /* Durations keep a decimal point so the YAML stays float-typed. */
  function yamlSeconds(value) {
    var rounded = round(num(value), 2);
    return Math.abs(rounded - Math.round(rounded)) < 0.005
      ? Math.round(rounded).toFixed(1) : String(rounded);
  }

  /* A `key: value` line with its comment in the template's column. */
  function yamlSetting(key, value, comment) {
    return '  ' + padRight(key + ': ' + value, PSYCHOPY_COMMENT_COLUMN) + '# ' + comment;
  }

  /* Repeated phase names are the norm - most designs open and close on
   * fixation - so make them unique the way the template does: _pre and _post
   * for a pair, numbered beyond that. */
  function psychopyPhaseNames(phases) {
    var counts = {};
    var bases = (phases || []).map(function (phase) {
      var base = yamlSlug(phase.name);
      counts[base] = (counts[base] || 0) + 1;
      return base;
    });
    var seen = {};
    return bases.map(function (base) {
      if (counts[base] < 2) return base;
      seen[base] = (seen[base] || 0) + 1;
      if (counts[base] === 2) return base + (seen[base] === 1 ? '_pre' : '_post');
      return base + '_' + seen[base];
    });
  }

  /* Split one run between the primary condition and the control conditions so
   * that per_run still sums to n_blocks * trials_per_block. */
  function psychopyConditions(trialsPerRun, controlPct) {
    var total = Math.max(0, Math.round(num(trialsPerRun)));
    var control = Math.min(total, Math.round(total * clamp(num(controlPct), 0, 100) / 100));
    var each = Math.floor(control / PSYCHOPY_CONTROLS.length);
    var extra = control - each * PSYCHOPY_CONTROLS.length;
    return {
      primary: total - control,
      rows: PSYCHOPY_CONTROLS.map(function (spec, index) {
        return { spec: spec, perRun: each + (index < extra ? 1 : 0) };
      })
    };
  }

  function psychopyFileName(aimReport) {
    return 'experiment-' + yamlSlug(aimReport.short || aimReport.id).replace(/_/g, '-') + '.yaml';
  }

  function psychopyYaml(report, aimReport) {
    var structure = aimReport.structure || {};
    var derived = aimReport.derived || {};
    var decode = aimReport.decode || {};
    var bank = report.questionBank || {};
    var blocksPerRun = Math.max(1, Math.round(num(structure.blocksPerRun, 1)));
    var trialsPerBlock = Math.max(1, Math.round(num(structure.trialsPerBlock, 1)));
    var trialsPerRun = blocksPerRun * trialsPerBlock;
    var runsPerSession = round(num(structure.runsPerSession), 2);
    var dummyVolumes = Math.max(0, Math.round(num(structure.dummyVolumes)));
    var yesPct = round(clamp(num(bank.yesPct, 50), 0, 100), 1);
    var controlPct = round(clamp(num(bank.controlPct), 0, 100), 1);
    var conditions = psychopyConditions(trialsPerRun, controlPct);
    var phases = aimReport.phases || [];
    var names = psychopyPhaseNames(phases);
    var answerPhase = phases.filter(function (phase) { return phase.role === 'answer'; })[0];
    var answerWindow = answerPhase ? trim(num(answerPhase.min), 1) + '-second' : 'answer';
    var lines = [];

    lines.push('# PsychoPy task configuration - generated by the fMRI Experimental Design Planner.');
    lines.push('# Study:     ' + yamlComment(report.meta.studyTitle));
    lines.push('# Aim:       ' + yamlComment(aimReport.name)
      + ' (' + yamlComment(decode.objective) + ')');
    lines.push('# Protocol:  ' + yamlComment(aimReport.protocol)
      + ', TR ' + round(num(aimReport.trMs), 1) + ' ms');
    lines.push('# Generated: ' + report.generated);
    lines.push('#');
    lines.push('# One run of this file is ' + trialsPerRun + ' trials, '
      + fmtRange(derived.runMin, derived.runMax) + '.');
    lines.push('# The plan calls for ' + runsPerSession + ' run'
      + (Math.abs(runsPerSession - 1) < 0.01 ? '' : 's') + ' per session across '
      + fmtNumber(derived.sessions) + ' session' + (derived.sessions === 1 ? '' : 's')
      + ', ' + fmtNumber(derived.totalTrials) + ' trials in total.');
    lines.push('# The scanner, run, trial and conditions blocks are filled in from the solved');
    lines.push('# design. Everything else is the lab template, unchanged.');
    lines.push('');
    lines.push('experiment: inner_speech_v2_' + yamlSlug(aimReport.id));
    lines.push('');
    lines = lines.concat(PSYCHOPY_PRESENTATION);

    lines.push('');
    lines.push('scanner:');
    lines.push(yamlSetting('tr', yamlSeconds(num(aimReport.trMs) / 1000),
      yamlComment(aimReport.protocol)));
    lines.push('  trigger_key: "5"');
    lines.push(yamlSetting('wait_for_triggers', dummyVolumes,
      'dummy volumes; t=0 is the LAST of these pulses'));
    lines.push('  log_triggers: true             # every pulse is written to the database');

    lines.push('');
    lines.push('run:');
    lines.push('  lead_in: ' + yamlSeconds(structure.leadIn));
    lines.push('  lead_out: ' + yamlSeconds(structure.leadOut));
    lines.push('  n_blocks: ' + blocksPerRun);
    lines.push(yamlSetting('trials_per_block', trialsPerBlock, '-> ' + trialsPerRun + ' trials/run'));
    lines.push(yamlSetting('inter_block_rest', yamlSeconds(structure.interBlockRest),
      'rest between blocks, inside the run'));
    lines.push(yamlSetting('inter_trial_gap', yamlSeconds(structure.interTrialGap),
      'dead time between successive trials'));
    lines.push(yamlSetting('label_order', decode.labelOrder || 'intermixed',
      'how yes and no answers are sequenced'));
    lines.push(yamlSetting('label_run_length', Math.max(1, Math.round(num(decode.labelRunLength, 1))),
      'same-label run length (blocked ordering only)'));
    lines.push(yamlSetting('label_balance_pct', yesPct,
      'share of primary trials whose answer is yes'));

    lines.push('');
    lines.push('trial:');
    lines.push('  round_jitter_to_tr: true');
    lines.push('  phases:');
    var nameWidth = 0;
    names.forEach(function (name) { nameWidth = Math.max(nameWidth, name.length + 2); });
    phases.forEach(function (phase, index) {
      var lo = Math.max(0, num(phase.min));
      var hi = Math.max(lo, num(phase.max));
      var jittered = hi - lo > 0.001;
      lines.push('    - {name: ' + padRight(names[index] + ',', nameWidth)
        + 'show: ' + padRight((PSYCHOPY_SHOW[phase.role] || 'blank') + ',', 10)
        + 'dur: ' + (jittered ? '[' + yamlSeconds(lo) + ', ' + yamlSeconds(hi) + ']' : yamlSeconds(lo))
        + (jittered ? ', jitter: ' + (phase.jitter ? 'exponential' : 'uniform') : '')
        + '}');
    });

    lines.push('');
    lines.push('# Trial conditions. `per_run` must sum to n_blocks * trials_per_block ('
      + trialsPerRun + ').');
    lines.push('# The control share is the question bank\'s embedded control-trial share ('
      + controlPct + '%),');
    lines.push('# split as evenly as the count allows across the four control conditions.');
    lines.push('# response = the token the participant actually repeats during the answer window.');
    lines.push('#   answer   -> the true answer          none  -> stay silent');
    lines.push('#   opposite -> the inverted answer      ready -> the constant word "ready"');
    lines.push('# cue_from_response: the cue displays the token itself (used for cue-only trials).');
    lines.push('conditions:');
    var keyWidth = 'primary:'.length;
    var countWidth = String(conditions.primary).length;
    conditions.rows.forEach(function (row) {
      keyWidth = Math.max(keyWidth, row.spec.key.length + 1);
      countWidth = Math.max(countWidth, String(row.perRun).length);
    });

    function conditionLine(key, perRun, spec) {
      return '  ' + padRight(key + ':', keyWidth + 1)
        + '{per_run: ' + padRight(perRun + ',', countWidth + 1)
        + ' cue: "' + spec.cue + '", show_question: ' + padRight(spec.showQuestion + ',', 6)
        + ' response: ' + spec.response
        + (spec.cueFromResponse ? ', cue_from_response: true' : '') + '}';
    }

    lines.push(conditionLine('primary', conditions.primary,
      { cue: '●', showQuestion: true, response: 'answer' }));
    conditions.rows.forEach(function (row) {
      lines.push(conditionLine(row.spec.key, row.perRun, row.spec));
    });

    lines.push('');
    lines = lines.concat(PSYCHOPY_KEYS);

    lines.push('');
    lines.push('instructions: |');
    lines.push('  When the answer cue appears, silently repeat the correct answer - yes or no -');
    lines.push('  throughout the entire ' + answerWindow + ' window at a steady, comfortable cadence.');
    lines.push('');
    lines.push('  Keep your jaw, tongue, and lips still.');
    lines.push('  When the cue disappears, stop repeating the word and return to fixation.');
    lines.push('');
    lines.push('  Press SPACE when you are ready.');
    lines.push('');

    return lines.join('\n');
  }

  /* -------------------------------------------------------------- methods */

  function buildMethods(report) {
    var totals = report.totals;
    var session = report.session;
    var parts = [];

    var participant = 'One healthy adult participant, age 18-60, a native English speaker with no MRI '
      + 'contraindications, will be recruited from the ' + (report.meta.institution || 'university')
      + ' neuroscience community. The study is an intensive within-participant feasibility design rather '
      + 'than a population estimate.';
    parts.push(participant);

    var scheduleText = 'The participant will complete ' + fmtNumber(totals.sessions)
      + ' scanning session' + (totals.sessions === 1 ? '' : 's') + ' of approximately '
      + round(session.sessionMeanMinutes, 0) + ' minutes (range '
      + round(session.sessionMinMinutes, 0) + ' to ' + round(session.sessionMaxMinutes, 0)
      + ' minutes), scheduled at up to ' + report.budget.sessionsPerWeek
      + ' sessions per week across approximately ' + totals.weeks
      + ' weeks, yielding ' + fmtNumber(totals.trials) + ' trials and '
      + round(totals.hours, 1) + ' hours of scanner time against a '
      + round(report.budget.totalScannerHours, 1) + ' hour budget ('
      + report.budget.contingencyPct + ' percent held in contingency). Each session begins with '
      + 'safety screening, positioning and a cadence refresher, followed by '
      + session.structurals.filter(function (row) { return row.enabled; })
        .map(function (row) { return row.protocolLabel; }).join(', ')
      + ', and ' + round(session.runsPerSession, 2) + ' functional runs separated by '
      + round(session.breakMinutes, 0) + ' minute breaks.';
    var customSessions = (session.perAimComposition || []).filter(function (record) {
      return record.custom;
    });
    if (customSessions.length) {
      scheduleText += ' ' + customSessions.map(function (record) {
        return record.name + ' runs its own session composition ('
          + round(record.setupMinutes, 0) + ' min setup including '
          + round(record.structuralMinutes, 0) + ' min of structural and reference series, '
          + round(record.breakMinutes, 0) + ' min breaks)';
      }).join('; ') + '.';
    }
    parts.push(scheduleText);

    var OBJECTIVE_SENTENCE = {
      detection: 'Trials are ordered in same-label runs so that successive covert answers of the same '
        + 'identity summate rather than returning to baseline, which maximises the sustained '
        + 'univariate contrast this aim depends on.',
      estimation: 'Trials are intermixed and label-balanced with sufficient separation for individual '
        + 'trial betas to be estimated independently, which is the input linear MVPA is trained on.',
      separation: 'Trials are intermixed and spaced so that the prompt response and the previous '
        + 'trial have both returned to baseline before the next answer window, giving event-aligned '
        + 'clips whose temporal structure is attributable to the covert answer itself.'
    };

    report.aims.forEach(function (aim) {
      var geometry = aim.derived;
      var text = aim.name + ' uses the ' + aim.protocolLabel + ' protocol (TR '
        + aim.acquisition.trMs + ' ms, TE ' + aim.acquisition.teMs + ' ms, '
        + aim.acquisition.voxel + ' mm voxels, ' + aim.acquisition.slices + ' slices, multiband '
        + aim.acquisition.mbFactor + ', in-plane acceleration ' + aim.acquisition.senseP
        + ', flip angle ' + aim.acquisition.flip + ' degrees). Each trial comprises '
        + aim.phases.map(phaseLabel).join(', then ') + ', giving a trial length of '
        + geometry.trialMin + ' to ' + geometry.trialMax + ' seconds. '
        + aim.structure.trialsPerBlock + ' intermixed, label-balanced trials form a block; '
        + aim.structure.blocksPerRun + ' block'
        + (aim.structure.blocksPerRun === 1 ? '' : 's') + ' plus '
        + aim.structure.dummyVolumes + ' dummy volumes ('
        + geometry.dummySeconds + ' s), a ' + aim.structure.leadIn + ' s lead-in and a '
        + aim.structure.leadOut + ' s lead-out form a run of '
        + round(geometry.runMin / 60, 1) + ' to ' + round(geometry.runMax / 60, 1)
        + ' minutes containing ' + geometry.trialsPerRun + ' trials ('
        + geometry.volumesPerRun + ' dynamics). The aim receives '
        + round(aim.derived.sharePct, 1) + ' percent of functional scanner time ('
        + round(aim.derived.functionalHours, 1) + ' hours) across '
        + geometry.sessions + ' session' + (geometry.sessions === 1 ? '' : 's')
        + ', for ' + fmtNumber(geometry.totalTrials) + ' trials ('
        + fmtNumber(geometry.primaryQuestions) + ' prompted questions and '
        + fmtNumber(geometry.controlTrials) + ' embedded control trials, about '
        + fmtNumber(geometry.questionsPerSession) + ' questions per session).';
      var eff = aim.efficiency || {};
      text += ' ' + (OBJECTIVE_SENTENCE[aim.decode.objective] || '')
        + ' Under this timing the simulated run holds a predicted-signal duty cycle of '
        + round(num(eff.sustainPct), 0) + ' percent, a question-answer regressor correlation of '
        + round(num(eff.corrQuestionAnswer), 2) + ', a residual carryover of '
        + round(num(eff.carryoverPct), 1) + ' percent of a single-event peak at the next prompt onset, '
        + 'and a prompt-response bleed of ' + round(num(eff.promptBleedPct), 1)
        + ' percent into the answer window.';
      parts.push(text);
    });

    var bank = report.questionBank;
    parts.push('The question bank contains ' + fmtNumber(bank.size)
      + ' prevalidated items presented at most ' + bank.maxRepeats
      + ' times each (' + fmtNumber(bank.supply) + ' available presentations against '
      + fmtNumber(bank.demand) + ' scheduled trials, mean ' + round(bank.meanRepeats, 2)
      + ' presentations per item). Labels are balanced at ' + bank.yesPct
      + ' percent yes within every run, and ' + bank.controlPct + ' percent of trials ('
      + fmtNumber(bank.controlTrials) + ') are embedded control conditions. Items are drawn from '
      + bank.families.length + ' question families; paraphrases and close variants are assigned to the '
      + 'same cross-validation fold.');

    parts.push('Trial order is randomised subject to label balance within run, question family and '
      + 'trial-position bin. Question and answer events carry independently jittered onsets so that '
      + 'prompt-locked and response-locked BOLD components can be estimated separately; the design '
      + 'matrix used for planning yields a question-answer regressor correlation of '
      + report.aims.map(function (aim) {
        return round(num((aim.efficiency || {}).corrQuestionAnswer), 2) + ' for ' + aim.short;
      }).join(', ') + '.');

    parts.push('Estimated reconstructed data volume is ' + round(totals.dataGB, 1)
      + ' GB of int16 magnitude images before derivatives. Acquisition parameters are frozen at the '
      + 'values recorded in the accompanying protocol cards; any hardware or software change will be '
      + 'documented as a session-level covariate.');

    return parts.join('\n\n');
  }

  /* ------------------------------------------------------------ optimiser */

  function aimObjective(aim) {
    return (aim.decode && aim.decode.objective) || 'estimation';
  }

  function optimiseStructure(state, boot, aimId, objective) {
    var draft = deepCopy(state);
    var aim = draft.aims[aimId];
    if (!aim) return state;
    if (!objective || objective === 'auto') objective = aimObjective(aim);

    var ctx = protocolContext(boot, aim.protocol);
    var caps = draft.caps;
    var basis = caps.applyTo === 'longest' ? 'max' : 'mean';
    var best = null;

    var sessionCfg = sessionConfigFor(draft, boot,
      draft.budget.sessionModel === 'pooled' ? null : aimId);
    var setupMinutes = sessionCfg.setupMinutes;
    var breakMinutes = sessionCfg.breakMinutes;
    var maxRuns = Math.max(1, Math.round(num(caps.maxRunsPerSession, 8)));

    /* Efficiency only depends on what happens inside a run, so memoise it on
     * the within-run geometry and reuse it across runs-per-session candidates. */
    var cache = {};
    function metricsFor(probe, geometry) {
      var key = geometry.trialsPerBlock + '|' + geometry.blocksPerRun + '|' + geometry.interBlockRest;
      if (!cache[key]) {
        cache[key] = global.PlannerEfficiency
          ? global.PlannerEfficiency.evaluate(probe, ctx.trSeconds, geometry, { maxTrials: 18 })
          : {};
      }
      return cache[key];
    }

    for (var trialsPerBlock = 4; trialsPerBlock <= 24; trialsPerBlock += 1) {
      for (var blocksPerRun = 1; blocksPerRun <= 10; blocksPerRun += 1) {
        var probe = deepCopy(aim);
        probe.structure.trialsPerBlock = trialsPerBlock;
        probe.structure.blocksPerRun = blocksPerRun;
        if (probe.decode && probe.decode.labelOrder === 'blocked') {
          probe.decode.labelRunLength = trialsPerBlock;
        }
        var geometry = aimGeometry(probe, ctx.trSeconds);
        if (geometry.run[basis] / 60 > num(caps.maxRunMinutes)) continue;

        var metrics = objective === 'trials' ? {} : metricsFor(probe, geometry);

        for (var runsPerSession = 1; runsPerSession <= maxRuns; runsPerSession += 1) {
          var sessionBound = setupMinutes + runsPerSession * geometry.run[basis] / 60
            + (runsPerSession - 1) * breakMinutes;
          if (sessionBound > num(caps.maxSessionMinutes)) break;

          var sessionMean = setupMinutes + runsPerSession * geometry.run.mean / 60
            + (runsPerSession - 1) * breakMinutes;
          var trialsPerHour = (runsPerSession * geometry.trialsPerRun) / (sessionMean / 60);
          var score = global.PlannerEfficiency
            ? global.PlannerEfficiency.objectiveScore(objective, metrics,
              geometry.run.mean / 60, trialsPerHour)
            : trialsPerHour;

          if (!best || score > best.score) {
            best = {
              score: score, trialsPerBlock: trialsPerBlock, blocksPerRun: blocksPerRun,
              runsPerSession: runsPerSession
            };
          }
        }
      }
    }

    if (best) {
      aim.structure.trialsPerBlock = best.trialsPerBlock;
      aim.structure.blocksPerRun = best.blocksPerRun;
      aim.structure.runsPerSession = best.runsPerSession;
      if (aim.decode && aim.decode.labelOrder === 'blocked') {
        aim.decode.labelRunLength = best.trialsPerBlock;
      }
    }
    return draft;
  }

  function optimiseTiming(state, boot, aimId, objective) {
    var draft = deepCopy(state);
    var aim = draft.aims[aimId];
    if (!aim || !global.PlannerEfficiency) return state;
    if (!objective || objective === 'auto') objective = aimObjective(aim);

    var ctx = protocolContext(boot, aim.protocol);
    var basis = draft.caps.applyTo === 'longest' ? 'max' : 'mean';

    var restIndex = -1, tailIndex = -1;
    aim.phases.forEach(function (phase, index) {
      if (phase.role === 'rest' && restIndex < 0) restIndex = index;
      if (phase.role === 'fixation') tailIndex = index;
    });
    if (restIndex < 0 || tailIndex < 0) return state;

    var restOptions = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18];
    var tailOptions = [2, 4, 6, 8, 12, 16, 20, 24, 28, 32];
    var spreadOptions = [0, 2, 4];
    var best = null;

    restOptions.forEach(function (restMin) {
      spreadOptions.forEach(function (restSpread) {
        tailOptions.forEach(function (tailMin) {
          spreadOptions.forEach(function (tailSpread) {
            var probe = deepCopy(aim);
            probe.phases[restIndex].min = restMin;
            probe.phases[restIndex].max = restMin + restSpread;
            probe.phases[restIndex].jitter = restSpread > 0;
            probe.phases[tailIndex].min = tailMin;
            probe.phases[tailIndex].max = tailMin + tailSpread;
            probe.phases[tailIndex].jitter = tailSpread > 0;

            var geometry = aimGeometry(probe, ctx.trSeconds);
            if (geometry.run[basis] / 60 > num(draft.caps.maxRunMinutes)) return;

            var metrics = global.PlannerEfficiency.evaluate(
              probe, ctx.trSeconds, geometry, { maxTrials: 16 }
            );
            var trialsPerHour = 3600 / Math.max(1, geometry.trial.mean);
            var score = global.PlannerEfficiency.objectiveScore(
              objective, metrics, geometry.run.mean / 60, trialsPerHour
            );
            if (!best || score > best.score) {
              best = {
                score: score, restMin: restMin, restMax: restMin + restSpread,
                tailMin: tailMin, tailMax: tailMin + tailSpread
              };
            }
          });
        });
      });
    });

    if (best) {
      aim.phases[restIndex].min = best.restMin;
      aim.phases[restIndex].max = best.restMax;
      aim.phases[restIndex].jitter = best.restMax > best.restMin;
      aim.phases[tailIndex].min = best.tailMin;
      aim.phases[tailIndex].max = best.tailMax;
      aim.phases[tailIndex].jitter = best.tailMax > best.tailMin;
    }
    return draft;
  }

  /* ---------------------------------------------- HRF separation solver */

  function phaseIndices(aim) {
    var index = { question: -1, rest: -1, answer: -1, leadFixation: -1, tailFixation: -1 };
    aim.phases.forEach(function (phase, position) {
      if (phase.role === 'question' && index.question < 0) index.question = position;
      if (phase.role === 'rest' && index.rest < 0 && index.question >= 0) index.rest = position;
      if (phase.role === 'answer' && index.answer < 0) index.answer = position;
      if (phase.role === 'fixation') {
        if (index.answer < 0) { if (index.leadFixation < 0) index.leadFixation = position; }
        else index.tailFixation = position;
      }
    });
    if (index.rest < 0) {
      aim.phases.forEach(function (phase, position) {
        if (phase.role === 'rest' && index.rest < 0) index.rest = position;
      });
    }
    return index;
  }

  function phaseMean(phase) {
    if (!phase) return 0;
    var lo = Math.max(0, num(phase.min));
    return (lo + Math.max(lo, num(phase.max))) / 2;
  }

  /* Solve the delay and post-answer fixation needed so that no event's
   * predicted response exceeds `tolerancePct` of its own peak by the time the
   * next event is measured.  Everything comes from the canonical HRF, so the
   * answer is exact rather than searched. */
  function separationTiming(aim, tolerancePct) {
    if (!global.PlannerEfficiency) return null;
    var index = phaseIndices(aim);
    if (index.question < 0 || index.answer < 0) return null;

    var tolerance = clamp(num(tolerancePct, 5), 0.25, 60) / 100;
    var questionPhase = aim.phases[index.question];
    var answerPhase = aim.phases[index.answer];
    var restPhase = index.rest >= 0 ? aim.phases[index.rest] : null;
    var leadPhase = index.leadFixation >= 0 ? aim.phases[index.leadFixation] : null;
    var tailPhase = index.tailFixation >= 0 ? aim.phases[index.tailFixation] : null;

    var questionSeconds = Math.max(0.1, phaseMean(questionPhase));
    var answerSeconds = Math.max(0.1, phaseMean(answerPhase));

    /* Prompt bleed is read at the answer response peak, five seconds after the
     * answer onset, so the question has had question + rest + 5 s to decay. */
    var questionDecay = global.PlannerEfficiency.decayTime(questionSeconds, tolerance);
    var restNeeded = Math.max(0, questionDecay - questionSeconds - 5);

    /* Carryover is read at the next prompt onset, so the answer has had
     * answer + tail fixation + lead fixation to decay. */
    var answerDecay = global.PlannerEfficiency.decayTime(answerSeconds, tolerance);
    var leadSeconds = Math.max(0, phaseMean(leadPhase));
    var tailNeeded = Math.max(0, answerDecay - answerSeconds - leadSeconds);

    var restSpread = restPhase ? Math.max(0, num(restPhase.max) - num(restPhase.min)) : 0;
    var tailSpread = tailPhase ? Math.max(0, num(tailPhase.max) - num(tailPhase.min)) : 0;

    var restMin = Math.round(restNeeded * 2) / 2;
    var tailMin = Math.round(tailNeeded * 2) / 2;

    var trialMean = 0;
    aim.phases.forEach(function (phase, position) {
      if (position === index.rest) trialMean += restMin + restSpread / 2;
      else if (position === index.tailFixation) trialMean += tailMin + tailSpread / 2;
      else trialMean += phaseMean(phase);
    });

    return {
      tolerancePct: tolerance * 100,
      restIndex: index.rest,
      tailIndex: index.tailFixation,
      restMin: restMin,
      restMax: restMin + restSpread,
      tailMin: tailMin,
      tailMax: tailMin + tailSpread,
      questionDecay: questionDecay,
      answerDecay: answerDecay,
      questionSeconds: questionSeconds,
      answerSeconds: answerSeconds,
      leadSeconds: leadSeconds,
      trialMean: trialMean,
      /* What the design would actually deliver at these settings. */
      promptResidualPct: global.PlannerEfficiency.residualAt(
        questionSeconds, questionSeconds + restMin + 5) * 100,
      carryResidualPct: global.PlannerEfficiency.residualAt(
        answerSeconds, answerSeconds + tailMin + leadSeconds) * 100
    };
  }

  function applySeparationTiming(state, aimId, tolerancePct) {
    var draft = deepCopy(state);
    var aim = draft.aims[aimId];
    if (!aim) return state;
    aim.separationTolerancePct = clamp(num(tolerancePct, 5), 0.25, 60);
    var solved = separationTiming(aim, aim.separationTolerancePct);
    if (!solved) return draft;
    if (solved.restIndex >= 0) {
      aim.phases[solved.restIndex].min = solved.restMin;
      aim.phases[solved.restIndex].max = solved.restMax;
      aim.phases[solved.restIndex].jitter = solved.restMax > solved.restMin;
    }
    if (solved.tailIndex >= 0) {
      aim.phases[solved.tailIndex].min = solved.tailMin;
      aim.phases[solved.tailIndex].max = solved.tailMax;
      aim.phases[solved.tailIndex].jitter = solved.tailMax > solved.tailMin;
    }
    return draft;
  }

  function applyRecommendedTiming(state, aimId) {
    var draft = deepCopy(state);
    var aim = draft.aims[aimId];
    if (!aim) return state;
    var recommended = RECOMMENDED_TIMING[aimObjective(aim)];
    if (!recommended) return state;
    aim.phases = deepCopy(recommended);
    return draft;
  }

  function applyObjectiveDefaults(state, aimId) {
    /* Called when the decoding objective changes: adopt the timing and the
     * label ordering that objective implies, leaving block/run counts alone. */
    var draft = deepCopy(state);
    var aim = draft.aims[aimId];
    if (!aim) return state;
    var objective = aimObjective(aim);
    aim.phases = deepCopy(RECOMMENDED_TIMING[objective] || aim.phases);
    if (objective === 'detection') {
      aim.decode.labelOrder = 'blocked';
      aim.decode.labelRunLength = Math.max(1, Math.round(num(aim.structure.trialsPerBlock, 12)));
      aim.structure.interBlockRest = Math.max(num(aim.structure.interBlockRest), 20);
    } else {
      aim.decode.labelOrder = 'intermixed';
      aim.decode.labelRunLength = 1;
    }
    return draft;
  }

  function balanceToTarget(state, boot) {
    /* Set the allocation percentages implied by each aim's question goal. */
    var draft = deepCopy(state);
    var weights = [];
    AIM_IDS.forEach(function (id) {
      var aim = draft.aims[id];
      if (!aim.enabled) { weights.push({ id: id, weight: 0 }); return; }
      var ctx = protocolContext(boot, aim.protocol);
      var geometry = aimGeometry(aim, ctx.trSeconds);
      var secondsPerTrial = geometry.run.mean / Math.max(1, geometry.trialsPerRun);
      weights.push({ id: id, weight: num(aim.targetQuestions) * secondsPerTrial });
    });
    var total = sum(weights, function (entry) { return entry.weight; });
    if (total <= 0) return draft;
    weights.forEach(function (entry) {
      draft.aims[entry.id].requestedPct = round(entry.weight / total * 100, 2);
    });
    return draft;
  }

  global.PlannerModel = {
    AIM_IDS: AIM_IDS,
    PHASE_ROLES: PHASE_ROLES,
    defaultState: defaultState,
    defaultPerAimSession: defaultPerAimSession,
    migrateState: migrateState,
    sessionConfigFor: sessionConfigFor,
    normaliseAllocation: normaliseAllocation,
    solve: solve,
    protocolContext: protocolContext,
    aimGeometry: aimGeometry,
    optimiseStructure: optimiseStructure,
    optimiseTiming: optimiseTiming,
    applyRecommendedTiming: applyRecommendedTiming,
    separationTiming: separationTiming,
    applySeparationTiming: applySeparationTiming,
    phaseIndices: phaseIndices,
    applyObjectiveDefaults: applyObjectiveDefaults,
    aimObjective: aimObjective,
    OBJECTIVES: OBJECTIVES,
    SOLVE_MODES: SOLVE_MODES,
    ALLOCATION_UNITS: ALLOCATION_UNITS,
    LABEL_ORDERS: LABEL_ORDERS,
    RECOMMENDED_TIMING: RECOMMENDED_TIMING,
    balanceToTarget: balanceToTarget,
    allMarkdown: allMarkdown,
    mdTable: mdTable,
    psychopyYaml: psychopyYaml,
    psychopyFileName: psychopyFileName,
    helpers: {
      num: num, clamp: clamp, round: round, sum: sum, deepCopy: deepCopy,
      fmtNumber: fmtNumber, fmtSeconds: fmtSeconds, fmtRange: fmtRange, trim: trim,
      fmtMinutes: fmtMinutes, fmtClock: fmtClock, phaseLabel: phaseLabel
    }
  };
}(window));
