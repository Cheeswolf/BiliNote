# BiliNote Batch Video Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent local batch queue that accepts multi-line video links and selected Bilibili parts, then generates one note at a time with manual recovery after restart.

**Architecture:** SQLite is the source of truth for batches and jobs. A single lifecycle-managed worker claims one eligible job at a time and invokes the existing note pipeline through a task workspace and status callback. The React application adds a two-step batch form and a batch center that use aggregate polling while preserving the existing single-note preview and history.

**Tech Stack:** FastAPI, SQLAlchemy, SQLite, pytest/unittest, React 19, TypeScript, Zustand, Axios, Vitest, Testing Library, Vite, Tauri 2.

**Spec:** `docs/superpowers/specs/2026-09-10-batch-video-notes-design.md`

## Global Constraints

- Support multi-line Bilibili, YouTube, Douyin, and Kuaishou links plus Bilibili multipart selection.
- Limit one submitted batch to 100 selected videos.
- Run at most one single-note or batch job globally at a time.
- Continue with the next job after one job fails.
- On desktop restart, mark an in-flight job interrupted and wait for manual resume.
- Never persist provider API keys in batch or job settings snapshots.
- Preserve the existing `/api/generate_note` request and response contract.
- Mark a job successful only after its final result file has been atomically written.
- Use task-specific media, frame, grid, and checkpoint paths.

---

### Task 1: Persistent batch and job records

**Files:**
- Create: `backend/app/db/models/note_batches.py`
- Create: `backend/app/db/models/note_jobs.py`
- Create: `backend/app/db/note_queue_dao.py`
- Modify: `backend/app/db/init_db.py`
- Test: `backend/tests/test_note_queue_dao.py`

**Interfaces:**
- Produces: `BatchStatus`, `JobStatus`, `NoteBatch`, `NoteJob`.
- Produces: `create_batch(session, request_id, name, source_label, settings, items) -> NoteBatch`.
- Produces: `get_batch_detail(session, batch_id) -> tuple[NoteBatch, list[NoteJob]]`.
- Produces: `claim_next_job(session) -> NoteJob | None` and attempt-guarded status update methods.

- [ ] **Step 1: Write failing persistence and idempotency tests**

Use a temporary SQLite engine and assert that one transaction creates a batch with ordered jobs, that repeating `request_id` returns the same batch, and that no persisted JSON contains `api_key`:

```python
def test_create_batch_is_atomic_ordered_and_idempotent(db_session):
    items = [
        {"original_url": "https://www.bilibili.com/video/BV1xx?p=2", "normalized_url": "https://www.bilibili.com/video/BV1xx?p=2", "platform": "bilibili", "resource_key": "bilibili:BV1xx:p2"},
        {"original_url": "https://youtu.be/abcdefghijk", "normalized_url": "https://youtu.be/abcdefghijk", "platform": "youtube", "resource_key": "youtube:abcdefghijk"},
    ]
    first = create_batch(db_session, "request-1", "课程", "多行链接", {"model_name": "demo", "api_key": "secret"}, items)
    second = create_batch(db_session, "request-1", "课程", "多行链接", {"model_name": "demo"}, items)
    assert first.id == second.id
    _, jobs = get_batch_detail(db_session, first.id)
    assert [job.position for job in jobs] == [0, 1]
    assert "secret" not in first.settings_json
```

- [ ] **Step 2: Run the new test and verify it fails**

Run: `cd backend && pytest tests/test_note_queue_dao.py -v`  
Expected: FAIL because the models and DAO do not exist.

- [ ] **Step 3: Add enums and SQLAlchemy models**

Define exact status values:

