# Batch video notes: recovery and smoke-test evidence

Date: 2026-09-15 (Asia/Shanghai). Branch: `feature/batch-video-notes`.
Production-code baseline: `6cc6be320ff65b46630cf371453d976e5557e866`.
Task 9 adds the integration test and this record; it does not change production code.

## Acceptance status

Automated recovery and regression checks passed. Live three-video generation and
Tauri exit/reopen acceptance were **not performed**. These remain open acceptance
items; the automated fixture is not evidence of working downloads, transcription,
provider credentials, rendered real notes, or packaged desktop lifecycle behavior.

## Reproducible automated checks

Run from the feature checkout. This Windows run used PowerShell, Python 3.10.6,
pytest 9.1.1, Node 22.21.0, npm 10.9.4, Vitest 3.2.4, and Vite 6.4.1.
The existing Python environment was used without dependency installation:

```powershell
$taskRoot = 'E:\BiliNote-workspace\BiliNote-src\.worktrees\batch-video-notes'
$taskPython = 'E:\BiliNote-workspace\BiliNote-production-build\.venv\Scripts\python.exe'
Set-Location "$taskRoot\backend"
& $taskPython -m pytest tests/test_batch_recovery_integration.py -q
& $taskPython -m pytest tests -v
Set-Location "$taskRoot\BillNote_frontend"
npm test -- --run
npm run build
npm run lint -- --format json --output-file ../.superpowers/sdd/2026-09-10-batch-video-notes/task-9-lint-rerun.json
Set-Location $taskRoot
git diff --check
```

For another checkout, substitute its root and a Python environment containing
`backend/requirements.txt` plus pytest. The `.superpowers` output directory above
is an existing, ignored local handoff directory; create it or choose a temporary
output file when reproducing the lint command elsewhere.

| Check | Observed result on 2026-09-15 | Exit |
| --- | --- | --- |
| Recovery integration | 1 passed in 13.50s | 0 |
| Complete backend suite | 215 passed, 3 subtests passed in 37.77s | 0 |
| Complete frontend suite | 72 passed across 9 suites in 13.35s | 0 |
| Production frontend build | 17,799 modules transformed; built in 1m 2s | 0 |
| Full frontend lint | 102 errors, 13 warnings, 29 files; unchanged baseline below | 1 |
| Working-tree whitespace check | No whitespace errors | 0 |

Frontend test counts: creation 19, detail 11, batch polling 15, batch store 8,
batch API 2, batch list 2, single-note form 3, single-note polling 9, app routes 3.
The build is `vite build`, not a Tauri binary build or a full-app TypeScript check.
Existing build warnings concern old Browserslist data, lottie-web `eval`, and
chunks over 500 kB. Tests also print an existing single-note retry fixture.
No new lint diagnostic was introduced by Task 9.

## Recovery test scope and observed trace

`backend/tests/test_batch_recovery_integration.py` uses real FastAPI batch routes,
SQLite transactions, DAO logic, `TaskWorkspace`, and queue workers. Only the
media/model runner is a controlled fixture. It creates a temporary database and
result directories, starts a hidden test-owned subprocess, and submits three jobs
through `/api/batch/submit`. It waits for the third job to reach `SUMMARIZING`,
terminates that subprocess, reopens the same database with a new application and
queue, and calls `/api/batch/{batch_id}/resume` explicitly. Cleanup always reaps
the subprocess and closes engines. No installed application process is stopped.

`create_app(None)` deliberately skips the full `main.py` lifespan. Recovery is
exercised through real `NoteQueueService.start()`. Separate existing backend tests
cover lifespan ownership and a shared single execution slot. This test does not
claim an actual Uvicorn/Tauri restart or a real model response. A graceful
`queue.stop()` waits for the active runner, so terminating the child is necessary
to test an interrupted job.

Sample IDs from the complete backend run (synthetic inputs only):

- Batch: `73937c77-c6bf-44df-80e1-405ac3895ddf`.
- Position 0: `8b7bb78e-9c1d-4abf-a71b-288a666e32f8`.
- Position 1: `15f5d02d-7e60-429f-a57b-c341e50feef2`.
- Position 2: `f1a26b23-efa7-4a21-93c8-25360b5bad00`.

| Observation | Batch | Ordered job statuses | Attempts |
| --- | --- | --- | --- |
| Before termination | RUNNING | SUCCESS, FAILED, SUMMARIZING | 0, 0, 0 |
| After restart, before resume | RECOVERABLE | SUCCESS, FAILED, INTERRUPTED | 0, 0, 0 |
| After manual resume | PARTIAL | SUCCESS, FAILED, SUCCESS | 0, 0, 1 |

