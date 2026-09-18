"""Request-bound, checksummed artifacts published with one atomic replacement.

Signatures identify generation inputs; SHA-256 checksums detect partial or edited
payloads. They are integrity checks, not authentication against a local attacker.
Unsigned legacy caches are deliberately never trusted for resumed generation.
"""
import hashlib
import json
import os
import shutil
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from app.models.audio_model import AudioDownloadResult
from app.models.notes_model import NoteResult
from app.models.transcriber_model import TranscriptResult, TranscriptSegment
from app.gpt.prompt_builder import generate_base_prompt
from app.gpt.prompt import MERGE_PROMPT


def digest(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
        separators=(',', ':'), default=str).encode('utf-8')).hexdigest()


def generation_signature(settings: dict) -> str:
    defaults = dict(quality='medium', model_name=None, provider_id=None, link=False,
        screenshot=False, format=[], style=None, extras=None, video_understanding=False,
        video_interval=0, grid_size=[], language=None)
    options = {key: settings.get(key, default) for key, default in defaults.items()}
    options['format'] = settings.get('_format', options['format']) or []
    options['grid_size'] = options['grid_size'] or []
    options['video_interval'] = options['video_interval'] or 0
    url = str(settings.get('video_url', '')).strip()
    parts = urlsplit(url)
    if parts.scheme in ('http', 'https'):
        url = urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path,
                         urlencode(sorted(parse_qsl(parts.query, keep_blank_values=True))), ''))
        source = {'url': url}
    else:
        path = Path(url).resolve()
        source = {'path': os.path.normcase(str(path))}
        if path.is_file():
            info = path.stat()
            source.update(size=info.st_size, modified_ns=info.st_mtime_ns)
    # Fingerprint effective instructions, including language/style/format rules.
    # Reading .py files here would break frozen/PyInstaller distributions.
    prompt_revision = digest({'summary': generate_base_prompt('', '', [],
        _format=options['format'], style=options['style'], extras=options['extras']),
        'merge': MERGE_PROMPT})
    from app.services.transcriber_config_manager import TranscriberConfigManager
    return digest(dict(version=2, task_id=settings.get('task_id'), source=source,
        platform=settings.get('platform'), options=options, prompt=prompt_revision,
        transcriber=TranscriberConfigManager().get_config(),
        request_bytes=os.getenv('OPENAI_MAX_REQUEST_BYTES', str(45 * 1024 * 1024))))


def seal(payload: dict, signature: str) -> dict:
    return {**payload, '_cache': {'version': 2, 'signature': signature, 'sha256': digest(payload)}}


def load_signed(path: Path, signature: str) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
        metadata = data.pop('_cache')
        if (metadata.get('version') == 2 and metadata.get('signature') == signature
                and metadata.get('sha256') == digest(data)):
            return data
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        pass
    return None


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    try:
        with temporary.open('w', encoding='utf-8') as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def save_signed(path: Path, payload: dict, signature: str) -> None:
    atomic_write(path, json.dumps(seal(payload, signature), ensure_ascii=False, indent=2))


def prepare_media(workspace, signature: str) -> None:
    """Discard only derived directories when ownership of their contents changed."""
    marker = workspace.root / 'media.identity.json'
    if load_signed(marker, signature) is None:
        root = workspace.root.resolve()
        for path in (workspace.media, workspace.frames, workspace.grids):
            if path.is_symlink() or path.resolve().parent != root:
                raise ValueError('media workspace must stay inside task root')
            if path.exists():
                shutil.rmtree(path)
        save_signed(marker, {'task_id': workspace.task_id}, signature)
    workspace.media.mkdir(parents=True, exist_ok=True)


def load_note_result(workspace, signature: str):
    data = load_signed(workspace.result, signature)
    try:
        if not data or not isinstance(data['markdown'], str) or not data['markdown'].strip():
            return None
        transcript = {**data['transcript'], 'raw': data['transcript'].get('raw')}
        cached_transcript = load_signed(workspace.transcript, signature)
        if cached_transcript is not None and {**cached_transcript, 'raw': cached_transcript.get('raw')} != transcript:
            return None
        return NoteResult(data['markdown'], TranscriptResult(
            language=transcript.get('language'), full_text=transcript['full_text'],
            segments=[TranscriptSegment(**segment) for segment in transcript['segments']], raw=transcript['raw']),
            AudioDownloadResult(**data['audio_meta']))
    except (KeyError, TypeError, ValueError, AttributeError):
        return None