```python
class BatchStatus(str, enum.Enum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    PAUSED = "PAUSED"
    RECOVERABLE = "RECOVERABLE"
    COMPLETED = "COMPLETED"
    PARTIAL = "PARTIAL"
    CANCELLED = "CANCELLED"

class JobStatus(str, enum.Enum):
    PENDING = "PENDING"
    PARSING = "PARSING"
    DOWNLOADING = "DOWNLOADING"
    TRANSCRIBING = "TRANSCRIBING"
    SUMMARIZING = "SUMMARIZING"
    FORMATTING = "FORMATTING"
    SAVING = "SAVING"
    SUCCESS = "SUCCESS"
    FAILED = "FAILED"
    INTERRUPTED = "INTERRUPTED"
    CANCELLED = "CANCELLED"
```

Use UUID strings for `NoteBatch.id` and `NoteJob.task_id`, a unique constraint on `NoteBatch.request_id`, and a unique constraint on `(batch_id, position)`. Store settings as JSON text so the existing SQLite setup remains portable.

- [ ] **Step 4: Implement transactional DAO operations**

Add `sanitize_settings()` that recursively removes `api_key`, `apiKey`, and `token`; create batch and jobs under one `session.begin()`; catch `IntegrityError`, roll back, and return the existing request. Implement claim with a conditional update from `PENDING` to `PARSING`, ordered by batch creation and job position.

```python
def update_job_status(session, task_id: str, attempt: int, status: JobStatus, *, error_message: str | None = None) -> bool:
    changed = session.query(NoteJob).filter(
        NoteJob.task_id == task_id,
        NoteJob.attempt == attempt,
    ).update({"status": status.value, "error_message": error_message, "updated_at": datetime.utcnow()})
    session.commit()
    return changed == 1
```

- [ ] **Step 5: Register both models and run tests**

Import both model modules in `init_db.py` before `Base.metadata.create_all()`.  
Run: `cd backend && pytest tests/test_note_queue_dao.py -v`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/app/db backend/tests/test_note_queue_dao.py
git commit -m "feat(backend): persist note batches and jobs"
```

### Task 2: URL normalization and Bilibili multipart preview

**Files:**
- Create: `backend/app/services/batch_preview.py`
- Modify: `backend/app/utils/url_parser.py`
- Modify: `backend/app/downloaders/bilibili_downloader.py`
- Test: `backend/tests/test_batch_preview.py`

**Interfaces:**
- Produces: `PreviewItem` dataclass with `original_url`, `normalized_url`, `platform`, `resource_key`, `title`, `cover_url`, `duration`, `valid`, `error`.
- Produces: `normalize_video_url(url: str, platform: str | None = None) -> PreviewItem`.
- Produces: `preview_batch(lines: list[str], expand_multipart: bool = True) -> list[PreviewItem]`.
- Produces: `BilibiliDownloader.list_parts(url: str) -> list[BilibiliPart]`.

- [ ] **Step 1: Write failing normalization and multipart tests**

```python
def test_bilibili_resource_key_keeps_part_and_drops_tracking():
    item = normalize_video_url("https://www.bilibili.com/video/BV1abc/?p=2&spm_id_from=333")
    assert item.normalized_url == "https://www.bilibili.com/video/BV1abc?p=2"
    assert item.resource_key == "bilibili:BV1abc:p2"

def test_preview_expands_parts_in_source_order(monkeypatch):
    monkeypatch.setattr(BilibiliDownloader, "list_parts", lambda self, url: [
        BilibiliPart(page=1, title="第一讲", duration=60, cover_url="cover"),
        BilibiliPart(page=2, title="第二讲", duration=90, cover_url="cover"),
    ])
    items = preview_batch(["https://www.bilibili.com/video/BV1abc"])
    assert [item.resource_key for item in items] == ["bilibili:BV1abc:p1", "bilibili:BV1abc:p2"]
