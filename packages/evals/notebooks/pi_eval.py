"""Thin client for the Pi eval runner.

Use it from a laptop, Colab, or Kaggle. The model may run anywhere; the runner
executes the agent on the OS named in the suite's environment config.

    from pi_eval import PiEval
    client = PiEval("https://my-windows-runner:8787", token=os.environ["RUNNER_TOKEN"])
    result = client.run(suite="example", os="windows")
    result.save("./run")
    result.traces_frame().head()
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any

import requests


class RunResult:
    """Artifacts returned by one suite run."""

    def __init__(self, payload: dict[str, Any], artifact_dir: Path | None = None):
        self.payload = payload
        self.report = payload.get("report")
        self.traces = payload.get("traces", [])
        self.datasets = payload.get("datasets", {})
        self.ok = payload.get("ok", True)
        self.stdout = payload.get("stdout", "")
        self.stderr = payload.get("stderr", "")

    def save(self, path: str | Path) -> Path:
        """Write report, traces, and datasets to a local directory."""
        target = Path(path)
        target.mkdir(parents=True, exist_ok=True)
        if self.report is not None:
            (target / "report.json").write_text(json.dumps(self.report, indent=2), encoding="utf-8")
        with (target / "traces.jsonl").open("w", encoding="utf-8") as handle:
            for trace in self.traces:
                handle.write(json.dumps(trace) + "\n")
        for name, lines in self.datasets.items():
            with (target / name).open("w", encoding="utf-8") as handle:
                for line in lines:
                    handle.write(json.dumps(line) + "\n")
        return target

    def traces_frame(self):
        """Return traces as a pandas DataFrame (one row per turn)."""
        import pandas as pd

        rows = []
        for trace in self.traces:
            metadata = trace.get("metadata", {})
            for index, message in enumerate(trace.get("messages", [])):
                rows.append({"run": metadata.get("caseId"), "index": index, **message})
        return pd.DataFrame(rows)


class PiEval:
    """Drive the eval runner over HTTP, or the local CLI when no URL is given."""

    def __init__(
        self,
        runner_url: str | None = None,
        token: str | None = None,
        repo_path: str | Path | None = None,
        timeout: int = 1800,
    ):
        self.runner_url = runner_url.rstrip("/") if runner_url else None
        self.token = token or os.environ.get("PI_EVAL_RUNNER_TOKEN")
        self.repo_path = Path(repo_path) if repo_path else None
        self.timeout = timeout

    def health(self) -> dict[str, Any]:
        if not self.runner_url:
            return {"ok": self.repo_path is not None, "mode": "local"}
        response = requests.get(f"{self.runner_url}/health", timeout=30)
        response.raise_for_status()
        return response.json()

    def run(
        self,
        suite: str = "example",
        provider: str | None = None,
        model: str | None = None,
        profiles: list[str] | None = None,
        tasks: list[str] | None = None,
        families: list[str] | None = None,
        domains: list[str] | None = None,
        runs: int | None = None,
        backend: str = "host",
        os_name: str | None = None,
        api_base: str | None = None,
        api_key: str | None = None,
        api: str | None = None,
        exports: list[str] | None = None,
    ) -> RunResult:
        """Run a suite and return its report, traces, and datasets."""
        payload: dict[str, Any] = {"suite": suite, "backend": backend}
        for key, value in {
            "provider": provider,
            "model": model,
            "profiles": profiles,
            "tasks": tasks,
            "families": families,
            "domains": domains,
            "runs": runs,
            "os": os_name,
            "apiBase": api_base,
            "apiKey": api_key,
            "api": api,
            "exports": exports,
        }.items():
            if value is not None:
                payload[key] = value

        if self.runner_url:
            headers = {"content-type": "application/json"}
            if self.token:
                headers["authorization"] = f"Bearer {self.token}"
            response = requests.post(f"{self.runner_url}/runs", json=payload, headers=headers, timeout=self.timeout)
            response.raise_for_status()
            return RunResult(response.json())

        if not self.repo_path:
            raise ValueError("Local mode needs repo_path, or use a runner_url.")
        artifact_dir = Path(tempfile.mkdtemp(prefix="pi-eval-notebook-"))
        command = [
            "npm",
            "run",
            "eval:suite",
            "-w",
            "packages/evals",
            "--",
            "--suite",
            suite,
            "--backend",
            backend,
            "--artifact-dir",
            str(artifact_dir),
        ]
        if provider:
            command += ["--provider", provider]
        if model:
            command += ["--model", model]
        if profiles:
            command += ["--profile", ",".join(profiles)]
        if tasks:
            command += ["--task", ",".join(tasks)]
        if families:
            command += ["--family", ",".join(families)]
        if domains:
            command += ["--domain", ",".join(domains)]
        if runs is not None:
            command += ["--runs", str(runs)]
        if os_name:
            command += ["--os", os_name]
        if api_base:
            command += ["--api-base", api_base]
        if api_key:
            command += ["--api-key", api_key]
        if api:
            command += ["--api", api]
        for export in exports or []:
            command += ["--export", export]
        result = subprocess.run(command, cwd=self.repo_path, capture_output=True, text=True, timeout=self.timeout)
        return RunResult(
            {
                "ok": result.returncode in (0, 1),
                "exitCode": result.returncode,
                "report": json.loads((artifact_dir / "report.json").read_text(encoding="utf-8"))
                if (artifact_dir / "report.json").exists()
                else None,
                "traces": [json.loads(line) for line in (artifact_dir / "traces.jsonl").read_text(encoding="utf-8").splitlines() if line]
                if (artifact_dir / "traces.jsonl").exists()
                else [],
                "datasets": {
                    path.name: [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]
                    for path in artifact_dir.glob("dataset.*.jsonl")
                },
                "stdout": result.stdout[-4000:],
                "stderr": result.stderr[-4000:],
            }
        )
