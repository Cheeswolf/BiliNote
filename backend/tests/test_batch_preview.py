import pathlib
import sys
import types


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

for module_name in list(sys.modules):
    if module_name == "app" or module_name.startswith("app."):
        del sys.modules[module_name]

app_package = types.ModuleType("app")
app_package.__path__ = [str(ROOT / "app")]
sys.modules["app"] = app_package

yt_dlp = types.ModuleType("yt_dlp")
yt_dlp.YoutubeDL = None
sys.modules.setdefault("yt_dlp", yt_dlp)

subtitle_module = types.ModuleType("app.downloaders.bilibili_subtitle")
subtitle_module.BilibiliSubtitleFetcher = object
sys.modules["app.downloaders.bilibili_subtitle"] = subtitle_module


from app.downloaders.bilibili_downloader import BilibiliDownloader, BilibiliPart
from app.services.batch_preview import normalize_video_url, preview_batch


def test_bilibili_resource_key_keeps_part_and_drops_tracking():
    item = normalize_video_url(
        "https://www.bilibili.com/video/BV1abc/?p=2&spm_id_from=333"
    )

    assert item.normalized_url == "https://www.bilibili.com/video/BV1abc?p=2"
    assert item.resource_key == "bilibili:BV1abc:p2"


def test_bilibili_resource_key_defaults_to_first_part():
    item = normalize_video_url("https://www.bilibili.com/video/BV1abc?utm_source=test")

    assert item.normalized_url == "https://www.bilibili.com/video/BV1abc"
    assert item.resource_key == "bilibili:BV1abc:p1"


def test_bilibili_path_part_is_normalized_as_a_part_query():
    item = normalize_video_url("https://www.bilibili.com/video/BV1abc/p2?share_source=copy")

    assert item.normalized_url == "https://www.bilibili.com/video/BV1abc?p=2"
    assert item.resource_key == "bilibili:BV1abc:p2"


def test_preview_keeps_unsupported_youtube_pages_invalid():
    item = normalize_video_url("https://www.youtube.com/channel/UC123")

    assert item.valid is False
    assert item.error == "暂不支持该视频平台或链接格式无效"


def test_preview_expands_parts_in_source_order(monkeypatch):
    monkeypatch.setattr(BilibiliDownloader, "list_parts", lambda self, url: [
        BilibiliPart(page=1, title="第一讲", duration=60, cover_url="cover"),
        BilibiliPart(page=2, title="第二讲", duration=90, cover_url="cover"),
    ])

    items = preview_batch(["https://www.bilibili.com/video/BV1abc"])

    assert [item.resource_key for item in items] == [
        "bilibili:BV1abc:p1",
        "bilibili:BV1abc:p2",
    ]
    assert [item.title for item in items] == ["第一讲", "第二讲"]


def test_preview_deduplicates_first_occurrence_without_reordering(monkeypatch):
    monkeypatch.setattr(BilibiliDownloader, "list_parts", lambda self, url: [])

    items = preview_batch([
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


def test_list_parts_returns_only_the_explicit_bilibili_part(monkeypatch):
    captured = {}

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

    monkeypatch.setattr("app.downloaders.bilibili_downloader.yt_dlp.YoutubeDL", FakeYoutubeDL)
    monkeypatch.setattr(BilibiliDownloader, "_write_netscape_cookie_file", lambda self: None)

    parts = BilibiliDownloader().list_parts("https://www.bilibili.com/video/BV1abc?p=2")

    assert captured["extract_flat"] is True
    assert parts == [BilibiliPart(page=2, title="第二讲", duration=90, cover_url="cover-2")]
