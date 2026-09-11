import os
from concurrent.futures import ThreadPoolExecutor, Future
from typing import Any, Callable


class ConcurrentTaskExecutor:
    """兼容执行器默认逐条执行；新任务由持久化队列调度。"""

    def __init__(self, max_workers: int | None = None):
        self._max_workers = max_workers or int(os.getenv("TASK_MAX_WORKERS", "1"))
        self._pool = ThreadPoolExecutor(max_workers=self._max_workers)

    def run(self, fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
        future: Future = self._pool.submit(fn, *args, **kwargs)
        return future.result()

    def shutdown(self, wait: bool = True):
        self._pool.shutdown(wait=wait)


# 保持向后兼容的导出名
class SerialTaskExecutor(ConcurrentTaskExecutor):
    """始终使用单执行槽，兼容旧调用方传入 max_workers 参数。"""

    def __init__(self, max_workers: int | None = None):
        super().__init__(max_workers=1)
task_serial_executor = SerialTaskExecutor()
