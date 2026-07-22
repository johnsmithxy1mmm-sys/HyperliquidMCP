# Фаза 5 — Go-to-market чек-лист

## 1. Деплой

- [ ] Собрать образ: `docker build -t hypersignal-mcp .`
- [ ] Заполнить `.env` (см. `.env.example`): ключи, builder-адрес, x402 (если включаем).
- [ ] Поднять remote HTTP: `docker compose up -d` (порт 8080, эндпоинт `/mcp`, `/healthz`).
- [ ] Вариант хостинга: **Fly.io** (`fly launch` + `fly deploy`, том для `/app/data`), **Railway**,
      или дешёвый VPS + Caddy/Nginx для TLS на публичном домене.
- [ ] Проверить, что `HL_ENABLE_TRADING=false` в remote (торговые инструменты никогда не в HTTP).
- [ ] Настроить бэкап SQLite (`/app/data/hypersignal.db`) — там ключи и счётчики.
- [ ] Прогнать `evals/eval.xml` вручную против задеплоенного сервера.

## 2. Регистрация в MCP-директориях

- [ ] **Официальный MCP Registry** — публикация `server.json`/манифеста, ссылка на репозиторий.
- [ ] **Smithery** — добавить сервер (stdio для локальной установки + remote URL).
- [ ] **PulseMCP** — карточка сервера, теги: hyperliquid, trading, analytics.
- [ ] **Glama** — листинг + health-бейдж.
- [ ] **mcp.so** — публикация.
- [ ] **Cursor Directory** — конфиг для `.cursor/mcp.json`.
- [ ] Free tier — «крючок»: во всех листингах подчёркиваем бесплатные рыночные инструменты,
      апселл на premium (whale/risk).

## 3. Apify Store

- [ ] `apify push` из `apify-actor/` (build context = корень пакета).
- [ ] Выставить цену события `premium-call` (pay-per-event).
- [ ] Описание, теги (hyperliquid, defi, signals), примеры input.

## 4. Killer-фичи для маркетинга

Фокус: **whale-alerts** и **portfolio-risk** — то, чего нет в бесплатных open-source MCP.

## 5. Пост-шаблоны

### X / Twitter (EN)
> 🐋 New: HyperSignal MCP for Hyperliquid.
> Give your AI agent whale-flow alerts, liquidation maps & ready-made portfolio-risk reports —
> data the free MCPs don't have. Free market-data tier, premium signals pay-per-call (x402/USDC).
> Plug into Claude/Cursor in 60s. 🧵

### X / Twitter (RU)
> 🐋 HyperSignal MCP для Hyperliquid.
> Твой AI-агент получает whale-сигналы, карту ликвидаций и готовый risk-отчёт по кошельку —
> то, чего нет в бесплатных MCP. Базовые данные бесплатно, премиум — pay-per-call (x402/USDC).
> Подключается к Claude/Cursor за минуту.

### Telegram (EN)
> **HyperSignal MCP** — Hyperliquid analytics for AI agents.
> • Free: markets, order book, candles, funding, account, orders
> • Premium: whale positions/flow, liquidation map, funding screener, HIP-3, portfolio risk, vault & trader reports
> • Optional local trading with builder code
> Install: `npx hypersignal-mcp` (stdio) or point your client at the hosted `/mcp` URL.

### Telegram (RU)
> **HyperSignal MCP** — аналитика Hyperliquid для AI-агентов.
> • Бесплатно: рынки, стакан, свечи, funding, аккаунт, ордера
> • Премиум: позиции/поток китов, карта ликвидаций, funding-скринер, HIP-3, risk-отчёт, вольты и трейдеры
> • Опционально — локальная торговля с builder code
> Установка: `npx hypersignal-mcp` (stdio) или hosted `/mcp` URL в вашем клиенте.

## 6. Реф / builder

- [ ] Промо-блок в README: «подключи наш терминальный конфиг» + builder-адрес/реф.
- [ ] Пример конфига клиента с включённым builder code.
