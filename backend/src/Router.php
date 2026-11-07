<?php

declare(strict_types=1);

namespace FinSent;

final class Router
{
    /** @var list<array{string,string,callable}> */
    private array $routes = [];

    public function get(string $pattern, callable $handler): void
    {
        $this->routes[] = ['GET', $pattern, $handler];
    }

    public function post(string $pattern, callable $handler): void
    {
        $this->routes[] = ['POST', $pattern, $handler];
    }

    public function dispatch(string $method, string $path): void
    {
        $allowed = false;
        foreach ($this->routes as [$m, $pattern, $handler]) {
            $regex = '#^' . preg_replace('#\{(\w+)\}#', '(?P<$1>[^/]+)', $pattern) . '$#';
            if (!preg_match($regex, $path, $matches)) {
                continue;
            }
            $allowed = true;
            if ($m !== $method) {
                continue;
            }
            $args = array_filter($matches, 'is_string', ARRAY_FILTER_USE_KEY);
            Http::json($handler(...array_map('urldecode', $args)));
            return;
        }
        throw new HttpError($allowed ? 405 : 404, $allowed ? 'method not allowed' : 'not found');
    }
}
