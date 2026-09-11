# app/routers/note.py
import json
import os
import uuid
from pathlib import Path
from typing import Optional, Callable
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from pydantic import BaseModel, validator, field_validator
from dataclasses import asdict

from app.db.engine import get_db
from app.db.models.note_jobs import JobStatus, NoteJob
from app.db.note_queue_dao import JobRetryConflict, enqueue_single_job, update_job_status
from app.enmus.exception import NoteErrorEnum
from app.enmus.note_enums import DownloadQuality
from app.exceptions.note import NoteError
from app.services.note import NoteGenerator, logger
from app.services.task_workspace import TaskWorkspace
from app.models.notes_model import NoteResult
from app.services.task_serial_executor import task_serial_executor
from app.utils.response import ResponseWrapper as R
from app.utils.url_parser import extract_video_id
from app.validators.video_url_validator import is_supported_video_url
from fastapi.responses import StreamingResponse
import httpx
from app.enmus.task_status_enums import TaskStatus

# from app.services.downloader import download_raw_audio
# from app.services.whisperer import transcribe_audio

router = APIRouter()


class RecordRequest(BaseModel):
    video_id: str
    platform: str


class VideoRequest(BaseModel):
    video_url: str
    platform: str
    quality: DownloadQuality
    screenshot: Optional[bool] = False
    link: Optional[bool] = False
    model_name: str
    provider_id: str
    task_id: Optional[str] = None
    format: Optional[list] = []
    style: Optional[str] = None
    extras: Optional[str]=None
    video_understanding: Optional[bool] = False
    video_interval: Optional[int] = 0
    grid_size: Optional[list] = []
    # 客户端（如浏览器插件）已经在用户浏览器里抓到字幕，直接传给后端复用，
    # 跳过 download_subtitles 和音频转写。形如：
    #   {"language": "zh", "full_text": "...", "segments": [{"start","end","text"}, ...]}
    prefetched_transcript: Optional[dict] = None

    @field_validator("video_url")
    def validate_supported_url(cls, v):
        url = str(v)
        parsed = urlparse(url)
        if parsed.scheme in ("http", "https"):
            # 是网络链接，继续用原有平台校验
            if not is_supported_video_url(url):
                raise NoteError(code=NoteErrorEnum.PLATFORM_NOT_SUPPORTED.code,
                                message=NoteErrorEnum.PLATFORM_NOT_SUPPORTED.message)

        return v


NOTE_OUTPUT_DIR = os.getenv("NOTE_OUTPUT_DIR", "note_results")
UPLOAD_DIR = "uploads"


