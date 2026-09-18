"""Real pipeline regressions; media/model boundaries are offline fixtures."""
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from tests.test_note_task_workspace import pipeline, workspace_for
from app.services import note as note_service
from app.gpt.universal_gpt import UniversalGPT
from app.models.gpt_model import GPTSource
from app.models.transcriber_model import TranscriptSegment


@pytest.fixture(autouse=True)
def isolated_pipeline_outputs(tmp_path, monkeypatch):
    from app.routers import note as router
    from app.services.vector_store import VectorStoreManager
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(router, 'NOTE_OUTPUT_DIR', str(tmp_path / 'legacy'))
    monkeypatch.setattr(VectorStoreManager, 'index_task', lambda self, task_id: None)


@pytest.mark.parametrize('task_id', ['same.', 'same ', 'SAME', 'con', 'nul.txt', 'a\x00b', 'a?b'])
def test_windows_alias_task_ids_cannot_open_another_workspace(tmp_path, task_id):
    with pytest.raises(ValueError):
        workspace_for(task_id, tmp_path)


def test_restart_after_summary_does_not_repeat_paid_gpt(pipeline, tmp_path, monkeypatch):
    workspace = workspace_for('restart', tmp_path)
    original = note_service.prepend_source_link
    monkeypatch.setattr(note_service, 'prepend_source_link', lambda *args: (_ for _ in ()).throw(RuntimeError('power loss')))
    with pytest.raises(RuntimeError, match='power loss'):
        note_service.NoteGenerator().generate('video', 'local', task_id='restart', workspace=workspace,
            status_callback=lambda *args: None)
    monkeypatch.setattr(note_service, 'prepend_source_link', original)
    pipeline.gpt.summarize = lambda source: pytest.fail('paid GPT repeated after durable summary')
    result = note_service.NoteGenerator().generate('video', 'local', task_id='restart', workspace=workspace,
        status_callback=lambda *args: None)
    assert result.markdown.endswith('# Lesson')


@pytest.mark.parametrize('changed', [
    {'video_url': 'video-b'}, {'provider_id': 'provider-b'}, {'model_name': 'other-model'},
    {'style': 'academic'}, {'extras': 'English please'}, {'link': True},
    {'screenshot': True}, {'_format': ['toc']}, {'video_interval': 30},
])
def test_reused_task_invalidates_source_and_config_dependent_caches(pipeline, tmp_path, changed):
    workspace = workspace_for('reuse', tmp_path)
    args = dict(video_url='video-a', platform='local', task_id='reuse', workspace=workspace,
                model_name='model-a', provider_id='provider-a', status_callback=lambda *args: None)
    note_service.NoteGenerator().generate(**args)
    pipeline.transcript.full_text = 'video B lesson'
    pipeline.transcript.segments[0].text = 'video B lesson'
    result = note_service.NoteGenerator().generate(**{**args, **changed})
    assert result.transcript.full_text == 'video B lesson'
    assert pipeline.sources[-1].segment[0].text == 'video B lesson'
    assert len(pipeline.downloads) >= 2


def test_unsigned_transcript_from_another_video_is_never_consumed(pipeline, tmp_path):
    workspace = workspace_for('unsigned', tmp_path)
    workspace.root.mkdir()
    workspace.transcript.write_text(json.dumps({'language': 'en', 'full_text': 'wrong video',
        'segments': [{'start': 0, 'end': 1, 'text': 'wrong video'}]}))
    result = note_service.NoteGenerator().generate('video', 'local', task_id='unsigned', workspace=workspace)
    assert result.transcript.full_text == 'lesson'


def offline_gpt(tmp_path):
    calls = []
    def create(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=f'paid answer {len(calls)}'))])
    gpt = UniversalGPT(SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create))), 'model')
    gpt.checkpoint_dir = tmp_path
    source = GPTSource(title='lesson', tags=[], segment=[TranscriptSegment(0, 1, 'lesson')], checkpoint_key='task')
    return gpt, source, calls


