# Batch video notes: recovery and smoke-test evidence

Date: 2026-09-15; latest live source acceptance update: 2026-09-17 (Asia/Shanghai). Branch: `feature/batch-video-notes`.
Production-code baseline: `6cc6be320ff65b46630cf371453d976e5557e866`.
The original Task 9 commit adds the integration test and this record. The notification follow-up below also changes frontend production code.

## Acceptance status

Automated recovery and regression checks passed. The 2026-09-17 live source
API/UI run below verified ordered three-item execution, failure continuation,
real transcription/model generation, rendered notes, and interrupted-backend
recovery without rerunning prior successes. Supplemental notification and reload
observations are recorded with their limits. A fully UI-driven creation workflow
and packaged Tauri exit/reopen acceptance remain open; source-process evidence
does not establish packaged desktop lifecycle behavior. Earlier dated sections
retain their historical test results and pre-live-run acceptance status.

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

## First notification follow-up verification (starting HEAD `3f5b894`)

Historical implementation details below are superseded by the second follow-up.
The recorded first-follow-up test results remain historical evidence.

The missing final notification is now implemented. After a verified detail read
returns `COMPLETED` or `PARTIAL`, polling sends one Chinese summary containing the
batch name, status, successes/total, failures, interruptions, and cancellations.
`BatchProgress` remains visible. Successful note imports do not emit per-video
success popups. The summary describes backend completion independently of result
import availability; import retries continue normally.

The shared batch store remembers terminal outcome fingerprints separately for
each batch: terminal status, server `updated_at`, and ordered task IDs, attempts,
and statuses. Repeated responses, terminal import retries, StrictMode, detail
remount/reopen, and unchanged cache revalidation do not repeat the notification.
A new terminal server revision or attempt can notify again, including a retry
that finishes between polls with unchanged counts. Stale invalidated reads do
not notify. Paused, recoverable, and cancelled batches do not emit completion.
This deduplication survives route navigation within the current app session;
the in-memory batch store does not persist notifications across a full app reload.

TDD evidence: before production edits, five notification tests failed because no
toasts were emitted; three non-completion tests passed. The first fixture was then
corrected to advance server state explicitly (StrictMode legitimately reads twice),
and tests were extended to cover a server-only revision and stale read. Tests use
real toast state, batch/task stores, and both polling hooks; only network calls and
the existing test IndexedDB boundary are mocked.

Run from `BillNote_frontend/`:

```powershell
npm test -- --run src/features/batch/useBatchNotifications.test.tsx src/features/batch/useBatchPolling.test.tsx src/features/batch/store.test.ts
npm test -- --run
npx tsc -p tsconfig.batch.json --noEmit
npx eslint src/features/batch/store.ts src/features/batch/useBatchPolling.ts src/features/batch/useBatchNotifications.test.tsx
npm run build
```

| Follow-up check | Observed result on 2026-09-15 | Exit |
| --- | --- | --- |
| Initial focused regression run | 31 passed across 3 suites, before two added cases | 0 |
| Final notification suite | 10 passed in 3.76s | 0 |
| Complete frontend suite | 82 passed across 10 suites in 12.23s | 0 |
| Scoped TypeScript | No diagnostics | 0 |
| Changed-file ESLint | No diagnostics | 0 |
| Production frontend build | 17,799 modules; built in 56.40s, existing warnings | 0 |
| Recovery integration rerun | 1 passed in 11.88s | 0 |

Backend production files are unchanged. The earlier full backend/lint results
remain historical evidence; only recovery integration and scoped lint were rerun
for this follow-up. Real-video and desktop acceptance below remain NOT PERFORMED.

## Second notification follow-up verification (starting HEAD `cea23e9`)

Receipt retention and import deduplication details below are superseded by the third follow-up.

