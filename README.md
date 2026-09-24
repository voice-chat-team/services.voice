# services.voice

Голосовые каналы: выдача LiveKit-токенов, состав участников и раздача событий
присутствия в Centrifugo.

Сервис **не имеет собственной базы данных**. Источник истины по тому, кто сейчас
сидит в голосовом канале, — сам LiveKit: состав участников читается через
`RoomServiceClient`, а изменения прилетают вебхуками. Благодаря этому состояние
переживает перезапуск контейнера и не может разойтись с реальностью.

## Как это устроено

- Имя комнаты LiveKit = `id` голосового канала, `identity` участника = `id` пользователя.
- В `metadata` токена кладётся `guildId` — вебхук читает его оттуда, чтобы знать,
  в какой Centrifugo-канал публиковать событие, и не ходить лишний раз в `services.guilds`.
- Права проверяются на каждый вызов через gRPC в `services.guilds`:
  `getGuildChannels` (канал существует и он голосовой) и `getMemberById`
  (пользователь — участник гильдии и не забанен).
- События присутствия публикуются в канал `guild:{guildId}` с конвертом
  `{ type, payload }`, где `type` — `VOICE_PARTICIPANT_JOINED` или `VOICE_PARTICIPANT_LEFT`.

Вебхуки LiveKit приходят не сюда напрямую, а на `POST /voice/webhook` в
`voice-chat-api-gateway` (наружу смотрит только он), который передаёт сырое тело
и заголовок `Authorization` сюда по gRPC. Подпись проверяется здесь.

## Команды

```
npm run start:dev      # watch-режим
npm run build          # nest build
npm run lint           # eslint --fix
```

gRPC слушает `0.0.0.0:5058`.

## Переменные окружения

В продакшене задаются в стеке Portainer, локально — в `.env.development.local`
(файл в `.gitignore`). Обязательны все, сервис падает на старте при отсутствии
любой из них.

| Переменная             | Назначение                                                                    |
| ---------------------- | ----------------------------------------------------------------------------- |
| `NODE_ENV`             | Выбирает файл `.env.${NODE_ENV}.local`                                        |
| `GUILD_GRPC_URL`       | Адрес `services.guilds`, например `guild-service:5054`                        |
| `CENTRIFUGO_URL`       | HTTP-база Centrifugo, к ней дописывается `/api/publish`                       |
| `CENTRIFUGO_API_KEY`   | Уходит заголовком `Authorization: apikey <key>`                               |
| `LIVEKIT_URL`          | Server API LiveKit по внутренней сети, например `http://livekit:7880`         |
| `LIVEKIT_WS_URL`       | Публичный WebSocket-адрес, уезжает клиенту: `wss://livekit.voice-chat-app.ru` |
| `LIVEKIT_API_KEY`      | Ключ из `livekit-server generate-keys`                                        |
| `LIVEKIT_API_SECRET`   | Секрет оттуда же; даёт право выпускать токены в любую комнату                 |

`LIVEKIT_URL` и `LIVEKIT_WS_URL` намеренно разные: первый — внутренний адрес для
серверных вызовов, второй отдаётся клиенту и потому обязан быть публичным.