```

- [ ] **Step 2: Run and verify failure**

Run: `cd backend && pytest tests/test_batch_preview.py -v`  
Expected: FAIL because the preview service does not exist.

- [ ] **Step 3: Implement pure URL normalization**

Resolve `b23.tv` with a bounded request timeout. Recognize supported hosts, preserve the content-selecting Bilibili `p` parameter, remove tracking parameters, and deduplicate by `resource_key` while keeping first occurrence order. Invalid entries stay in the preview response with a Chinese error reason.

```python
def bilibili_resource_key(url: str) -> str:
    video_id = extract_video_id(url, "bilibili")
    page = extract_bilibili_p_number(url) or 1
    if not video_id:
        raise ValueError("无法识别 B 站 BV 号")
    return f"bilibili:{video_id}:p{page}"
```

- [ ] **Step 4: Implement Bilibili part metadata lookup**

Use yt-dlp metadata with `download=False` and `extract_flat=True`; map `entries` in page order to `BilibiliPart`. If the URL explicitly contains `p`, return that part only. Close temporary cookie resources through the downloader’s existing cleanup path.

- [ ] **Step 5: Run tests**

Run: `cd backend && pytest tests/test_batch_preview.py tests/test_video_url_support.py -v`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/app/services/batch_preview.py backend/app/utils/url_parser.py backend/app/downloaders/bilibili_downloader.py backend/tests/test_batch_preview.py
git commit -m "feat(backend): preview links and Bilibili parts"
```

### Task 3: Single-slot queue worker and restart recovery

**Files:**
- Create: `backend/app/services/note_queue.py`
- Modify: `backend/app/services/task_serial_executor.py`
- Test: `backend/tests/test_note_queue_service.py`
- Modify test: `backend/tests/test_task_serial_executor.py`

**Interfaces:**
- Consumes: `claim_next_job`, `update_job_status`, batch/job enums from Task 1.
- Produces: `NoteQueueService(session_factory, runner)` with `start()`, `stop()`, `wake()`, `recover_interrupted_jobs()`, `run_once()`.
- Produces: `QueueJobContext(task_id, attempt, workspace, settings)` passed to the runner.

- [ ] **Step 1: Write failing serial, failure-continuation, and recovery tests**

Use a fake runner that records concurrent count and raises for the second job. Assert peak active count is one, the third job still runs, and restart converts running stages to interrupted without automatically claiming them.

```python
def test_failure_does_not_block_next_job(queue_with_three_jobs):
    service, jobs, seen = queue_with_three_jobs
    service.run_once()
    service.run_once()
    service.run_once()
    assert seen == [jobs[0].task_id, jobs[1].task_id, jobs[2].task_id]
    assert load_job(jobs[1].task_id).status == JobStatus.FAILED.value
    assert load_job(jobs[2].task_id).status == JobStatus.SUCCESS.value
```

- [ ] **Step 2: Run and verify failure**

Run: `cd backend && pytest tests/test_note_queue_service.py tests/test_task_serial_executor.py -v`  
Expected: FAIL because the worker is absent and the old executor still permits three workers.

- [ ] **Step 3: Implement the worker lifecycle and wake loop**

Use one daemon thread, a `threading.Event`, and a stop event. `run_once()` claims no more than one job and always persists a terminal state before returning. Paused and recoverable batches are excluded by `claim_next_job`. `recover_interrupted_jobs()` updates nonterminal jobs to `INTERRUPTED` and their batch to `RECOVERABLE`.

```python
def _loop(self) -> None:
    while not self._stop.is_set():
        if not self.run_once():
            self._wake.wait(timeout=1.0)
            self._wake.clear()
```

- [ ] **Step 4: Make the compatibility executor actually serial**

Set `ConcurrentTaskExecutor` default to one worker or replace it with `SerialTaskExecutor(max_workers=1)`. The queue becomes the only normal call site, but the compatibility export must still satisfy its existing test.

- [ ] **Step 5: Run tests**

Run: `cd backend && pytest tests/test_note_queue_service.py tests/test_task_serial_executor.py -v`  
Expected: PASS and asserted peak concurrency `1`.

- [ ] **Step 6: Commit**

