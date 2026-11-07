"""Live KAP client: real disclosures from KAP's public disclosure API.

These are the same endpoints www.kap.org.tr's own UI calls:

* list:   POST /tr/api/disclosure/members/byCriteria
          {"fromDate": "YYYY-MM-DD", "toDate": "YYYY-MM-DD", "disclosureTypes": null,
           "memberTypes": ["IGS"], "mkkMemberOid": null}
* detail: GET  /tr/Bildirim/{disclosureIndex}   (HTML; the narrative is under "Açıklamalar")

Requests identify themselves with FINSENT_KAP_USER_AGENT, are spaced by
FINSENT_KAP_INTERVAL_S and back off on 429/5xx. Mechanical notices (circuit
breakers, debt-instrument coupon notices, company info forms...) are dropped.
"""
from __future__ import annotations

import html as html_lib
import logging
import os
import re
import time
from datetime import date, datetime, timedelta

import pandas as pd

from .config import Settings

log = logging.getLogger(__name__)

NOISE_SUBJECTS = {
    "Pay Bazında Devre Kesici Bildirimi",
    "Pay Dışında Sermaye Piyasası Aracı İşlemlerine İlişkin Bildirim (Faiz İçeren)",
    "Pay Dışında Sermaye Piyasası Aracı İşlemlerine İlişkin Bildirim (Faizsiz)",
    "Şirket Genel Bilgi Formu",
    "BISTECH Pay Piyasası Alım Satım Sistemi Duyurusu",
    "Kurumsal Yönetim Uyum Raporu",
    "Sürdürülebilirlik Raporu",
    "Sorumluluk Beyanı",
    # structured products / market-making flow - not company news
    "Yatırım Kuruluşu Varant - Sertifika - Senetlerine İlişkin Bildirim",
    "Piyasa Yapıcılığı Kapsamında Gerçekleştirilen İşlemler Bildirimi",
    "Varant ve Yatırım Kuruluşu Sertifikalarına İlişkin Bildirim",
}
# Subjects whose full text is worth downloading; for the rest the list summary is enough.
BODY_SUBJECT_HINTS = ("Özel Durum", "Yeni İş İlişkisi", "Birleşme", "Bölünme", "Geri Alın",
                      "Sermaye Artırımı", "Kar Payı", "Kâr Payı", "Kredi Derecelendirme",
                      "Maddi Duran Varlık", "Finansal Duran Varlık", "Genel Açıklama",
                      "İhale", "Dava", "Pay Alım Satım", "Önemli")


