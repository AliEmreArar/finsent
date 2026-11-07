"""Generate a synthetic KAP disclosure dataset for local development.

The records are *not* real disclosures: they are produced from templates for
real BIST tickers so that the pipeline, the dashboard and the event studies
can run end to end without network access. Every record carries
``source="sample"`` and the company title is marked "(örnek veri)".

The generator deliberately injects duplicates so the dedup stage has work:
~2% are exact re-sends (same disclosure index) and ~3% are re-publications of
the same text under a new index.

Usage: python scripts/generate_kap_sample.py [--start 2024-06-03] [--end 2025-11-21]
"""
from __future__ import annotations

import argparse
import json
import random
from datetime import date, datetime, time, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SYMBOLS_FILE = ROOT.parent / "bist_symbols.txt"
OUT = ROOT / "data" / "samples" / "kap_disclosures_sample.jsonl"

CLIENTS = ["yurt dışında yerleşik bir müşteri", "bir kamu kurumu", "Avrupa merkezli bir sanayi şirketi",
           "Orta Doğu'da faaliyet gösteren bir yatırımcı", "yurt içinde yerleşik bir holding şirketi"]

# (disclosure_class, subject, summary template, body template, weight)
TEMPLATES = [
    ("ODA", "Yeni İş İlişkisi", "{amount} {ccy} tutarında yeni sözleşme",
     "Şirketimiz ile {client} arasında {amount} {ccy} tutarında, {years} yıl süreli tedarik sözleşmesi imzalanmıştır. "
     "Sözleşmenin şirketimizin satış gelirlerine olumlu katkı sağlaması beklenmektedir.", 8),
    ("ODA", "Özel Durum Açıklaması (Genel)", "İhale sonucu",
     "Şirketimizin katıldığı {amount} {ccy} bedelli ihaleyi şirketimiz en uygun teklif ile kazanmıştır.", 5),
    ("ODA", "Özel Durum Açıklaması (Genel)", "İhale sonucu",
     "Şirketimizin katıldığı ihalede teklifimiz kabul edilmemiş olup ihale başka bir firmaya verilmiştir.", 2),
    ("ODA", "Kar Payı Dağıtım İşlemlerine İlişkin Bildirim", "Nakit kar payı dağıtımı",
     "Yönetim kurulumuz {amount_tl} TL tutarında brüt nakit kar payı dağıtılmasına ve dağıtımın "
     "{month} ayında yapılmasına karar vermiştir. Pay başına brüt kar payı {per_share} TL'dir.", 5),
    ("ODA", "Sermaye Artırımı - Azaltımı İşlemlerine İlişkin Bildirim", "Bedelsiz sermaye artırımı",
     "Şirketimizin çıkarılmış sermayesinin %{pct} oranında bedelsiz olarak artırılması için "
     "Sermaye Piyasası Kurulu'na başvuru yapılmasına karar verilmiştir.", 3),
    ("ODA", "Geri Alınan Paylara İlişkin Bildirim", "Pay geri alımı",
     "Pay geri alım programı kapsamında {shares} adet pay ortalama {price} TL fiyattan geri alınmıştır.", 6),
    ("FR", "Finansal Rapor", "Dönemsel finansal rapor",
     "Şirketimizin {period} dönemine ait finansal raporu ekte sunulmuştur. Net satışlar geçen yılın aynı "
     "dönemine göre %{growth} artış göstermiş, dönem net kârı {amount_tl} TL olarak gerçekleşmiştir.", 5),
    ("FR", "Finansal Rapor", "Dönemsel finansal rapor",
     "Şirketimizin {period} dönemine ait finansal raporu ekte sunulmuştur. Net satışlar geçen yılın aynı "
     "dönemine göre %{decline} düşüş göstermiş ve dönem {amount_tl} TL net zarar ile kapanmıştır.", 3),
    ("FR", "Sorumluluk Beyanı", "Finansal tablolara ilişkin sorumluluk beyanı",
     "{period} dönemine ait finansal tablolara ilişkin sorumluluk beyanı ekte yer almaktadır.", 5),
    ("ODA", "Genel Kurul İşlemlerine İlişkin Bildirim", "Olağan genel kurul toplantısı",
     "Şirketimizin olağan genel kurul toplantısı {month} ayında şirket merkezinde yapılacaktır. "
     "Gündem ve vekaletname örneği ekte yer almaktadır.", 6),
    ("ODA", "Özel Durum Açıklaması (Genel)", "Dava hakkında",
     "Şirketimiz aleyhine açılan {amount_tl} TL tutarlı tazminat davasında mahkeme şirketimiz aleyhine karar vermiştir. "
     "Karara karşı istinaf yoluna başvurulacaktır.", 2),
    ("ODA", "Özel Durum Açıklaması (Genel)", "Dava hakkında",
     "Şirketimiz aleyhine açılan dava reddedilmiş olup şirketimiz için herhangi bir yükümlülük doğmamıştır.", 2),
    ("ODA", "Özel Durum Açıklaması (Genel)", "İdari para cezası",
     "Rekabet Kurumu tarafından şirketimize {amount_tl} TL idari para cezası uygulanmasına karar verilmiştir.", 1),
    ("ODA", "Kredi Derecelendirmesi", "Kredi derecelendirme notu",
     "Kredi derecelendirme kuruluşu şirketimizin uzun vadeli ulusal notunu bir kademe yükseltmiş, "
     "görünümü durağan olarak belirlemiştir.", 2),
    ("ODA", "Kredi Derecelendirmesi", "Kredi derecelendirme notu",
     "Kredi derecelendirme kuruluşu şirketimizin notunu negatif görünümle bir kademe indirmiştir.", 1),
    ("ODA", "Özel Durum Açıklaması (Genel)", "Üretim faaliyetleri hakkında",
     "Fabrikamızda meydana gelen yangın nedeniyle üretime geçici olarak ara verilmiştir. "
     "Hasar tespit çalışmaları devam etmektedir; tesisimiz sigortalıdır.", 1),
    ("ODA", "Özel Durum Açıklaması (Genel)", "Kapasite artışı yatırımı",
     "{amount} {ccy} tutarındaki kapasite artış yatırımımız tamamlanmış ve üretime başlanmıştır. "
     "Yatırım için yatırım teşvik belgesi alınmıştır.", 3),
    ("ODA", "Pay Alım Satım Bildirimi", "Yönetici pay işlemleri",
     "Yönetim kurulu üyemiz {shares} adet şirket payını borsada satın almıştır.", 3),
    ("ODA", "Borçlanma Aracı İhracına İlişkin Bildirim", "Borçlanma aracı ihracı",
     "Şirketimizin {amount_tl} TL nominal tutarlı, {days} gün vadeli finansman bonosu ihracı tamamlanmıştır.", 4),
    ("ODA", "Yönetim Kurulu Komitelerine İlişkin Bildirim", "Komite görev dağılımı",
     "Kurumsal yönetim, denetim ve riskin erken saptanması komitelerinin oluşturulmasına karar verilmiştir.", 3),
    ("ODA", "Özel Durum Açıklaması (Genel)", "Basın haberleri hakkında",
     "Basında şirketimiz hakkında çıkan haberler gerçeği yansıtmamaktadır; şirketimizin finansal yapısı güçlüdür "
     "ve faaliyetleri olağan şekilde devam etmektedir.", 1),
    ("ODA", "Özel Durum Açıklaması (Genel)", "Görev değişikliği",
     "Genel müdürümüz kişisel nedenlerle görevinden istifa etmiştir. Yerine atama yapılıncaya kadar "
     "genel müdür yardımcımız vekaleten görev yapacaktır.", 1),
]

