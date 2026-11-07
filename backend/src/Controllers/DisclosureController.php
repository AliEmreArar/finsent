<?php

declare(strict_types=1);

namespace FinSent\Controllers;

use FinSent\Db;
use FinSent\Http;
use FinSent\HttpError;

final class DisclosureController
{
    private const LABELS = ['positive', 'negative', 'neutral'];

    /** @return array<string,mixed> */
    public static function list(): array
    {
        $where = [];
        $params = [];
        if ($s = Http::query('symbol')) {
            $where[] = 'd.symbol = ?';
            $params[] = Http::symbol($s);
        }
        if ($label = Http::query('label')) {
            if (!in_array($label, self::LABELS, true)) {
                throw new HttpError(400, 'label must be positive|negative|neutral');
            }
            $where[] = 's.label = ?';
            $params[] = $label;
        }
        if ($type = Http::query('event_type')) {
            $where[] = 's.event_type = ?';
            $params[] = $type;
        }
        if ($from = Http::dateQuery('from')) {
            $where[] = 'd.published_at >= ?';
            $params[] = $from;
        }
        if ($to = Http::dateQuery('to')) {
            $where[] = 'd.published_at < DATE_ADD(?, INTERVAL 1 DAY)';
            $params[] = $to;
        }
        if ($q = Http::query('q')) {
            $where[] = '(d.subject LIKE ? OR d.body LIKE ?)';
            $params[] = "%$q%";
            $params[] = "%$q%";
        }
        $sql = 'FROM disclosures d LEFT JOIN v_sentiment s USING (disclosure_id)
                LEFT JOIN event_returns e USING (disclosure_id)'
            . ($where ? ' WHERE ' . implode(' AND ', $where) : '');
        $limit = Http::intQuery('limit', 50, 1, 500);
        $offset = Http::intQuery('offset', 0, 0, 1_000_000);
        $total = (int) Db::one("SELECT COUNT(*) AS n $sql", $params)['n'];
        $rows = Db::all(
            "SELECT d.disclosure_id, d.symbol, d.company_title, d.published_at, d.disclosure_class, d.subject,
                    d.summary, d.body, d.url, d.source, s.label, s.score, s.confidence, s.event_type,
                    s.key_points, s.provider, s.model, e.event_date, e.car_1d, e.car_3d, e.car_5d
             $sql ORDER BY d.published_at DESC LIMIT $limit OFFSET $offset",
            $params
        );
        foreach ($rows as &$r) {
            $r['key_points'] = $r['key_points'] !== null ? json_decode((string) $r['key_points'], true) : [];
        }
        return ['total' => $total, 'limit' => $limit, 'offset' => $offset, 'items' => $rows];
    }

    /** @return array<string,mixed> */
    public static function show(string $id): array
    {
        $row = Db::one('SELECT * FROM disclosures WHERE disclosure_id = ?', [$id]);
        if ($row === null) {
            throw new HttpError(404, 'disclosure not found');
        }
        $row['sentiment'] = Db::all('SELECT provider, model, label, score, confidence, event_type, key_points, rationale
                                       FROM disclosure_sentiment WHERE disclosure_id = ?', [$id]);
        foreach ($row['sentiment'] as &$s) {
            $s['key_points'] = json_decode((string) $s['key_points'], true);
        }
        $row['event_returns'] = Db::one('SELECT * FROM event_returns WHERE disclosure_id = ?', [$id]);
        return $row;
    }

    /** Daily average sentiment for one symbol. @return list<array<string,mixed>> */
    public static function dailySentiment(string $symbol): array
    {
        return Db::all(
            'SELECT DATE(d.published_at) AS day, COUNT(*) AS n, AVG(s.score) AS avg_score,
                    SUM(s.label = "positive") AS pos, SUM(s.label = "negative") AS neg
               FROM disclosures d JOIN v_sentiment s USING (disclosure_id)
              WHERE d.symbol = ? GROUP BY DATE(d.published_at) ORDER BY day',
            [Http::symbol($symbol)]
        );
    }
}
