# HyperSignal MCP — руководство по запуску, трафику и монетизации

Пошагово: от локальной проверки до задеплоенного монетизированного сервера,
привлечения трафика и приёма денег.

---

# ЧАСТЬ 1. Локальная проверка (10 минут, обязательно перед деплоем)

```bash
cd HyperliquidMCP        # или hypersignal-mcp
npm install
npm run build
npm test                 # все тесты должны пройти (40/40)
```

Проверка через официальный MCP Inspector (открывает UI в браузере):
```bash
npm run inspect
```
В Inspector: Connect → вкладка Tools → List Tools → вызовите `hl_get_markets`
с `{"filter":"BTC","limit":5}`. Если вернулись рынки — ядро и сеть работают.

> Если сеть Hyperliquid закрыта фаерволом/прокси — на Node 22+ добавьте
> `NODE_USE_ENV_PROXY=1`.

---

# ЧАСТЬ 2. Деплой удалённого сервера (free + premium)

Удалённый HTTP-сервер отдаёт **free + premium** и НИКОГДА не отдаёт trading.
Ниже — два пути хостинга. Рекомендую Fly.io (дёшево, есть тома под SQLite).

## 2A. Fly.io (рекомендуется)

### Шаг 1. Установить flyctl и войти
```bash
# macOS/Linux
curl -L https://fly.io/install.sh | sh
# Windows PowerShell
pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"

fly auth signup      # или: fly auth login
```

### Шаг 2. Сгенерировать API-ключи для клиентов
Ключи — это то, что вы продаёте. Сгенерируйте несколько:
```bash
# Linux/macOS
openssl rand -hex 24
# Windows PowerShell
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```
Сохраните: одни пойдут в `HYPERSIGNAL_PRO_KEYS` (безлимит), другие — в
`HYPERSIGNAL_FREE_KEYS` (100 премиум-вызовов/мес).

### Шаг 3. Создать `fly.toml` в корне репозитория
```toml
app = "hypersignal-mcp"          # придумайте уникальное имя
primary_region = "iad"           # ближайший регион: iad, fra, sin, ...

[build]
  dockerfile = "Dockerfile"

[env]
  PORT = "8080"
  HL_NETWORK = "mainnet"
  HYPERSIGNAL_DB_PATH = "/app/data/hypersignal.db"
  HL_WS_ENABLED = "true"
  TRUST_PROXY = "true"            # Fly передаёт клиентский IP в X-Forwarded-For
  HTTP_RATE_LIMIT_PER_MIN = "120" # per-IP лимит на /mcp

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "off"      # НЕ усыплять: иначе теряются whale-снапшоты
  auto_start_machines = true
  min_machines_running = 1        # держим 1 инстанс всегда

  [[http_service.checks]]
    interval = "30s"
    timeout = "5s"
    grace_period = "10s"
    method = "GET"
    path = "/healthz"

[[mounts]]
  source = "hypersignal_data"
  destination = "/app/data"       # SQLite (ключи, счётчики) переживает рестарты

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
```

### Шаг 4. Создать приложение и том
```bash
fly apps create hypersignal-mcp                          # то же имя, что в fly.toml
fly volumes create hypersignal_data --size 1 --region iad
```

### Шаг 5. Прописать секреты (НЕ в fly.toml, а в secrets)
```bash
fly secrets set \
  HYPERSIGNAL_PRO_KEYS="проkey1,проkey2" \
  HYPERSIGNAL_FREE_KEYS="демоkey1" \
  HL_WHALE_ADDRESSES="0xКит1,0xКит2,0xКит3" \
  HL_BUILDER_ADDRESS="0xВашBuilderАдрес"
```
> `HL_WHALE_ADDRESSES` **важно**: без когорты whale-инструменты потребуют,
> чтобы клиент передавал `cohort` сам. Заполните 20–100 адресов топ-трейдеров
> (можно собрать с публичного leaderboard Hyperliquid).

### Шаг 6. Деплой и проверка
```bash
fly deploy
fly status
curl https://hypersignal-mcp.fly.dev/healthz
# {"ok":true,...}
```
Проверка списка инструментов и премиум-гейта:
```bash
curl -s -X POST https://hypersignal-mcp.fly.dev/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# премиум без ключа → payment_required:
curl -s -X POST https://hypersignal-mcp.fly.dev/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"hl_funding_screener","arguments":{}}}'

# премиум С ключом → данные:
curl -s -X POST https://hypersignal-mcp.fly.dev/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H 'X-API-Key: проkey1' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"hl_funding_screener","arguments":{}}}'
```

