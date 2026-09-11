import importlib
import pathlib
import sys
import types

import pytest


ROOT = pathlib.Path(__file__).resolve().parents[1]


@pytest.fixture
def preview_api(monkeypatch):
    """Load preview modules in a test-local app package and restore sys.modules."""
    tracked_names = [
        name for name in sys.modules
        if name == "app" or name.startswith("app.") or name == "yt_dlp" or name.startswith("yt_dlp.")
    ]
    original_modules = {name: sys.modules[name] for name in tracked_names}

    for name in tracked_names:
        del sys.modules[name]

    app_package = types.ModuleType("app")
    app_package.__path__ = [str(ROOT / "app")]
    sys.modules["app"] = app_package

    yt_dlp = types.ModuleType("yt_dlp")
    yt_dlp.__path__ = []
    yt_dlp.YoutubeDL = None
    sys.modules["yt_dlp"] = yt_dlp

    extractor_module = types.ModuleType("yt_dlp.extractor")
    bilibili_module = types.ModuleType("yt_dlp.extractor.bilibili")

    class BilibiliBaseIE:
        def _download_playinfo(self, *args, **kwargs):
            return None

    bilibili_module.BilibiliBaseIE = BilibiliBaseIE
    sys.modules["yt_dlp.extractor"] = extractor_module
    sys.modules["yt_dlp.extractor.bilibili"] = bilibili_module

    subtitle_module = types.ModuleType("app.downloaders.bilibili_subtitle")
    subtitle_module.BilibiliSubtitleFetcher = object
    sys.modules["app.downloaders.bilibili_subtitle"] = subtitle_module

    sys.path.insert(0, str(ROOT))
    try:
        downloader_module = importlib.import_module("app.downloaders.bilibili_downloader")
        preview_module = importlib.import_module("app.services.batch_preview")
        monkeypatch.setattr(
            downloader_module,
            "CookieConfigManager",
            lambda: types.SimpleNamespace(get=lambda platform: None),
        )
        yield types.SimpleNamespace(
            downloader_module=downloader_module,
            preview_module=preview_module,
        )
    finally:
        sys.path.remove(str(ROOT))
        for name in list(sys.modules):
            if name == "app" or name.startswith("app.") or name == "yt_dlp" or name.startswith("yt_dlp."):
                del sys.modules[name]
        sys.modules.update(original_modules)


def test_bilibili_resource_key_keeps_part_and_drops_tracking(preview_api):
    item = preview_api.preview_module.normalize_video_url(
        "https://www.bilibili.com/video/BV1abc/?p=2&spm_id_from=333"
    )

    assert item.normalized_url == "https://www.bilibili.com/video/BV1abc?p=2"
    assert item.resource_key == "bilibili:BV1abc:p2"


def test_bilibili_keeps_content_selector_while_dropping_share_tracking(preview_api):
    item = preview_api.preview_module.normalize_video_url(
        "https://www.bilibili.com/video/BV1abc?p=2&t=45&spm_id_from=333&share_source=copy"
    )

    assert item.normalized_url == "https://www.bilibili.com/video/BV1abc?p=2&t=45"
    assert item.resource_key == "bilibili:BV1abc:p2"


def test_youtube_keeps_playlist_selector_while_dropping_tracking(preview_api):
    item = preview_api.preview_module.normalize_video_url(
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&spm=abc&share_source=copy"
    )

    assert item.normalized_url == "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123"
    assert item.resource_key == "youtube:dQw4w9WgXcQ"


def test_bilibili_path_part_is_normalized_as_a_part_query(preview_api):
    item = preview_api.preview_module.normalize_video_url(
        "https://www.bilibili.com/video/BV1abc/p2?share_source=copy"
    )

    assert item.normalized_url == "https://www.bilibili.com/video/BV1abc?p=2"
    assert item.resource_key == "bilibili:BV1abc:p2"


