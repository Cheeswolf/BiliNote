import re
from dataclasses import dataclass, replace
from typing import Optional
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from app.downloaders.bilibili_downloader import BilibiliDownloader
from app.utils.url_parser import (
    extract_bilibili_p_number,
    extract_video_id,
    resolve_bilibili_short_url,
)


SUPPORTED_PLATFORMS = {"bilibili", "youtube", "douyin", "kuaishou"}
TRACKING_QUERY_KEYS = {
    "from",
    "from_source",
    "from_spmid",
    "refer",
    "share_medium",
    "share_plat",
    "share_session_id",
    "share_source",
    "source",
    "spm",
    "timestamp",
    "unique_k",
    "utm_campaign",
    "utm_content",
    "utm_medium",
    "utm_source",
    "utm_term",
    "vd_source",
}


@dataclass(frozen=True)
class PreviewItem:
    original_url: str
    normalized_url: str
    platform: Optional[str]
    resource_key: str
    title: Optional[str] = None
    cover_url: Optional[str] = None
    duration: Optional[float] = None
    valid: bool = True
    error: Optional[str] = None


def bilibili_resource_key(url: str) -> str:
    video_id = extract_video_id(url, "bilibili")
    page = extract_bilibili_p_number(url, resolve_short_url=False) or 1
    if not video_id:
        raise ValueError("无法识别 B 站 BV 号")
    return f"bilibili:{video_id}:p{page}"


def normalize_video_url(url: str, platform: str | None = None) -> PreviewItem:
    """Keep malformed URL parsing local to this row, including on submission."""
    try:
        return _normalize_video_url(url, platform)
    except ValueError as error:
        return _invalid_item(url, str(error))


def _normalize_video_url(url: str, platform: str | None = None) -> PreviewItem:
    original_url = url
    candidate = url.strip()
    if not candidate:
        return _invalid_item(original_url, "链接不能为空")
    if "://" not in candidate:
        candidate = f"https://{candidate}"

    parsed = urlparse(candidate)
    if _is_bilibili_short_url(parsed):
        short_page = extract_bilibili_p_number(candidate, resolve_short_url=False)
        resolved_url = resolve_bilibili_short_url(candidate)
        if not resolved_url:
            return _invalid_item(original_url, "无法解析 B 站短链接")
        candidate = resolved_url
        parsed = urlparse(candidate)
        if short_page is not None and extract_bilibili_p_number(candidate, resolve_short_url=False) is None:
            candidate = _with_bilibili_page(candidate, short_page)
            parsed = urlparse(candidate)

    detected_platform = _detect_platform(parsed)
    if platform in SUPPORTED_PLATFORMS and platform != detected_platform:
        return _invalid_item(original_url, "暂不支持该视频平台或链接格式无效")
    if detected_platform is None:
        return _invalid_item(original_url, "暂不支持该视频平台或链接格式无效")

    normalized_url = _normalize_url(parsed, detected_platform)
    try:
        resource_key = _resource_key(normalized_url, detected_platform)
    except ValueError as error:
        return _invalid_item(original_url, str(error), detected_platform, normalized_url)

    return PreviewItem(
        original_url=original_url,
        normalized_url=normalized_url,
        platform=detected_platform,
        resource_key=resource_key,
    )


def preview_batch(lines: list[str], expand_multipart: bool = True) -> list[PreviewItem]:
    previewed = []
    for line in lines:
        if not line.strip():
            continue
        item = normalize_video_url(line)
        if item.valid and item.platform == "bilibili" and expand_multipart:
            previewed.extend(_expand_bilibili_parts(item))
        else:
            previewed.append(item)

    seen_resource_keys = set()
    deduplicated = []
    for item in previewed:
        if not item.valid:
            deduplicated.append(item)
            continue
        if item.resource_key in seen_resource_keys:
            continue
        seen_resource_keys.add(item.resource_key)
        deduplicated.append(item)
    return deduplicated