```bash
git add backend/app/services/note_queue.py backend/app/services/task_serial_executor.py backend/tests/test_note_queue_service.py backend/tests/test_task_serial_executor.py
git commit -m "feat(backend): run note jobs through a recoverable serial queue"
```

### Task 4: Task workspace, stage callbacks, and atomic results

**Files:**
- Create: `backend/app/services/task_workspace.py`
- Modify: `backend/app/services/note.py`
- Modify: `backend/app/routers/note.py`
- Modify: `backend/app/utils/video_reader.py`
- Modify: `backend/app/utils/video_helper.py`
- Test: `backend/tests/test_note_task_workspace.py`
- Test: `backend/tests/test_note_atomic_result.py`

**Interfaces:**
- Produces: `TaskWorkspace.for_task(task_id) -> TaskWorkspace` with `root`, `media`, `frames`, `grids`, `transcript`, `summary`, `result` paths.
- Changes: `NoteGenerator.generate(..., workspace: TaskWorkspace | None = None, status_callback: Callable[[TaskStatus, str], None] | None = None)`.
- Produces: `atomic_save_note(task_id: str, note: NoteResult, target: Path) -> Path`.

- [ ] **Step 1: Write failing isolation and save-order tests**

```python
def test_task_workspaces_do_not_share_frame_paths(tmp_path):
    one = TaskWorkspace.for_task("one", root=tmp_path)
    two = TaskWorkspace.for_task("two", root=tmp_path)
    assert one.frames != two.frames
    assert one.media.parent == one.root

def test_success_is_emitted_after_atomic_result(monkeypatch, tmp_path):
    events = []
    monkeypatch.setattr(note_router, "atomic_save_note", lambda *args: events.append("saved") or tmp_path / "result.json")
    callback = lambda status, message="": events.append(status.value)
    execute_note_job(fake_request, callback)
    assert events.index("saved") < events.index("SUCCESS")
```

- [ ] **Step 2: Run and verify failure**

Run: `cd backend && pytest tests/test_note_task_workspace.py tests/test_note_atomic_result.py -v`  
Expected: FAIL because workspace and atomic saving are absent.

- [ ] **Step 3: Route all cache and media paths through `TaskWorkspace`**

Create directories lazily. Pass `workspace.media` to downloader methods, `workspace.frames` and `workspace.grids` to `VideoReader`, and use workspace-owned transcript and summary files. Stop deriving task IDs from `markdown_cache_file.stem`; pass the real `task_id` to summarization status updates.

- [ ] **Step 4: Add callback-backed status updates**

Keep JSON status projection for old tasks, but call the queue callback for new tasks:

```python
def _report(self, task_id, status, message="", callback=None):
    self._update_status(task_id, status, message)
    if callback:
        callback(status, message)
```

Create the transcriber only when transcript fallback is actually needed, so enqueueing or parsing does not initialize Whisper.

- [ ] **Step 5: Save the final result atomically**

Serialize to `<task_id>.json.tmp`, flush and `os.fsync()`, then call `os.replace(temp_path, final_path)`. Emit SUCCESS only after replacement. Keep vector indexing after success and log its failure without changing the job result.

- [ ] **Step 6: Run focused and existing media tests**

Run: `cd backend && pytest tests/test_note_task_workspace.py tests/test_note_atomic_result.py tests/test_video_reader_dedupe.py tests/test_screenshot_marker.py tests/test_universal_gpt_checkpoint.py -v`  
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/app/services/task_workspace.py backend/app/services/note.py backend/app/routers/note.py backend/app/utils/video_reader.py backend/app/utils/video_helper.py backend/tests/test_note_task_workspace.py backend/tests/test_note_atomic_result.py
git commit -m "refactor(backend): isolate note jobs and save results atomically"
```

### Task 5: Queue integration for existing single-note requests

**Files:**
- Modify: `backend/main.py`
- Modify: `backend/app/routers/note.py`
- Modify: `backend/app/__init__.py`
- Test: `backend/tests/test_generate_note_queue.py`

**Interfaces:**
- Consumes: `NoteQueueService` and job DAO.
- Produces: `app.state.note_queue` during FastAPI lifespan.
- Preserves: `POST /api/generate_note -> {task_id: str}`.

- [ ] **Step 1: Write a failing API compatibility test**

Override database/session dependencies and inject a fake queue. Assert `/api/generate_note` creates a `batch_id=None` job, wakes the queue, and returns the task ID without scheduling FastAPI `BackgroundTasks`.

```python
def test_generate_note_enqueues_single_job(client, fake_queue):
    response = client.post("/api/generate_note", json=valid_note_payload())
    assert response.status_code == 200
    assert response.json()["data"]["task_id"]
    assert fake_queue.wake_count == 1