The completion observer is now mounted in `App`, after backend initialization and
above the router. It scans every summary page and observes running batches even
on the batch list or note page. A mounted detail reader owns that batch; the
background observer skips it and takes over after unmount. Both use one serialized
request/import lane, with revision checks before accepting detail responses.
StrictMode cleanup leaves one active chain. Verified unchanged terminal summaries
avoid repeated detail reads; failed imports retry and do not block other batches.
List-page pagination and its visible progress refresh remain independent.

Receipts use localStorage key `bilinote-batch-outcomes`, schema version 1, and
survive store/module reloads and app restarts in the same browser profile. They
retain at most 200 batches, eight outcomes per batch, and 30 days since observation.
Pruning favors batches observed nonterminal over historical completions. Malformed
JSON, unknown versions, invalid records and expired receipts recover safely.
Read/write denial or quota failures retain in-memory deduplication and never stop
progress or successful note imports; persistence cannot be guaranteed while
storage is unavailable. Evicted or expired terminal batches are silently baselined.

An outcome contains terminal status plus task IDs, attempts and statuses sorted by
task ID. Timestamps and display order are excluded. Timestamp-only management
updates and no-op races remain silent; changed attempts or statuses notify once,
even when a fast retry finishes between polls. First-discovered historical terminal
batches are baselined silently and background discovery does not import their old
notes. Persisted nonterminal observations remain eligible for completion after
reload. Directly opening historical detail still permits its normal note import.
Summary messages remain Chinese, with no per-video success popups.

TDD evidence: the two inherited interrupted regressions first failed for timestamp
and module-reload duplicates. Added historical-baseline and malformed-storage
regressions also failed before receipt changes. Both real app-route tests then
failed with zero messages after navigating from detail to `/batch` or `/`, and
passed after the observer was installed. Additional red tests exposed backlog
eviction of an observed running batch and unwanted historical-note imports; both
passed after targeted changes. One initial route-test text locator was corrected
before the meaningful zero-toast failure was observed. No live media/model calls
were made by these tests.

Run from `BillNote_frontend/`:

```powershell
npm test -- --run src/features/batch/useBatchNotifications.test.tsx src/features/batch/useBatchObserver.test.tsx src/features/batch/useBatchPolling.test.tsx src/features/batch/store.test.ts src/App.batch.test.tsx
npm test -- --run
npx tsc -p tsconfig.batch.json --noEmit
npx eslint src/App.tsx src/App.batch.test.tsx src/features/batch/api.ts src/features/batch/store.ts src/features/batch/outcomeReceipts.ts src/features/batch/pollingLane.ts src/features/batch/useBatchPolling.ts src/features/batch/useBatchObserver.ts src/features/batch/useBatchObserver.test.tsx src/features/batch/useBatchNotifications.test.tsx
npm run build
```

| Second follow-up check | Observed result on 2026-09-16 | Exit |
| --- | --- | --- |
| Final receipt/observer focused suites | 26 passed across 2 suites in 4.38s | 0 |
| Complete frontend suite | 100 passed across 11 suites | 0 |
| Scoped TypeScript | No diagnostics | 0 |
| Changed-file ESLint | No diagnostics | 0 |
| Production frontend build | 17,802 modules; built in 1m 22s, existing warnings | 0 |
| Recovery integration rerun | 1 passed in 31.17s | 0 |
| Working-tree and staged whitespace checks | No whitespace errors | 0 |

All backend production files remain unchanged. Full-backend and full-lint results
above remain historical; recovery integration and changed-file lint were rerun.
Real-video and packaged desktop acceptance remain **NOT PERFORMED**.

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

The previously identified missing batch summary notification is addressed by the notification follow-up above. Its automated coverage is separate from the live UI acceptance procedures below.

## Third notification follow-up verification (starting HEAD `759d076`)

Successful imports now commit a task-ID/attempt acknowledgement in the same
IndexedDB `task-storage` snapshot as the note. The highest imported attempt is
retained independently of note contents; both individual history deletion and
clearing history preserve it. Observer restart and detail reopening cannot restore
that deleted attempt. A later successful attempt still imports new content once.
The legacy-note and receipt migration behavior from this follow-up is superseded
by the fourth follow-up below. Current-schema acknowledged history remains untouched.

