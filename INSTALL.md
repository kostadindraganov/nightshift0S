# Nightshift — Инсталация и конфигурация

Пълно ръководство за инсталиране, конфигуриране и стартиране на проекта.

> **Важно за frontend-а:** В момента Nightshift е **само backend** — HTTP JSON API
> + SSE event stream. Уеб интерфейсът (React kanban) е таск **1.6** в
> `IMPLEMENTATION-PLAN.md` и **още не е имплементиран**. Папката `ui-reference/`
> съдържа само референтен React код (копиран от съседен проект), който **не е
> свързан, няма `package.json` и не може да се стартира**. Виж секция
> [Frontend](#7-frontend-състояние) долу.

---

## 1. Технологичен стек

| Компонент      | Технология                                  |
|----------------|---------------------------------------------|
| Runtime        | [Bun](https://bun.sh) (≥ 1.3)               |
| Език           | TypeScript (ESM, strict)                    |
| База данни     | SQLite през `bun:sqlite` (WAL режим)        |
| ORM / миграции | Drizzle ORM + drizzle-kit                   |
| HTTP сървър    | `Bun.serve` (вградено, без Express)         |
| Тестове        | `bun test` (вграден test runner)            |

Външни зависимости са минимални — само `drizzle-orm` в runtime. SQLite е
вграден в Bun, не се инсталира отделно.

---

## 2. Предпоставки (какво трябва да имаш)

1. **Bun ≥ 1.3** — единственото задължително нещо. Проверка:
   ```sh
   bun --version
   ```
   Ако липсва, инсталирай:
   ```sh
   curl -fsSL https://bun.sh/install | bash
   ```
   (на macOS може и `brew install oven-sh/bun/bun`)

2. **Git** — за version probe-а (`/version` чете `.git/HEAD`) и за бъдещите
   forge функции.

3. **НЕ ти трябват:** Node.js, npm, отделен SQLite, Docker. Bun покрива всичко.

---

## 3. Инсталация стъпка по стъпка

```sh
# 1. влез в директорията на проекта
cd "SOFTWARE FACTORY/nightshift"

# 2. инсталирай зависимостите (root + vendor/sandcastle workspace)
bun install

# 3. приложи миграциите към базата (създава data/nightshift.db)
bun run db:migrate
```

`bun install` чете `bun.lock` (вече е в repo-то) и инсталира:
- runtime: `drizzle-orm`
- dev: `@types/bun`, `drizzle-kit`, `typescript`
- workspace `vendor/sandcastle` (декларирано в `package.json` → `workspaces`)

> Стъпка 3 не е строго задължителна — сървърът сам прилага миграциите при
> стартиране (виж `src/server/main.ts`). Полезна е само ако искаш да създадеш
> базата предварително или да я мигрираш отделно.

---

## 4. Конфигурация (environment variables)

Целият контрол е през env променливи. Няма config файл още (read-only Settings
страницата е таск 1.7, още не е готова).

| Променлива             | По подразбиране        | Предназначение                                                        |
|------------------------|------------------------|-----------------------------------------------------------------------|
| `NIGHTSHIFT_PORT`      | `3000`                 | Порт, на който слуша HTTP сървърът.                                    |
| `NIGHTSHIFT_DB_PATH`   | `data/nightshift.db`   | Път до SQLite файла. `:memory:` се поддържа (за тестове).             |
| `NIGHTSHIFT_API_TOKEN` | *(няма)*               | Bearer токен за защитените route-ове. **Ако липсва → fail closed.**   |

### Важно за `NIGHTSHIFT_API_TOKEN`

Сървърът работи **fail-closed**: ако токенът не е зададен, всеки защитен
endpoint връща `503 auth_not_configured` — т.е. API-то на практика е заключено,
докато не зададеш токен. Само публичните probe-ове (`/healthz`, `/readyz`,
`/version`) работят без токен.

Токенът се чете **при всяка заявка** (не се кешира при старт), сравнението е
constant-time (SHA-256 + `timingSafeEqual`).

### Препоръчителен `.env`

`.env` е в `.gitignore` — създай го локално:

```sh
# .env
NIGHTSHIFT_PORT=3000
NIGHTSHIFT_DB_PATH=data/nightshift.db
NIGHTSHIFT_API_TOKEN=$(openssl rand -hex 32)
```

Bun автоматично зарежда `.env`. Алтернативно подай inline:

```sh
NIGHTSHIFT_API_TOKEN=my-secret-token bun run dev
```

---

## 5. Стартиране на сървъра

```sh
bun run dev
```

Това изпълнява `bun run src/server/main.ts`, който:
1. отваря базата (`NIGHTSHIFT_DB_PATH`) и прилага миграциите;
2. вдига event log-а (write-through DB + SSE източник);
3. слуша на `NIGHTSHIFT_PORT`.

При успех ще видиш:
```
nightshift listening on http://localhost:3000/
```

### Бърза проверка (smoke test)

```sh
# публични probe-ове — без токен
curl http://localhost:3000/healthz      # {"ok":true}
curl http://localhost:3000/readyz       # {"ok":true} ако миграциите са минали
curl http://localhost:3000/version      # {name, version, commit}

# защитен route — иска Bearer токен
curl -H "Authorization: Bearer $NIGHTSHIFT_API_TOKEN" \
     http://localhost:3000/routes        # списък с всички endpoint-и
```

> Бележка: горните `curl` команди се изпълняват в **твоя** терминал. Ако
> работиш през Claude Code сесия с context-mode, `curl` е блокиран — ползвай
> `ctx_execute`.

### Налични API endpoint-и (текущо)

| Метод | Път                                  | Auth | Описание                                  |
|-------|--------------------------------------|------|-------------------------------------------|
| GET   | `/healthz`                           | не   | Liveness probe                            |
| GET   | `/readyz`                            | не   | Readiness (DB отворена + мигрирана)       |
| GET   | `/version`                           | не   | Име, версия, git commit                   |
| GET   | `/routes`                            | да   | Самоописание на API-то                    |
| POST  | `/projects`                          | да   | Създай проект                             |
| GET   | `/projects`                          | да   | Списък проекти                            |
| POST  | `/tasks`                             | да   | Създай таск                               |
| GET   | `/tasks`                             | да   | Списък таскове (`?project_id=`, `?state=`)|
| GET   | `/tasks/:id`                         | да   | Един таск                                 |
| PATCH | `/tasks/:id`                         | да   | Обнови съдържание (без state)             |
| DELETE| `/tasks/:id`                         | да   | Изтрий таск                               |
| POST  | `/tasks/:id/transition`              | да   | State machine преход                      |
| POST  | `/tasks/:id/dependencies`            | да   | Добави зависимост                         |
| DELETE| `/tasks/:id/dependencies/:depId`     | да   | Премахни зависимост                       |
| GET   | `/events/stream`                     | да   | SSE стрийм на event log-а                 |

---

## 6. Тестове и работа с базата

```sh
# всички тестове (db, events, server, tasks)
bun test

# генерирай нова миграция след промяна в src/db/schema.ts
bun run db:generate

# приложи миграциите ръчно
bun run db:migrate
```

> **Никога не пускай `drizzle-kit push`** — миграциите се ГЕНЕРИРАТ, ревюват и
> commit-ват (виж `drizzle.config.ts` и `AGENTS.md`). `push` diff-ва срещу жива
> база и може да изтрие данни.

---

## 7. Frontend (състояние)

**Все още няма работещ frontend.** Сървърът връща JSON и SSE — няма HTML, няма
статични файлове, няма dev сървър за UI.

- `ui-reference/` = **референтен** React код (app-shell, kanban, theme), копиран
  от съседен проект. Няма `package.json`, няма build, **не се стартира**. Служи
  само като отправна точка за бъдещата имплементация.
- Истинският UI е таск **1.6** в `IMPLEMENTATION-PLAN.md`: design tokens
  (`design-tokens.json`) + app shell + минимален kanban board, който чете live
  SSE от `/events/stream`. Този таск е отворен (☐), затова инструкции за
  „стартиране на frontend-а" още няма как да дам — той не съществува като
  изпълним артефакт.

Когато 1.6 бъде имплементиран, тази секция ще се обнови с реалните стъпки
(вероятно отделен Bun/Vite процес или статични файлове, обслужвани от
`Bun.serve`). До тогава взаимодействието с Nightshift е през HTTP API-то по-горе
и SSE стрийма.

---

## 8. Структура на проекта (накратко)

```
src/
  db/        bun:sqlite клиент, schema, миграции, writer queue
  events/    глобален event log + broker (write-through + SSE)
  server/    Bun.serve, route таблица, bearer auth
  tasks/     CRUD, state machine, зависимости (BFS cycle check)
drizzle/     генерирани SQL миграции (0001_*.sql)
docs/        BLUEPRINT.md + 3-те спецификации + plan review log
ui-reference/  референтен React код (НЕ е свързан)
vendor/sandcastle/  вграден workspace
```

Подробности: `README.md` (общ преглед), `IMPLEMENTATION-PLAN.md` (фази и
таскове), `docs/BLUEPRINT.md` (§3.12 = обвързващи правила), `AGENTS.md`
(оперативни правила).

---

## 9. Чести проблеми

| Симптом                                   | Причина / решение                                                       |
|-------------------------------------------|-------------------------------------------------------------------------|
| `503 auth_not_configured` на всеки route  | `NIGHTSHIFT_API_TOKEN` не е зададен — задай го в `.env`.                |
| `401 unauthorized`                        | Липсва или грешен `Authorization: Bearer <token>` хедър.               |
| `/readyz` връща `503 not_ready`           | Миграциите не са приложени — пусни `bun run db:migrate`.               |
| `bun: command not found`                  | Bun не е инсталиран / не е в PATH — виж секция 2.                       |
| Сървърът reset-ва SSE връзката            | Зад reverse proxy с idle timeout < 60s — вдигни го (heartbeat е 15s).  |
