# RUNBOOK — пошаговый алгоритм запуска HyperSignal MCP от и до

Маршрут построен под Windows/PowerShell и НЕ требует локальной сборки:
Fly.io собирает Docker-образ на своих серверах (`--remote-only`), поэтому
проблемы Node 24 / Visual Studio на вашей машине не мешают запуску.

Обозначения: 💻 — команда в PowerShell; 🌐 — действие в браузере;
✅ — контрольная точка (не идите дальше, пока не сойдётся).

---

## ЭТАП 0. Что нужно иметь перед стартом (15 мин)

| # | Что | Зачем |
|---|---|---|
| 0.1 | Аккаунт GitHub (есть: `johnsmithxy1mmm-sys`) | код уже в `HyperliquidMCP` |
| 0.2 | Аккаунт Fly.io (бесплатная регистрация, попросит карту) | хостинг сервера, ~$3–5/мес |
| 0.3 | Git на компьютере (есть — вы уже пушили) | доставка кода |
| 0.4 | Node.js любой версии (есть 24 — для генерации ключей хватит) | одноразовые команды |

> Комментарий: карта в Fly.io нужна для верификации; на минимальной машине
> shared-cpu-1x/512MB счёт обычно $3–5/мес.

---

## ЭТАП 1. Довезти v1.0.0 в GitHub (5 мин)

**1.1** 💻 Распакуйте присланный `HyperliquidMCP-v1.0.0.zip` в новую папку и запушьте:
```powershell
Expand-Archive $HOME\Downloads\HyperliquidMCP-v1.0.0.zip -DestinationPath $HOME\HyperliquidMCP-v1
cd $HOME\HyperliquidMCP-v1
git remote set-url origin https://github.com/johnsmithxy1mmm-sys/HyperliquidMCP.git
git push -u origin main
```
> Комментарий: внутри архива уже полный `.git` с историей, включающей ваши
> прошлые пуши, поэтому push пройдёт fast-forward, без `--force`. Если git
> спросит логин — используйте Personal Access Token (как в прошлый раз).

**✅ Контроль:** на `github.com/johnsmithxy1mmm-sys/HyperliquidMCP` последний
коммит — «v1.0.0: final pre-launch polish…».

---

## ЭТАП 2. Сгенерировать все секреты (10 мин)

Выполняйте в PowerShell; каждый вывод СРАЗУ сохраняйте в менеджер паролей
или локальный файл вне репозитория.

**2.1** 💻 API-ключи клиентов (это ваш «товар»; сделайте 3 Pro и 2 Free про запас):
```powershell
node -e "for(let i=0;i<5;i++)console.log(require('crypto').randomBytes(24).toString('hex'))"
```
> Комментарий: первые 3 строки пометьте как PRO, последние 2 — FREE (демо,
> 100 премиум-вызовов/мес). Сервер хранит только SHA-256 хэши — потерянный
> ключ восстановить нельзя, только выпустить новый.

**2.2** 💻 Ключ подписи сигналов (СТАБИЛЬНАЯ криптоличность вашего track record):
```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```
> Комментарий: это `SIGNAL_SIGNING_KEY`. Без него сервер сгенерирует
> временный ключ и публичный ключ будет меняться при каждом рестарте — track
> record потеряет доказуемость. Сохраните надёжно, это часть бренда.

**2.3** 🌐 Когорта китов `HL_WHALE_ADDRESSES` (питание whale-инструментов):
1. Откройте `app.hyperliquid.xyz/leaderboard`;
2. Отсортируйте по PnL (30D) и по Account Value;
3. Кликайте по трейдерам, копируйте их 0x-адреса (из URL профиля);
4. Соберите 20–50 адресов через запятую БЕЗ пробелов:
   `0xабв...,0xгде...,0xжзи...`
> Комментарий: это главный вход премиум-аналитики. Больше адресов = богаче
> сигналы, но дороже по rate-limit'у: каждый скан когорты = 2 запроса на
> кошелёк. 30–50 — рабочий баланс. Список можно менять через `fly secrets set`
> без передеплоя кода.

**2.4** (опционально сейчас, нужно для builder-дохода) Builder-адрес:
ваш EVM-адрес, на который будут капать builder-комиссии. Подойдёт любой ваш
кошелёк, на Hyperliquid ему нужно право получать fee (адрес должен иметь
хотя бы $100 депозита на HL, по правилам builder codes).

