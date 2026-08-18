import importlib.util
import os
import shutil
import subprocess
import sys
import types
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient


BACKEND_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = BACKEND_ROOT / "ffmpeg_helper.py"


def _load_ffmpeg_helper(monkeypatch):
    logger_module = types.ModuleType("app.utils.logger")
    logger_module.get_logger = lambda _name: types.SimpleNamespace(
        info=lambda *_args, **_kwargs: None,
        error=lambda *_args, **_kwargs: None,
    )
    monkeypatch.setitem(sys.modules, "app", types.ModuleType("app"))
    monkeypatch.setitem(sys.modules, "app.utils", types.ModuleType("app.utils"))
    monkeypatch.setitem(sys.modules, "app.utils.logger", logger_module)

    spec = importlib.util.spec_from_file_location("ffmpeg_helper_under_test", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _configured_executable(bin_dir: Path) -> Path:
    return bin_dir / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")


def _install_test_executable(bin_dir: Path, name: str) -> Path:
    suffix = ".exe" if os.name == "nt" else ""
    executable = bin_dir / f"{name}{suffix}"
    source = Path(os.environ["SystemRoot"]) / "System32" / "cmd.exe" if os.name == "nt" else Path(sys.executable)
    shutil.copy2(source, executable)
    executable.chmod(0o755)
    return executable


def _successful_test_command(name: str) -> list[str]:
    return [name, "/c", "exit", "0"] if os.name == "nt" else [name, "--version"]


def _load_config_router(monkeypatch):
    response_module = types.ModuleType("app.utils.response")

    class ResponseWrapper:
        @staticmethod
        def success(data=None, msg="success", code=0):
            return JSONResponse(content={"code": code, "msg": msg, "data": data})

    response_module.ResponseWrapper = ResponseWrapper
    logger_module = types.ModuleType("app.utils.logger")
    logger_module.get_logger = lambda _name: types.SimpleNamespace(
        info=lambda *_args, **_kwargs: None,
        error=lambda *_args, **_kwargs: None,
    )
    path_module = types.ModuleType("app.utils.path_helper")
    path_module.get_model_dir = lambda *_args, **_kwargs: Path("models")
    cookie_module = types.ModuleType("app.services.cookie_manager")
    cookie_module.CookieConfigManager = type("CookieConfigManager", (), {})
    transcriber_module = types.ModuleType("app.services.transcriber_config_manager")

    class TranscriberConfigManager:
        def get_config(self):
            return {"whisper_model_size": "tiny", "transcriber_type": "groq"}

    transcriber_module.TranscriberConfigManager = TranscriberConfigManager
    download_state_module = types.ModuleType("app.transcriber.model_download_state")
    download_state_module.is_downloading = lambda *_args, **_kwargs: False
    ffmpeg_module = types.ModuleType("ffmpeg_helper")
    ffmpeg_module.ensure_ffmpeg_or_raise = lambda: None

    modules = {
        "app": types.ModuleType("app"),
        "app.utils": types.ModuleType("app.utils"),
        "app.utils.response": response_module,
        "app.utils.logger": logger_module,
        "app.utils.path_helper": path_module,
        "app.services": types.ModuleType("app.services"),
        "app.services.cookie_manager": cookie_module,
        "app.services.transcriber_config_manager": transcriber_module,
        "app.transcriber": types.ModuleType("app.transcriber"),
        "app.transcriber.model_download_state": download_state_module,
        "ffmpeg_helper": ffmpeg_module,
    }
    modules["app.transcriber"].model_download_state = download_state_module
    for name, module in modules.items():
        monkeypatch.setitem(sys.modules, name, module)

    config_path = BACKEND_ROOT / "app" / "routers" / "config.py"
    spec = importlib.util.spec_from_file_location("config_router_under_test", config_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_valid_configured_bin_executes_absolute_path(monkeypatch, tmp_path):
    helper = _load_ffmpeg_helper(monkeypatch)
    executable = _configured_executable(tmp_path)
    executable.touch()
    monkeypatch.setenv("FFMPEG_BIN_PATH", str(tmp_path))
    monkeypatch.setattr(helper.shutil, "which", lambda _name: pytest.fail("PATH fallback used"))
    calls = []
    monkeypatch.setattr(helper.subprocess, "run", lambda command, **_kwargs: calls.append(command))

    assert helper.check_ffmpeg_exists() is True
    assert calls == [[str(executable.resolve()), "-version"]]


def test_startup_initialization_enables_bare_ffmpeg_and_ffprobe_once(monkeypatch, tmp_path):
    ffmpeg_executable = _install_test_executable(tmp_path, "ffmpeg")
    ffprobe_executable = _install_test_executable(tmp_path, "ffprobe")
    monkeypatch.setenv("FFMPEG_BIN_PATH", str(tmp_path))
    monkeypatch.setenv("PATH", str(tmp_path / "system-without-ffmpeg"))

    helper = _load_ffmpeg_helper(monkeypatch)
    initialized_path = os.environ["PATH"]
    results = [helper.initialize_ffmpeg_path() for _ in range(1000)]

    assert results == [True] * 1000
    assert os.environ["PATH"] == initialized_path
    assert os.path.normcase(shutil.which("ffmpeg")) == os.path.normcase(str(ffmpeg_executable))
    assert os.path.normcase(shutil.which("ffprobe")) == os.path.normcase(str(ffprobe_executable))
    assert subprocess.run(_successful_test_command("ffmpeg"), check=False).returncode == 0
    assert subprocess.run(_successful_test_command("ffprobe"), check=False).returncode == 0


@pytest.mark.parametrize("configured_value", [None, "missing"])
def test_startup_initialization_preserves_path_without_valid_config(
    monkeypatch, tmp_path, configured_value
):
    original_path = str(tmp_path / "system-path")
    monkeypatch.setenv("PATH", original_path)
    if configured_value is None:
        monkeypatch.delenv("FFMPEG_BIN_PATH", raising=False)
    else:
        monkeypatch.setenv("FFMPEG_BIN_PATH", str(tmp_path / configured_value))

    helper = _load_ffmpeg_helper(monkeypatch)

    assert helper.initialize_ffmpeg_path() is False
    assert os.environ["PATH"] == original_path


def test_startup_initialization_preserves_working_system_path(monkeypatch, tmp_path):
    _install_test_executable(tmp_path, "ffmpeg")
    _install_test_executable(tmp_path, "ffprobe")
    monkeypatch.delenv("FFMPEG_BIN_PATH", raising=False)
    monkeypatch.setenv("PATH", str(tmp_path))
    original_path = os.environ["PATH"]

    helper = _load_ffmpeg_helper(monkeypatch)

    assert helper.initialize_ffmpeg_path() is False
    assert os.environ["PATH"] == original_path
    assert subprocess.run(_successful_test_command("ffmpeg"), check=False).returncode == 0
    assert subprocess.run(_successful_test_command("ffprobe"), check=False).returncode == 0


def test_unset_configured_bin_uses_resolved_system_executable(monkeypatch):
    helper = _load_ffmpeg_helper(monkeypatch)
    monkeypatch.delenv("FFMPEG_BIN_PATH", raising=False)
    resolved = str(Path("system") / "ffmpeg")
    monkeypatch.setattr(helper.shutil, "which", lambda name: resolved if name == "ffmpeg" else None)
    calls = []
    monkeypatch.setattr(helper.subprocess, "run", lambda command, **_kwargs: calls.append(command))

    assert helper.check_ffmpeg_exists() is True
    assert calls == [[resolved, "-version"]]


def test_invalid_configured_bin_falls_back_to_system_path(monkeypatch, tmp_path):
    helper = _load_ffmpeg_helper(monkeypatch)
    monkeypatch.setenv("FFMPEG_BIN_PATH", str(tmp_path / "missing"))
    resolved = str(Path("system") / "ffmpeg")
    monkeypatch.setattr(helper.shutil, "which", lambda _name: resolved)
    calls = []
    monkeypatch.setattr(helper.subprocess, "run", lambda command, **_kwargs: calls.append(command))

    assert helper.check_ffmpeg_exists() is True
    assert calls == [[resolved, "-version"]]


def test_missing_ffmpeg_returns_false_without_spawning(monkeypatch):
    helper = _load_ffmpeg_helper(monkeypatch)
    monkeypatch.delenv("FFMPEG_BIN_PATH", raising=False)
    monkeypatch.setattr(helper.shutil, "which", lambda _name: None)
    monkeypatch.setattr(
        helper.subprocess,
        "run",
        lambda *_args, **_kwargs: pytest.fail("subprocess should not be started"),
    )

    assert helper.check_ffmpeg_exists() is False


@pytest.mark.parametrize(
    "failure",
    [subprocess.CalledProcessError(1, ["ffmpeg", "-version"]), OSError("cannot execute")],
)
def test_ffmpeg_execution_failure_returns_false(monkeypatch, failure):
    helper = _load_ffmpeg_helper(monkeypatch)
    monkeypatch.delenv("FFMPEG_BIN_PATH", raising=False)
    monkeypatch.setattr(helper.shutil, "which", lambda _name: str(Path("system") / "ffmpeg"))

    def fail_run(*_args, **_kwargs):
        raise failure

    monkeypatch.setattr(helper.subprocess, "run", fail_run)

    assert helper.check_ffmpeg_exists() is False


def test_ensure_ffmpeg_or_raise_preserves_missing_ffmpeg_contract(monkeypatch):
    helper = _load_ffmpeg_helper(monkeypatch)
    monkeypatch.setattr(helper, "check_ffmpeg_exists", lambda: False)

    with pytest.raises(EnvironmentError, match="ffmpeg"):
        helper.ensure_ffmpeg_or_raise()


def test_ensure_ffmpeg_or_raise_returns_normally_when_available(monkeypatch):
    helper = _load_ffmpeg_helper(monkeypatch)
    monkeypatch.setattr(helper, "check_ffmpeg_exists", lambda: True)

    assert helper.ensure_ffmpeg_or_raise() is None


def test_one_thousand_checks_leave_path_byte_for_byte_unchanged(monkeypatch, tmp_path):
    helper = _load_ffmpeg_helper(monkeypatch)
    executable = _configured_executable(tmp_path)
    executable.touch()
    monkeypatch.setenv("FFMPEG_BIN_PATH", str(tmp_path))
    original_path = os.environ.get("PATH", "")
    monkeypatch.setattr(helper.subprocess, "run", lambda *_args, **_kwargs: None)

    results = [helper.check_ffmpeg_exists() for _ in range(1000)]

    assert results == [True] * 1000
    assert os.environ.get("PATH", "") == original_path


def test_deploy_status_reports_ffmpeg_unavailable_without_500(monkeypatch):
    config = _load_config_router(monkeypatch)

    def fail_check():
        raise OSError("cannot execute ffmpeg")

    monkeypatch.setattr(config, "ensure_ffmpeg_or_raise", fail_check)
    app = FastAPI()
    app.include_router(config.router, prefix="/api")

    with TestClient(app) as client:
        response = client.get("/api/deploy_status")

    assert response.status_code == 200
    assert response.json()["data"]["ffmpeg"] == {"available": False}


def test_one_thousand_deploy_status_checks_stay_available_and_preserve_path(monkeypatch):
    config = _load_config_router(monkeypatch)
    monkeypatch.setattr(config, "ensure_ffmpeg_or_raise", lambda: None)
    original_path = os.environ.get("PATH", "")
    app = FastAPI()
    app.include_router(config.router, prefix="/api")

    with TestClient(app) as client:
        responses = [client.get("/api/deploy_status") for _ in range(1000)]

    assert all(response.status_code == 200 for response in responses)
    assert all(
        response.json()["data"]["ffmpeg"] == {"available": True}
        for response in responses
    )
    assert os.environ.get("PATH", "") == original_path
