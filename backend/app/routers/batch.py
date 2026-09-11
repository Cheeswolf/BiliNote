"""Batch creation and manual queue controls."""

from dataclasses import asdict

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.db.engine import get_db
from app.db.note_queue_dao import (
    create_batch, get_batch_detail, get_batch_counts, list_batches, manage_batch,
)
from app.models.batch_models import (
    BatchDetail, BatchJobSummary, BatchPreviewRequest, BatchSubmitRequest, BatchSummary,
)
from app.services.batch_preview import normalize_video_url, preview_batch
from app.utils.response import ResponseWrapper as R

router = APIRouter()


def _summary(batch, counts):
    return BatchSummary(
        id=batch.id, name=batch.name, source_label=batch.source_label, status=batch.status,
        created_at=batch.created_at, updated_at=batch.updated_at,
        total=sum(counts.values()), counts=counts,
    )


def _detail(session, batch_id):
    batch, jobs = get_batch_detail(session, batch_id)
    if batch is None:
        raise HTTPException(status_code=404, detail='Batch not found')
    counts = get_batch_counts(session, [batch_id])[batch_id]
    return BatchDetail(**_summary(batch, counts).model_dump(),
                       jobs=[BatchJobSummary.model_validate(job) for job in jobs])


@router.post('/preview')
def preview(data: BatchPreviewRequest):
    return R.success({'items': [asdict(item) for item in preview_batch(data.lines, data.expand_multipart)]})


@router.post('/submit')
def submit(data: BatchSubmitRequest, request: Request, session=Depends(get_db)):
    items = []
    seen = set()
    for selected in data.items:
        # Expanded Bilibili rows share original_url; the chosen page is in normalized_url.
        item = normalize_video_url(selected.normalized_url)
        if not selected.valid or not item.valid:
            raise HTTPException(status_code=400, detail=item.error or 'Selected item is invalid')
        if item.resource_key in seen:
            raise HTTPException(status_code=400, detail='Duplicate selected video')
        seen.add(item.resource_key)
        items.append({**asdict(item), 'original_url': selected.original_url,
                      'title': selected.title, 'cover_url': selected.cover_url, 'duration': selected.duration})
    batch = create_batch(session, data.request_id, data.name, data.source_label,
                         data.settings.model_dump(mode='json'), items)
    batch_id = batch.id
    _, jobs = get_batch_detail(session, batch_id)
    task_ids = [job.task_id for job in jobs]
    request.app.state.note_queue.wake()
    return R.success({'batch_id': batch_id, 'task_ids': task_ids})


@router.get('')
def batch_list(page: int = Query(default=1, ge=1), page_size: int = Query(default=20, ge=1, le=100),
               session=Depends(get_db)):
    batches, total = list_batches(session, page, page_size)
    counts = get_batch_counts(session, [batch.id for batch in batches])
    return R.success({'items': [_summary(batch, counts[batch.id]).model_dump(mode='json') for batch in batches],
                      'total': total, 'page': page, 'page_size': page_size})


@router.get('/{batch_id}')
def batch_detail(batch_id: str, session=Depends(get_db)):
    return R.success(_detail(session, batch_id).model_dump(mode='json'))


def _manage(batch_id, action, request, session):
    if not manage_batch(session, batch_id, action):
        raise HTTPException(status_code=404, detail='Batch not found')
    if action in ('resume', 'retry-failed'):
        request.app.state.note_queue.wake()
    return R.success(_detail(session, batch_id).model_dump(mode='json'))


@router.post('/{batch_id}/pause')
def pause(batch_id: str, request: Request, session=Depends(get_db)):
    return _manage(batch_id, 'pause', request, session)


@router.post('/{batch_id}/resume')
def resume(batch_id: str, request: Request, session=Depends(get_db)):
    return _manage(batch_id, 'resume', request, session)


@router.post('/{batch_id}/retry-failed')
def retry_failed(batch_id: str, request: Request, session=Depends(get_db)):
    return _manage(batch_id, 'retry-failed', request, session)


@router.post('/{batch_id}/cancel-pending')
def cancel_pending(batch_id: str, request: Request, session=Depends(get_db)):
    return _manage(batch_id, 'cancel-pending', request, session)