```

- [ ] **Step 2: Run and verify failure**

Run: `cd backend && pytest tests/test_generate_note_queue.py -v`  
Expected: FAIL because the endpoint still uses `BackgroundTasks`.

- [ ] **Step 3: Start and stop the queue in lifespan**

After `init_db()`, construct the singleton, run recovery, and start it. In `finally` after `yield`, call `stop()`. Store it on `app.state` so routers can wake the exact lifecycle instance.

- [ ] **Step 4: Replace single-note background execution with a queue record**

Serialize the existing request fields into the sanitized settings snapshot, persist prefetched transcript inside the new task workspace, create a standalone job, and call `request.app.state.note_queue.wake()`. Preserve the transcriber readiness response and the old `task_id` retry behavior through DAO retry rules.

- [ ] **Step 5: Make task status read SQLite first**

For a known `NoteJob`, return its database state and final result when successful. If no job exists, fall back to existing status JSON and result JSON behavior so old history remains readable.

- [ ] **Step 6: Run API and regression tests**

Run: `cd backend && pytest tests/test_generate_note_queue.py tests/test_note_helper.py tests/test_task_serial_executor.py -v`  
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/main.py backend/app/__init__.py backend/app/routers/note.py backend/tests/test_generate_note_queue.py
git commit -m "feat(backend): enqueue single note generation"
```

### Task 6: Batch management API

**Files:**
- Create: `backend/app/models/batch_models.py`
- Create: `backend/app/routers/batch.py`
- Modify: `backend/app/__init__.py`
- Modify: `backend/app/db/note_queue_dao.py`
- Test: `backend/tests/test_batch_api.py`

**Interfaces:**
- Consumes: preview service, DAO, and app queue from Tasks 1–5.
- Produces: `/api/batch/preview`, `/submit`, list/detail, pause, resume, retry-failed, and cancel-pending routes.

- [ ] **Step 1: Write failing endpoint behavior tests**

Test preview without persistence, submit limit 100, request idempotency, ordered detail, pause, manual resume, retry of only failed/interrupted jobs, and cancellation of only pending jobs.

```python
def test_retry_failed_does_not_touch_success(client, seeded_batch):
    response = client.post(f"/api/batch/{seeded_batch.id}/retry-failed")
    assert response.status_code == 200
    jobs = fetch_jobs(seeded_batch.id)
    assert status_of(jobs, "success") == ("SUCCESS", 0)
    assert status_of(jobs, "failed") == ("PENDING", 1)
    assert status_of(jobs, "interrupted") == ("PENDING", 1)
```

- [ ] **Step 2: Run and verify failure**

Run: `cd backend && pytest tests/test_batch_api.py -v`  
Expected: FAIL with missing batch router.

- [ ] **Step 3: Define request and response models**

Use strict Pydantic models: `BatchPreviewRequest(lines: list[str], expand_multipart: bool=True)`, `BatchSubmitRequest(request_id, name, source_label, items, settings)`, lightweight `BatchSummary`, and `BatchDetail`. Validate `1 <= len(selected items) <= 100` and reject unknown settings fields that could smuggle credentials.

- [ ] **Step 4: Implement preview and submission**