The batch receipt's `importPending` obligation is separate from those completed
acknowledgements. Only after the history write resolves may the obligation clear;
a rejected write leaves it eligible for retry. Note-history read failures still
block imports. localStorage notification failures retain the existing in-memory
fallback; durable notifications require available localStorage, while durable
note acknowledgements use the same IndexedDB persistence as history.

The 200-batch/30-day limits now apply only to historical terminal receipts.
Nonterminal batches and terminal batches awaiting imports are neither count-capped
nor age-expired. The eight-outcome limit remains per batch. The original handling of version-1 tracked terminal receipts without
`importPending` is superseded by the deletion-preserving migration below. Historical terminal discovery after upgrade stays silent.

A successful submission response registers its returned batch ID before any
navigation. Even if generation finishes before the first detail read, its final
summary and successful notes are observed. If the response arrives after the user
leaves, the confirmed server batch remains tracked but navigation stays on the
user's chosen destination. An abandoned request without a confirmed server batch
ID registers nothing. Registration also invalidates a terminal discovery that
raced ahead of a delayed submit response.

TDD evidence: before production changes, four observer regressions failed (remove
and clear followed by restart, 205 active obligations across retention, terminal
import failure across pruning) and three creation regressions failed (immediate
success/failure summaries and tracking a late confirmed response). Their expected
failures were unwanted history restoration or missing tracking/summary/import.
The subsequent focused four-suite run passed 60 tests. Additional durable-write,
new-attempt-content and delayed-submit-discovery checks passed in the final
21-test import/observer run. These tests use real stores, hooks and toast state,
with network and IndexedDB boundaries controlled by the test harness.

Commands from `BillNote_frontend/`:

```powershell
npm test -- --run src/features/batch/useBatchObserver.test.tsx src/features/batch/BatchCreatePage.test.tsx src/features/batch/store.test.ts src/features/batch/useBatchNotifications.test.tsx
npm test -- --run src/features/batch/store.test.ts src/features/batch/useBatchObserver.test.tsx
npm test -- --run
npx tsc -p tsconfig.batch.json --noEmit
npx eslint src/features/batch/BatchCreatePage.tsx src/features/batch/BatchCreatePage.test.tsx src/features/batch/BatchDetailPage.test.tsx src/features/batch/outcomeReceipts.ts src/features/batch/store.ts src/features/batch/store.test.ts src/features/batch/useBatchNotifications.test.tsx src/features/batch/useBatchObserver.test.tsx src/features/batch/useBatchPolling.test.tsx src/store/taskStore/index.ts
npm run build
```

| Third follow-up check | Observed result on 2026-09-16 | Exit |
| --- | --- | --- |
| Focused four-suite run | 60 passed, 12.73s (before three additional cases) | 0 |
| Final import/observer suites | 21 passed, 4.81s | 0 |
| Complete frontend suite | 110 passed across 11 suites, 18.17s | 0 |
| Scoped TypeScript | No diagnostics | 0 |
| Changed-file ESLint | No diagnostics | 0 |
| Recovery integration | 1 passed in 15.75s | 0 |
| Production frontend build | 17,802 modules; built in 1m 6s, existing warnings | 0 |
| Working-tree whitespace check | No whitespace errors | 0 |

Build warnings remain the existing Browserslist age, lottie-web eval and large
chunks. Backend production code is unchanged. Full backend and full-repository lint were not
rerun; prior baseline evidence remains historical. Live video generation and
packaged Tauri restart acceptance remain NOT PERFORMED.

## Fourth notification follow-up: migration safety (starting HEAD `922de9d`)

