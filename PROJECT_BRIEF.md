# HyperSignal MCP — Project Brief

> Монетизированный MCP-сервер аналитики и сигналов Hyperliquid.
> Этот файл — очищенная версия мастер-промпта (исходник: `masterprompthyperliquidmcp.pdf`).
> Реализация — в этом репозитории (файлы в корне).

## Роль и контекст

Senior TypeScript/Node инженер, специализирующийся на MCP-серверах (Model Context
Protocol) и крипто-трейдинговой инфраструктуре. Задача — построить production-grade
монетизированный MCP-сервер для Hyperliquid: от пустого репозитория до деплоя и
листинга в директориях. Заказчик — соло-разработчик с опытом бот-инфраструктуры
(Polymarket CLOB, маркет-мейкинг) и quant-аналитики. Работа автономная, с остановкой
в конце каждой фазы для ревью.

## Цель продукта

MCP-сервер, дающий AI-агентам (Claude, Cursor, ChatGPT, автономные trading-агенты)
доступ к аналитике Hyperliquid, недоступной в бесплатных open-source MCP.

- **Free tier** (крючок для листинга в директориях): базовые рыночные данные.
- **Premium tier** (монетизация per-call / подписка): whale-cohort сигналы,
  liquidation-аналитика, HIP-3 аналитика, funding-скринеры, готовые risk-метрики.
- **Двойная монетизация**: опциональные торговые инструменты исполняют ордера с
  прикреплённым builder code заказчика (доход с оборота поверх платы за вызовы).

## Стек и архитектурные решения (не обсуждаются)

- **Язык**: TypeScript (официальный `@modelcontextprotocol/sdk`).
- **Транспорт**: два entrypoint из одного ядра:
  1. `stdio` — локальный запуск (Claude Desktop / Claude Code), free tier (+ trading локально);
  2. Streamable HTTP, stateless JSON (без stateful-сессий и стриминга) — удалённый монетизированный сервер.
- **Валидация**: Zod-схемы на вход и `outputSchema` + `structuredContent` на выход каждого инструмента.
- **Данные Hyperliquid**: публичный Info API (`https://api.hyperliquid.xyz/info`, POST JSON)
  + WebSocket (`wss://api.hyperliquid.xyz/ws`) для real-time; Exchange API — только для
  торговых инструментов (подпись через агент-кошелёк, приватный ключ ТОЛЬКО из env,
  никогда в коде/логах).
- **Кэш**: in-memory LRU + TTL (рынки 5с, метаданные 5мин, whale-когорты 60с). Уважать
  rate limits Hyperliquid (агрегированный вес запросов), экспоненциальный backoff.
- **Хостинг**: Docker-образ; деплой на дешёвый VPS/Fly.io/Railway. Никаких managed-зависимостей, которые нельзя заменить.
- **Деньги**: интеграция x402 (HTTP 402 Payment Required, USDC на Base) для per-call оплаты
  премиум-инструментов + альтернативный путь — обёртка под Apify Actor (pay-per-event).
  API-ключи как fallback (таблица ключей в SQLite, лимиты по тиру).
- **Хранилище**: SQLite (better-sqlite3) — ключи, счётчики вызовов, кэш тяжёлых агрегаций. Без Postgres на MVP.

## Спецификация инструментов

