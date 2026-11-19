# Pi evals

A configurable task-environment harness for evaluating coding agents. It runs a
model in an isolated environment under a chosen profile, grades the result, and
exports the full model-visible conversation as a fine-tuning dataset.

The runner uses `vitest-evals` for harness execution, judges, and artifacts.
Execution is pluggable: Linux containers, the local host OS, or a remote runner
that owns the OS you want to test.

## Concepts

A **suite** (`SuiteSpec`) is one experiment. It declares profiles, tasks, an
optional control/treatment pair, repetitions, and dataset exports.

A **profile** is one configuration arm:

| Field | Meaning |
|-------|---------|
| `systemPrompt` | `pi-default`, `pi-default-minus-docs`, `literal` text, or a named `transform` |
| `tools` | allowlist (`tools`), suppression (`noTools`), denylist (`excludeTools`), custom tool definitions (`customTools`), and style (`"pi"` default or `"inspect"` for Inspect-compatible `python`/`text_editor` tools) |
| `environment` | environment id from the suite, or an inline environment |
| `thinkingLevel` | model thinking level; defaults to `"off"` for reproducible runs |

An **environment** is where the agent runs:

| Field | Meaning |
|-------|---------|
| `baseImage` | container base image, used by the docker backend |
| `includeDocs` | ship Pi documentation in the image |
| `os` | `linux`, `windows`, or `macos` (default `linux`) |
| `backend` | `docker`, `host`, `local`, or `remote` (default `docker`) |
| `runner` | runner base URL, required for the `remote` backend |
| `workspaceFiles` | files seeded into an empty workspace |

Docker supports Linux only. `windows`/`macos` require `host` (same OS as the
runner machine) or `remote` (a runner on a machine with that OS). Each distinct
Docker environment becomes one image; each task runs in a fresh container.
Host and remote backends run declarative suites only — code eval files still
require the container sandbox. The host backend has no container isolation:
the agent runs directly on that machine under its normal user account, so use
it for trusted tasks or for OS-specific behavior tests. Docker remains the
backend for untrusted code.

A **task** is one eval case: `evalSet`, `id`, an optional `family`, a user
message or multi-step input (`prompt`/`reload`), task-specific workspace files
merged over the environment files, and judges. Families group tasks into
capability areas (for example `tools`, `reasoning`, `long-context`); domains
group families under a root area. A run can select a whole family or domain,
and the report rolls results up at both levels.

Judges are declarative: `exact`, `contains`, `regex`, `structured`, `toolCalls`,
and `factuality` (needs an LLM judge harness wired into the suite runner).

## Agent-style profiles and tasks

`packages/evals/src/agent/` ports the agent-eval toolchain into pi-eval:

- `profile.ts` / `profile-loader.ts`: JSON profiles with prompts, tool skins,
  nine wire protocols, reminders, permissions, faults, skills, loop limits, and
  cross-field validation. Load with `loadAgentProfile` / `loadAgentProfiles`.
- `task.ts` / `verify.ts`: task folders (`task.json`, `repo/`, optional
  `hidden/`, `verify.json`, `solution/gold.json`) and 12 declarative checks
  with path-escape protection and host-value scrubbing.
- `gold.ts`: the gold/Null gate. `validateTask(task)` proves the canonical
  solution passes and a do-nothing model fails before spending model calls.
- `metrics.ts` / `recorder.ts` / `fidelity.ts`: exclusive failure buckets with
  Wilson intervals, deterministic host-scrubbed JSONL recording, and
  request-fidelity diffs against a captured real request.

CLI:

```bash
npm run eval:agent -w packages/evals -- validate-task <task-dir>
npm run eval:agent -w packages/evals -- show-profile <profile.json>
npm run eval:agent -w packages/evals -- fidelity <profile.json> <real-request.json>
```

Config files are JSON (not YAML) to avoid a runtime dependency.

## Run a suite

```bash
PI_PROVIDER=openai-codex PI_MODEL=gpt-5.6-sol \
  npm run eval:suite -w packages/evals -- --suite example
```

Flags:

```
--suite <id>          suite id (default: docs)
--profile <id[,id]>   run only these profiles
--task <id[,id]>      run only these declarative tasks
--family <id[,id]>    run only declarative tasks in these families
--domain <id[,id]>    run only declarative tasks in these root domains
--runs <n>            repetitions per (case, profile, model)
--provider <p>        overrides PI_PROVIDER
--model <m>           overrides PI_MODEL
--export <fmt[:file]> add a dataset export to the suite's exports
--backend <docker|host|remote>  override the environment backend
--os <linux|windows|macos>      override the claimed OS
--runner <url>                  override the remote runner URL
--artifact-dir <path>           write artifacts to a chosen directory
-t, --testNamePattern <pattern>   filter code eval cases (docs suite)
```