Verified on 2026-09-17. A legacy successful note without an imported-attempt
acknowledgement is no longer treated as proof that the current backend attempt
was imported. An eligible import retrieves the current result and replaces the
old note contents, preserving its creation time and selection, then persists the
note and current attempt acknowledgement in one snapshot. Already acknowledged
current-schema notes remain untouched; a later successful attempt refreshes once.

Legacy terminal receipts without durable `importPending` metadata migrate to
untracked, handled history while retaining their observed outcome fingerprints.
Background discovery stays silent and does not restore notes deleted or cleared
before upgrade. A changed attempt can subsequently notify and import normally.
The old schema cannot distinguish user deletion from an unfinished import. This
migration deliberately respects deletion: an old outstanding import may require
opening its batch detail or retrying manually. Explicitly recorded current-schema
pending imports and legacy nonterminal observations retain their recovery behavior.

Hydration accepts imported-attempt acknowledgements only from plain objects.
Task IDs must contain 1–256 ASCII letters, digits, underscores or hyphens, starting
with a letter or digit; attempts must be numeric nonnegative safe integers
(0 through `Number.MAX_SAFE_INTEGER`). Invalid containers become empty maps;
invalid entries are dropped individually while valid acknowledgements survive.

TDD evidence: the first store/observer run failed seven expected assertions:
legacy Markdown stayed stale, a numeric-string acknowledgement suppressed import,
four malformed containers survived hydration, and cleared legacy history was
restored. After the fixes the focused store, observer and notification suites
passed 49 tests. The mixed-entry fixture also covers numeric overflow (`1e400`),
unsafe integers, fractions, negatives, booleans, null, and invalid task IDs. The
legacy receipt case checks a second restart, no accidental notifications, and a
later successful attempt; existing tests cover durable-write failure/retry and
current-schema acknowledgement preservation.

Commands from `BillNote_frontend/`:

```powershell
npm test -- --run src/features/batch/store.test.ts src/features/batch/useBatchObserver.test.tsx src/features/batch/useBatchNotifications.test.tsx
npm test -- --run
npx tsc -p tsconfig.batch.json --noEmit
npx eslint src/features/batch/outcomeReceipts.ts src/features/batch/store.ts src/features/batch/store.test.ts src/features/batch/useBatchObserver.test.tsx src/store/taskStore/index.ts
npm run build
```

Recovery used the same existing Python environment and command recorded above.

| Fourth follow-up check | Observed result on 2026-09-17 | Exit |
| --- | --- | --- |
| Focused migration/notification suites | 49 passed, 4.35s | 0 |
| Complete frontend suite | 118 passed across 11 suites, 16.86s | 0 |
| Scoped TypeScript | No diagnostics | 0 |
| Changed-file ESLint | No diagnostics | 0 |
| Recovery integration | 1 passed in 27.84s | 0 |
| Production frontend build | 17,802 modules; built in 1m 9s, existing warnings | 0 |
| Working-tree whitespace check | No whitespace errors | 0 |

Existing Browserslist age, lottie-web eval and large-chunk build warnings remain.
No backend source changed. Full backend and full-repository lint were not rerun;
previous evidence remains historical. Live three-video generation and packaged
Tauri restart acceptance remain NOT PERFORMED.

## Fifth notification follow-up: preserve Markdown history (starting HEAD `f8e8901`)

Verified on 2026-09-17. Refreshing an eligible legacy or retried successful result
now merges Markdown into the existing note. It retains local edits and every
previous version object, the original creation time, selected note, and saved
generation settings. Matching content reuses its existing version; incoming
repeated content is deduplicated and colliding version IDs receive unused suffixes.
Server metadata and the canonical source URL/platform are refreshed.

The note stores `currentMarkdownVersionId` in the same durable snapshot as its
versions and imported-attempt acknowledgement. Imported content is selected even
when a preserved local version has a later timestamp. A subsequent local edit
becomes current. The mounted viewer reacts to refreshed content; reload preserves
selection. Legacy notes without the field keep timestamp-based selection. A failed
storage write retains old versions and the outstanding import obligation, and its
retry commits without duplicating history. This supersedes the fourth follow-up's
replacement of old note contents; its receipt/deletion migration is unchanged.

