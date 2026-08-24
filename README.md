# fMRI Experimental Design Planner

A design planner and scanner-time optimiser for the dense single-participant inner-speech
decoding study. Python backend, browser front end, Wright State University palette.

The tool solves one question in both directions: **how much scanner time does this design
need**, and **what design fits the scanner time I have** — while keeping every level of the
hierarchy (trial, block, run, session, experiment) consistent with the acquisition
parameters actually recorded on the protocol cards.

## Running it

```bash
./run.sh
```

Then open <http://127.0.0.1:8760>. The launcher uses `.venv` if present and serves through
**waitress**, not the Flask development server. Options:

```bash
./run.sh --port 9000 --host 0.0.0.0
```

First-time setup on a machine without the virtual environment:

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

## Layout

| Path | Purpose |
|---|---|
| `server.py` | Flask application and waitress entry point |
| `planner/protocols.py` | Loading, validation, atomic writes and backups for the parameter cards |
| `planner/report.py` | XLSX workbook generation |
| `static/js/model.js` | Design state, constraint solver, optimisers, Markdown and methods text |
| `static/js/efficiency.js` | HRF convolution, design matrix, contrast efficiency, decode diagnostics |
| `static/js/ui.js` | Control factories and panels |
| `static/js/protocols.js` | Scanner parameter card editor |
| `static/js/export.js` | Clipboard, Markdown and workbook export |
| `scanner-parameters/*.json` | The protocol cards, edited in place |
| `scanner-parameters/.backups/` | Timestamped snapshot before every save |
| `presets/` | Saved designs; `current.json` is the autosaved working design |
| `exports/` | Every generated workbook is archived here |

## The three specific aims and what "optimal" means for each

Each aim carries its own **decoding objective**, and every optimiser on that aim's panel
maximises that objective rather than a single global notion of efficiency.

| Aim | Objective | What the optimiser maximises | Resulting timing |
|---|---|---|---|
| Aim 1 - GLM / FIR | Detection (saturating) | Duty cycle and stacking gain per minute: same-label trials run back to back with minimal rest so the response never settles | Fixation 2-6 s, question 4 s, rest 1-2 s, answer 3 s, fixation 2-6 s |
| Aim 2 - MVPA | Single-trial estimation | Least-squares-all trial-beta estimability, penalised for prompt bleed into the answer window | Fixation 2-6 s, question 4 s, rest 6-10 s, answer cue 3 s, fixation 10-14 s |
| Aim 3 - Spatiotemporal | Full HRF separation | Prompt response and previous trial both back at baseline before the next answer window | Fixation 2-6 s, question 4 s, rest 14-16 s, answer cue 3 s, fixation 24-28 s |

Aim 1 also defaults to **blocked** label ordering — a run of yes trials, then a run of no
trials — which is what makes the sustained univariate contrast worth measuring. Aims 2 and 3
default to intermixed, label-balanced ordering.

### HRF separation solver

Each aim panel carries a single smart slider — **allowed residual at the next event** — that
solves the delay and post-answer fixation ranges directly from the canonical HRF rather than
by search. For a given tolerance it computes how long each event's predicted response stays
above that fraction of its own peak, undershoot included, then sets:

- the **delay** so the prompt response has decayed below tolerance by the time the answer
  response peaks, and
- the **post-answer fixation** so the answer response has decayed below tolerance by the next
  prompt onset, counting the leading fixation already in the trial.

Existing jitter spreads are preserved and the minimum is what satisfies the constraint, so the
worst-case trial is still clean. Dragging the slider moves the phase ranges live, and the
Design efficiency plot above it redraws as you drag. Presets cover 1, 4, 10 and 45
percent; the readout shows the solved values, the residuals they deliver, and the resulting
cost per question, plus whether the current phases match the solution or are only a preview.

On the Time-Series aim the slider spans the whole design space:

| Tolerance | Delay | Post-answer fixation | Trial | Prompt bleed | Carryover | Duty cycle |
|---:|---|---|---|---:|---:|---:|
| 1 % | 18.5-20.5 s | 19.5-23.5 s | 47-57 s | 0.6 % | 0.8 % | 0 % |
| 4 % | 14.5-16.5 s | 15.5-19.5 s | 39-49 s | 2.7 % | 2.9 % | 4 % |
| 10 % | 4-6 s | 5.5-9.5 s | 18.5-28.5 s | 3.4 % | 9.7 % | 46 % |
| 45 % | 2-4 s | 3-7 s | 14-24 s | 22.5 % | 29.3 % | 65 % |

### Decode diagnostics

**Design efficiency** spans the full width of every aim panel, with the HRF-convolved
regressor trace as its centrepiece: shaded bands mark the question and answer windows, the
mouse reads out all three regressors at any time point, and the plot zooms (scroll wheel, zoom
slider, `+`/`-`, **Fit**, **First trial**) and pans (drag, double-click to fit) so a single
trial can be inspected inside a twenty-minute run. The vertical scale follows the visible
window, so zooming into a quiet stretch shows what happens there rather than a flat line.
**Trial phase structure** and **Block, run and session assembly** sit side by side underneath.

Design efficiency reports, from a simulated run at the bound TR:

- **Duty cycle** - median predicted task signal as a percentage of its 95th percentile.
  High means the response never settles (what detection wants); near zero means full
  recovery (what separation wants).