FLAGS
```
--api-base <url>          local OpenAI-compatible endpoint (e.g. a model served in Kaggle)
--api-key <key>           key for that endpoint (or PI_EVAL_API_KEY)
--api <api>               API protocol, default openai-completions
```
When `--api-base` is used, the provider defaults to `pi-eval-local` and a
temporary `models.json` is generated for the run. No provider auth file is
needed. The same fields are accepted by `POST /runs` and the Python client
(`api_base`, `api_key`, `api`).

Provider and model are required, from flags or `PI_PROVIDER`/`PI_MODEL`.
`PI_EVAL_RUNS` defaults repetitions when `--runs` is absent.

Run the original documentation lift comparison (six documentation code evals,
`without_docs` versus `with_docs`):

```bash
PI_PROVIDER=openai-codex PI_MODEL=gpt-5.6-sol npm run eval:docs -w packages/evals
```

Host smoke and documentation audit remain explicit:

```bash
npm run eval:host -w packages/evals
npm run eval:audit -w packages/evals
```

## Runner and notebooks

Start a runner on the machine that owns the OS you want to test:

```bash
npm run eval:serve -w packages/evals   # port 8787; PI_EVAL_RUNNER_PORT to change
PI_EVAL_RUNNER_TOKEN=secret npm run eval:serve -w packages/evals   # require a bearer token
```

`GET /health` reports the runner OS and registered suites. `POST /runs` runs a
whole suite through the CLI and returns `report`, `traces`, and `datasets` as
JSON. `POST /tasks/run` runs one planned arm for the remote runtime adapter.
Credentials stay on the runner: it uses the provider auth/config available in
its own environment; the caller sends only provider and model ids.

`packages/evals/notebooks/pi_eval.py` is a thin client usable from a laptop,
Colab, or Kaggle. A notebook cannot host a Docker daemon or a Windows/macOS
sandbox, so it should call a runner; local laptop mode can invoke the CLI
directly with `repo_path`:

```python
from pi_eval import PiEval
client = PiEval(os.environ["PI_EVAL_RUNNER_URL"], token=os.environ.get("PI_EVAL_RUNNER_TOKEN"))
result = client.run(suite="example", os_name="windows", provider="kaggle", model="my-model", families=["tools"])
result.traces_frame().head()
result.save("./run")
```

`packages/evals/notebooks/kaggle-qwen3-4b-ollama.ipynb` is a ready-to-copy
Kaggle notebook: it checks 2x T4 hardware, installs Node 22, clones the repo,
installs `zstd` and starts `ollama serve` manually (Kaggle has no systemd) with
flash attention and q8_0 KV cache so the model loads 100% on the two T4s,
pulls the real `qwen3:4b` tag, creates a `qwen3:4b-max` variant with `num_ctx`
262,144, warms it, and serves it on `localhost:11434`. It writes the
`pi_eval.py` client into the clone, runs a one-task smoke test and then the
extraction suite with `--runs 5`. The full run starts the CLI in the background
and polls `traces.jsonl`, so assistant text, reasoning, tool calls, and tool
results from each completed run appear live in the notebook. At 262,144 context
the f16 KV cache is ~36 GiB and spills ~34% of the model to CPU; q8_0 KV (~19
GiB) avoids that. If `ollama ps` still shows a CPU share, drop to `num_ctx`
131072 on one GPU. The eval config uses a 30-minute per-test timeout.
Set Kaggle's accelerator to **GPU T4 x2** and enable Internet. The default
`REPO_URL` is the public `https://github.com/velostudioagency/pi-eval.git`; set
the `PI_EVAL_REPO_URL` secret to use a fork, or add the repo as a Kaggle Dataset
named `pi-eval`.

## Create a suite

Suites are typed TypeScript files under `evals/suites/`. Add a file, then
register it in `evals/suites/index.ts` so both the host runner and the container
can resolve it by id. See `evals/suites/example.ts` for a complete template.

```ts
import type { SuiteSpec } from "../../src/config.ts";

export const mySuite: SuiteSpec = {
	id: "my-suite",
	environments: [
		{ id: "repo", includeDocs: true, workspaceFiles: { "README.md": "..." } },
		{ id: "win11", os: "windows", backend: "remote", runner: "https://my-win-vm:8787" },
	],
	profiles: [
		{ id: "full", systemPrompt: { kind: "pi-default" }, environment: "repo" },
		{ id: "windows", systemPrompt: { kind: "pi-default" }, environment: "win11" },
		{
			id: "no-tools",
			systemPrompt: { kind: "literal", text: "Answer concisely." },
			tools: { noTools: "all" },
			environment: "repo",
		},
	],
	tasks: [
		{
			id: "answers-a-fact",
			evalSet: "knowledge",
			input: "What is the capital of France? Answer with only the city name.",
			judges: [{ type: "exact", expected: "Paris" }],
		},
	],
	comparison: { control: "full", treatment: "no-tools" },
	exports: [{ format: "messages" }],
};
```

