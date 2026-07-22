# Фаза 0 — Отчёт по исследованию

## 1. MCP: используемый API

- Пакет: **`@modelcontextprotocol/sdk`** (официальный TypeScript SDK).
- Сервер: `McpServer` из `@modelcontextprotocol/sdk/server/mcp.js`.
- Регистрация инструмента: `server.registerTool(name, { title, description, inputSchema, outputSchema, annotations }, handler)`.
  - `inputSchema` / `outputSchema` принимают **ZodRawShape** (объект Zod-полей), SDK сам оборачивает в `z.object`.
  - handler возвращает `{ content: [{type:"text", text}], structuredContent }` (или `{ isError: true }` при ошибке).
- Транспорты:
  - stdio: `StdioServerTransport` из `.../server/stdio.js`.
  - Streamable HTTP (stateless JSON): `StreamableHTTPServerTransport` из `.../server/streamableHttp.js`
    с `sessionIdGenerator: undefined` (без сессий) и `enableJsonResponse: true` (одиночный JSON-ответ, без SSE).
    На каждый POST создаём новый `server + transport` (stateless-паттерн из README SDK).

## 2. Hyperliquid Info API (проверенные endpoint'ы)

Все — `POST https://api.hyperliquid.xyz/info`, тело JSON, поле `type`.
(Testnet: `https://api.hyperliquid-testnet.xyz`. Источник тел запросов — официальный
`hyperliquid-python-sdk/hyperliquid/info.py`.)

| Назначение | Тело запроса |
|---|---|
| Перп-мета | `{"type":"meta"}` |
| Мета + контексты активов (funding, OI, объём, mark/oracle) | `{"type":"metaAndAssetCtxs"}` |
| Спот-мета | `{"type":"spotMeta"}` / `{"type":"spotMetaAndAssetCtxs"}` |
| L2-стакан | `{"type":"l2Book","coin":"<coin>"}` |
| Свечи | `{"type":"candleSnapshot","req":{"coin","interval","startTime","endTime"}}` |
| История funding по монете | `{"type":"fundingHistory","coin","startTime","endTime"}` |
| Прогноз funding (кросс-венью) | `{"type":"predictedFundings"}` |
| Состояние перп-аккаунта (позиции/маржа) | `{"type":"clearinghouseState","user":"<addr>"}` |
| Состояние спот-аккаунта | `{"type":"spotClearinghouseState","user":"<addr>"}` |
| Открытые ордера | `{"type":"openOrders","user":"<addr>"}` / `frontendOpenOrders` |
| Сделки пользователя | `{"type":"userFills","user":"<addr>"}` / `userFillsByTime` |
| Начисления funding пользователя | `{"type":"userFunding","user","startTime","endTime"}` |

Контексты активов (`metaAndAssetCtxs[1][i]`) содержат: `funding`, `openInterest`,
`dayNtlVlm`, `markPx`, `oraclePx`, `premium`, `midPx`, `prevDayPx`, `impactPxs`.

**Дополнительно** (задокументированы в официальном API, но отсутствуют в python-SDK на момент
Фазы 0 — поэтому используются за `try/catch` с graceful degradation):
`{"type":"predictedFundings"}` (кросс-венью прогноз funding) и
`{"type":"vaultDetails","vaultAddress":"0x…"}` (метрики вольта). Также подтверждены в SDK:
`{"type":"portfolio","user":"0x…"}` и `{"type":"userVaultEquities","user":"0x…"}`.

## 3. Hyperliquid Exchange API (только trading tier, подпись)

`POST https://api.hyperliquid.xyz/exchange`, действие подписывается агент-кошельком.

- **Ордер**: action `order`, к ордеру прикрепляется builder-объект `{"b": "<builder addr>", "f": <int>}`,
  где `f` — комиссия билдера в **десятых долях базисного пункта** (`f=10` → 1 б.п., `f=5` → 0.5 б.п.).
  Максимум для перпов — 10 б.п. Wire-формат ордера: `a` (asset index), `b` (isBuy), `p` (limitPx),
  `s` (sz), `r` (reduceOnly), `t` (order type: `{"limit":{"tif":"Gtc|Ioc|Alo"}}` или trigger).
- **approveBuilderFee**: `{"type":"approveBuilderFee","builder":"<addr>","maxFeeRate":"0.005%","nonce":<ms>}`
  (`maxFeeRate` — строка-процент; `f` десятых-б.п. → процент = `f * 0.001`).
- **cancel**: `{"type":"cancel","cancels":[{"a":<asset>,"o":<oid>}]}`.

## 4. Карта конкурентов (open-source Hyperliquid MCP)

Существующие open-source серверы (`hyperliquid mcp server` на GitHub) обычно покрывают:
рынки, стакан, свечи, funding-историю, состояние аккаунта, открытые ордера — **это наш free
tier** (паритет, крючок для листинга). Чего у них, как правило, **нет** и что мы монетизируем:
whale-cohort агрегации, liquidation-кластеры, готовые risk-отчёты, funding-скринеры,
HIP-3 аналитика, vault-скрининг, trader-report. Это premium-дифференциатор.

## 5. Открытые вопросы / честные ограничения

- **Официального leaderboard-endpoint в Info API нет.** Поэтому whale-инструменты работают
  по **явной когорте адресов** (параметр `cohort` или env `HL_WHALE_ADDRESSES`) — это канонический,
  воспроизводимый путь без выдуманных endpoint'ов. Публичный frontend-leaderboard подключается
  опционально (best-effort) и при недоступности возвращает actionable-ошибку.
- **liquidation-map / portfolio-risk** используют модель поддерживающей маржи Hyperliquid
  (макс. плечо → maintenance margin). Оценки помечаются как аналитические, не точные значения биржи.
- **x402**: реализован каркас по спецификации (payment requirements + verify через facilitator);
  фактический on-chain settlement включается конфигом facilitator'а (fail-closed без него).

## Итог: финальный список инструментов

6 free + 8 premium + 4 trading = **18 инструментов**. Список — в `README.md` и `src/tools/`.