Preview calls `preview_batch()` and returns valid and invalid rows. Submit repeats normalization and validation server-side, creates the transaction through the DAO, wakes the queue, and returns existing identifiers when the same `request_id` is retried.

- [ ] **Step 5: Implement state transition endpoints**

Pause changes only batch eligibility. Resume converts `INTERRUPTED` jobs to `PENDING`, changes `RECOVERABLE/PAUSED` to `PENDING`, and wakes the worker. Retry-failed increments `attempt`, clears the error, and queues only `FAILED/INTERRUPTED`. Cancel-pending changes only `PENDING` jobs and recomputes batch status.

- [ ] **Step 6: Register the router and run tests**

Run: `cd backend && pytest tests/test_batch_api.py tests/test_note_queue_service.py -v`  
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/app/models/batch_models.py backend/app/routers/batch.py backend/app/__init__.py backend/app/db/note_queue_dao.py backend/tests/test_batch_api.py
git commit -m "feat(backend): expose batch note management API"
```

### Task 7: Frontend batch domain, API client, store, and resilient polling

**Files:**
- Modify: `BillNote_frontend/package.json`
- Create: `BillNote_frontend/src/features/batch/types.ts`
- Create: `BillNote_frontend/src/features/batch/api.ts`
- Create: `BillNote_frontend/src/features/batch/store.ts`
- Create: `BillNote_frontend/src/features/batch/useBatchPolling.ts`
- Create: `BillNote_frontend/src/features/batch/store.test.ts`
- Create: `BillNote_frontend/src/features/batch/useBatchPolling.test.tsx`
- Modify: `BillNote_frontend/src/store/taskStore/index.ts`
- Modify: `BillNote_frontend/src/hooks/useTaskPolling.ts`

**Interfaces:**
- Produces: `BatchStatus`, `BatchJobStatus`, `BatchSummary`, `BatchDetail`, `BatchPreviewItem` TypeScript types matching Task 6.
- Produces: typed API methods `previewBatch`, `submitBatch`, `listBatches`, `getBatch`, `pauseBatch`, `resumeBatch`, `retryFailed`, `cancelPending`.
- Produces: `useBatchStore` and `useBatchPolling(batchId, interval=3000)`.

- [ ] **Step 1: Add the frontend test command and write failing store/polling tests**

Add `"test": "vitest run"` and dev dependencies for Vitest, jsdom, React Testing Library, and user-event. Assert successful results import once by `task_id`, a network rejection sets `connection: 'offline'` without changing job status, and terminal batches stop polling.

```typescript
it('keeps job status when polling loses the backend', async () => {
  useBatchStore.setState({ active: detailWithJob('SUMMARIZING'), connection: 'online' })
  getBatchMock.mockRejectedValueOnce(new Error('offline'))
  renderHook(() => useBatchPolling('batch-1', 10))
  await waitFor(() => expect(useBatchStore.getState().connection).toBe('offline'))
  expect(useBatchStore.getState().active?.jobs[0].status).toBe('SUMMARIZING')
})
```

- [ ] **Step 2: Install test dependencies and verify failure**

Run: `cd BillNote_frontend && npm install`  
Run: `cd BillNote_frontend && npm test -- src/features/batch`  
Expected: FAIL because feature modules are absent.

- [ ] **Step 3: Implement exact frontend types and API client**

Use `request` with `suppressToast: true` for polling only. Mutation methods keep normal error feedback. Match backend status strings exactly and keep connection status as a separate union: `'online' | 'offline' | 'reconnecting'`.

- [ ] **Step 4: Implement store and non-overlapping polling**

Keep an `inFlight` ref so a slow request is never overlapped. Poll every three seconds, back off after network failures, reset to three seconds on success, and stop when the active batch is `COMPLETED`, `PARTIAL`, or `CANCELLED`. Import a successful note into the existing task store only if that task has not already been imported.

- [ ] **Step 5: Fix the existing task status contract**

Replace `FAILD` with `FAILED`, include all backend stages plus `INTERRUPTED` and `CANCELLED`, and change the existing single-task polling catch block to record connectivity without setting the task to failed.

- [ ] **Step 6: Run tests and type-aware build**

Run: `cd BillNote_frontend && npm test -- src/features/batch`  
Run: `cd BillNote_frontend && npm run build`  
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add BillNote_frontend/package.json BillNote_frontend/package-lock.json BillNote_frontend/src/features/batch BillNote_frontend/src/store/taskStore/index.ts BillNote_frontend/src/hooks/useTaskPolling.ts
git commit -m "feat(frontend): add batch state and resilient polling"
```

