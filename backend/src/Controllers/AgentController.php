<?php

declare(strict_types=1);

namespace FinSent\Controllers;

use FinSent\Config;
use FinSent\Http;
use FinSent\HttpError;
use FinSent\Services\AgentTools;
use GuzzleHttp\Client;
use GuzzleHttp\Exception\GuzzleException;

/**
 * Chart-aware Grok agent. POST /api/agent streams NDJSON events while the model works:
 *   {"type":"status"} {"type":"tool","name","args"} {"type":"tool_done","name","ok","ms"}
 *   {"type":"chart","symbol","actions"} {"type":"answer","text","citations","usage"} {"type":"error"}
 * The loop runs server-side: Grok calls our function tools (data, indicators, backtests,
 * chart drawing) and its own web/X search, until it writes the final answer.
 */
final class AgentController
{
    private const MAX_STEPS = 8;

    private const SYSTEM = <<<'TXT'
Sen FinSent'in Borsa İstanbul analiz asistanısın. Kullanıcı Türkçe konuşur; her zaman Türkçe, net ve
kısa yanıt ver. Kullanıcının ekranda gördüğü bağlam (sayfa, hisse, mum aralığı, para birimi) aşağıda verilir;
soru belirsizse bu bağlamdaki hisseyi kastettiğini varsay.

Kurallar:
- Rakam uydurma. Fiyat, indikatör, haber, tahmin ya da istatistik gerekiyorsa önce araçları çağır; birden fazla
  bağımsız aracı aynı adımda paralel çağırabilirsin.
- Grafik üzerinde göstermek mantıklıysa (destek/direnç, hedef, önemli tarih, farklı zaman dilimi) chart_actions
  ile grafiğe çiz ve yanıtında bunu belirt. Seviye çizerken find_support_resistance veya fiyat verisine dayan.
- Güncel haber veya piyasa yorumu gerekiyorsa web_search / x_search kullan ve kaynağı kısaca an.
- Model tahminleri zayıf kanıttır (isabet yazı-turaya yakın); bunu söylemeden kesin yön iddia etme.
- Backtest sonuçlarını alırken maliyeti ve "geçmiş getiri geleceği garanti etmez" uyarısını unutma.
- Yatırım tavsiyesi verme; kanıtı ve olasılıkları anlat. Gerekirse riskleri belirt.
- Kullanıcının çizdiği trend çizgileri, kanallar, Fibonacci ve seviyeler bağlamda (ya da get_user_drawings ile) gelir:
  bunları "senin çizdiğin kanal/trend" diye an, fiyatın bunlara göre konumunu (üstünde/altında, kanalın neresinde) yorumla.
  İstenirse chart_actions ile trendline / channel / fib çizebilirsin (noktaları fiyat verisindeki gerçek tepe/diplerden seç).
- Kullanıcı "haber ver / uyar / alarm" derse create_alert ile alarm kur ve ne zaman tetikleneceğini söyle.
- Mesajda grafik görüntüsü varsa onu dikkatle incele (trend, formasyon, hacim) ama sayısal iddiaları araç verisiyle doğrula.
- Yanıt biçimi: kısa paragraflar ve gerektiğinde madde işaretleri; önemli sayıları **kalın** yaz.
TXT;

    private static function emit(array $event): void
    {
        echo json_encode($event, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION), "\n";
        @ob_flush();
        flush();
    }