**✅ Контроль:** у вас записаны: 5 API-ключей, 1 signing key, строка из
20+ адресов китов, (опц.) builder-адрес.

---

## ЭТАП 3. Установить flyctl и создать приложение (15 мин)

**3.1** 💻 Установка Fly CLI:
```powershell
pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"
```
Закройте и откройте PowerShell заново (обновится PATH), затем:
```powershell
fly version
fly auth signup      # или fly auth login, если аккаунт уже есть
```
> Комментарий: `fly auth signup` откроет браузер. Если `fly` «не распознано» —
> перезапустите терминал ещё раз или перезагрузитесь (как было с npm).

**3.2** 💻 Создайте `fly.toml` в корне репозитория. Файл с таким содержимым
уже описан в `docs/LAUNCH.md`; создайте его так:
```powershell
cd $HOME\HyperliquidMCP-v1
notepad fly.toml
```
Вставьте (имя приложения поменяйте на своё уникальное, например
`hypersignal-<ваш-ник>`):
```toml
app = "hypersignal-mcp-ns8x"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[env]
  PORT = "8080"
  HL_NETWORK = "mainnet"
  HYPERSIGNAL_DB_PATH = "/app/data/hypersignal.db"
  HL_WS_ENABLED = "true"
  TRUST_PROXY = "true"
  HTTP_RATE_LIMIT_PER_MIN = "120"
  ALERT_INTERVAL_SEC = "60"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 1

  [[http_service.checks]]
    interval = "30s"
    timeout = "5s"
    grace_period = "10s"
    method = "GET"
    path = "/healthz"

[[mounts]]
  source = "hypersignal_data"
  destination = "/app/data"

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
```
> Комментарии к критичным строкам:
> • `auto_stop_machines = "off"` — сервер ДОЛЖЕН работать непрерывно: движок
>   алертов тикает раз в минуту, whale-дельты копятся во времени; усыпление
>   машины сломает и то и другое.
> • `TRUST_PROXY = "true"` — Fly передаёт IP клиента через X-Forwarded-For;
>   без этого rate-limit будет считать всех клиентов одним IP.
> • `[[mounts]]` — SQLite (ключи, счётчики, алерты, сигналы, снапшоты)
>   живёт на томе и переживает рестарты/деплои.

Сохраните файл, закоммитьте:
```powershell
git add fly.toml
git commit -m "Add fly.toml"
git push
```

**3.3** 💻 Создайте приложение и том (регион тот же, что в fly.toml):
```powershell
fly apps create hypersignal-mcp-ns8x
fly volumes create hypersignal_data --size 1 --region iad --app hypersignal-mcp-ns8x
```
> Комментарий: том 1 GB — с запасом на годы SQLite-данных. `--app` указывайте
> везде, если имя в fly.toml отличается от дефолта.

**✅ Контроль:** `fly apps list` показывает ваше приложение; `fly volumes list
--app hypersignal-mcp-ns8x` показывает том.

---

## ЭТАП 4. Секреты и деплой (15 мин)

**4.1** 💻 Залейте секреты (подставьте СВОИ значения из Этапа 2):
```powershell
fly secrets set --app hypersignal-mcp-ns8x `
  HYPERSIGNAL_PRO_KEYS="proключ1,proключ2,proключ3" `
  HYPERSIGNAL_FREE_KEYS="freeключ1,freeключ2" `
  SIGNAL_SIGNING_KEY="ваш_base64_ключ_подписи" `
  HL_WHALE_ADDRESSES="0x...,0x...,0x..." `
  HL_BUILDER_ADDRESS="0xВашBuilderАдрес"
```
> Комментарии:
> • Бэктик ` в PowerShell — перенос строки (аналог \ в bash).
> • Секреты НИКОГДА не кладите в fly.toml или git — только `fly secrets`.
> • Убрали ключ из списка → при следующем деплое/рестарте он автоматически
>   ОТЗЫВАЕТСЯ (это встроено). Добавили обратно → снова работает.
> • `HL_BUILDER_ADDRESS` можно пропустить сейчас и добавить позже.

