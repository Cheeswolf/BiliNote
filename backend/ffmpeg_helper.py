import os
import shutil
import subprocess
import sys
from dotenv import load_dotenv

from app.utils.logger import get_logger
logger = get_logger(__name__)


def _load_dotenv_from_multiple_paths():
    """尝试多个位置加载 .env，适配源码运行和 PyInstaller 打包场景。

    PyInstaller 打包后当前工作目录是 EXE 所在目录，而源码运行时 .env
    通常在项目根目录或 backend/ 同级。遍历常见候选路径确保能命中。
    """
    candidates = []
    # 1. 当前工作目录（EXE 所在目录）
    candidates.append(os.path.join(os.getcwd(), '.env'))
    # 2. 本脚本所在目录（backend/）
    script_dir = os.path.dirname(os.path.abspath(__file__))
    candidates.append(os.path.join(script_dir, '.env'))
    # 3. 项目根目录（backend/../.env）
    candidates.append(os.path.join(script_dir, '..', '.env'))
    # 4. PyInstaller 打包后的 _internal/ 子目录
    if getattr(sys, 'frozen', False):
        exe_dir = os.path.dirname(sys.executable)
        candidates.append(os.path.join(exe_dir, '_internal', '.env'))

    for path in candidates:
        normalized = os.path.normpath(path)
        if os.path.isfile(normalized):
            load_dotenv(normalized)
            return
    # 都没找到，fallback 到默认行为（从 CWD 找）
    load_dotenv()


def initialize_ffmpeg_path() -> bool:
    """在进程启动时将有效的 FFMPEG_BIN_PATH 幂等地加入 PATH。"""
    ffmpeg_bin_path = os.getenv("FFMPEG_BIN_PATH")
    if not ffmpeg_bin_path:
        return False

    normalized_bin_path = os.path.abspath(ffmpeg_bin_path)
    executable_name = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    if not os.path.isfile(os.path.join(normalized_bin_path, executable_name)):
        return False

    current_path = os.environ.get("PATH", "")
    path_entries = current_path.split(os.pathsep) if current_path else []
    normalized_key = os.path.normcase(normalized_bin_path)
    remaining_entries = [
        entry
        for entry in path_entries
        if os.path.normcase(os.path.abspath(entry.strip('"'))) != normalized_key
    ]
    updated_path = os.pathsep.join([normalized_bin_path, *remaining_entries])
    if updated_path != current_path:
        os.environ["PATH"] = updated_path
        logger.info(f"启动时已将 FFMPEG_BIN_PATH 加入 PATH: {normalized_bin_path}")
    return True


_load_dotenv_from_multiple_paths()
initialize_ffmpeg_path()
def check_ffmpeg_exists() -> bool:
    """
    检查 ffmpeg 是否可用。优先使用 FFMPEG_BIN_PATH 环境变量指定的路径。
    """
    ffmpeg_bin_path = os.getenv("FFMPEG_BIN_PATH")
    logger.info(f"FFMPEG_BIN_PATH: {ffmpeg_bin_path}")
    resolved_ffmpeg = None
    if ffmpeg_bin_path:
        executable_name = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
        configured_ffmpeg = os.path.abspath(os.path.join(ffmpeg_bin_path, executable_name))
        if os.path.isfile(configured_ffmpeg):
            resolved_ffmpeg = configured_ffmpeg
            logger.info(f"使用FFMPEG_BIN_PATH: {configured_ffmpeg}")

    if resolved_ffmpeg is None:
        resolved_ffmpeg = shutil.which("ffmpeg")
        if resolved_ffmpeg:
            logger.info(f"在系统PATH中找到ffmpeg: {resolved_ffmpeg}")

    if resolved_ffmpeg is None:
        logger.info("ffmpeg 未安装")
        return False

    try:
        subprocess.run([resolved_ffmpeg, "-version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        logger.info("ffmpeg 已安装")
        return True
    except (FileNotFoundError, OSError, subprocess.CalledProcessError):
        logger.info("ffmpeg 未安装")
        return False


def ensure_ffmpeg_or_raise():
    """
    校验 ffmpeg 是否可用，否则抛出异常并提示安装方式。
    """
    if not check_ffmpeg_exists():
        logger.error("未检测到 ffmpeg，请先安装后再使用本功能。")
        raise EnvironmentError(
            " 未检测到 ffmpeg，请先安装后再使用本功能。\n"
            "👉 下载地址：https://ffmpeg.org/download.html\n"
            "🪟 Windows 推荐：https://www.gyan.dev/ffmpeg/builds/\n"
            "💡 如果你已安装，请将其路径写入 `.env` 文件，例如：\n"
            "FFMPEG_BIN_PATH=/your/custom/ffmpeg/bin"
        )
