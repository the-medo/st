"""Linux cgroup-v2 / procfs observations. Sampling runs outside the model service."""

from pathlib import Path
import os
import statistics
import threading
import time


def fields(path):
    return {parts[0].rstrip(":"): int(parts[1])
            for line in path.read_text().splitlines()
            if len(parts := line.split()) >= 2 and parts[1].isdigit()}


class Sampler:
    def __init__(self, cgroup=None, interval=0.5):
        self.cgroup = Path(cgroup) if cgroup else None
        self.interval = interval
        self.phase = "startup"
        self.samples = []
        self.errors = []
        self.stop_event = threading.Event()
        self.thread = None
        self.started = time.monotonic()

    def cpu(self):
        if self.cgroup:
            return fields(self.cgroup / "cpu.stat")["usage_usec"] / 1_000_000
        return time.process_time()

    def sample(self):
        observation = {"t_seconds": round(time.monotonic() - self.started, 3),
                       "phase": self.phase, "cpu_seconds": self.cpu()}
        pids = {os.getpid()}
        if self.cgroup:
            pids = set()
            for p in self.cgroup.rglob("cgroup.procs"):
                pids.update(int(pid) for pid in p.read_text().split())
            memory = fields(self.cgroup / "memory.stat")
            observation.update(
                cgroup_current_bytes=int((self.cgroup / "memory.current").read_text()),
                cgroup_anon_bytes=memory.get("anon", 0),
                cgroup_file_bytes=memory.get("file", 0),
                cgroup_swap_bytes=int((self.cgroup / "memory.swap.current").read_text()),
                memory_events=fields(self.cgroup / "memory.events"),
                cpu_stat=fields(self.cgroup / "cpu.stat"),
            )
        totals = {"rss_bytes": 0, "pss_bytes": 0, "private_bytes": 0}
        observed = 0
        for pid in pids:
            try:
                mem = fields(Path(f"/proc/{pid}/smaps_rollup"))
            except ProcessLookupError:
                continue
            except FileNotFoundError:
                continue
            totals["rss_bytes"] += mem.get("Rss", 0) * 1024
            totals["pss_bytes"] += mem.get("Pss", 0) * 1024
            totals["private_bytes"] += (mem.get("Private_Clean", 0) + mem.get("Private_Dirty", 0)) * 1024
            observed += 1
        observation.update(totals, process_count=observed,
                           host_load_1m=os.getloadavg()[0],
                           host_available_bytes=fields(Path("/proc/meminfo"))["MemAvailable"] * 1024)
        self.samples.append(observation)
        return observation

    def _run(self):
        while not self.stop_event.is_set():
            try:
                self.sample()
            except (OSError, ValueError, KeyError) as error:
                self.errors.append(type(error).__name__)
            self.stop_event.wait(self.interval)

    def start(self):
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        self.thread.join()

    def summarize(self):
        result = {"scope": "Unsloth service and descendants" if self.cgroup else "benchmark HTTP client only; remote server unavailable",
                  "sample_interval_seconds": self.interval, "sampling_errors": self.errors,
                  "logical_cpu_count": os.cpu_count(), "phases": {}}
        for phase in dict.fromkeys(s["phase"] for s in self.samples):
            rows = [s for s in self.samples if s["phase"] == phase]
            data = {"samples": len(rows)}
            for key in ("pss_bytes", "rss_bytes", "private_bytes", "cgroup_current_bytes",
                        "cgroup_anon_bytes", "cgroup_file_bytes", "cgroup_swap_bytes"):
                values = [r[key] for r in rows if key in r]
                if values:
                    data[key] = {"median": statistics.median(values), "max": max(values)}
            if len(rows) > 1:
                wall = rows[-1]["t_seconds"] - rows[0]["t_seconds"]
                cpu = rows[-1]["cpu_seconds"] - rows[0]["cpu_seconds"]
                data.update(wall_seconds=wall, cpu_seconds=cpu,
                            cpu_percent_one_core=100 * cpu / wall if wall else None,
                            cpu_percent_machine=100 * cpu / wall / os.cpu_count() if wall else None)
            result["phases"][phase] = data
        return result