Declarative tasks run through `evals/suite.eval.ts`, which builds the harness
for the profile selected in `PI_EVAL_PROFILE`. Bundled suites:

- `docs` — the original documentation-lift comparison
- `example` — small template suite with two capability families
- `data-manipulation-read-organize` — root domain `data-manipulation` with four
  families: `data-manipulation-read-organize` (T1–T3),
  `data-manipulation-read-editing-writing` (T4–T5), `data-extraction` (T6–T7),
  and composite `data-manipulation` (T8–T9). Fixture files are text stubs.
- `extraction` — real binary DOCX/XLSX/PPTX/PDF/RTF/scan fixtures generated by
  `npm run fixtures:generate -w packages/evals`. It uses the default Pi profile
  and default tool spec; prompts contain no tool, library, or install hints, so
  the model must discover what is available. Fixtures include an encrypted PDF
  with a password chain, a corrupt file, mojibake text, tracked changes, and a
  hidden slide. Judges check canary facts, provenance from tool results, and
  honest failure reporting. `extraction-minimal` repeats the tasks with a
  `minimal` tool-tier label; no capability is guaranteed in either tier.
  `extraction-raw` uses the same tasks and judges without the `Context:` block
  that spells out the traps, so guided and raw baselines can be reported
  separately. The `grounded` judge grades literal manifest-derived facts,
  forbidden artifacts, template placeholders, and process checks (for example
  a listing after a write) instead of loose substrings.
 Code eval files
(`*.docs.eval.ts`) still work: list them in `suite.evalFiles`, keep the ordinary
`describeEval` style, and the same profile selection applies.

## Traces and datasets

Every run emits a canonical trace artifact: the system prompt, user turns,
assistant text with reasoning and tool calls, and tool results, plus metadata
(profile, model, token usage, score). All traces are written to `traces.jsonl`.

Dataset exporters are configurable per suite (or via `--export`):

| Format | Output |
|--------|--------|
| `messages` | OpenAI-style `{messages: [...]}` with `tool_calls` |
| `sharegpt` | `{conversations: [{from, value}]}` |
| `alpaca` | `{instruction, input, output}`, single-turn only; other traces are skipped |
| `rendered` | `{text}` with a model-family chat template applied |
| `atif` | Harbor ATIF: one `{steps: [...]}` step object per message, with `action` and `observation` — usable by pi-eval-inspect-style tooling and other ATIF readers |

Built-in templates: `chatml` (Qwen, Yi), `hermes`, `deepseek`, `llama3`.
Define a custom `ChatTemplateSpec` for other models: it declares `bos`, `eos`,
role wrappers with `{content}`, `turnEnd`, and a `toolCall` renderer with
`{name}` and `{arguments}`.

Exporter options: `file`, `includeMetadata`, `includeReasoning` (emits
`reasoning_content`, DeepSeek/Qwen style), `template`, and `onlyScored` (default
true). Most trainers apply their own chat template to `messages` JSONL; use
`rendered` only when the training pipeline expects finished text.

## Results

Each invocation creates an ignored `.eval/<timestamp>_<id>/` directory:

- `protocol.json`: suite description, model, images, planned tasks, digest
- `expected-runs.json`: the complete planned cohort
- `observations.jsonl`: normalized outcomes and telemetry
- `traces.jsonl`: canonical traces
- `judge-inputs/*.json`: exact judge artifacts for each run, saved for offline
  rescoring
- `inspect-log.json`: Inspect-AI-compatible JSON evaluation log, readable by
  `inspect view` and `inspect log dump`
- `dataset.*.jsonl`: exported training files
- `tasks/*/vitest.json`: native JSON for each isolated arm
- `<profile>/sessions/*/session.jsonl`: native Pi sessions
- `report.json` / `report.txt`: pass rates per profile, lift when a
  control/treatment pair is declared, operational totals, blocked pairs

To change scorers without re-running the model or agent:

```bash
npm run eval:rescore -w packages/evals -- .eval/<timestamp>_<id>
```

Rescoring reads `judge-inputs/`, re-applies the suite's judges to the saved
transcripts and workspaces, and rewrites `observations.jsonl`, `report.json`,
`report.txt`, and `inspect-log.json`. No provider calls are made.

A pair contributes to pass-rate lift only when both profiles produce exactly
one score. Blocked pairs withhold headline rates and make the process exit
nonzero. Missing telemetry stays unavailable rather than becoming zero.

## Isolation

The image installs the current workspace packages and removes documentation
for `includeDocs: false`. The runner permanently drops to an unprivileged UID
before prompting the model, and evaluator sources, judges, and suite configs
are root-only and unreadable to the model. Each run gets a fresh home, agent
directory, workspace, session directory, and container filesystem.
Documentation profiles allow only `read`, `write`, `edit`, `grep`, `find`, and
`ls`. Provider traffic still needs container network access, so containers do
not prove generated code never used the network.

Artifacts may contain prompts, responses, generated code, and tool output.