The durable runner-call trace is `(position 0, attempt 0)`, `(1, 0)`, `(2, 0)`,
`(2, 1)`: no successful-job rerun and no implicit retry of the failed job.
The second job retains `controlled inaccessible video`; its result path is null.
The final counts are two successes and one failure, total three. The first result
is byte-identical after restart; both successful results live under different
`data/tasks/<task_id>/` directories. IDs are generated afresh on each run.
The inherited test was reviewed and rerun without modification; no fresh
pre-implementation failing-test run is claimed for it.

## Local prerequisites and limits

Read-only checks on 2026-09-15 found no listeners on backend/frontend ports 8483
or 3015 and no BiliNote-named process. The feature checkout has neither its Tauri
sidecar directory nor a debug/release desktop executable. `cargo` is unavailable
on PATH. Therefore no desktop build or desktop launch was attempted. The already
installed desktop application belongs to a separate older build and cannot
validate this feature branch.

The preceding Task 9 environment inspection reported reachable configured provider
hosts, but made **no authenticated/model request**. Reachability does not validate
provider credentials, model support, quota, or inference. It also found a packaged
tiny transcriber model while the source-mode model cache was absent. These earlier
observations were carried forward; no provider host, key, cookie, or private URL
is recorded here, and no real download/transcription/inference was performed.

Static inspection confirmed an existing readiness issue:
`TranscriberConfigManager.is_model_ready()` imports `config._downloading`, whereas
`config.py` now uses `model_download_state` as `dl_state`. This can prevent a
reliable readiness result. It did not block the isolated automated suite and was
not changed in this task. Actual readiness must be established before live runs.

The specification also asks for one final batch summary notification and no
per-success notification stream. Static inspection finds the persistent
`BatchProgress` summary but no batch completion-toast path in the batch
pages/store/polling. The once-only notification requirement is **not verified**;
do not count the persistent progress summary alone as proof of it.

## Manual three-item workflow — NOT PERFORMED

Prerequisites: a backend and UI built from this branch (one backend process), a
working configured provider, a ready transcriber, FFmpeg, and controlled video
fixtures. Record commit, app version, provider/model alias, transcriber type/size,
date, and a test batch name without credentials. Use disposable test data, and
choose one valid video without usable subtitles if actual transcription needs to
be verified; a subtitle-only run does not test the transcriber.

1. Open **批量任务** and create a batch. Paste a Bilibili multipart source, a
   controlled inaccessible video URL, and an ordinary valid video in that order.
   Click **解析链接**. Select exactly one intended multipart part, the inaccessible
   fixture, and the ordinary valid video. Check part title/number, displayed order,
   normalized part selector, and selected count of three.
2. A malformed URL should be invalid and unselectable; verify removal with
   **移除无效项** separately. Such a row cannot test worker failure continuation.
   The inaccessible fixture must remain a syntactically valid, preview-accepted
   video that fails during execution. If metadata lookup already rejects it,
   use a controlled video whose media becomes unavailable after preview, or
   another preview-accepted inaccessible fixture. Do not bypass validation merely
   to claim a successful UI acceptance run.
3. Continue to shared settings. Select the configured provider/model and desired
   transcription/output settings. Confirm the button says **开始生成 3 条笔记**,
   submit once, and record the batch ID and ordered task IDs from the response or
   detail API. Do not capture request headers or provider configuration secrets.
4. Observe detail status and timestamped backend stage logs throughout execution.
   Expect the chosen multipart item first, the failure second, and the ordinary
   video third. At every transition at most one job may be in `PARSING`,
   `DOWNLOADING`, `TRANSCRIBING`, or `SUMMARIZING`. Use logs as well as polling;
   occasional UI samples alone cannot establish absence of overlapping work.
5. Verify the second item becomes `FAILED` with an intelligible error and the
   third starts without a retry/resume click. Confirm two real successful notes,
   `PARTIAL`, success 2 / failure 1 / waiting 0 / interrupted 0, and ended 3 / 3.
   Check the specification's single final summary notification and absence of
   per-item success toasts. Record a missing or repeated notification as a failure.
6. Record relative result paths and hashes. Confirm distinct
   `data/tasks/<task_id>/` directories, matching result task IDs, and the intended
   multipart content rather than the first part or entire multipart video.
   Click **打开笔记** for each success; verify real Markdown, title, and source,
   plus transcript/screenshots if selected. Reopen the detail page and confirm
   history imports do not duplicate either note.
7. In a disposable follow-up batch, verify **停止后续任务** lets the current item
   finish but starts no later item; **继续生成** resumes it. Verify
   **取消等待项** leaves the active item running and cancels only waiting items.
   Use **重试失败项** on a controlled failure and confirm successful IDs/results
   remain unchanged. Record these supplemental checks separately.

Real-run evidence: batch/task IDs, stage timestamps, note hashes, and screenshots
are **not available**, because this workflow was not executed.