- **Stacking gain** - peak predicted signal divided by the peak of one isolated trial.
- **Single-trial efficiency** - reciprocal mean variance of least-squares-all trial betas.
- **Carryover** - previous answer response still present at the next prompt onset.
- **Prompt bleed** - question response still present inside the answer window.
- **Contrast efficiency** for yes vs no, answer vs baseline and question vs answer, plus
  the question/answer regressor correlation and variance inflation.

## Reading the numbers

The masthead carries the study totals at all times: sessions, questions recorded, then a chip
per modality (GLM / MVPA / Time-Series) with its question count, session count and share of
scanner time, followed by hours committed, utilisation, raw data volume and open constraint
flags.

**Overview** is the simplified tab and the default landing panel: a headline strip, one large
tile per modality showing questions recorded, control trials, questions per session, sessions,
scanner time, share and data volume against its goal, and a short set of master controls —
what to solve for, **total questions to collect**, hours available, sessions per week, weeks
available and longest session — followed by the per-aim distribution sliders and the per-aim
question goals. Everything else lives in the detail panels.

The total-questions slider fills as much of the goal as the hours allow. The strip under the
master controls always reads back how many of the questions asked for are actually scheduled,
what fraction of the goal that is, and how much of the budget it spends.

A *question* is a primary prompted trial. The embedded control share set in the Question bank
panel is subtracted from the trial count, so questions recorded plus control trials equals
total trials, per modality and overall. Every goal in the planner — the total, the per-aim
goals and the per-aim floor — counts questions rather than trials, and the solver converts
through the control share when it works out how many sessions a goal needs.

**Session composition** carries a tab per aim beside the shared defaults. In the dedicated
session model each aim runs its own session, so each gets its own console-order timeline built
from its own runs; ticking *Give this aim its own session composition* also gives it its own
setup allowance, break length and structural block, which the solver then uses for that aim's
session length, overhead and session count. Aims left alone follow the shared composition, and
the *Who runs what* table says which is which. Pooled sessions are shared by every aim, so
they keep the single shared composition.

## Solver

- **Solve modes**
  - *Hours available* — spend the whole budget; the question count is whatever the hours buy.
  - *Question goal* — fill as much of one total question goal as the hours allow, keeping the
    per-aim split of scanner time. Sessions are indivisible, so the plan lands on the nearest
    whole session and says so in the constraint report.
  - *Per-aim goals* — each aim runs until it reaches its own question goal, however long that
    takes.
  - *Session counts* — you set the number of sessions per aim directly.
- **Session models** - dedicated (one aim per session) or pooled (runs from several aims
  share a session).
- **Allocation** - one set of per-aim sliders, driven in whichever unit you are thinking in:
  **percent** of scanner time (with locks; the remainder always redistributes so the shares
  total 100), **hours** of the usable budget, or **number of sessions**. Choosing the session
  unit seeds the counts from the solved plan and moves the solver into session-count mode, so
  the sliders mean what they say.
- **Constraint envelope** - maximum run duration, session duration, runs per session, total
  sessions, continuous-scanning comfort limit and a minimum question floor per aim. Caps apply
  either to the expected duration or to the worst-case longest duration.
- **Auto-clamp** - when structure violates a cap the solver reduces blocks, trials per block
  or runs per session and reports exactly what it changed in the constraint report.

## Scanner parameter cards

Every parameter in every card under `scanner-parameters/` is editable in the Acquisition
panel, grouped by console page and indented as on the console.

The link is bidirectional:

- **Card to design** - TR, TE, slices, reconstruction matrix, voxel size and series duration
  feed run lengths, dynamic counts, data volume and the efficiency simulation.
- **Design to card** - *Push solved timing to protocol card* writes the solved `dyn scans`,
  `dummy scans` and `Total scan duration` back into the JSON, leaving every other parameter
  untouched.

Saving writes a timestamped backup into `scanner-parameters/.backups/` first; the last 25
per card are kept and any of them can be restored from the Backups view.

## Export

- **XLSX workbook** - summary, design matrix per aim, trial structure, budget and allocation,
  one session timeline per aim, efficiency diagnostics, question bank, data volume, methods
  text, Markdown tables, and one sheet per protocol card with every parameter as saved.
- **Copy methods text** - a paste-ready narrative generated from the solved design.
- **Copy Markdown** - any single table, or the whole report, as GitHub-flavoured Markdown.
- **Design JSON** - the full state plus the solved report.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness and protocol count |
| GET | `/api/bootstrap` | Manifest, all cards, acquisition summary, saved design, presets |
| GET | `/api/protocols` | Card manifest |
| GET/PUT | `/api/protocols/<slug>` | Read or save one card |
| GET | `/api/protocols/<slug>/backups` | List snapshots |
| POST | `/api/protocols/<slug>/restore` | Restore a snapshot |
| POST | `/api/apply-derived` | Write solved acquisition values into a card |
| GET/POST | `/api/design` | Load or save a design (`?name=`, default `current`) |
| DELETE | `/api/design/<name>` | Delete a preset |
| POST | `/api/export/xlsx` | Build and download the workbook |
| POST | `/api/export/json` | Download the design payload |

## Notes on the shipped defaults

The default design solves for a 6,000-question goal in *Question goal* mode. With fully
separated trials (47-57 s) that costs far more scanner time than a default budget covers, so
the planner fills what the hours allow and reports the shortfall rather than quietly shrinking
the design; the earlier 12-21 s trial is retained as the Aim 1 detection design, where
saturation is the point. Adjust the budget, the caps or the per-aim question goals and the
whole hierarchy re-solves.

Designs saved before goals became question-denominated load unchanged: the old trial targets
carry over as question goals with the same numbers, and every aim starts on the shared session
composition.