def test_completed_gpt_checkpoint_survives_crash_before_summary_write(tmp_path):
    gpt, source, calls = offline_gpt(tmp_path)
    assert gpt.summarize(source) == 'paid answer 1'
    assert gpt.summarize(source) == 'paid answer 1'
    assert len(calls) == 1


@pytest.mark.parametrize('change', ['provider_id', 'generation_signature', 'link', 'screenshot'])
def test_partial_gpt_checkpoint_cannot_cross_request_identity(tmp_path, change):
    gpt, source, calls = offline_gpt(tmp_path)
    gpt._save_checkpoint('task', gpt._build_source_signature(source), ['wrong request answer'], 'summarize')
    if change in ('link', 'screenshot'):
        setattr(source, change, True)
    else:
        setattr(gpt, change, 'changed')
    assert gpt.summarize(source) == 'paid answer 1'
    assert len(calls) == 1


def test_signed_final_republishes_after_legacy_projection_failure(pipeline, tmp_path, monkeypatch):
    from app.routers import note as router
    monkeypatch.setattr(router, 'NOTE_OUTPUT_DIR', str(tmp_path / 'legacy'))
    workspace = workspace_for('saved', tmp_path)
    request = router.VideoRequest(video_url='video', platform='local', quality='medium',
        task_id='saved', model_name='model', provider_id='provider')
    publish = router.save_note_to_file
    monkeypatch.setattr(router, 'save_note_to_file', lambda *args: (_ for _ in ()).throw(OSError('disk full')))
    with pytest.raises(OSError, match='disk full'):
        router.execute_note_job(request, workspace=workspace)
    assert workspace.result.is_file()
    monkeypatch.setattr(router, 'save_note_to_file', publish)
    monkeypatch.setattr(note_service.NoteGenerator, 'generate', lambda *args, **kw: pytest.fail('generation repeated'))
    result = router.execute_note_job(request, workspace=workspace)
    assert json.loads(result.read_text())['markdown'].endswith('# Lesson')
    assert json.loads((tmp_path / 'legacy' / 'saved.json').read_text())['markdown'].endswith('# Lesson')


def test_missing_downloaded_audio_is_fetched_again_before_reuse(pipeline, tmp_path):
    workspace = workspace_for('missing-audio', tmp_path)
    pipeline.downloader.download_subtitles = lambda *args, **kwargs: None
    download = pipeline.downloader.download
    def real_file(**kwargs):
        audio = download(**kwargs)
        Path(audio.file_path).write_bytes(b'audio')
        return audio
    pipeline.downloader.download = real_file
    args = dict(video_url='video', platform='local', task_id='missing-audio', workspace=workspace)
    note_service.NoteGenerator().generate(**args)
    (workspace.media / 'audio.mp3').unlink()
    # A transcript now exists, so the downloader can fetch metadata only; it
    # must still reject the cached reference to the deleted downloaded file.
    note_service.NoteGenerator().generate(**args)
    assert len(pipeline.downloads) == 2


def test_edited_summary_is_not_used_as_verified_output(pipeline, tmp_path):
    workspace = workspace_for('corrupt', tmp_path)
    args = dict(video_url='video', platform='local', task_id='corrupt', workspace=workspace)
    note_service.NoteGenerator().generate(**args)
    checkpoint = workspace.summary.with_suffix('.checkpoint.json')
    data = json.loads(checkpoint.read_text())
    data['markdown'] = 'wrong edited summary'
    checkpoint.write_text(json.dumps(data))
    result = note_service.NoteGenerator().generate(**args)
    assert result.markdown.endswith('# Lesson')
    assert len(pipeline.sources) == 2


def test_merge_checkpoint_never_restarts_source_chunk_generation(tmp_path):
    gpt, source, calls = offline_gpt(tmp_path)
    gpt.max_request_bytes = 5000
    source.segment = [TranscriptSegment(0, 1, 'lesson ' * 2500)]
    signature = gpt._build_source_signature(source)
    gpt._save_checkpoint('task', signature, ['already fully merged'], 'merge')
    assert gpt.summarize(source) == 'already fully merged'
    assert calls == []


