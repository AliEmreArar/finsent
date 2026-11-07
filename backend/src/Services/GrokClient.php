<?php

declare(strict_types=1);

namespace FinSent\Services;

use FinSent\Config;
use GuzzleHttp\Client;
use GuzzleHttp\Exception\GuzzleException;

/**
 * xAI Grok over its REST API: structured sentiment / insights via chat
 * completions, and social sentiment via the Responses API with the
 * server-side x_search / web_search tools.
 */
final class GrokClient
{
    private const SENTIMENT_SYSTEM = <<<'TXT'
You are a financial analyst covering Borsa Istanbul. You read company disclosures published on KAP
(Kamuyu Aydınlatma Platformu), usually in Turkish, and judge their likely effect on the company's
share price from a shareholder's point of view.

Score guidance: +1 = clearly value-accretive news (large contract win, strong earnings beat, bonus
issue), 0 = routine/administrative notice with no price relevance, -1 = clearly value-destructive
news (large loss, bankruptcy filing, regulatory ban). Routine filings (general assembly notices,
responsibility statements, address changes) are neutral even when they mention words like "kâr" or
"dava". Denials of negative rumours and dismissed lawsuits are positive. When a sentence contrasts
two facts ("...rağmen..."), weigh the main clause.

key_points: up to 4 short phrases, in Turkish, quoting or paraphrasing the facts that drove the
score. rationale: one or two sentences in Turkish.
TXT;

    private const INSIGHT_SYSTEM = <<<'TXT'
You are a technical and fundamental analyst for Borsa Istanbul. You get detected chart patterns,
recent price statistics, recent KAP disclosure sentiment and (when available) recent social-media
sentiment for one stock. Write a short, balanced interpretation in Turkish: what the signals
suggest together, where they conflict, and the main risks. Do not give investment advice or price
targets; describe the evidence.
TXT;

    private const SOCIAL_SYSTEM = <<<'TXT'
You are a market-sentiment analyst for Borsa Istanbul (BIST). Use the search tools to find recent
posts and news about the given stock and summarise what investors are saying. Focus on the listed
company (ticker and company name), ignore unrelated uses of the same word, and discount obvious
spam, bots and paid promotion ("VIP grup", "sinyal kanalı"). Report in Turkish. score: -1 very
bearish .. +1 very bullish. label: overall tone. bullish_share / bearish_share: rough shares (0..1)
of opinionated posts. themes: 2-6 short topics. notable_posts: up to 5 representative, informative
posts with their URL (skip profanity, insults and pure hype). Do not give investment advice.
TXT;

    private const EVENT_TYPES = ['financial_report', 'dividend', 'capital_increase', 'buyback', 'new_business',
        'legal', 'rating', 'm_and_a', 'debt', 'governance', 'operations', 'investment', 'regulatory', 'other'];

    private Client $http;

    public function __construct(private readonly string $model, private readonly string $searchModel)
    {
        $this->http = new Client([
            'base_uri' => rtrim((string) Config::get('XAI_BASE_URL', 'https://api.x.ai/v1'), '/') . '/',
            'timeout' => 180,
            'headers' => [
                'Authorization' => 'Bearer ' . Config::get('XAI_API_KEY'),
                'Content-Type' => 'application/json',
            ],
        ]);
    }

    /** @return array<string,mixed> */
    private function post(string $path, array $body): array
    {
        try {
            $resp = $this->http->post($path, ['json' => $body]);
        } catch (GuzzleException $e) {
            throw new \RuntimeException('xAI request failed: ' . $e->getMessage(), 0, $e);
        }
        return json_decode((string) $resp->getBody(), true, flags: JSON_THROW_ON_ERROR);
    }

    /** @return array<string,mixed> */
    private function chatJson(string $model, string $system, string $user, array $schema, string $name): array
    {
        $data = $this->post('chat/completions', [
            'model' => $model,
            'messages' => [['role' => 'system', 'content' => $system], ['role' => 'user', 'content' => $user]],
            'response_format' => ['type' => 'json_schema',
                'json_schema' => ['name' => $name, 'schema' => $schema, 'strict' => true]],
        ]);
        $choice = $data['choices'][0] ?? null;
        if (!$choice || ($choice['finish_reason'] ?? '') === 'length') {
            throw new \RuntimeException('no complete structured output');
        }
        return json_decode((string) $choice['message']['content'], true, flags: JSON_THROW_ON_ERROR);
    }

    /** @return array{0: array<string,mixed>, 1: list<array{url:string,title:string}>, 2: array<string,mixed>} */
    private function searchJson(string $system, string $user, array $schema, string $name, array $tools, int $maxToolCalls): array
    {
        $data = $this->post('responses', [
            'model' => $this->searchModel,
            'instructions' => $system,
            'input' => [['role' => 'user', 'content' => $user]],
            'tools' => $tools,
            'max_tool_calls' => $maxToolCalls,
            'text' => ['format' => ['type' => 'json_schema', 'name' => $name, 'schema' => $schema, 'strict' => true]],
        ]);
        $text = null;
        $citations = [];
        foreach ($data['output'] ?? [] as $item) {
            if (($item['type'] ?? '') !== 'message') {
                continue;
            }
            foreach ($item['content'] ?? [] as $c) {
                if (($c['type'] ?? '') === 'output_text') {
                    $text = $c['text'];
                    foreach ($c['annotations'] ?? [] as $a) {
                        if (($a['type'] ?? '') === 'url_citation' && !empty($a['url'])) {
                            $citations[$a['url']] = ['url' => $a['url'], 'title' => $a['title'] ?? $a['url']];
                        }
                    }
                }
            }
        }
        if ($text === null) {
            throw new \RuntimeException('no output_text in xAI response');
        }
        return [json_decode($text, true, flags: JSON_THROW_ON_ERROR), array_values($citations), $data['usage'] ?? []];
    }