### Task 8: Batch creation and batch center UI

**Files:**
- Create: `BillNote_frontend/src/features/batch/BatchCreatePage.tsx`
- Create: `BillNote_frontend/src/features/batch/BatchVideoPicker.tsx`
- Create: `BillNote_frontend/src/features/batch/BatchSettings.tsx`
- Create: `BillNote_frontend/src/features/batch/BatchListPage.tsx`
- Create: `BillNote_frontend/src/features/batch/BatchDetailPage.tsx`
- Create: `BillNote_frontend/src/features/batch/BatchCreatePage.test.tsx`
- Create: `BillNote_frontend/src/features/batch/BatchDetailPage.test.tsx`
- Create: `BillNote_frontend/src/pages/HomePage/components/GenerationSettings.tsx`
- Modify: `BillNote_frontend/src/pages/HomePage/components/NoteForm.tsx`
- Modify: `BillNote_frontend/src/layouts/HomeLayout.tsx`
- Modify: `BillNote_frontend/src/App.tsx`

**Interfaces:**
- Consumes: batch domain from Task 7 and existing model/config stores.
- Produces: routes `/batch/new`, `/batch`, `/batch/:batchId`.
- Produces: reusable `GenerationSettings` that emits the existing note settings payload without API credentials.

- [ ] **Step 1: Write failing interaction tests**

Test multi-line preview, invalid-row removal, multipart selection, 100-item guard, start-button count, batch progress labels, manual continue, retry failed, and opening a successful note.

```typescript
it('submits only selected valid items in displayed order', async () => {
  render(<BatchCreatePage />)
  await userEvent.type(screen.getByLabelText('视频链接'), 'https://b23.tv/a\ninvalid')
  await userEvent.click(screen.getByRole('button', { name: '解析链接' }))
  await userEvent.click(screen.getByRole('button', { name: '移除无效项' }))
  await userEvent.click(screen.getByRole('button', { name: '下一步' }))
  expect(screen.getByRole('button', { name: '开始生成 2 条笔记' })).toBeEnabled()
})
```

- [ ] **Step 2: Run and verify failure**

Run: `cd BillNote_frontend && npm test -- src/features/batch/BatchCreatePage.test.tsx src/features/batch/BatchDetailPage.test.tsx`  
Expected: FAIL because pages and controls do not exist.

- [ ] **Step 3: Extract shared generation settings**

Move model, style, format, screenshot, video-understanding, interval, grid, and extras controls from `NoteForm.tsx` into `GenerationSettings`. Keep the existing single-note defaults and submission payload unchanged.

- [ ] **Step 4: Build the two-step creation page**

Step one renders the textarea, parse action, metadata rows, validity messages, full select, inverse select, clear, and remove-invalid actions. Step two renders `GenerationSettings`, selected count, and a submit button. Generate one UUID `request_id` per creation attempt and retain it while retrying a timed-out submit.

- [ ] **Step 5: Build list and detail pages**

List cards show name, source, creation time, progress, and success/failure/pending/interrupted counts. Detail rows show actual stage and error text. Wire pause, resume, retry-failed, and cancel-pending buttons to API mutations followed by immediate refresh. Successful rows call the existing task-store selection and navigate to the note preview.

- [ ] **Step 6: Add navigation and routes**