## 2B. Свой VPS (альтернатива, ~$5/мес)

На любом VPS с Docker:
```bash
git clone <ваш HyperliquidMCP> && cd HyperliquidMCP
cp .env.example .env         # заполните ключи/builder/whale
docker compose up -d
```
Публичный HTTPS — через Caddy (авто-TLS). `Caddyfile`:
```
mcp.вашдомен.com {
    reverse_proxy 127.0.0.1:8080
}
```
```bash
caddy run    # или systemd-сервис
```

## Прогнать evals (после деплоя)
Откройте `evals/eval.xml` и вручную задайте 10 вопросов агенту, подключённому к
серверу. Все ответы должны сходиться — это ваш приёмочный тест.

---

# ЧАСТЬ 3. Монетизация

Три способа, можно комбинировать. Начните с №1.

## Способ 1 — Подписка по API-ключам (проще всего, старт за день)

Модель: `anonymous` (только free) → `free`-ключ (100 премиум/мес) →
`pro`-ключ ($19/мес, безлимит). Сервер сам считает вызовы в SQLite.

**Как продавать Pro:**
1. Создайте Stripe Payment Link ($19/мес подписка): dashboard.stripe.com →
   Payment Links → recurring.
2. После оплаты (вручную или через Stripe webhook) выдайте клиенту ключ:
   - сгенерируйте `openssl rand -hex 24`;
   - добавьте его в `HYPERSIGNAL_PRO_KEYS` и передеплойте секреты:
     ```bash
     fly secrets set HYPERSIGNAL_PRO_KEYS="старые...,новыйКлюч"
     ```
   - отправьте клиенту ключ + инструкцию по подключению (Часть 4).
3. Отмена подписки → уберите ключ из secrets.

> Для автоматизации: небольшой webhook-эндпоинт на Stripe `checkout.session.completed`,
> который дергает `fly secrets set` или пишет ключ в БД. На старте — вручную ок.

## Способ 2 — x402 pay-per-call (крипто, автоматический)

Оплата по $0.005–0.02 USDC на Base за каждый премиум-вызов. Без ключей, без
Stripe — агент платит на лету.

1. Заведите кошелёк на Base для приёма USDC (`X402_PAY_TO`).
2. Подключите facilitator (проверяет и сеттлит платёж on-chain) — по актуальной
   спеке x402 (facilitator от Coinbase / x402.org). Без facilitator оплата
   **fail-closed** (не пропускается).
3. Секреты:
   ```bash
   fly secrets set \
     X402_ENABLED=true \
     X402_PAY_TO=0xВашBaseКошелёк \
     X402_FACILITATOR_URL=https://<facilitator> \
     X402_PRICE_PER_CALL_USDC=0.01
   ```
4. Теперь запрос без ключа возвращает x402 payment requirements; после оплаты
   (заголовок `X-PAYMENT`) вызов исполняется. Реплеи блокируются по payment id.

> Рекомендация: запускайтесь сначала на ключах (способ 1), x402 включайте вторым
> этапом после теста с реальным facilitator.

## Способ 3 — Apify Store (pay-per-event, готовый маркетплейс)

Отдельная витрина с трафиком Apify. Каталог `apify-actor/` уже готов.
```bash
npm i -g apify-cli
apify login
cd apify-actor
apify push
```
В настройках Actor на консоли Apify включите монетизацию → цена события
`premium-call`. Apify сам биллит пользователей и платит вам.

## Способ 4 — Builder code (доход с торгового оборота)

Пассивный доход поверх всего: каждый ордер trading-яруса несёт ваш builder code.
1. `HL_BUILDER_ADDRESS=0x...`, `HL_BUILDER_FEE_TENTHS_BPS=5` (0.5 б.п.).
2. Клиент один раз одобряет ваш builder code главным кошельком
   (`hl_approve_builder_fee_guide` выдаёт точный payload).
3. С каждого их ордера через сервер вы получаете 0.5 б.п. с оборота.
> Trading работает только локально (stdio) у клиента — продвигайте как
> «поставь наш конфиг» с реф-выгодой.

---

# ЧАСТЬ 4. Как подключаются клиенты (это раздаёте пользователям)

## Claude Desktop / Claude Code (удалённый сервер через мост mcp-remote)
`claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "hypersignal": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://hypersignal-mcp.fly.dev/mcp",
        "--header", "X-API-Key: КЛЮЧ_КЛИЕНТА"
      ]
    }
  }
}
```