**4.2** 💻 Деплой (сборка на серверах Fly — ваша машина не собирает ничего):
```powershell
fly deploy --remote-only --app hypersignal-mcp-ns8x
```
> Комментарий: первый деплой идёт 3–6 минут (компилируется better-sqlite3 под
> Linux). Смотрите лог сборки прямо в терминале. Ошибка «failed fetching»?
> Просто повторите команду.

**4.3** 💻 Проверьте, что поднялось:
```powershell
fly status --app hypersignal-mcp-ns8x
fly logs --app hypersignal-mcp-ns8x
```
> В логах должны быть строки: `billing db ready`, `alert engine started`,
> `hypersignal-mcp http ready`. Если видите `revoked bootstrap keys` — это
> нормальная синхронизация ключей.

**✅ Контроль (главный):**
```powershell
curl https://hypersignal-mcp-ns8x.fly.dev/healthz
```
Ответ: `{"ok":true,"server":"hypersignal-mcp","version":"1.0.0",...}`

---

## ЭТАП 5. Приёмочные проверки боевого сервера (20 мин)

**5.1** 💻 Список инструментов (должно быть 23, торговых — ни одного):
```powershell
curl -s -X POST https://hypersignal-mcp-ns8x.fly.dev/mcp -H "content-type: application/json" -H "accept: application/json, text/event-stream" -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}'
```
> Комментарий: в PowerShell кавычки внутри JSON экранируются `\"`. Если
> неудобно — используйте curl из Git Bash или сразу шаг 5.4 (Inspector).

**5.2** 💻 Премиум-гейт работает (без ключа — отказ с прайсингом):
```powershell
curl -s -X POST https://hypersignal-mcp-ns8x.fly.dev/mcp -H "content-type: application/json" -H "accept: application/json, text/event-stream" -d '{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"hl_funding_screener\",\"arguments\":{}}}'
```
Ожидание: `payment_required` в ответе.

**5.3** 💻 С Pro-ключом — живые данные:
```powershell
curl -s -X POST https://hypersignal-mcp-ns8x.fly.dev/mcp -H "content-type: application/json" -H "accept: application/json, text/event-stream" -H "X-API-Key: proключ1" -d '{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"hl_funding_screener\",\"arguments\":{}}}'
```
Ожидание: JSON с рынками и funding APR. **Это первый живой вызов вашего
продукта** — Hyperliquid отвечает через ваш сервер.

**5.4** 💻 Прогон eval-набора через MCP Inspector (визуально, удобнее curl):
```powershell
npx @modelcontextprotocol/inspector
```
В открывшемся UI: Transport = «Streamable HTTP», URL =
`https://hypersignal-mcp-ns8x.fly.dev/mcp`, в headers добавьте
`X-API-Key: proключ1` → Connect → Tools.
Откройте `evals/eval.xml` из репозитория и проверьте все 10 вопросов —
каждый должен сходиться с эталонным ответом.
> Комментарий: это ваш приёмочный тест. Особо проверьте: hl_get_markets
> (BTC есть), hl_get_orderbook ETH (bid<ask), hl_whale_positions (когорта
> из env подхватилась), hl_polymarket_divergence BTC (Polymarket доступен).

**5.5** 💻 Проверка standing-алертов end-to-end:
через Inspector вызовите `hl_create_alert`
`{"type":"price_move","coin":"BTC","movePct":0.001,"windowMinutes":5,"cooldownMinutes":5}`
(порог 0.1% — сработает почти наверняка), подождите 10–15 минут, вызовите
`hl_poll_alerts` → должно прийти событие с подписью. После проверки удалите
алерт (`hl_delete_alert`) или оставьте как демо.

**✅ Контроль:** 10/10 evals сходятся, алерт сработал и запишется в track
record (`hl_signal_track_record` покажет 1 сигнал спустя 24ч скоринга).

---

## ЭТАП 6. Подключение клиентов — то, что вы раздаёте (10 мин)

**6.1** Конфиг для Claude Desktop (файл
`%APPDATA%\Claude\claude_desktop_config.json` на Windows клиента):
```json
{
  "mcpServers": {
    "hypersignal": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://hypersignal-mcp-ns8x.fly.dev/mcp",
        "--header", "X-API-Key: КЛЮЧ_КЛИЕНТА"
      ]
    }
  }
}
```
**6.2** Конфиг для Cursor (`.cursor/mcp.json` в проекте клиента):
```json
{
  "mcpServers": {
    "hypersignal": {
      "url": "https://hypersignal-mcp-ns8x.fly.dev/mcp",
      "headers": { "X-API-Key": "КЛЮЧ_КЛИЕНТА" }
    }
  }
}
```
> Комментарий: проверьте ОБА конфига сами до раздачи клиентам — подключите
> свой Claude Desktop с одним из Pro-ключей и спросите: «какой сейчас funding
> по BTC на Hyperliquid?» Ответ через ваш сервер = продукт работает.

