"""Snapshot seed: download, checksum, unpack and load, with the network and MySQL faked."""
import gzip
import json
import shutil
from dataclasses import replace
from decimal import Decimal
from unittest import mock

import numpy as np
import pandas as pd
import pytest

from finsent import snapshot
from finsent.config import Settings


def _release(tmp_path, tamper=False):
    rel = tmp_path / "release"
    rel.mkdir()
    pd.DataFrame({"symbol": ["THYAO"], "name": ["Türk Hava Yolları"]}).to_parquet(rel / "tables__companies.parquet")
    with gzip.open(rel / "market__bist_updates.db.gz", "wb") as f:
        f.write(b"sqlite-bytes")
    (rel / "models__gold_study.json").write_text("{}")
    files = {"tables/companies.parquet": {}, "market/bist_updates.db.gz": {"unpacked_name": "bist_updates.db"},
             "models/gold_study.json": {}}
    for k, m in files.items():
        p = rel / snapshot._asset_name(k)
        m.update(size=p.stat().st_size, sha256=snapshot._sha256(p))
    if tamper:
        (rel / "models__gold_study.json").write_text('{"x": 1}')
    (rel / "manifest.json").write_text(json.dumps({"files": files, "coverage": {"disclosures": ["2025-01-01", "2025-01-31"]}}))
    assets = [{"name": p.name, "browser_download_url": str(p)} for p in rel.iterdir()]
    return {"tag_name": "data-test", "html_url": "x", "assets": assets}


@pytest.fixture
def settings(tmp_path):
    return replace(Settings(), market_updates_path=str(tmp_path / "data" / "market" / "bist_updates.db"))


def test_seed_downloads_verifies_unpacks_and_loads(tmp_path, settings):
    rel = _release(tmp_path)
    with mock.patch.object(snapshot, "latest_release", return_value=rel), \
         mock.patch.object(snapshot, "_download", side_effect=lambda url, dst: (dst.parent.mkdir(parents=True, exist_ok=True), shutil.copy(url, dst))), \
         mock.patch.object(snapshot, "load_tables", return_value={"companies": 1}) as load:
        out = snapshot.seed(settings, lake=False)
    assert out == {"release": "data-test", "tables": {"companies": 1}}
    data = tmp_path / "data"
    assert (data / "market" / "bist_updates.db").read_bytes() == b"sqlite-bytes"
    assert (data / "models" / "gold_study.json").exists()
    assert load.call_args.args[1] == data / "snapshot"
    assert not (data / "snapshot").exists()       # downloads cleaned up


def test_seed_rejects_a_tampered_asset(tmp_path, settings):
    rel = _release(tmp_path, tamper=True)
    with mock.patch.object(snapshot, "latest_release", return_value=rel), \
         mock.patch.object(snapshot, "_download", side_effect=lambda url, dst: (dst.parent.mkdir(parents=True, exist_ok=True), shutil.copy(url, dst))), \
         mock.patch.object(snapshot, "load_tables") as load, pytest.raises(RuntimeError, match="checksum"):
        snapshot.seed(settings, lake=False)
    load.assert_not_called()


def test_value_conversion_for_mysql():
    assert snapshot._to_db(np.int64(3)) == 3 and snapshot._to_db(np.float64("nan")) is None
    assert snapshot._to_db(pd.NaT) is None and snapshot._to_db(np.bool_(True)) is True
    df = snapshot._clean_frame(pd.DataFrame({"p": [Decimal("1.5"), None], "s": [b"\xc3\xa7", None]}))
    assert df["p"].dtype == float and df["s"][0] == "ç"