## Cursor (`.cursor/mcp.json`) — нативный remote MCP
```json
{
  "mcpServers": {
    "hypersignal": {
      "url": "https://hypersignal-mcp.fly.dev/mcp",
      "headers": { "X-API-Key": "КЛЮЧ_КЛИЕНТА" }
    }
  }
}
```

## Локальная установка (free + trading, stdio)
```json
{
  "mcpServers": {
    "hypersignal": {
      "command": "node",
      "args": ["/путь/HyperliquidMCP/dist/server-stdio.js"],
      "env": { "HL_BUILDER_ADDRESS": "0x...", "HL_ENABLE_TRADING": "false" }
    }
  }
}
```

---

# ЧАСТЬ 5. Как направлять трафик

Стратегия: free-ярус — «крючок» для листингов, премиум — апселл. Killer-фичи
для маркетинга: **whale-alerts** и **portfolio-risk**.

## 5.1. Листинги в MCP-директориях (главный источник)
Подайте сервер во все каталоги (у каждого своя форма/GitHub PR):
- **Официальный MCP Registry** — `github.com/modelcontextprotocol/registry` (PR/CLI).
- **Smithery** — `smithery.ai` (поддерживает remote + stdio, есть авто-скан репо).
- **PulseMCP** — `pulsemcp.com` (форма добавления).
- **Glama** — `glama.ai/mcp/servers` (авто-скан GitHub + health-бейдж).
- **mcp.so** — `mcp.so` (submit).
- **Cursor Directory** — `cursor.directory` (submit MCP).

Что нужно для листинга: публичный GitHub-репо с хорошим README, теги
(hyperliquid, trading, analytics, defi), пример конфига, скриншот/GIF вызова
`hl_whale_flow_alerts`.

## 5.2. Apify Store
`apify push` уже даёт витрину с органическим трафиком Apify. Заполните описание,
теги, примеры input — это отдельный канал продаж (pay-per-event).

## 5.3. Контент (RU+EN) — шаблоны в `docs/GTM.md`
- **X/Twitter**: тред «дал AI-агенту whale-сигналы Hyperliquid» + GIF вызова.
- **Telegram**: посты в крипто/трейдинг-каналы, фокус на whale-alerts + risk.
- Публикуйте примеры реальных сигналов (скриншоты выводов инструментов).

## 5.4. Сообщества
- Hyperliquid Discord / форумы (раздел tools/bots).
- r/mcp, r/Hyperliquid, MCP-Discord'ы.
- Показывайте пользу: «вот как агент нашёл кластер ликвидаций перед каскадом».

## 5.5. Воронка конверсии (уже встроена)
free-инструменты бесплатны → агент упирается в премиум → сервер возвращает
`payment_required` с прайсингом и upgrade-подсказкой → клиент берёт ключ/платит
x402. Ничего дополнительно кодить не надо — сообщение об оплате самодостаточно.

---

# ЧАСТЬ 6. Эксплуатация и что сделать до trading

- **Бэкапы**: периодически копируйте `/app/data/hypersignal.db` (ключи+счётчики).
  `fly ssh console -C "cat /app/data/hypersignal.db" > backup.db` (или volume snapshot).
- **Логи**: `fly logs`. Секреты в логи не попадают (redaction встроен).
- **Мониторинг**: пингуйте `/healthz` (UptimeRobot и т.п.).
- **Масштаб**: `fly scale count 2` — но тогда SQLite/снапшоты не общие; для >1
  инстанса вынесите счётчики в общий Postgres (пункт бэклога).
- **Перед включением trading**: обязательно `HL_NETWORK=testnet` + 2–3 тестовых
  ордера на testnet, проверьте, что `assertExchangeOk` корректно ловит отказы,
  и только потом mainnet.

---

# Быстрый чек-лист запуска

1. [ ] `npm install && npm run build && npm test` (40/40)
2. [ ] `fly launch` + том + секреты (ключи, whale, builder)
3. [ ] `fly deploy`, проверить `/healthz` и премиум-гейт
4. [ ] Прогнать `evals/eval.xml`
5. [ ] Раздать конфиги клиентам (mcp-remote / Cursor)
6. [ ] Подать в 6 MCP-директорий + Apify Store
7. [ ] Настроить приём денег: Stripe (ключи) и/или x402
8. [ ] Пост в X/Telegram с whale-alert демо
9. [ ] (позже) testnet → trading + x402 с facilitator