Именование: префикс `hl_`, action-oriented, краткие описания для агента (что возвращает,
когда использовать). Пагинация и фильтры везде, где ответ может быть большим. Аннотации
на каждом инструменте: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`.

### Free tier (паритет с open-source, крючок)

| Инструмент | Описание |
|---|---|
| `hl_get_markets` | Список перп-рынков: mark/oracle price, funding, OI, объём 24ч; фильтр по имени |
| `hl_get_orderbook` | L2-стакан по монете, глубина N уровней |
| `hl_get_candles` | OHLCV свечи (интервал, диапазон) |
| `hl_get_funding_history` | История funding по монете |
| `hl_get_account` | Позиции/баланс/маржа произвольного адреса |
| `hl_get_open_orders` | Открытые ордера адреса |

### Premium tier (дифференциатор, за деньги)

| Инструмент | Описание |
|---|---|
| `hl_whale_positions` | Агрегированные позиции топ-N кошельков по монете: суммарный long/short, средняя цена входа, изменение за 1ч/24ч |
| `hl_whale_flow_alerts` | Свежие крупные изменения позиций китов (порог $, окно времени) |
| `hl_liquidation_map` | Оценка кластеров ликвидаций по монете: распределение liq-цен когорты, ближайшие уровни каскадов |
| `hl_funding_screener` | Скрининг всех рынков по аннуализированному funding: топ по абсолюту, спреды для carry/дельта-нейтральных стратегий |
| `hl_hip3_analytics` | Метрики HIP-3 рынков (RWA/акции-перпы): объёмы, OI, funding, спреды, базис к внешнему спот-прайсу |
| `hl_portfolio_risk` | Risk-отчёт по адресу: liquidation distance, эффективное плечо, концентрация, стресс-сценарии (-5/-10/-20%), Sharpe по PnL |
| `hl_vault_screener` | Скрининг user-вольтов: APR, max drawdown, Sharpe/Sortino, возраст, TVL, доля лидера |
| `hl_trader_report` | Разбор кошелька: winrate, средний R, PnL-кривая, стиль (скальп/свинг), торгуемые монеты |

### Trading tier (опционально, builder code, максимальные предупреждения)

| Инструмент | Описание |
|---|---|
| `hl_place_order` | Лимит/маркет ордер через агент-кошелёк пользователя, с прикреплением builder code заказчика (`f` из env, по умолчанию 5 = 0.5 б.п.) |
| `hl_cancel_order` | Отмена ордера |
| `hl_close_position` | Закрытие позиции (reduce-only) |
| `hl_approve_builder_fee_guide` | Read-only: генерирует пользователю инструкцию/payload для `approveBuilderFee` главным кошельком |

**Требования к trading tier**: `destructiveHint: true`, обязательный параметр `confirm: true`,
dry-run по умолчанию, явный disclaimer в описании. Приватный ключ агент-кошелька — только
env-переменная клиента. В remote-режиме торговые инструменты НЕ выставляются (только stdio локально).

## Монетизация (Фаза 3)

1. **Слой биллинга** — middleware перед premium-инструментами в HTTP-режиме: проверка
   API-ключа → тир → счётчик вызовов в SQLite → лимиты (free: 100 premium-вызовов/мес demo;
   pro: $19/мес безлимит аналитики; pay-per-call через x402: $0.005–0.02/вызов в USDC на Base).
   x402: при отсутствии ключа/кредита — стандартный 402-flow с payment requirements; после
   верификации платежа — исполнять.
2. **Apify-обёртка** — отдельная тонкая обёртка `apify-actor/`, экспортирующая 3–4 самых
   продаваемых premium-инструмента (`whale_flow_alerts`, `funding_screener`, `portfolio_risk`)
   как Actor с pay-per-event. Ядро одно, обёртки разные.
3. **Builder code** — константа адреса + `f` в конфиге; прикрепляется ко всем ордерам trading tier.
   Плюс промо-блок в README.

## Структура репозитория

```
hypersignal-mcp/
├── src/
│   ├── core/            # клиент Hyperliquid API, ws, кэш, rate limiter
│   ├── tools/           # по файлу на инструмент: schema (Zod) + handler
│   ├── billing/         # ключи, счётчики, x402, тиры
│   ├── server-stdio.ts  # локальный entrypoint (free + trading)
│   └── server-http.ts   # remote entrypoint (free + premium, stateless)
├── apify-actor/         # тонкая обёртка Actor
├── evals/               # eval-вопросы
├── Dockerfile
├── docker-compose.yml
├── README.md            # с примерами конфигов для Claude Desktop/Cursor
└── .env.example         # ВСЕ секреты только тут, с комментариями
```

## Фазы работы

- **Фаза 0** — исследование. Стоп, ревью.
- **Фаза 1** — каркас: проект, tsconfig, ядро (API-клиент + кэш + rate limiter), оба entrypoint, 2 free-инструмента, сборка, тест через inspector. Стоп, ревью.
- **Фаза 2** — все free + все premium инструменты (Zod input, outputSchema, structuredContent, аннотации, actionable-ошибки, пагинация). Стоп, ревью.
- **Фаза 3** — биллинг (ключи + x402 + тиры), apify-обёртка, trading tier (только stdio). Стоп, ревью.
- **Фаза 4** — качество: DRY-ревью, типы без `any`, README, Dockerfile, 10 eval-вопросов в `evals/eval.xml`. Стоп, финальное ревью.
- **Фаза 5** — go-to-market чек-лист: деплой; регистрация в MCP-директориях (MCP Registry, Smithery, PulseMCP, Glama, mcp.so, Cursor Directory); Apify Store; пост-шаблоны для X/Telegram (RU+EN).

## Жёсткие правила

1. Никаких секретов в коде, логах, README. Только `.env`.
2. Никогда не выставляй торговые инструменты в remote HTTP-режиме.
3. Каждый ответ инструмента ≤ разумного размера: обрезай, пагинируй, агрегируй.
4. Все внешние вызовы — с таймаутом, ретраями (3, экспоненциально), graceful degradation (ws упал → REST-фоллбэк).
5. Финансовые дисклеймеры в описаниях premium/trading инструментов: «аналитика, не инвестиционный совет».
6. Не выдумывай endpoint'ы Hyperliquid — только проверенные из официальной документации.
7. После каждой фазы: краткий отчёт (что сделано, что отложено, риски) и СТОП.