    public static function costUsd(array $usage): ?float
    {
        return isset($usage['cost_in_usd_ticks']) ? round($usage['cost_in_usd_ticks'] / 1e10, 4) : null;
    }

    /** @return array<string,mixed> */
    public function sentiment(string $text, ?string $symbol = null): array
    {
        $schema = [
            'type' => 'object',
            'properties' => [
                'label' => ['type' => 'string', 'enum' => ['positive', 'negative', 'neutral']],
                'score' => ['type' => 'number', 'description' => '-1 (very negative) to +1 (very positive)'],
                'confidence' => ['type' => 'number', 'description' => '0 to 1'],
                'event_type' => ['type' => 'string', 'enum' => self::EVENT_TYPES],
                'key_points' => ['type' => 'array', 'items' => ['type' => 'string']],
                'rationale' => ['type' => 'string'],
            ],
            'required' => ['label', 'score', 'confidence', 'event_type', 'key_points', 'rationale'],
            'additionalProperties' => false,
        ];
        $user = ($symbol ? "Symbol: $symbol\n" : '') . "Disclosure text:\n" . mb_substr($text, 0, 12000);
        $data = $this->chatJson($this->model, self::SENTIMENT_SYSTEM, $user, $schema, 'disclosure_sentiment');
        $data['score'] = max(-1.0, min(1.0, (float) $data['score']));
        $data['confidence'] = max(0.0, min(1.0, (float) $data['confidence']));
        $data['provider'] = 'xai';
        $data['model'] = $this->model;
        return $data;
    }

    /** @param array<string,mixed> $context @return array<string,mixed> */
    public function insight(array $context): array
    {
        $schema = [
            'type' => 'object',
            'properties' => [
                'summary' => ['type' => 'string'],
                'bias' => ['type' => 'string', 'enum' => ['bullish', 'bearish', 'neutral', 'mixed']],
                'signals' => ['type' => 'array', 'items' => ['type' => 'string']],
                'risks' => ['type' => 'array', 'items' => ['type' => 'string']],
            ],
            'required' => ['summary', 'bias', 'signals', 'risks'],
            'additionalProperties' => false,
        ];
        $user = (string) json_encode($context, JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
        $data = $this->chatJson($this->searchModel, self::INSIGHT_SYSTEM, $user, $schema, 'pattern_insight');
        $data['provider'] = 'xai';
        $data['model'] = $this->searchModel;
        return $data;
    }

    /** Live X (+ optional web) search for one stock. @return array<string,mixed> */
    public function social(string $symbol, ?string $company, string $from, string $to, bool $web = false): array
    {
        $schema = [
            'type' => 'object',
            'properties' => [
                'label' => ['type' => 'string', 'enum' => ['positive', 'negative', 'neutral', 'mixed']],
                'score' => ['type' => 'number'],
                'bullish_share' => ['type' => 'number'],
                'bearish_share' => ['type' => 'number'],
                'post_volume' => ['type' => 'string', 'enum' => ['none', 'low', 'medium', 'high']],
                'summary' => ['type' => 'string'],
                'themes' => ['type' => 'array', 'items' => ['type' => 'string']],
                'notable_posts' => ['type' => 'array', 'items' => [
                    'type' => 'object',
                    'properties' => ['text' => ['type' => 'string'], 'url' => ['type' => 'string'],
                        'stance' => ['type' => 'string', 'enum' => ['bullish', 'bearish', 'neutral']]],
                    'required' => ['text', 'url', 'stance'], 'additionalProperties' => false]],
            ],
            'required' => ['label', 'score', 'bullish_share', 'bearish_share', 'post_volume', 'summary', 'themes', 'notable_posts'],
            'additionalProperties' => false,
        ];
        $tools = [['type' => 'x_search', 'from_date' => $from, 'to_date' => $to]];
        if ($web) {
            $tools[] = ['type' => 'web_search'];
        }
        $who = "\$$symbol / #$symbol" . ($company ? " ($company)" : '');
        $user = "Hisse: $who, Borsa İstanbul. Dönem: $from - $to. Bu dönemde X'te (ve gerekiyorsa haberlerde) bu hisse hakkında ne konuşuluyor?";
        [$data, $citations, $usage] = $this->searchJson(self::SOCIAL_SYSTEM, $user, $schema, 'social_sentiment', $tools, 3);
        $data['score'] = max(-1.0, min(1.0, (float) $data['score']));
        $data['citations'] = $citations;
        $data['provider'] = 'xai';
        $data['model'] = $this->searchModel;
        $data['posts_fetched'] = $usage['server_side_tool_usage_details']['x_posts_fetched'] ?? null;
        $data['cost_usd'] = self::costUsd($usage);
        return $data;
    }
}