def test_changed_prefetched_language_invalidates_summary(pipeline, tmp_path, monkeypatch):
    from app.services.note_artifacts import generation_signature, save_signed
    from dataclasses import asdict
    workspace = workspace_for('language', tmp_path)
    args = dict(video_url='video', platform='local', task_id='language', workspace=workspace)
    note_service.NoteGenerator().generate(**args)
    transcript = asdict(pipeline.transcript)
    transcript['language'] = 'zh'
    save_signed(workspace.transcript, transcript, generation_signature(args))
    note_service.NoteGenerator().generate(**args)
    assert len(pipeline.sources) == 2


def test_cache_fingerprints_work_without_unbundled_python_source_files(tmp_path, monkeypatch):
    from app.services.note_artifacts import generation_signature
    monkeypatch.setattr(Path, 'read_bytes', lambda self: (_ for _ in ()).throw(FileNotFoundError('bundled module')))
    assert len(generation_signature({'video_url': 'video', 'platform': 'local', 'task_id': 'packed'})) == 64


@pytest.mark.parametrize('raw', [None, {'source': 'platform-subtitles'}])
def test_transcript_optional_metadata_does_not_invalidate_durable_final(pipeline, tmp_path, raw):
    from app.routers import note as router
    from app.services.note_artifacts import generation_signature, load_note_result
    workspace = workspace_for('optional-transcript', tmp_path)
    request = router.VideoRequest(video_url='video', platform='local', quality='medium',
        task_id=workspace.task_id, model_name='model', provider_id='provider',
        prefetched_transcript={'language': 'en', 'full_text': 'lesson',
            'segments': [{'start': 0, 'end': 1, 'text': 'lesson'}]} if raw is None else None)
    pipeline.transcript.raw = raw
    router.execute_note_job(request, workspace=workspace)
    signature = generation_signature(request.model_dump(mode='json'))
    result = load_note_result(workspace, signature)
    assert result is not None
    assert result.transcript.raw == raw


def test_transcript_metadata_survives_resume_without_another_summary(pipeline, tmp_path):
    workspace = workspace_for('raw-resume', tmp_path)
    pipeline.transcript.raw = {'source': 'subtitles'}
    args = dict(video_url='video', platform='local', task_id=workspace.task_id, workspace=workspace)
    note_service.NoteGenerator().generate(**args)
    pipeline.gpt.summarize = lambda source: pytest.fail('unchanged transcript repeated GPT')
    result = note_service.NoteGenerator().generate(**args)
    assert result.transcript.raw == pipeline.transcript.raw


def test_failed_merge_resumes_saved_frontier_without_repeating_completed_group(tmp_path, monkeypatch):
    gpt, source, calls = offline_gpt(tmp_path)
    # Older isolation tests may reload app packages after this class was imported.
    chunker_class = gpt._merge_partials.__globals__['RequestChunker']
    signature = gpt._build_source_signature(source)
    original = ['part-a', 'part-b', 'part-c', 'part-d']
    gpt._save_checkpoint('task', signature, original, 'merge')
    monkeypatch.setattr(chunker_class, 'group_texts_by_budget',
        lambda self, texts, build: [texts[i:i + 2] for i in range(0, len(texts), 2)])
    real_create = gpt._chat_completion_create
    seen = []
    def fail_second(messages):
        seen.append(messages)
        if len(seen) == 2:
            raise RuntimeError('merge interrupted')
        return real_create(messages)
    monkeypatch.setattr(gpt, '_chat_completion_create', fail_second)
    with pytest.raises(RuntimeError, match='merge interrupted'):
        gpt.summarize(source)
    checkpoint = gpt._load_checkpoint('task', signature)
    assert checkpoint['phase'] == 'merge'
    assert checkpoint['partials'] == ['paid answer 1', 'part-c', 'part-d']
    monkeypatch.setattr(gpt, '_chat_completion_create', real_create)
    assert gpt.summarize(source).startswith('paid answer')
    assert 'part-a' not in str(calls[1:])
    assert 'part-b' not in str(calls[1:])
    assert gpt._load_checkpoint('task', signature)['phase'] == 'complete'
