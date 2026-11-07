<?php

declare(strict_types=1);

namespace FinSent\Services;

/**
 * Offline Turkish financial sentiment scorer - a port of
 * pipeline/finsent/sentiment/lexicon.py over the same lexicon file.
 */
final class LexiconSentiment
{
    /** @var list<array{list<string>,float}> */
    private array $terms = [];
    /** @var array<string,bool> */
    private array $negators = [];
    /** @var list<array{list<string>,float}> */
    private array $intensifiers = [];
    /** @var list<array{list<string>,string}> */
    private array $eventTerms = [];
    private string $version;

    public function __construct(string $lexiconPath)
    {
        $lex = json_decode((string) file_get_contents($lexiconPath), true, flags: JSON_THROW_ON_ERROR);
        $this->version = (string) ($lex['version'] ?? '0');
        foreach ([...array_keys($lex['positive']), ...array_keys($lex['negative'])] as $k) {
            $w = $lex['positive'][$k] ?? $lex['negative'][$k];
            $this->terms[] = [self::tokenize((string) $k), (float) $w];
        }
        usort($this->terms, fn($a, $b) => count($b[0]) <=> count($a[0]));
        foreach ($lex['negators'] as $n) {
            $this->negators[$n] = true;
        }
        foreach ($lex['intensifiers'] as $k => $v) {
            $this->intensifiers[] = [self::tokenize((string) $k), (float) $v];
        }
        foreach ($lex['neutral_event_types'] as $k => $v) {
            $this->eventTerms[] = [self::tokenize((string) $k), (string) $v];
        }
        usort($this->eventTerms, fn($a, $b) => count($b[0]) <=> count($a[0]));
    }

    public static function trLower(string $text): string
    {
        return mb_strtolower(str_replace(['I', 'İ'], ['ı', 'i'], $text), 'UTF-8');
    }

    /** @return list<string> */
    public static function tokenize(string $text): array
    {
        preg_match_all('/[0-9a-zçğıöşüâîû%]+/u', self::trLower($text), $m);
        return $m[0];
    }

    /** @param list<string> $tokens @param list<string> $phrase */
    private static function matchAt(array $tokens, int $i, array $phrase): bool
    {
        if ($i + count($phrase) > count($tokens)) {
            return false;
        }
        foreach ($phrase as $j => $p) {
            if (!str_starts_with($tokens[$i + $j], $p)) {
                return false;
            }
        }
        return true;
    }

    /** @param list<string> $tokens @return array{float,list<string>} */
    private function scoreTokens(array $tokens): array
    {
        $total = 0.0;
        $hits = [];
        $n = count($tokens);
        $i = 0;
        while ($i < $n) {
            $matched = false;
            foreach ($this->terms as [$phrase, $weight]) {
                if (!self::matchAt($tokens, $i, $phrase)) {
                    continue;
                }
                $w = $weight;
                $before = array_slice($tokens, max(0, $i - 3), $i - max(0, $i - 3));
                foreach ($this->intensifiers as [$intens, $mult]) {
                    $k = count($intens);
                    for ($s = 0; $s + $k <= count($before); $s++) {
                        if (array_slice($before, $s, $k) === $intens) {
                            $w *= $mult;
                            break;
                        }
                    }
                }
                foreach (array_slice($tokens, $i + count($phrase), 3) as $t) {
                    if (isset($this->negators[$t])) {
                        $w = -$w * 0.8;
                        break;
                    }
                }
                $total += $w;
                $hits[] = implode(' ', array_slice($tokens, $i, count($phrase)));
                $i += count($phrase);
                $matched = true;
                break;
            }
            if (!$matched) {
                $i++;
            }
        }
        return [$total, $hits];
    }

    public function eventType(string $text): string
    {
        $tokens = self::tokenize($text);
        foreach (array_keys($tokens) as $i) {
            foreach ($this->eventTerms as [$phrase, $type]) {
                if (self::matchAt($tokens, $i, $phrase)) {
                    return $type;
                }
            }
        }
        return 'other';
    }

    /** @return array<string,mixed> */
    public function analyze(string $text): array
    {
        $lower = self::trLower($text);
        if (preg_match('/(*UCP)\b(rağmen|karşın|ancak|fakat|ama|buna karşılık)\b/u', $lower, $m, PREG_OFFSET_CAPTURE)) {
            [$word, $offset] = $m[1];
            [$s1, $h1] = $this->scoreTokens(self::tokenize(substr($lower, 0, $offset)));
            [$s2, $h2] = $this->scoreTokens(self::tokenize(substr($lower, $offset + strlen($word))));
            $raw = in_array($word, ['rağmen', 'karşın'], true) ? 0.4 * $s1 + 1.2 * $s2 : 0.6 * $s1 + 1.2 * $s2;
            $hits = [...$h1, ...$h2];
        } else {
            [$raw, $hits] = $this->scoreTokens(self::tokenize($lower));
        }
        $score = tanh($raw / 1.5);
        $label = $score > 0.2 ? 'positive' : ($score < -0.2 ? 'negative' : 'neutral');
        return [
            'label' => $label,
            'score' => round($score, 4),
            'confidence' => $hits ? round(min(1.0, 0.35 + 0.2 * count($hits)), 3) : 0.3,
            'event_type' => $this->eventType($text),
            'key_points' => array_slice($hits, 0, 5),
            'rationale' => 'lexicon hits: ' . (implode(', ', array_slice($hits, 0, 5)) ?: 'none'),
            'provider' => 'lexicon',
            'model' => 'lexicon-tr-' . $this->version,
        ];
    }
}