**✅ Контроль:** ваш собственный Claude/Cursor получает данные через сервер.

---

## ЭТАП 7. Приём денег (30–60 мин)

**7.1** 🌐 Stripe Payment Link для Pro ($19/мес):
1. `dashboard.stripe.com` → Products → Add product: «HyperSignal Pro»,
   $19/month, recurring;
2. Payment Links → New → выберите продукт → Create;
3. Получите ссылку вида `buy.stripe.com/...` — это ваша страница оплаты.

**7.2** Процесс выдачи ключа (пока вручную, 2 минуты на клиента):
1. Пришло письмо Stripe об оплате;
2. 💻 сгенерируйте ключ: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`;
3. 💻 добавьте в секреты (СТАРЫЕ КЛЮЧИ СОХРАНЯЙТЕ в строке!):
   `fly secrets set --app hypersignal-mcp-ns8x HYPERSIGNAL_PRO_KEYS="старый1,старый2,новый"`
   (машина перезапустится сама, ~30 сек);
4. Отправьте клиенту ключ + конфиг из Этапа 6.
> Комментарий: отмена подписки → удалите ключ из строки и повторите
> `fly secrets set` — отзыв сработает автоматически при рестарте.
> Ведите таблицу «email клиента → ключ» у себя (сервер хранит только хэши).

**7.3** 🌐 Apify Store (второй канал, pay-per-event):
```powershell
npm i -g apify-cli
apify login
cd $HOME\HyperliquidMCP-v1\apify-actor
apify push
```
Затем в консоли Apify: Actor → Monetization → pay-per-event → цена события
`premium-call` (например $0.02). Заполните описание и теги
(hyperliquid, whale-tracking, defi, signals).

**✅ Контроль:** тестовая оплата по своей же ссылке Stripe (можно тут же
возврат), ключ выдан, работает.

---

## ЭТАП 8. Листинги и трафик (2–4 часа, растянуто на неделю)

Порядок по отдаче:

**8.1** Подготовка витрины GitHub (нужна для всех каталогов):
- README уже полный; добавьте в шапку репозитория description и topics:
  `mcp`, `hyperliquid`, `trading`, `whale-tracking`, `defi`, `ai-agents`;
- запишите 30-сек GIF: Claude вызывает `hl_whale_positions` → ответ
  (ScreenToGif на Windows), вставьте в README.

**8.2** Каталоги MCP (везде нужен URL репо + remote URL сервера):
| Каталог | Как подать |
|---|---|
| Smithery (smithery.ai) | «Add server» → GitHub URL; поддерживает и remote URL |
| PulseMCP (pulsemcp.com) | форма Submit |
| Glama (glama.ai/mcp/servers) | Submit; авто-скан репо |
| mcp.so | Submit |
| Cursor Directory (cursor.directory) | Submit MCP |
| Официальный MCP Registry | PR в `github.com/modelcontextprotocol/registry` по их README |

> Комментарий: в описаниях везде ведите на бесплатный ярус («7 free tools,
> no key required») — это крючок; премиум продаёт `payment_required`-ответ сам.

**8.3** Посты (шаблоны готовы в `docs/GTM.md`, RU+EN):
X/Twitter-тред + Telegram в крипто-чаты. Лучший контент — скриншоты реальных
срабатываний: whale-flip алерт, divergence с Polymarket, risk-отчёт кошелька.

**✅ Контроль:** минимум 3 каталога приняли листинг; первый входящий
трафик виден в `fly logs`.

---

## ЭТАП 9. Эксплуатация — еженедельная рутина (15 мин/нед)

**9.1** Бэкап БД (ключи, счётчики, алерты, track record!):
```powershell
fly ssh sftp get /app/data/hypersignal.db backup-$(Get-Date -Format yyyyMMdd).db --app hypersignal-mcp-ns8x
```
> Комментарий: раз в неделю, файл в облако (Drive/Dropbox). Потеря БД =
> потеря счётчиков и накопленного track record (ключи можно перевыпустить).

**9.2** Мониторинг:
- 🌐 uptimerobot.com (бесплатно) → HTTP-монитор на
  `https://hypersignal-mcp-ns8x.fly.dev/healthz`, алерт на email/Telegram;
