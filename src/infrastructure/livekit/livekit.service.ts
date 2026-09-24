import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AccessToken,
  RoomServiceClient,
  WebhookReceiver,
  type ParticipantInfo,
  type WebhookEvent,
} from 'livekit-server-sdk';

/**
 * Токен нужен клиенту только в момент room.connect(), дальше соединение
 * живёт само по себе — поэтому TTL намеренно короткий.
 */
const JOIN_TOKEN_TTL = '10m';

export interface JoinTokenMetadata {
  guildId: string;
}

@Injectable()
export class LiveKitService {
  private readonly _API_KEY: string;
  private readonly _API_SECRET: string;
  private readonly _WS_URL: string;

  private readonly roomService: RoomServiceClient;
  private readonly webhookReceiver: WebhookReceiver;

  constructor(private readonly configService: ConfigService) {
    this._API_KEY = configService.getOrThrow<string>('LIVEKIT_API_KEY');
    this._API_SECRET = configService.getOrThrow<string>('LIVEKIT_API_SECRET');
    this._WS_URL = configService.getOrThrow<string>('LIVEKIT_WS_URL');

    // Server API ходит по внутренней docker-сети, а _WS_URL уезжает клиенту
    // и потому обязан быть публичным адресом.
    const apiUrl = configService.getOrThrow<string>('LIVEKIT_URL');

    this.roomService = new RoomServiceClient(
      apiUrl,
      this._API_KEY,
      this._API_SECRET,
    );
    this.webhookReceiver = new WebhookReceiver(this._API_KEY, this._API_SECRET);
  }

  get wsUrl(): string {
    return this._WS_URL;
  }

  /**
   * Имя комнаты = id голосового канала, identity участника = id пользователя.
   * guildId кладётся в metadata, чтобы вебхук мог определить, в какой
   * Centrifugo-канал публиковать событие, не ходя лишний раз в services.guilds.
   */
  async createJoinToken(
    userId: string,
    guildId: string,
    channelId: string,
  ): Promise<string> {
    const metadata: JoinTokenMetadata = { guildId };

    const token = new AccessToken(this._API_KEY, this._API_SECRET, {
      identity: userId,
      ttl: JOIN_TOKEN_TTL,
      metadata: JSON.stringify(metadata),
    });

    token.addGrant({
      roomJoin: true,
      room: channelId,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    return token.toJwt();
  }

  /**
   * Возвращает только те комнаты из списка, которые сейчас существуют
   * (в LiveKit комната живёт, пока в ней кто-то есть).
   */
  async listActiveRoomNames(roomNames: string[]): Promise<string[]> {
    if (roomNames.length === 0) return [];

    try {
      const rooms = await this.roomService.listRooms(roomNames);
      return rooms.map((room) => room.name);
    } catch (error) {
      console.error('Ошибка получения списка комнат LiveKit:', error);
      return [];
    }
  }

  async listParticipants(roomName: string): Promise<ParticipantInfo[]> {
    try {
      return await this.roomService.listParticipants(roomName);
    } catch (error) {
      console.error(`Ошибка получения участников комнаты ${roomName}:`, error);
      return [];
    }
  }

  /**
   * Бросает, если подпись не сошлась — вызывающий код должен это пропустить
   * наверх, чтобы поддельный вебхук не попал в обработку.
   */
  async verifyWebhook(body: string, authHeader: string): Promise<WebhookEvent> {
    return this.webhookReceiver.receive(body, authHeader);
  }
}
