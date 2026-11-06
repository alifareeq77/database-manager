import os
import shutil
import tempfile
from pathlib import Path

_tmp = Path(tempfile.mkdtemp(prefix="strata-test-"))
os.environ["STRATA_DATA_DIR"] = str(_tmp)
os.environ["STRATA_SQLITE_ROOT"] = str(_tmp / "sqlite")
os.environ["STRATA_SECRET_KEY"] = "test-secret-key-for-unit-tests-only-0123456789"
os.environ["STRATA_LOGIN_RATE_PER_MINUTE"] = "1000"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


@pytest.fixture(scope="session")
def client():
    from app.main import app

    with TestClient(app) as c:
        r = c.get("/api/auth/status")
        assert r.json()["setup_required"] is True
        r = c.post("/api/auth/setup", json={"username": "admin", "password": "correct-horse-battery"})
        assert r.status_code == 200, r.text
        c.headers["x-csrf-token"] = r.json()["csrf_token"]
        yield c
    shutil.rmtree(_tmp, ignore_errors=True)