    public static function stream(): void
    {
        $body = Http::body();
        $message = trim((string) ($body['message'] ?? ''));
        if ($message === '' || mb_strlen($message) > 4000) {
            throw new HttpError(400, 'mesaj gerekli (en fazla 4000 karakter)');
        }
        if (!Config::grokEnabled()) {
            throw new HttpError(503, 'XAI_API_KEY tanımlı değil');
        }
        // stream: no buffering anywhere between PHP and the browser
        @ini_set('zlib.output_compression', '0');
        @ini_set('output_buffering', '0');
        if (function_exists('apache_setenv')) {
            @apache_setenv('no-gzip', '1');
        }
        while (ob_get_level() > 0) {
            ob_end_flush();
        }
        ob_implicit_flush(true);
        header('Content-Type: application/x-ndjson; charset=utf-8');
        header('Cache-Control: no-cache');
        header('X-Accel-Buffering: no');
        set_time_limit(300);

        $ctx = is_array($body['context'] ?? null) ? $body['context'] : [];
        $drawings = is_array($ctx['drawings'] ?? null) ? array_slice($ctx['drawings'], 0, 15) : [];
        $context = 'Bağlam: ' . json_encode(array_intersect_key($ctx, array_flip(['page', 'symbol', 'interval', 'range', 'currency', 'pair'])),
                JSON_UNESCAPED_UNICODE)
            . ($drawings ? "\nKullanıcının grafikte şu an görünen çizimleri (sayısal anlamıyla): " . json_encode($drawings, JSON_UNESCAPED_UNICODE) : '') . ' · Bugün: ' . date('Y-m-d') . ' · Son veri günü: '
            . (\FinSent\Db::one('SELECT MAX(trade_date) AS d FROM market_daily WHERE source <> "instrument"')['d'] ?? '?');
        $input = [];
        foreach (array_slice(is_array($body['history'] ?? null) ? $body['history'] : [], -10) as $h) {
            if (in_array($h['role'] ?? '', ['user', 'assistant'], true) && is_string($h['content'] ?? null)) {
                $input[] = ['role' => $h['role'], 'content' => mb_substr($h['content'], 0, 6000)];
            }
        }
        $image = (string) ($body['image'] ?? '');
        if ($image !== '' && preg_match('#^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$#', $image) && strlen($image) < 4_000_000) {
            // the user attached a screenshot of the chart they are looking at
            $input[] = ['role' => 'user', 'content' => [
                ['type' => 'input_text', 'text' => $message . "

(Ekte kullanıcının şu an ekranda gördüğü grafiğin görüntüsü var.)"],
                ['type' => 'input_image', 'image_url' => $image],
            ]];
        } else {
            $input[] = ['role' => 'user', 'content' => $message];
        }

        $http = new Client([
            'base_uri' => rtrim((string) Config::get('XAI_BASE_URL', 'https://api.x.ai/v1'), '/') . '/',
            'timeout' => 240,
            'headers' => ['Authorization' => 'Bearer ' . Config::get('XAI_API_KEY'), 'Content-Type' => 'application/json'],
        ]);
        $model = (string) Config::get('XAI_AGENT_MODEL', Config::xaiModel());
        $tools = AgentTools::definitions();
        $prev = null;
        $usage = ['input_tokens' => 0, 'output_tokens' => 0, 'cost_usd' => 0.0, 'tool_calls' => 0];
        self::emit(['type' => 'status', 'text' => 'Düşünüyor…']);

        try {
            for ($step = 0; $step < self::MAX_STEPS; $step++) {
                $req = ['model' => $model, 'input' => $input, 'tools' => $tools, 'max_tool_calls' => 12];
                if ($prev) {
                    // continuation: the stored response already carries the instructions
                    $req['previous_response_id'] = $prev;
                } else {
                    $req['instructions'] = self::SYSTEM . "\n\n" . $context;
                }
                try {
                    $resp = json_decode((string) $http->post('responses', ['json' => $req])->getBody(), true, flags: JSON_THROW_ON_ERROR);
                } catch (GuzzleException $e) {
                    self::emit(['type' => 'error', 'text' => 'Grok\'a ulaşılamadı: ' . mb_substr($e->getMessage(), 0, 200)]);
                    return;
                }
                $prev = $resp['id'] ?? null;
                $u = $resp['usage'] ?? [];
                $usage['input_tokens'] += (int) ($u['input_tokens'] ?? 0);
                $usage['output_tokens'] += (int) ($u['output_tokens'] ?? 0);
                $usage['cost_usd'] += isset($u['cost_in_usd_ticks']) ? $u['cost_in_usd_ticks'] / 1e10 : 0;

                $calls = [];
                $text = '';
                $citations = [];
                foreach ($resp['output'] ?? [] as $item) {
                    $type = $item['type'] ?? '';
                    if ($type === 'function_call') {
                        $calls[] = $item;
                    } elseif ($type === 'message') {
                        foreach ($item['content'] ?? [] as $c) {
                            if (($c['type'] ?? '') === 'output_text') {
                                $text .= $c['text'];
                                foreach ($c['annotations'] ?? [] as $an) {
                                    if (($an['type'] ?? '') === 'url_citation' && !empty($an['url'])) {
                                        $citations[$an['url']] = ['url' => $an['url'], 'title' => $an['title'] ?? $an['url']];
                                    }
                                }
                            }
                        }
                    } elseif (in_array($type, ['web_search_call', 'x_search_call', 'custom_tool_call'], true)) {
                        $label = str_contains((string) ($item['name'] ?? $type), 'x_') || str_starts_with($type, 'x_') ? 'X\'te arıyor' : 'Web\'de arıyor';
                        self::emit(['type' => 'tool', 'name' => $item['name'] ?? $type, 'label' => $label, 'server' => true]);
                    }
                }
                if (!$calls) {
                    self::emit(['type' => 'answer', 'text' => $text !== '' ? $text : 'Bir yanıt üretilemedi.',
                                'citations' => array_values($citations), 'usage' => $usage, 'model' => $model]);
                    return;
                }
                $input = [];
                foreach ($calls as $call) {
                    $name = (string) $call['name'];
                    $args = json_decode((string) ($call['arguments'] ?? '{}'), true) ?: [];
                    self::emit(['type' => 'tool', 'name' => $name, 'args' => $args]);
                    $t0 = microtime(true);
                    try {
                        $out = AgentTools::call($name, $args);
                        $ok = !isset($out['error']);
                    } catch (\Throwable $e) {
                        $out = ['error' => $e->getMessage()];
                        $ok = false;
                    }
                    $usage['tool_calls']++;
                    if ($name === 'chart_actions' && $ok) {
                        self::emit(['type' => 'chart', 'symbol' => $args['symbol'] ?? null, 'actions' => $args['actions'] ?? []]);
                    }
                    self::emit(['type' => 'tool_done', 'name' => $name, 'ok' => $ok, 'ms' => (int) ((microtime(true) - $t0) * 1000)]);
                    $input[] = ['type' => 'function_call_output', 'call_id' => $call['call_id'],
                                'output' => json_encode($out, JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION)];
                }
            }
            self::emit(['type' => 'error', 'text' => 'Çok fazla adım gerekti; soruyu daraltmayı dene.']);
        } catch (\Throwable $e) {
            error_log('[finsent] agent: ' . $e);
            self::emit(['type' => 'error', 'text' => 'Ajan hatası: ' . mb_substr($e->getMessage(), 0, 200)]);
        }
    }
}
