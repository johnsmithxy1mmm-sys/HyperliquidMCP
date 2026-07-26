# Фаза 0 — Модель системы

HEAD на момент аудита: `792dba0` (v1.4.0). Ветка: `audit/2026-07-26`.
7 900 строк TS в `src`, 54 offline-теста, `strict: true`.

## Точки входа

| Вход | Тир инструментов | Идентичность | Метрика |
|---|---|---|---|
| `server-http.ts` → `POST /mcp` | free + **premium** | API-ключ / x402 / аноним | публичный интернет |
| `server-stdio.ts` | free + **trading** | всегда `local` | локальный процесс |
| `apify-actor/main.js` | прокси к HTTP | PRO-ключ оператора | Apify |

Торговые инструменты не регистрируются в HTTP ни при каких настройках — проверено в
`tools/index.ts` + `buildServer(tiers)`.

Фоновые задачи (обе точки входа): `AlertEngine` (60 с), `CohortRefresher` (1 ч),
`ScoreSampler` (24 ч). Все таймеры `unref`'нуты.

## Границы доверия

```
НЕДОВЕРЕННОЕ                                       ГДЕ ПАРСИТСЯ
─────────────────────────────────────────────────────────────────────
Polymarket Gamma API  ← создать рынок может ЛЮБОЙ  polymarket/parse.ts ⚠
  question (текст), outcomePrices, endDate         polymarket/client.ts
Hyperliquid Info API  (полу-доверенный вендор)     hl/*.ts, core/hlClient
HL leaderboard        НЕДОКУМЕНТИРОВАННЫЙ, opt-in  hl/cohortRank.ts
Аргументы инструментов (Zod-валидация)             tools/**
HTTP-заголовки: X-API-Key, X-PAYMENT, XFF          billing/*, server-http
x402 facilitator      (внешний, деньги)            billing/x402.ts
env-переменные                                     config.ts
```

Ключевая особенность продукта: **всё, что возвращает инструмент, попадает в контекст
LLM-агента как доверенный факт.** Текст из Polymarket проходит в `summary` дословно.

## Состояние

Один файл SQLite (`getDb`, синглтон, WAL) — 8 таблиц: `api_keys`, `usage_counters`,
`x402_payments`, `free_key_grants`, `snapshots`, `alerts`, `fired_events`, `signals`,
`score_snapshots`, `whale_cohort`.

В памяти: `TtlLruCache` (500 записей, TTL 2 с–5 мин, **отдаёт массивы по ссылке**),
`RateLimiter` (token bucket, **очередь не ограничена**), `MidsFeed` (WS + REST-фолбэк),
`ExecutionRunner` (планы только в памяти, теряются при рестарте).

## Побочные эффекты и необратимость

| Действие | Необратимо | Где |
|---|---|---|
| Отправка ордера на биржу | **да, деньги** | `trading/exchange.ts` (только stdio) |
| x402 settle | **да, деньги** | `billing/x402.ts` |
| Выдача free-ключа (отзывает предыдущий) | да | `billing/db.ts:recordFreeKeyGrant` |
| Ack событий алертов | да (событие исчезает) | `alertStore.pollUnacked` |
| Скоринг сигнала | да (переписывает трек-рекорд) | `alerts/engine.ts` |

## Конкурентность

`better-sqlite3` синхронный, Node однопоточный → внутрипроцессных гонок на БД нет.
Но: stdio и http **могут делить один файл БД** (`HYPERSIGNAL_DB_PATH`) — тогда
read-then-write в `ScoreStore.record` и `issueFreeKey` становятся межпроцессными TOCTOU.
`AlertEngine.tick` и `ScoreSampler.runOnce` защищены флагом `running`.

## Хотспоты истории (74 коммита за 12 мес, 11 со словами fix/hotfix)

`server-core.ts` (14) · `tools/index.ts` (7) · `server-http.ts` (7) ·
`billing/service.ts` (5) · `trading/exchange.ts` (4) · `alerts/engine.ts` (4) ·
`billing/db.ts` (4) · `smartMoney.ts` (4)

Хотспоты совпадают с денежными и авторизационными границами — там и искал в первую очередь.

## Инструментарий

Недоступны в среде: semgrep, gitleaks, osv-scanner, Stryker, fast-check.
Все соответствующие техники выполнены **ручной эмуляцией** (явно помечено в отчёте):
property-тесты и мутационный анализ написаны вручную как скрипты-репродьюсеры.

`noUncheckedIndexedAccess` **выключен** в tsconfig → под ним 47 ошибок непроверенного
индексного доступа (большинство защищены проверками длины, разбор в реестре).