def _expand_bilibili_parts(item: PreviewItem) -> list[PreviewItem]:
    downloader = BilibiliDownloader()
    try:
        parts = downloader.list_parts(item.normalized_url)
    except Exception:
        return [item]
    finally:
        downloader.close()

    if not parts:
        return [item]
    return [
        replace(
            item,
            normalized_url=_with_bilibili_page(item.normalized_url, part.page),
            resource_key=bilibili_resource_key(_with_bilibili_page(item.normalized_url, part.page)),
            title=part.title,
            cover_url=part.cover_url,
            duration=part.duration,
        )
        for part in parts
    ]


def _invalid_item(
    original_url: str,
    error: str,
    platform: Optional[str] = None,
    normalized_url: Optional[str] = None,
) -> PreviewItem:
    return PreviewItem(
        original_url=original_url,
        normalized_url=normalized_url or original_url.strip(),
        platform=platform,
        resource_key="",
        valid=False,
        error=error,
    )


def _is_bilibili_short_url(parsed) -> bool:
    return (parsed.hostname or "").lower() == "b23.tv"


def _detect_platform(parsed) -> Optional[str]:
    hostname = (parsed.hostname or "").lower()
    path = parsed.path or ""
    if hostname in {"bilibili.com", "www.bilibili.com"} and path.startswith("/video/"):
        return "bilibili"
    if hostname == "youtu.be" and path.strip("/"):
        return "youtube"
    if hostname in {"youtube.com", "www.youtube.com", "m.youtube.com"} and (
        (path == "/watch" and any(key == "v" and value for key, value in parse_qsl(parsed.query)))
        or path.startswith("/shorts/")
    ):
        return "youtube"
    if _matches_domain(hostname, "douyin.com"):
        return "douyin"
    if _matches_domain(hostname, "kuaishou.com"):
        return "kuaishou"
    return None


def _normalize_url(parsed, platform: str) -> str:
    hostname = (parsed.hostname or "").lower()
    path = parsed.path.rstrip("/") or "/"
    if platform == "bilibili":
        hostname = "www.bilibili.com"
        page = extract_bilibili_p_number(urlunparse(parsed), resolve_short_url=False)
        path = re.sub(r"/p\d+$", "", path)
        query = _canonical_query(parsed, "p", str(page) if page is not None else None)
    elif platform == "youtube":
        video_id = next((value for key, value in parse_qsl(parsed.query) if key == "v"), None)
        query = _canonical_query(parsed, "v", video_id)
    else:
        query = _non_tracking_query(parsed)
    return urlunparse(("https", hostname, path, "", urlencode(query), ""))


def _resource_key(normalized_url: str, platform: str) -> str:
    if platform == "bilibili":
        return bilibili_resource_key(normalized_url)
    video_id = extract_video_id(normalized_url, platform)
    if video_id:
        return f"{platform}:{video_id}"
    labels = {
        "youtube": "YouTube",
        "douyin": "抖音",
        "kuaishou": "快手",
    }
    raise ValueError(f"无法识别 {labels[platform]} 视频 ID")


def _matches_domain(hostname: str, domain: str) -> bool:
    return hostname == domain or hostname.endswith(f".{domain}")


def _canonical_query(parsed, key: str, value: Optional[str]) -> list[tuple[str, str]]:
    retained = [
        (query_key, query_value)
        for query_key, query_value in _non_tracking_query(parsed)
        if query_key != key
    ]
    return [(key, value)] + retained if value is not None else retained


def _non_tracking_query(parsed) -> list[tuple[str, str]]:
    return [
        (key, value)
        for key, value in parse_qsl(parsed.query, keep_blank_values=True)
        if not _is_tracking_query(key)
    ]


def _is_tracking_query(key: str) -> bool:
    normalized = key.lower()
    return normalized in TRACKING_QUERY_KEYS or normalized.startswith(("spm_", "utm_"))


def _with_bilibili_page(url: str, page: int) -> str:
    parsed = urlparse(url)
    return urlunparse((
        "https",
        "www.bilibili.com",
        parsed.path.rstrip("/"),
        "",
        urlencode({"p": page}),
        "",
    ))