Add “单个视频” and “批量任务” entries without removing the current home route. Lazy-load batch pages from `App.tsx`. Ensure HashRouter routes work in the packaged desktop application.

- [ ] **Step 7: Run UI tests, build, and lint**

Run: `cd BillNote_frontend && npm test -- src/features/batch`  
Run: `cd BillNote_frontend && npm run build`  
Run: `cd BillNote_frontend && npm run lint`  
Expected: all pass. If lint exposes pre-existing unrelated failures, record the exact baseline separately and ensure no new failure touches changed files.

- [ ] **Step 8: Commit**

```bash
git add BillNote_frontend/src/features/batch BillNote_frontend/src/pages/HomePage/components/GenerationSettings.tsx BillNote_frontend/src/pages/HomePage/components/NoteForm.tsx BillNote_frontend/src/layouts/HomeLayout.tsx BillNote_frontend/src/App.tsx
git commit -m "feat(frontend): add batch creation and task center"
```

### Task 9: Full recovery, regression, and real workflow verification

**Files:**
- Create: `backend/tests/test_batch_recovery_integration.py`
- Create: `docs/testing/batch-video-notes-smoke-test.md`
- Modify only if failures reveal defects: files owned by Tasks 1–8

**Interfaces:**
- Consumes: complete batch feature.
- Produces: repeatable automated recovery test and recorded manual desktop acceptance steps.

- [ ] **Step 1: Write the recovery integration test**

Seed three jobs and use a controllable fake note runner. Complete the first, fail the second, interrupt the third by stopping the worker, recreate the service, verify `INTERRUPTED`, call resume, and verify final batch `PARTIAL` with no successful-job rerun.

```python
def test_restart_requires_manual_resume_and_preserves_success(test_app):
    batch = submit_three_jobs(test_app)
    complete_first_and_interrupt_third(test_app, batch.id)
    restarted = restart_backend(test_app)
    assert job_statuses(restarted, batch.id) == ["SUCCESS", "FAILED", "INTERRUPTED"]
    assert runner_calls("first") == 1
    restarted.post(f"/api/batch/{batch.id}/resume")
    wait_for_terminal(restarted, batch.id)
    assert runner_calls("first") == 1
```

- [ ] **Step 2: Run all backend tests**

Run: `cd backend && pytest tests -v`  
Expected: PASS.

- [ ] **Step 3: Run all frontend checks**

Run: `cd BillNote_frontend && npm test`  
Run: `cd BillNote_frontend && npm run build`  
Run: `cd BillNote_frontend && npm run lint`  
Expected: PASS, subject only to an explicitly recorded unchanged lint baseline.

- [ ] **Step 4: Perform the real three-item batch test**

Use the configured local provider and transcriber with: one selected Bilibili multipart item, one ordinary valid video, and one deliberately invalid or inaccessible video. Verify actual order, maximum one active job, failure continuation, separate result directories, successful note previews, and one final batch summary.

- [ ] **Step 5: Verify desktop restart recovery**

Start a batch, exit the Tauri application while one job is active, reopen it, verify the batch shows interrupted/waiting states without automatic model use, click “继续生成”, and verify the batch completes without rerunning earlier successes.

- [ ] **Step 6: Record evidence**

Write commands, test dates, sample task IDs, observed statuses, and any known limitation to `docs/testing/batch-video-notes-smoke-test.md`. Do not include cookies, provider keys, local secrets, or full private URLs.

- [ ] **Step 7: Commit**

```bash
git add backend/tests/test_batch_recovery_integration.py docs/testing/batch-video-notes-smoke-test.md
git commit -m "test: verify batch note recovery and workflow"
```

- [ ] **Step 8: Run final verification from a clean Git status**

Run: `git status --short`  
Run: `cd backend && pytest tests -q`  
Run: `cd BillNote_frontend && npm test -- --run`  
Run: `cd BillNote_frontend && npm run build`  
Expected: clean status after committed generated files, all tests pass, and the production build completes.