MONTHS = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül",
          "Ekim", "Kasım", "Aralık"]


def fmt(n: float) -> str:
    return f"{n:,.0f}".replace(",", ".")


def render(tpl: str, rng: random.Random, day: date) -> str:
    q = (day.month - 1) // 3
    period = f"{day.year - (1 if q == 0 else 0)}/{[12, 3, 6, 9][q]}"
    return tpl.format(
        amount=fmt(rng.choice([5, 12, 25, 40, 75, 120, 300]) * 1_000_000),
        ccy=rng.choice(["USD", "EUR", "TL"]), client=rng.choice(CLIENTS), years=rng.randint(1, 5),
        amount_tl=fmt(rng.randint(20, 4000) * 1_000_000), month=MONTHS[(day.month + 1) % 12],
        per_share=f"{rng.uniform(0.2, 12):.2f}".replace(".", ","), pct=rng.choice([50, 100, 200, 400]),
        shares=fmt(rng.randint(10, 2000) * 1000), price=f"{rng.uniform(5, 400):.2f}".replace(".", ","),
        period=period, growth=rng.randint(8, 90), decline=rng.randint(5, 40), days=rng.choice([91, 182, 364]),
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2024-06-03")
    ap.add_argument("--end", default="2025-11-21")
    ap.add_argument("--symbols", type=int, default=60)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    symbols = [s.strip().upper() for s in SYMBOLS_FILE.read_text(encoding="utf-8").splitlines() if s.strip()]
    symbols = symbols[: args.symbols]
    start, end = date.fromisoformat(args.start), date.fromisoformat(args.end)
    weights = [t[4] for t in TEMPLATES]

    records, index = [], 9_000_000  # high synthetic range, never collides with real KAP indices
    day = start
    while day <= end:
        if day.weekday() < 5:
            for sym in symbols:
                if rng.random() < 0.06:  # ~1.3 disclosures per symbol per month
                    cls, subject, summary, body_tpl, _ = rng.choices(TEMPLATES, weights)[0]
                    minute = rng.choice([rng.randint(8 * 60, 10 * 60), rng.randint(10 * 60, 18 * 60),
                                         rng.randint(18 * 60, 22 * 60)])
                    ts = datetime.combine(day, time(minute // 60, minute % 60))
                    index += 1
                    rec = {"disclosure_index": index, "symbol": sym, "company_title": f"{sym} (örnek veri)",
                           "published_at": ts.isoformat(), "disclosure_class": cls, "subject": subject,
                           "summary": summary, "body": render(body_tpl, rng, day),
                           "url": f"https://www.kap.org.tr/tr/Bildirim/{index}", "source": "sample"}
                    records.append(rec)
                    r = rng.random()
                    if r < 0.02:      # exact re-send
                        records.append(dict(rec))
                    elif r < 0.05:    # same text, new index, a few minutes later
                        index += 1
                        dup = dict(rec, disclosure_index=index,
                                   published_at=(ts + timedelta(minutes=rng.randint(1, 30))).isoformat(),
                                   url=f"https://www.kap.org.tr/tr/Bildirim/{index}")
                        records.append(dup)
        day += timedelta(days=1)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"wrote {len(records)} synthetic disclosures for {len(symbols)} symbols -> {OUT}")


if __name__ == "__main__":
    main()