- `fly logs` при инцидентах; строка `alert tick failed` эпизодически — норма
  (сетевые сбои), постоянно — смотреть причину.

**9.3** Обновления кода: правка → `git push` → `fly deploy --remote-only`.
Том и БД не затрагиваются деплоем.

---

## ЭТАП 10. Включение trading-яруса (ТОЛЬКО после обкатки; 1–2 часа)

Торговля работает только локально у клиента (stdio) — на сервере её нет и
не будет. Ваш доход — builder code с оборота.

**10.1** Одобрите свой builder-адрес (одноразово):
на `app.hyperliquid.xyz` builder-адрес должен иметь депозит ≥ $100.

**10.2** Тестнет-прогон (ОБЯЗАТЕЛЬНО, деньги настоящие только на mainnet):
1. Создайте АГЕНТ-кошелёк: app.hyperliquid.xyz → More → API → Generate agent
   wallet (это ключ с правом торговли, но БЕЗ права вывода — безопаснее);
2. Локально (нужен Node 20/22 — см. README, или WSL):
   ```powershell
   $env:HL_NETWORK="testnet"
   $env:HL_ENABLE_TRADING="true"
   $env:HL_AGENT_PRIVATE_KEY="0x...тестнетный агент-ключ"
   $env:HL_BUILDER_ADDRESS="0xВашBuilder"
   node dist/server-stdio.js
   ```
3. Через Inspector: `hl_place_order` BTC, size маленький, СНАЧАЛА dry-run
   (по умолчанию) → посмотрите payload → затем `confirm:true, dryRun:false`;
4. Проверьте: ордер виден в UI тестнета; отказы (мало маржи) приходят
   ошибкой `order_rejected`, а НЕ ложным «Submitted»;
5. `hl_twap_order` с 3 слайсами по 2 минуты → `hl_execution_status`.

**10.3** Только после чистого тестнета — публикуйте инструкцию клиентам
(локальный конфиг с их агент-ключом + ваш builder-адрес,
`hl_approve_builder_fee_guide` выдаёт им payload одобрения).

**✅ Контроль:** тестовый ордер на testnet прошёл и отменился корректно.

---

## ЭТАП 11. Включение x402 (опционально, после появления facilitator-а)

1. Кошелёк на Base для приёма USDC → `X402_PAY_TO`;
2. Рабочий facilitator (Coinbase / x402.org) → `X402_FACILITATOR_URL`;
3. ```powershell
   fly secrets set --app hypersignal-mcp-ns8x X402_ENABLED=true X402_PAY_TO=0x... X402_FACILITATOR_URL=https://... X402_PRICE_PER_CALL_USDC=0.01
   ```
4. Проверка: премиум-вызов без ключа теперь возвращает x402 requirements
   (вместо просто payment_required); тестовый платёж — вызов проходит.
> Без facilitator оплата fail-closed: никто не получит премиум бесплатно.

---

## Сводный чек-лист (распечатать)

- [ ] 1. v1.0.0 запушен в GitHub
- [ ] 2. Секреты сгенерированы и сохранены (ключи, signing key, киты)
- [ ] 3. flyctl установлен, app + volume созданы, fly.toml в репо
- [ ] 4. `fly secrets set` + `fly deploy --remote-only` → healthz = 1.0.0
- [ ] 5. tools/list = 23, гейт без ключа, данные с ключом, 10/10 evals,
        алерт сработал
- [ ] 6. Свой Claude/Cursor подключён и работает
- [ ] 7. Stripe-ссылка создана, процесс выдачи ключей отработан, Apify запушен
- [ ] 8. 3+ каталога, GIF в README, первые посты
- [ ] 9. Бэкап-команда проверена, UptimeRobot следит за /healthz
- [ ] 10. (позже) testnet-прогон трейдинга → инструкция клиентам
- [ ] 11. (позже) x402 с facilitator

Типичное время до работающего платного сервиса: **один вечер** (этапы 1–7).
