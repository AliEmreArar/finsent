<?php

declare(strict_types=1);

namespace FinSent;

final class Config
{
    public static function get(string $name, ?string $default = null): ?string
    {
        $value = getenv($name);
        return ($value === false || $value === '') ? $default : $value;
    }

    /** Active LLM provider: anthropic | xai | lexicon (FINSENT_LLM_PROVIDER=auto picks by available key). */
    public static function llmProvider(): string
    {
        $p = self::get('FINSENT_LLM_PROVIDER', 'auto');
        if (in_array($p, ['anthropic', 'xai', 'lexicon'], true)) {
            return $p;
        }
        if (self::get('ANTHROPIC_API_KEY') !== null) {
            return 'anthropic';
        }
        return self::get('XAI_API_KEY') !== null ? 'xai' : 'lexicon';
    }

    public static function llmEnabled(): bool
    {
        return self::llmProvider() !== 'lexicon';
    }

    public static function grokEnabled(): bool
    {
        return self::get('XAI_API_KEY') !== null;
    }

    public static function llmModel(): string
    {
        return self::llmProvider() === 'xai' ? self::xaiModel() : self::get('FINSENT_LLM_MODEL', 'claude-opus-5');
    }

    /** Flagship Grok model (search, insights, real-time analysis). */
    public static function xaiModel(): string
    {
        return self::get('XAI_MODEL', 'grok-4.7');
    }

    public static function resourcesDir(): string
    {
        return self::get('FINSENT_RESOURCES', dirname(__DIR__) . '/resources');
    }
}
