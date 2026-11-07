<?php

declare(strict_types=1);

namespace FinSent;

final class Http
{
    public static function json(mixed $data, int $status = 200): void
    {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION);
    }

    /** @return array<string,mixed> */
    public static function body(): array
    {
        $raw = file_get_contents('php://input') ?: '';
        $data = json_decode($raw, true);
        if (!is_array($data)) {
            throw new HttpError(400, 'request body must be a JSON object');
        }
        return $data;
    }

    public static function query(string $name, ?string $default = null): ?string
    {
        $v = $_GET[$name] ?? null;
        return (is_string($v) && $v !== '') ? $v : $default;
    }

    public static function intQuery(string $name, int $default, int $min, int $max): int
    {
        $v = filter_var($_GET[$name] ?? null, FILTER_VALIDATE_INT);
        return $v === false || $v === null ? $default : max($min, min($max, $v));
    }

    public static function dateQuery(string $name): ?string
    {
        $v = self::query($name);
        if ($v === null) {
            return null;
        }
        $d = \DateTimeImmutable::createFromFormat('!Y-m-d', $v);
        if ($d === false || $d->format('Y-m-d') !== $v) {
            throw new HttpError(400, "$name must be YYYY-MM-DD");
        }
        return $v;
    }

    public static function symbol(string $value): string
    {
        $s = strtoupper(trim($value));
        if (!preg_match('/^[A-Z0-9]{2,12}$/', $s)) {
            throw new HttpError(400, 'invalid symbol');
        }
        return $s;
    }
}
