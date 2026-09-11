import importlib.util
import pathlib
import threading
import time
import unittest

import pytest


ROOT = pathlib.Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "app" / "services" / "task_serial_executor.py"
spec = importlib.util.spec_from_file_location("task_serial_executor", MODULE_PATH)
if spec is None or spec.loader is None:
    raise ImportError("task_serial_executor module spec not found")
task_serial_executor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(task_serial_executor)
SerialTaskExecutor = task_serial_executor.SerialTaskExecutor


class TestTaskSerialExecutor(unittest.TestCase):
    def test_executor_runs_tasks_one_by_one(self):
        executor = SerialTaskExecutor()
        self.addCleanup(executor.shutdown)
        state_lock = threading.Lock()
        state = {"active": 0, "peak_active": 0}

        def critical_work():
            with state_lock:
                state["active"] += 1
                state["peak_active"] = max(state["peak_active"], state["active"])
            time.sleep(0.05)
            with state_lock:
                state["active"] -= 1

        threads = [threading.Thread(target=lambda: executor.run(critical_work)) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(state["peak_active"], 1)


if __name__ == "__main__":
    unittest.main()

@pytest.mark.parametrize("mode", ["default", "explicit", "singleton"])
def test_serial_executor_cannot_be_configured_to_run_concurrently(monkeypatch, mode):
    monkeypatch.setenv("TASK_MAX_WORKERS", "3")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if mode == "singleton":
        executor = module.task_serial_executor
    elif mode == "explicit":
        executor = module.SerialTaskExecutor(max_workers=3)
    else:
        executor = module.SerialTaskExecutor()
    state = {"active": 0, "peak_active": 0}
    state_lock = threading.Lock()

    def work():
        with state_lock:
            state["active"] += 1
            state["peak_active"] = max(state["peak_active"], state["active"])
        time.sleep(0.05)
        with state_lock:
            state["active"] -= 1

    threads = [threading.Thread(target=lambda: executor.run(work)) for _ in range(3)]
    try:
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        assert state["peak_active"] == 1
    finally:
        executor.shutdown()
        module.task_serial_executor.shutdown()


if __name__ == "__main__":
    unittest.main()
