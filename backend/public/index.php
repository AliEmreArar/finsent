<?php

declare(strict_types=1);

require dirname(__DIR__) . '/vendor/autoload.php';

use FinSent\Controllers\AlertController;
use FinSent\Controllers\AnalysisController;
use FinSent\Controllers\DisclosureController;
use FinSent\Controllers\DrawingController;
use FinSent\Controllers\InstrumentController;
use FinSent\Controllers\MarketController;
use FinSent\Controllers\OverviewController;
use FinSent\Controllers\PairController;
use FinSent\Controllers\PatternController;
use FinSent\Controllers\SocialController;
use FinSent\Http;
use FinSent\HttpError;
use FinSent\Router;

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if (!str_starts_with($path, '/api/')) {
    header('Content-Type: text/html; charset=utf-8');
    readfile(__DIR__ . '/app.html');
    return;
}

// the agent streams NDJSON itself, so it bypasses the JSON router
if ($path === '/api/agent' && $method === 'POST') {
    try {
        FinSent\Controllers\AgentController::stream();
    } catch (HttpError $e) {
        Http::json(['error' => $e->getMessage()], $e->status);
    }
    return;
}

$router = new Router();
$router->get('/api/health', [OverviewController::class, 'health']);
$router->get('/api/overview', [OverviewController::class, 'overview']);
$router->get('/api/pipeline', [OverviewController::class, 'pipeline']);
$router->get('/api/market-summary', [OverviewController::class, 'market']);
$router->get('/api/instruments', [InstrumentController::class, 'tiles']);
$router->get('/api/gold-analysis', [InstrumentController::class, 'goldAnalysis']);
$router->get('/api/event-study', [OverviewController::class, 'eventStudy']);
$router->get('/api/news-impact', [OverviewController::class, 'newsImpact']);
$router->get('/api/symbols', [MarketController::class, 'symbols']);
$router->get('/api/market/{symbol}', [MarketController::class, 'series']);
$router->get('/api/quote/{symbol}', [MarketController::class, 'quote']);
$router->get('/api/forecast/{symbol}', [MarketController::class, 'forecast']);
$router->get('/api/social', [SocialController::class, 'latest']);
$router->get('/api/social/{symbol}', [SocialController::class, 'show']);
$router->post('/api/social/{symbol}', [SocialController::class, 'refresh']);
$router->get('/api/brief', [SocialController::class, 'brief']);
$router->get('/api/disclosures', [DisclosureController::class, 'list']);
$router->get('/api/disclosures/{id}', [DisclosureController::class, 'show']);
$router->get('/api/sentiment/{symbol}/daily', [DisclosureController::class, 'dailySentiment']);
$router->get('/api/patterns', [PatternController::class, 'list']);
$router->get('/api/pair/{a}/{b}', [PairController::class, 'show']);
$router->get('/api/drawings/{symbol}', [DrawingController::class, 'show']);
$router->post('/api/drawings/{symbol}', [DrawingController::class, 'save']);
$router->get('/api/alerts', [AlertController::class, 'list']);
$router->post('/api/alerts', [AlertController::class, 'createFromBody']);
$router->post('/api/alerts/check', [AlertController::class, 'check']);
$router->post('/api/alerts/seen', [AlertController::class, 'markSeen']);
$router->post('/api/alerts/{id}/delete', [AlertController::class, 'delete']);
$router->post('/api/analyze', [AnalysisController::class, 'analyze']);
$router->post('/api/insights/{symbol}', [AnalysisController::class, 'insight']);

try {
    $router->dispatch($method, rtrim($path, '/') ?: '/');
} catch (HttpError $e) {
    Http::json(['error' => $e->getMessage()], $e->status);
} catch (\PDOException $e) {
    error_log('[finsent] db error: ' . $e->getMessage());
    Http::json(['error' => 'database unavailable'], 503);
} catch (\Throwable $e) {
    error_log('[finsent] ' . $e);
    Http::json(['error' => 'internal error'], 500);
}
