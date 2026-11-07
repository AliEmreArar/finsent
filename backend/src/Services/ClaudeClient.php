<?php

declare(strict_types=1);

namespace FinSent\Services;

use Anthropic\Client;
use FinSent\Config;

/**
 * Real-time LLM calls for the web app (official Anthropic PHP SDK).
 * Structured outputs guarantee schema-valid JSON; callers fall back to the
 * lexicon / rule-based path when this throws.
 */
final class ClaudeClient
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
recent price statistics and recent KAP disclosure sentiment for one stock. Write a short, balanced
interpretation in Turkish: what the signals suggest together, where they conflict, and the main
risks. Do not give investment advice or price targets; describe the evidence.
TXT;

    private const EVENT_TYPES = ['financial_report', 'dividend', 'capital_increase', 'buyback', 'new_business',
        'legal', 'rating', 'm_and_a', 'debt', 'governance', 'operations', 'investment', 'regulatory', 'other'];

    private Client $client;

    public function __construct(private readonly string $model)
    {
        $this->client = new Client(apiKey: (string) Config::get('ANTHROPIC_API_KEY'));
    }

    /** @return array<string,mixed> */
    private function structured(string $system, string $user, array $schema, int $maxTokens): array
    {
        $message = $this->client->messages->create(
            model: $this->model,
            maxTokens: $maxTokens,
            system: $system,
            messages: [['role' => 'user', 'content' => $user]],
            outputConfig: [
                'effort' => Config::get('FINSENT_LLM_EFFORT', 'low'),
                'format' => ['type' => 'json_schema', 'schema' => $schema],
            ],
        );
        if ($message->stopReason === 'refusal') {
            throw new \RuntimeException('model refused the request');
        }
        if ($message->stopReason === 'max_tokens') {
            throw new \RuntimeException('structured output truncated');
        }
        foreach ($message->content as $block) {
            if ($block->type === 'text') {
                return json_decode($block->text, true, flags: JSON_THROW_ON_ERROR);
            }
        }
        throw new \RuntimeException('no text block in response');
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
        $data = $this->structured(self::SENTIMENT_SYSTEM, $user, $schema, 4000);
        $data['score'] = max(-1.0, min(1.0, (float) $data['score']));
        $data['confidence'] = max(0.0, min(1.0, (float) $data['confidence']));
        $data['provider'] = 'anthropic';
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
        $user = json_encode($context, JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
        $data = $this->structured(self::INSIGHT_SYSTEM, (string) $user, $schema, 6000);
        $data['provider'] = 'anthropic';
        $data['model'] = $this->model;
        return $data;
    }
}