def parse_kap_time(value: str | None) -> datetime | None:
    for fmt in ("%d.%m.%Y %H:%M:%S", "%d.%m.%Y %H:%M", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(value or "", fmt)
        except ValueError:
            continue
    return None


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", html_lib.unescape(text).replace(" ", " ")).strip()


def extract_body_text(page: str, max_chars: int = 6000) -> str:
    """Pull the free-text section out of a KAP notification page.

    The page embeds the rendered disclosure as an escaped HTML string; the
    narrative follows the "Açıklamalar" label and ends before the standard
    responsibility footer. Falls back to the longest <p> block.
    """
    s = (page.replace("\\u003c", "<").replace("\\u003e", ">").replace("\\u0026", "&")
             .replace('\\"', '"').replace("\\n", " ").replace("\\t", " "))
    idx = s.find("Açıklamalar")
    text = ""
    if idx >= 0:
        chunk = s[idx + len("Açıklamalar"): idx + 40000]
        for stop in ("Yukarıdaki açıklamalarımızın", '"footerNote"', "Ek Açıklamalar"):
            cut = chunk.find(stop)
            if cut > 0:
                chunk = chunk[:cut]
        text = _clean(re.sub(r"<[^>]+>", " ", chunk))
    if len(text) < 40:
        blocks = [_clean(re.sub(r"<[^>]+>", " ", b)) for b in re.findall(r"<p[^>]*>(.*?)</p>", s, flags=re.S)]
        text = max(blocks, key=len, default="")
    # template labels that precede the narrative, e.g. "Explanations oda_ExplanationTextBlock|"
    text = re.sub(r"^(Explanations\s*)?[\w.]*ExplanationTextBlock\|\s*", "", text)
    # the page's serialized component payload can follow the text: 38:["$","$L41",null,...
    text = re.split(r'\s*\d+:\["\$', text, maxsplit=1)[0]
    text = re.split(r'"\]\)?\s*self\.__next_f', text, maxsplit=1)[0].rstrip(' "\\])')
    return text[:max_chars]


class KapRateLimited(RuntimeError):
    """KAP kept answering 429 after all retries - stop sending requests for this run."""


class KapLiveClient:
    def __init__(self, settings: Settings, session=None):
        import requests

        self.settings = settings
        self.session = session or requests.Session()
        self.session.headers.update({"User-Agent": settings.kap_user_agent})
        base = os.environ.get("FINSENT_KAP_BASE_URL", "https://www.kap.org.tr")
        self.list_url = os.environ.get("FINSENT_KAP_LIST_URL", f"{base}/tr/api/disclosure/members/byCriteria")
        self.detail_url = base + "/tr/Bildirim/{idx}"
        self._last = 0.0

    def _throttle(self) -> None:
        wait = self.settings.kap_request_interval_s - (time.monotonic() - self._last)
        if wait > 0:
            time.sleep(wait)
        self._last = time.monotonic()

    def _request(self, method: str, url: str, attempts: int = 4, **kw):
        delay = max(self.settings.kap_request_interval_s, 2.0)
        for attempt in range(1, attempts + 1):
            self._throttle()
            try:
                resp = self.session.request(method, url, timeout=45, **kw)
            except Exception as e:  # noqa: BLE001 - network errors are retried
                if attempt == attempts:
                    raise
                log.warning("KAP request error %s, retry %d in %.0fs", e, attempt, delay)
                time.sleep(delay)
                delay *= 2
                continue
            if resp.status_code == 200:
                return resp
            if resp.status_code in (429, 500, 502, 503, 504) and attempt < attempts:
                try:  # honour the server's Retry-After when it sends one
                    wait = max(delay, float(resp.headers.get("Retry-After", 0)))
                except ValueError:
                    wait = delay
                log.warning("KAP HTTP %s, retry %d in %.0fs", resp.status_code, attempt, wait)
                time.sleep(wait)
                delay *= 2
                continue
            if resp.status_code == 429:
                raise KapRateLimited(f"KAP rate limit persists for {url}")
            resp.raise_for_status()
        raise RuntimeError("KAP retries exhausted")

    def list_day(self, day: date) -> list[dict]:
        payload = {"fromDate": day.isoformat(), "toDate": day.isoformat(), "disclosureTypes": None,
                   "memberTypes": ["IGS"], "mkkMemberOid": None}
        data = self._request("POST", self.list_url, json=payload,
                             headers={"Accept": "application/json"}).json()
        return data if isinstance(data, list) else []

    @staticmethod
    def to_rows(item: dict) -> list[dict]:
        """One row per related stock code (a disclosure can name several)."""
        idx = int(item.get("disclosureIndex") or 0)
        codes = [c.strip().upper() for c in str(item.get("stockCodes") or "").split(",") if c.strip()]
        published = parse_kap_time(item.get("publishDate"))
        if not idx or not codes or published is None:
            return []
        base = {
            "disclosure_index": idx,
            "company_title": item.get("kapTitle") or "",
            "published_at": published.isoformat(),
            "disclosure_class": item.get("disclosureClass") or item.get("disclosureCategory") or "",
            "subject": item.get("subject") or "",
            "summary": item.get("summary") or "",
            "body": "",
            "url": f"https://www.kap.org.tr/tr/Bildirim/{idx}",
            "source": "kap",
        }
        return [dict(base, symbol=c) for c in codes]

    def fetch_raw(self, start: date, end: date) -> pd.DataFrame:
        rows: list[dict] = []
        day = start
        while day <= end:
            if day.weekday() < 5 or os.environ.get("FINSENT_KAP_WEEKENDS") == "1":
                items = self.list_day(day)
                kept = [i for i in items if (i.get("subject") or "").strip() not in NOISE_SUBJECTS]
                for i in kept:
                    rows.extend(self.to_rows(i))
                log.info("KAP %s: %d disclosures, %d after noise filter", day, len(items), len(kept))
            day += timedelta(days=1)
        return pd.DataFrame(rows)

    def wants_body(self, subject: str) -> bool:
        mode = self.settings.kap_fetch_body
        if mode == "none":
            return False
        return mode == "all" or any(h in subject for h in BODY_SUBJECT_HINTS)

    def enrich_bodies(self, df: pd.DataFrame, cache: dict | None = None) -> tuple[pd.DataFrame, dict]:
        """Fill ``body`` for relevant rows (at most FINSENT_KAP_MAX_BODIES downloads per run).

        ``cache`` maps disclosure_index -> text so a notice is downloaded at most once.
        """
        cache = dict(cache or {})
        df = df.copy()
        fetched = 0
        for i, r in df.iterrows():
            key = str(r["disclosure_index"])
            if key in cache:
                df.at[i, "body"] = cache[key]
                continue
            if fetched >= self.settings.kap_max_bodies or not self.wants_body(r["subject"]):
                continue
            try:
                text = extract_body_text(self._request("GET", self.detail_url.format(idx=key)).text)
            except KapRateLimited:
                # back off for the rest of the run; the list summaries are still scored
                log.warning("KAP rate limit reached after %d bodies; skipping the remaining texts", fetched)
                break
            except Exception as e:  # noqa: BLE001 - a missing body is not fatal
                log.warning("KAP body %s failed: %s", key, e)
                continue
            cache[key] = text
            df.at[i, "body"] = text
            fetched += 1
        log.info("KAP bodies downloaded: %d (cache %d)", fetched, len(cache))
        return df, cache
