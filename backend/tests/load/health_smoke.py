from concurrent.futures import ThreadPoolExecutor
from urllib.request import urlopen


def request_health(url: str) -> int:
    with urlopen(f"{url.rstrip('/')}/api/v1/health", timeout=5) as response:
        return response.status


def run(base_url: str, requests: int = 20, concurrency: int = 5) -> None:
    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        statuses = list(executor.map(lambda _: request_health(base_url), range(requests)))
    if any(status != 200 for status in statuses):
        raise RuntimeError(f"Health smoke test failed with statuses: {statuses}")


if __name__ == "__main__":
    import os

    run(os.environ.get("COMPDASH_ASK_LOAD_URL", "http://127.0.0.1:8000"))