## Manual Tauri restart — NOT PERFORMED

1. Build/package this branch with its matching backend sidecar and launch that
   desktop build. Record the build commit and the exact test data directory.
   Create a three-item all-valid batch with the later items long enough to observe
   interruption. Wait for item one to finish and save its task ID, result hash,
   attempt, and relevant stage/provider-call logs.
2. While item two is actively downloading, transcribing, or summarizing, use the
   app's normal exit action. Record the active stage and whether the sidecar really
   exits. Do not assume closing the window kills the backend. If graceful shutdown
   completes the active item, record that behavior; it does not constitute an
   interrupted-active-job case. In an isolated disposable instance only, add a
   separate crash test by terminating its verified test-owned sidecar/process.
3. Reopen the same build against the same database. Expect `RECOVERABLE`, item one
   still `SUCCESS`, the interrupted active item `INTERRUPTED`, and unstarted items
   `PENDING`. Observe at least two normal polling cycles before any management
   action; corroborate with backend/provider logs that no job is claimed and no
   new transcription/model generation request starts automatically. Existing
   provider requests may finish remotely; distinguish those from new submissions.
4. Click **继续生成** once. Expect only interrupted/pending items to run, in order
   with one active job. Earlier successes must keep their task IDs, attempts,
   result hashes, and history entries. Confirm no new download/transcription/model
   calls for them. Verify valid matching caches are reused where present; record
   the actual resumed stage rather than assuming all work resumes mid-stage.
5. For an all-valid batch, expect `COMPLETED` with three successes. If a separate
   variant already contains a failed job, ordinary resume must leave that failure
   untouched and finish `PARTIAL`; **重试失败项** is the distinct retry action.
   Open the resulting notes and verify final counts and once-only summary behavior.

Desktop-run evidence: exit/reopen logs, screenshots, task IDs, and provider-call
counts are **not available**. Missing branch desktop artifacts/toolchain and
unverified live generation prerequisites are the reasons, not a passed acceptance
result.

## Full lint baseline

The following diagnostics are on files byte-unchanged from `6cc6be3` (each checked
with `git diff --quiet 6cc6be3 -- <file>`, exit 0). The fresh ESLint JSON's file,
message, location, severity, and counts exactly match the preceding Task 9 JSON.
All paths below are relative to `BillNote_frontend/`. To reproduce exact diagnostic
messages/locations, run the recorded lint command on that baseline with the same
installed dependencies. This is an explicit baseline exception, not a clean lint.

| File | Errors | Warnings |
| --- | ---: | ---: |
| src/components/BackendHealth/BackendHealthIndicator.tsx | 1 | 0 |
| src/components/Form/DownloaderForm/Form.tsx | 1 | 1 |
| src/components/Form/DownloaderForm/Options.tsx | 5 | 0 |
| src/components/Form/DownloaderForm/providerCard.tsx | 5 | 0 |
| src/components/Form/modelForm/Form.tsx | 22 | 1 |
| src/components/Form/modelForm/ModelSelector.tsx | 1 | 1 |
| src/components/Form/modelForm/components/providerCard.tsx | 1 | 0 |
| src/components/ui/badge.tsx | 0 | 1 |
| src/components/ui/button.tsx | 0 | 1 |
| src/components/ui/form.tsx | 0 | 1 |
| src/hooks/useCheckBackend.ts | 1 | 0 |
| src/layouts/RootLayout.tsx | 0 | 1 |
| src/pages/HomePage/Home.tsx | 1 | 0 |
| src/pages/HomePage/components/ChatPanel.tsx | 2 | 2 |
| src/pages/HomePage/components/History.tsx | 2 | 0 |
| src/pages/HomePage/components/MarkdownHeader.tsx | 2 | 0 |
| src/pages/HomePage/components/MarkdownViewer.tsx | 24 | 2 |
| src/pages/HomePage/components/MarkmapComponent.tsx | 7 | 0 |
| src/pages/HomePage/components/NoteHistory.tsx | 4 | 0 |
| src/pages/HomePage/components/StepBar.tsx | 1 | 0 |
| src/pages/HomePage/components/transcriptViewer.tsx | 2 | 0 |
| src/pages/Onboarding/index.tsx | 12 | 1 |
| src/pages/SettingPage/Monitor.tsx | 1 | 0 |
| src/pages/SettingPage/about.tsx | 1 | 0 |
| src/pages/SettingPage/components/menuBar.tsx | 3 | 0 |
| src/pages/SettingPage/index.tsx | 0 | 1 |
| src/pages/SettingPage/transcriber.tsx | 1 | 0 |
| src/services/downloader.ts | 1 | 0 |
| src/store/chatStore/index.ts | 1 | 0 |