def atomic_save_note(task_id: str, note: NoteResult, target: Path) -> Path:
    """Publish a complete result only after its temporary file is flushed to disk."""
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f"{task_id}.json.tmp")
    try:
        with temporary.open("w", encoding="utf-8") as stream:
            json.dump(asdict(note), stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    return target


def save_note_to_file(task_id: str, note: NoteResult) -> Path:
    return atomic_save_note(task_id, note, Path(NOTE_OUTPUT_DIR) / f"{task_id}.json")


def _persist_prefetched_transcript(task_id: str, transcript: dict, workspace: Optional[TaskWorkspace] = None) -> None:
    """把客户端预取的字幕写到 NoteGenerator 期望的转写缓存文件里。

    NoteGenerator.generate 会优先读 <task_id>_transcript.json，命中即跳过 download_subtitles
    与音频转写流程。要求字段：language(可空)/full_text/segments[{start,end,text}]
    """
    segments = transcript.get("segments") or []
    cleaned_segments = []
    for s in segments:
        text = (s.get("text") or "").strip()
        if not text:
            continue
        cleaned_segments.append({
            "start": float(s.get("start", 0)),
            "end": float(s.get("end", 0)),
            "text": text,
        })
    if not cleaned_segments:
        raise ValueError("prefetched_transcript 没有可用的 segments")

    full_text = transcript.get("full_text") or " ".join(s["text"] for s in cleaned_segments)
    payload = {
        "language": transcript.get("language") or "zh",
        "full_text": full_text,
        "segments": cleaned_segments,
    }

    target = workspace.transcript if workspace else Path(NOTE_OUTPUT_DIR) / f"{task_id}_transcript.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    logger.info(f"已写入客户端预取字幕缓存: {target} ({len(cleaned_segments)} 段)")


def execute_note_job(
    request: VideoRequest,
    status_callback: Optional[Callable[[TaskStatus, str], None]] = None,
    workspace: Optional[TaskWorkspace] = None,
) -> Path:
    """Generate and durably save a job before reporting SUCCESS.

    The caller owns scheduling; legacy polling and indexing retain their
    note_results projection until all readers support workspace results.
    """
    task_id = request.task_id
    if not task_id:
        raise ValueError("task_id is required")
    if workspace is not None and workspace.task_id != task_id:
        raise ValueError("workspace does not belong to task_id")
    failed_reported = False

    def report(status, message=""):
        nonlocal failed_reported
        if status == TaskStatus.FAILED:
            failed_reported = True
        if status_callback is not None:
            status_callback(status, message)

    try:
        generator = NoteGenerator()
        if not request.model_name or not request.provider_id:
            raise HTTPException(status_code=400, detail="请选择模型和提供者")
        if request.prefetched_transcript:
            _persist_prefetched_transcript(task_id, request.prefetched_transcript, workspace)
        note = generator.generate(
            video_url=request.video_url, platform=request.platform, quality=request.quality,
            task_id=task_id, model_name=request.model_name, provider_id=request.provider_id,
            link=request.link, _format=request.format, style=request.style, extras=request.extras,
            screenshot=request.screenshot, video_understanding=request.video_understanding,
            video_interval=request.video_interval, grid_size=request.grid_size,
            workspace=workspace, status_callback=report,
        )
        if not note or not note.markdown:
            raise RuntimeError("Note generation returned no markdown")
        generator._report(task_id, TaskStatus.SAVING, callback=report)
        if workspace is not None:
            result_path = atomic_save_note(task_id, note, workspace.result)
            save_note_to_file(task_id, note)
        else:
            result_path = save_note_to_file(task_id, note)
    except Exception as exc:
        if not failed_reported:
            NoteGenerator._update_status(task_id, TaskStatus.FAILED, str(exc))
            report(TaskStatus.FAILED, str(exc))
        raise

    generator._report(task_id, TaskStatus.SUCCESS, callback=report)
    try:
        from app.services.vector_store import VectorStoreManager
        VectorStoreManager().index_task(task_id)
    except Exception as exc:
        logger.warning(f"向量索引失败（不影响笔记）: {exc}")
    return result_path


def run_queued_note(context, session_factory):
    """Adapt persisted jobs to the note pipeline and persist stage callbacks."""
    with session_factory() as session:
        job = session.get(NoteJob, context.task_id)
        settings = {**context.settings, "video_url": job.normalized_url,
                    "platform": job.platform, "task_id": context.task_id}
    request = VideoRequest(**settings)

    def report(status, message=""):
        # The queue owns terminal completion after execute_note_job returns.
        if status in (TaskStatus.SUCCESS, TaskStatus.FAILED):
            return
        with session_factory() as session:
            update_job_status(session, context.task_id, context.attempt,
                              JobStatus(status.value), error_message=message or None)

    return execute_note_job(request, status_callback=report, workspace=context.workspace)


def run_note_task(task_id: str, video_url: str, platform: str, quality: DownloadQuality,
                  link: bool = False, screenshot: bool = False, model_name: str = None, provider_id: str = None,
                  _format: list = None, style: str = None, extras: str = None, video_understanding: bool = False,
                  video_interval=0, grid_size=None):
    request = VideoRequest(
        task_id=task_id, video_url=video_url, platform=platform, quality=quality,
        link=link, screenshot=screenshot, model_name=model_name, provider_id=provider_id,
        format=_format, style=style, extras=extras, video_understanding=video_understanding,
        video_interval=video_interval, grid_size=grid_size,
    )
    logger.info(f"任务进入执行队列 (task_id={task_id})")
    return task_serial_executor.run(lambda: execute_note_job(request))


@router.post('/delete_task')
def delete_task(data: RecordRequest):
    try:
        # TODO: 待持久化完成
        # NoteGenerator().delete_note(video_id=data.video_id, platform=data.platform)
        return R.success(msg='删除成功')
    except Exception as e:
        return R.error(msg=e)


@router.post("/upload")
async def upload(file: UploadFile = File(...)):
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    file_location = os.path.join(UPLOAD_DIR, file.filename)

    with open(file_location, "wb+") as f:
        f.write(await file.read())

    # 假设你静态目录挂载了 /uploads
    return R.success({"url": f"/uploads/{file.filename}"})


@router.post("/generate_note")
def generate_note(data: VideoRequest, request: Request, session=Depends(get_db)):
    try:
        # 就绪门禁：本地转写引擎（fast-whisper / mlx-whisper）必须等模型下载完才能跑视频，
        # 否则任务会卡在首次下载（慢 / OOM / 截断），用户只看到一个静默失败的任务。
        # 客户端已抓好字幕（prefetched_transcript）则不需要转写，跳过检查。
        if not data.prefetched_transcript:
            from app.services.transcriber_config_manager import TranscriberConfigManager
            readiness = TranscriberConfigManager().is_model_ready()
            if not readiness["ready"]:
                logger.warning(f"拒绝 generate_note：{readiness['reason']}")
                return R.error(
                    msg=readiness["reason"],
                    code=300102,
                    data={
                        "reason": "transcriber_model_not_ready",
                        "transcriber_type": readiness["transcriber_type"],
                        "model_size": readiness["model_size"],
                        "downloading": readiness["downloading"],
                    },
                )

        task_id = data.task_id or str(uuid.uuid4())
        workspace = TaskWorkspace.for_task(task_id)
        settings = data.model_dump(mode="json", exclude={"task_id", "prefetched_transcript"})
        prepare = None
        if data.prefetched_transcript:
            prepare = lambda: _persist_prefetched_transcript(task_id, data.prefetched_transcript, workspace)
        enqueue_single_job(session, task_id, settings, prepare=prepare)
        request.app.state.note_queue.wake()
        return R.success({"task_id": task_id})
    except JobRetryConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (ValueError, TypeError, AttributeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc



@router.get("/task_status/{task_id}")
def get_task_status(task_id: str, session=Depends(get_db)):
    job = session.get(NoteJob, task_id)
    if job is not None:
        data = {"status": job.status, "message": job.error_message or "", "task_id": task_id}
        if job.status == JobStatus.SUCCESS.value:
            result_path = Path(job.result_path) if job.result_path else TaskWorkspace.for_task(task_id).result
            if result_path.is_file():
                with result_path.open(encoding="utf-8") as stream:
                    data["result"] = json.load(stream)
            else:
                data["message"] = "任务完成，但结果文件未找到"
        return R.success(data)

    status_path = os.path.join(NOTE_OUTPUT_DIR, f"{task_id}.status.json")
    result_path = os.path.join(NOTE_OUTPUT_DIR, f"{task_id}.json")

    # 优先读状态文件
    if os.path.exists(status_path):
        with open(status_path, "r", encoding="utf-8") as f:
            status_content = json.load(f)

        status = status_content.get("status")
        message = status_content.get("message", "")

        if status == TaskStatus.SUCCESS.value:
            # 成功状态的话，继续读取最终笔记内容
            if os.path.exists(result_path):
                with open(result_path, "r", encoding="utf-8") as rf:
                    result_content = json.load(rf)
                return R.success({
                    "status": status,
                    "result": result_content,
                    "message": message,
                    "task_id": task_id
                })
            else:
                # 理论上不会出现，保险处理
                return R.success({
                    "status": TaskStatus.PENDING.value,
                    "message": "任务完成，但结果文件未找到",
                    "task_id": task_id
                })

        if status == TaskStatus.FAILED.value:
            return R.error(message or "任务失败", code=500)

        # 处理中状态
        return R.success({
            "status": status,
            "message": message,
            "task_id": task_id
        })

    # 没有状态文件，但有结果
    if os.path.exists(result_path):
        with open(result_path, "r", encoding="utf-8") as f:
            result_content = json.load(f)
        return R.success({
            "status": TaskStatus.SUCCESS.value,
            "result": result_content,
            "task_id": task_id
        })

    # 什么都没有，默认PENDING
    return R.success({
        "status": TaskStatus.PENDING.value,
        "message": "任务排队中",
        "task_id": task_id
    })


@router.get("/image_proxy")
async def image_proxy(request: Request, url: str):
    headers = {
        "Referer": "https://www.bilibili.com/",
        "User-Agent": request.headers.get("User-Agent", ""),
    }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url, headers=headers)

            if resp.status_code != 200:
                raise HTTPException(status_code=resp.status_code, detail="图片获取失败")

            content_type = resp.headers.get("Content-Type", "image/jpeg")
            return StreamingResponse(
                resp.aiter_bytes(),
                media_type=content_type,
                headers={
                    "Cache-Control": "public, max-age=86400",  #  缓存一天
                    "Content-Type": content_type,
                }
            )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