The initial implementation run recorded seven store regression failures and two
viewer failures before their fixes; its focused four-suite run passed 57 tests.
The resumed verification inspected all four source/test changes and ran:

```powershell
npm test -- --run
npx tsc -p tsconfig.batch.json --noEmit
npx eslint src/features/batch/store.test.ts src/store/taskStore/index.ts src/pages/HomePage/components/MarkdownViewer.test.tsx
npm run build
```

Recovery used the same existing Python environment and command recorded above.

| Fifth follow-up check | Observed result on 2026-09-17 | Exit |
| --- | --- | --- |
| Complete frontend suite | 126 passed across 12 suites, 25.49s | 0 |
| Scoped TypeScript (`tsconfig.batch.json`) | No diagnostics | 0 |
| Changed store/test ESLint | No diagnostics | 0 |
| Viewer ESLint baseline comparison | 24 unchanged errors; warnings reduced from 2 to 1; no added diagnostics | 0 (comparison) |
| Recovery integration | 1 passed in 15.77s | 0 |
| Production frontend build | 17,802 modules; built in 1m 14s, existing warnings | 0 |
| Working-tree whitespace check | No whitespace errors | 0 |

The viewer comparison used ESLint `lintText` with the same file path/configuration
for `git show f8e8901:BillNote_frontend/src/pages/HomePage/components/MarkdownViewer.tsx`
and the working source. Diagnostic rule, severity, message, columns and exact
source spans matched as a multiset after accounting for shifted line numbers.
Only the first effect's missing-dependencies warning disappeared. Viewer lint is
still an explicit baseline exception, not clean lint. The scoped TypeScript config
does not include the viewer; no full-app TypeScript pass is claimed.

Existing Browserslist age, lottie-web eval and large-chunk build warnings remain.
Tests also print the existing retry fixture and the viewer dependency's unsupported
Notification API warning in jsdom. No backend source changed. Full backend and
full-repository lint were not rerun; previous evidence remains historical. Live
three-video generation and packaged Tauri restart acceptance remain NOT PERFORMED.

## Live source acceptance — 2026-09-17

Source commit: `0dabf8d54f7465e117c57672445bae27e104a353`.
This run used an isolated disposable copy of the source backend and Vite UI;
325 tracked backend/frontend files were byte-equal to that commit. It did not
build or run a packaged Tauri application. Provider alias/model: `qwen` /
`qwen3-vl-flash`; transcriber: local `fast-whisper`, `tiny`; FFmpeg available.
Real downloads, transcription, model generation, persistence, and Markdown
rendering were exercised, with no mocked APIs. Preview, ordered selection,
submission and process interruption/resume were driven through the source API
harness; the source UI supplied note rendering and supplemental notification
observations. This is not evidence that every creation-wizard step was clicked.

Local evidence root (uncommitted):
`E:\biliNote\batch-acceptance\20260917-live-source`.
Safe summaries are `three-item-result.json`, `recovery-result.json`,
`transition-audit.json`, `events.jsonl`, `verification.json`,
`final-verification.json`, `source-copy-verification.json`,
`ui-observations.json`, `cleanup-verification.json`, and
`sanitized-lifecycle.log`. Raw private logs, provider
configuration, and the disposable database are not publication artifacts and
were not staged. An exact-value scan of the exported summaries and documentation
found no configured provider credential or private provider endpoint.

### Ordered three-item batch

Batch `d41dbfcb-92b0-44f6-9aaa-1e5d80694027` (`Live source three-item acceptance`)
finished `PARTIAL` in **179.547 seconds**: success 2, failed 1, pending 0,
interrupted 0. The original execution claimed the jobs in this order:

| Position | Task ID | Source | Initial outcome |
| --- | --- | --- | --- |
| 0 | `bccce761-d71d-44e1-a677-f5079c0fa458` | `BV1Xt411275k?p=2` | `SUCCESS`, attempt 0 |
| 1 | `80ef2092-294f-4db9-80af-a5434182624c` | `BV0000000000?p=1` | `FAILED`, HTTP 404, attempt 0 |
| 2 | `9548d74f-1b49-4edd-8e76-103caab02534` | `BV1piKH6SEG2?p=1` | `SUCCESS`, attempt 0 |

The inaccessible fixture was accepted by the real preview API as syntactically
valid, then failed during execution. The third item started automatically after
that failure. A disposable SQLite transition-audit trigger recorded **42 status
transitions**, including recovery and supplemental retries; maximum active jobs
was **1** across parsing, downloading, transcribing, summarizing and saving.
The successful jobs each passed through transcription and summarization.

Both successful notes were opened and rendered in the Vite UI. Their results
live under separate `backend/data/tasks/<task_id>/<task_id>.json` paths. The
multipart result identifies `BV1Xt411275k_p2`, with 392.166 seconds of media;
the ordinary result identifies `BV1piKH6SEG2_p1`, with 169.393 seconds. Preview
metadata supplied the parent title and zero duration for multipart rows, so
part-specific preview title/duration quality remains a limitation; the selected
`p=2` URL and actual result establish which part ran.

| Successful task | SHA-256 of result JSON |
| --- | --- |
| `bccce761-d71d-44e1-a677-f5079c0fa458` | `fdd52660ca14fa89d625ef1df33039c75b47921e1bb7fa09b2e8e0b60b36fa80` |
| `9548d74f-1b49-4edd-8e76-103caab02534` | `2e9a1aa22857434d76b6f36cff0c774a5d3ad73659fb936f007a44b5a85ae2e2` |

Supplemental failed-item retries reached attempt 2 and remained `FAILED`.
The two successful jobs retained attempt 0 and their original result hashes.

### Process interruption and manual recovery

Batch `9e7f743a-65e9-4808-a1f5-a7dd9e832810` (`Live source process recovery`)
finished `COMPLETED`, success **2 / 2**, in **168.031 seconds** including the
interruption, restart, 12-second idle observation and explicit resume.

| Task ID | Before process termination | After backend restart | Final outcome |
| --- | --- | --- | --- |
| `7c55d693-f17f-4ed8-b236-c22323ef3677` | `SUCCESS`, attempt 0 | `SUCCESS`, attempt 0 | `SUCCESS`, attempt 0 |
| `110c755c-4338-447e-ac5c-5945f947ab18` | `PARSING`, attempt 0 | `INTERRUPTED`, attempt 0 | `SUCCESS`, attempt 1 |

Restart exposed `RECOVERABLE`. The next **12 seconds recorded zero status
transitions** before the explicit resume request. The second item restarted at
parsing and then downloaded, transcribed, summarized and saved. It did not resume
mid-stage. Terminal completion was recorded at `2026-09-17T08:05:56.646576Z`
(16:05:56 Asia/Shanghai). The first success retained its full job metadata,
attempt and result hash; the audit contains only one parsing claim for that task.
Thus this run did not rerun the prior success.

Recovery result hashes:

| Task ID | SHA-256 |
| --- | --- |
| `7c55d693-f17f-4ed8-b236-c22323ef3677` | `321a6395efd46979d030ecbf2701d6401e206a33f4829408f7a1b8d6e2b1c75b` |
| `110c755c-4338-447e-ac5c-5945f947ab18` | `a43961f27e3cb7e59a7952f5b0ff0e63b752b81b8d78512a783f983173231f14` |

### Notification observations and remaining scope

The original three-item terminal notification was **not captured**, so its
exactly-once behavior is not claimed. Recorded live accessibility observations
in `ui-observations.json` provide supplemental evidence:

