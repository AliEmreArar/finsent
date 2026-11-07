<?php

declare(strict_types=1);

namespace FinSent\Controllers;

use FinSent\Config;
use FinSent\Db;
use FinSent\Http;
use FinSent\HttpError;
use FinSent\Services\GrokClient;

/** Social (X / web) sentiment and daily market briefs, both produced by Grok search. */
final class SocialController
{
    private const JSON_COLS = ['themes', 'notable_posts', 'citations'];

    private static function decode(array $row): array
    {
        foreach (self::JSON_COLS as $c) {
            if (array_key_exists($c, $row)) {
                $row[$c] = $row[$c] !== null ? json_decode((string) $row[$c], true) : [];
            }
        }
        return $row;
    }

    /** Latest social sentiment for every tracked symbol. @return list<array<string,mixed>> */
    public static function latest(): array
    {
        $rows = Db::all(
            'SELECT s.symbol, s.as_of, s.label, s.score, s.bullish_share, s.bearish_share, s.post_volume,
                    s.summary, s.themes, s.posts_fetched, s.model
               FROM social_sentiment s
               JOIN (SELECT symbol, MAX(as_of) AS d FROM social_sentiment GROUP BY symbol) l
                 ON l.symbol = s.symbol AND l.d = s.as_of
              ORDER BY s.as_of DESC, ABS(s.score) DESC LIMIT 100'
        );
        return array_map([self::class, 'decode'], $rows);
    }

    /** @return array<string,mixed> */
    public static function show(string $symbol): array
    {
        $symbol = Http::symbol($symbol);
        $rows = Db::all('SELECT * FROM social_sentiment WHERE symbol = ? ORDER BY as_of DESC LIMIT 30', [$symbol]);
        return ['symbol' => $symbol, 'grok' => Config::grokEnabled(),
                'history' => array_map([self::class, 'decode'], $rows)];
    }

    /** Run a live Grok X search now (cached per symbol per day). @return array<string,mixed> */
    public static function refresh(string $symbol): array
    {
        $symbol = Http::symbol($symbol);
        if (!Config::grokEnabled()) {
            throw new HttpError(503, 'XAI_API_KEY tanımlı değil');
        }
        $today = (new \DateTimeImmutable('now', new \DateTimeZone('Europe/Istanbul')))->format('Y-m-d');
        $cached = Db::one('SELECT * FROM social_sentiment WHERE symbol = ? AND as_of = ?', [$symbol, $today]);
        $force = ($_GET['force'] ?? '') === '1';
        if ($cached && !$force) {
            return ['cached' => true] + self::decode($cached);
        }
        $days = max(1, min(14, (int) ($_GET['days'] ?? 3)));
        $from = (new \DateTimeImmutable($today))->modify("-$days days")->format('Y-m-d');
        $company = Db::one('SELECT title FROM companies WHERE symbol = ?', [$symbol])['title'] ?? null;
        $r = (new GrokClient(Config::xaiModel(), Config::xaiModel()))
            ->social($symbol, $company, $from, $today, ($_GET['web'] ?? '') === '1');
        Db::exec(
            'REPLACE INTO social_sentiment (symbol, as_of, window_start, window_end, label, score, bullish_share,
                 bearish_share, post_volume, summary, themes, notable_posts, citations, provider, model, posts_fetched, cost_usd)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [$symbol, $today, $from, $today, $r['label'], $r['score'], $r['bullish_share'], $r['bearish_share'],
             $r['post_volume'], $r['summary'], json_encode($r['themes'], JSON_UNESCAPED_UNICODE),
             json_encode($r['notable_posts'], JSON_UNESCAPED_UNICODE), json_encode($r['citations'], JSON_UNESCAPED_UNICODE),
             $r['provider'], $r['model'], $r['posts_fetched'], $r['cost_usd']]
        );
        return ['cached' => false, 'symbol' => $symbol, 'as_of' => $today, 'window_start' => $from] + $r;
    }

    /** Latest daily market brief. @return array<string,mixed>|null */
    public static function brief(): ?array
    {
        $row = Db::one('SELECT as_of, mood, summary, payload, model, cost_usd, created_at FROM market_briefs
                         ORDER BY as_of DESC LIMIT 1');
        if (!$row) {
            return null;
        }
        $row['payload'] = json_decode((string) $row['payload'], true);
        return $row;
    }
}