@pytest.mark.parametrize(("url", "error"), [
    ("https://youtu.be/foo", "无法识别 YouTube 视频 ID"),
    ("https://www.youtube.com/channel/UC123", "暂不支持该视频平台或链接格式无效"),
    ("https://www.douyin.com/video/not-a-video-id", "无法识别 抖音 视频 ID"),
    ("https://www.kuaishou.com/", "无法识别 快手 视频 ID"),
])
def test_preview_rejects_supported_platform_urls_without_video_ids(preview_api, url, error):
    item = preview_api.preview_module.normalize_video_url(url)

    assert item.valid is False
    assert item.resource_key == ""
    assert item.error == error


@pytest.mark.parametrize("url", [
    "https://douyin.com.evil.example/video/123456789",
    "https://evil-kuaishou.com/short-video/abc123",
])
def test_preview_rejects_spoofed_platform_hosts(preview_api, url):
    item = preview_api.preview_module.normalize_video_url(url)

    assert item.valid is False
    assert item.error == "暂不支持该视频平台或链接格式无效"


def test_kuaishou_short_video_url_has_a_stable_resource_key(preview_api):
    item = preview_api.preview_module.normalize_video_url(
        "https://www.kuaishou.com/short-video/3x7e4k9?from=share"
    )

    assert item.valid is True
    assert item.normalized_url == "https://www.kuaishou.com/short-video/3x7e4k9"
    assert item.resource_key == "kuaishou:3x7e4k9"


def test_preview_expands_parts_in_source_order(preview_api, monkeypatch):
    BilibiliDownloader = preview_api.downloader_module.BilibiliDownloader
    BilibiliPart = preview_api.downloader_module.BilibiliPart
    monkeypatch.setattr(BilibiliDownloader, "list_parts", lambda self, url: [
        BilibiliPart(page=1, title="第一讲", duration=60, cover_url="cover"),
        BilibiliPart(page=2, title="第二讲", duration=90, cover_url="cover"),
    ])

    items = preview_api.preview_module.preview_batch([
        "https://www.bilibili.com/video/BV1abc",
    ])

    assert [item.resource_key for item in items] == [
        "bilibili:BV1abc:p1",
        "bilibili:BV1abc:p2",
    ]
    assert [item.title for item in items] == ["第一讲", "第二讲"]


def test_preview_deduplicates_first_occurrence_without_reordering(preview_api):
    items = preview_api.preview_module.preview_batch([
        "https://youtu.be/dQw4w9WgXcQ?utm_source=first",
        "not a supported link",
        "https://www.bilibili.com/video/BV1abc?p=2&spm_id_from=333",
        "https://youtu.be/dQw4w9WgXcQ?utm_campaign=duplicate",
        "https://www.bilibili.com/video/BV1abc?p=2",
    ], expand_multipart=False)

    assert [item.resource_key for item in items] == [
        "youtube:dQw4w9WgXcQ",
        "",
        "bilibili:BV1abc:p2",
    ]
    assert items[1].valid is False
    assert items[1].error == "暂不支持该视频平台或链接格式无效"


def test_list_parts_returns_only_the_explicit_bilibili_part(preview_api, monkeypatch):
    captured = {}
    BilibiliDownloader = preview_api.downloader_module.BilibiliDownloader
    BilibiliPart = preview_api.downloader_module.BilibiliPart

    class FakeYoutubeDL:
        def __init__(self, options):
            captured.update(options)

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc_value, traceback):
            return False

        def extract_info(self, url, download):
            assert url == "https://www.bilibili.com/video/BV1abc?p=2"
            assert download is False
            return {
                "title": "课程",
                "thumbnail": "series-cover",
                "entries": [
                    {"playlist_index": 1, "title": "第一讲", "duration": 60, "thumbnail": "cover-1"},
                    {"playlist_index": 2, "title": "第二讲", "duration": 90, "thumbnail": "cover-2"},
                ],
            }

    monkeypatch.setattr(preview_api.downloader_module.yt_dlp, "YoutubeDL", FakeYoutubeDL)

    parts = BilibiliDownloader().list_parts("https://www.bilibili.com/video/BV1abc?p=2")

    assert captured["extract_flat"] is True
    assert parts == [BilibiliPart(page=2, title="第二讲", duration=90, cover_url="cover-2")]