- Recovery summary appeared at `08:06:46.488Z` and disappeared at `08:06:49.432Z`;
  one appearance was observed in a 22-second window, reporting success 2 / 2.
- Failed retry attempt 2 produced one summary in an 18-second window on `/batch`,
  appearing at `08:08:22.595Z` and disappearing at `08:08:27.612Z`; it reported
  success 2 / 3 and failure 1, demonstrating notification outside batch detail.
- A full-page reload at `08:08:48.343Z` was followed for 12 seconds; no summary
  appeared for those unchanged outcomes.

These finite observation windows support once-only behavior for the recorded
outcomes; they do not prove every notification scenario. Per-item toast absence,
browser/profile restart, delete/clear-history behavior, stop/cancel controls,
and a completely UI-driven creation flow were not separately observed live here.
Existing automated tests cover their documented cases independently.

Fresh evidence verification re-read the disposable database, audited claim order,
matched all four successful result hashes, confirmed no retry of the prior
success, and compared all 325 copied source files. Cleanup verification found no
remaining test-owned backend/Vite processes or listeners. Packaged Tauri normal
exit/reopen, sidecar termination, native notification behavior and matching
desktop artifact acceptance remain **NOT PERFORMED**. The process crash test
above is source-backend recovery evidence, not a desktop lifecycle pass.

## Manual three-item workflow — source API/UI coverage above; full UI checklist pending

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
   per-item success toasts. Before the final item ends, navigate to the batch list
   or note page and confirm the final summary still appears there. Reopen detail,
   refresh the whole page, then restart the app against the same profile: the same
   outcome must stay silent. A first visit to a historical completed batch after
   upgrading must also stay silent. Retry failed items and confirm exactly one new
   summary when that attempt ends. Record missing or repeated notifications as failures.
6. Record relative result paths and hashes. Confirm distinct
   `data/tasks/<task_id>/` directories, matching result task IDs, and the intended
   multipart content rather than the first part or entire multipart video.
   Click **打开笔记** for each success; verify real Markdown, title, and source,
   plus transcript/screenshots if selected. Reopen the detail page and confirm
   history imports do not duplicate either note. Delete one imported note, restart
   the app with the same profile, and confirm background discovery does not restore
   it. Repeat with clearing history. A newly successful retry attempt should still
   import its own result.
7. In a disposable follow-up batch, verify **停止后续任务** lets the current item
   finish but starts no later item; **继续生成** resumes it. Verify
   **取消等待项** leaves the active item running and cancels only waiting items.
   Use **重试失败项** on a controlled failure and confirm successful IDs/results
   remain unchanged. Record these supplemental checks separately.

Live source batch/task IDs, stage timestamps, note hashes and accessibility
observations are available in the dated section above. That partial API/UI run
does not complete every step of this manual UI checklist; screenshots were not
captured.

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

Desktop-run evidence: packaged exit/reopen logs, screenshots, task IDs and
provider-call counts are **not available**. A matching branch desktop artifact
was not built or launched. Live generation prerequisites were verified by the
source run above; packaged lifecycle acceptance remains pending.

## Historical Task 9 full lint baseline

This table is historical Task 9 evidence, captured for files byte-unchanged from
`6cc6be3` (each checked with `git diff --quiet 6cc6be3 -- <file>`, exit 0). The
fresh ESLint JSON's file, message, location, severity, and counts exactly matched
the preceding Task 9 JSON. All paths below are relative to `BillNote_frontend/`.
To reproduce exact diagnostic messages/locations, run the recorded lint command on
that baseline with the same installed dependencies.

The historical `MarkdownViewer.tsx` entry records 24 errors and two warnings; it
does not describe the later source. The [fifth follow-up comparison](#fifth-notification-follow-up-preserve-markdown-history)
is the authoritative update for that file: its 24 errors are unchanged, warnings
reduced from 2 to 1, and no diagnostics were added. This remains an explicit
baseline exception; no full lint rerun or clean lint pass is claimed.

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
