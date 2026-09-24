import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { RpcStatus } from '@voice-chat/common';
import { ChannelType } from '@voice-chat/contracts/dist/constants';
import type {
  GetGuildVoiceParticipantsRequest,
  HandleLiveKitWebhookRequest,
  JoinVoiceChannelRequest,
  JoinVoiceChannelResponse,
  VoiceParticipant,
} from '@voice-chat/contracts/gen/voice';
import type { ParticipantInfo, WebhookEvent } from 'livekit-server-sdk';
import { CentrifugoService } from 'src/infrastructure/centrifugo/centrifugo.service';
import {
  LiveKitService,
  type JoinTokenMetadata,
} from 'src/infrastructure/livekit/livekit.service';
import { GuildClientGrpc } from '../guild/guild.grpc';

export const VOICE_PARTICIPANT_JOINED = 'VOICE_PARTICIPANT_JOINED';
export const VOICE_PARTICIPANT_LEFT = 'VOICE_PARTICIPANT_LEFT';

@Injectable()
export class VoiceService {
  constructor(
    private readonly guildClient: GuildClientGrpc,
    private readonly liveKitClient: LiveKitService,
    private readonly centrifugoClient: CentrifugoService,
  ) {}

  async joinVoiceChannel(
    request: JoinVoiceChannelRequest,
  ): Promise<JoinVoiceChannelResponse> {
    const { userId, guildId, channelId } = request;
    await this._checkVoiceChannel(guildId, channelId);
    await this._checkMember(guildId, userId);

    try {
      const token = await this.liveKitClient.createJoinToken(
        userId,
        guildId,
        channelId,
      );

      return { token, url: this.liveKitClient.wsUrl, room: channelId };
    } catch (error) {
      console.error(error);
      throw new RpcException({
        code: RpcStatus.INTERNAL,
        details: 'Не удалось подключиться к голосовому каналу',
      });
    }
  }

  /**
   * Состав участников не хранится в сервисе: источник истины — сам LiveKit.
   * Так состояние переживает перезапуск сервиса и не расходится с реальностью.
   */
  async getGuildVoiceParticipants(
    request: GetGuildVoiceParticipantsRequest,
  ): Promise<VoiceParticipant[]> {
    const { userId, guildId } = request;

    await this._checkMember(guildId, userId);

    const { channels } = await this.guildClient.call('getGuildChannels', {
      guildId,
    });

    const voiceChannelIds = channels
      .filter((channel) => Number(channel.type) === ChannelType.VOICE)
      .map((channel) => channel.id);

    const activeRoomNames =
      await this.liveKitClient.listActiveRoomNames(voiceChannelIds);

    const perRoom = await Promise.all(
      activeRoomNames.map(async (channelId) => {
        const participants =
          await this.liveKitClient.listParticipants(channelId);

        return participants.map((participant) =>
          this._toProto(participant, guildId, channelId),
        );
      }),
    );

    return perRoom.flat();
  }

  async handleLiveKitWebhook(
    request: HandleLiveKitWebhookRequest,
  ): Promise<boolean> {
    const { body, authHeader } = request;

    let event: WebhookEvent;

    try {
      event = await this.liveKitClient.verifyWebhook(body, authHeader);
    } catch (error) {
      console.error('Не удалось проверить подпись вебхука LiveKit:', error);
      throw new RpcException({
        code: RpcStatus.PERMISSION_DENIED,
        details: 'Некорректная подпись вебхука',
      });
    }

    if (
      event.event !== 'participant_joined' &&
      event.event !== 'participant_left'
    ) {
      return true;
    }

    const channelId = event.room?.name;
    const participant = event.participant;

    if (!channelId || !participant) return true;

    const guildId = this._readGuildId(participant);

    if (!guildId) {
      console.error(
        `В metadata участника ${participant.identity} нет guildId — событие пропущено`,
      );
      return true;
    }

    const type =
      event.event === 'participant_joined'
        ? VOICE_PARTICIPANT_JOINED
        : VOICE_PARTICIPANT_LEFT;

    await this.centrifugoClient.publish(`guild:${guildId}`, {
      type,
      payload: this._toProto(participant, guildId, channelId),
    });

    return true;
  }

  private async _checkVoiceChannel(guildId: string, channelId: string) {
    const { channels } = await this.guildClient.call('getGuildChannels', {
      guildId,
    });

    const channel = channels.find((c) => c.id === channelId);

    if (!channel) {
      throw new RpcException({
        code: RpcStatus.NOT_FOUND,
        details: 'Канал не найден',
      });
    }

    if (Number(channel.type) !== ChannelType.VOICE) {
      throw new RpcException({
        code: RpcStatus.INVALID_ARGUMENT,
        details: 'Подключиться можно только к голосовому каналу',
      });
    }

    return channel;
  }

  private async _checkMember(guildId: string, userId: string) {
    const { memberInfo } = await this.guildClient.call('getMemberById', {
      guildId,
      userId,
    });

    if (!memberInfo || memberInfo.isBanned) {
      throw new RpcException({
        code: RpcStatus.PERMISSION_DENIED,
        details: 'Вы не являетесь участником сервера',
      });
    }

    return memberInfo;
  }

  private _readGuildId(participant: ParticipantInfo): string | null {
    if (!participant.metadata) return null;

    try {
      const metadata = JSON.parse(participant.metadata) as JoinTokenMetadata;
      return metadata.guildId ?? null;
    } catch {
      return null;
    }
  }

  private _toProto(
    participant: ParticipantInfo,
    guildId: string,
    channelId: string,
  ): VoiceParticipant {
    return {
      userId: participant.identity,
      channelId,
      guildId,
      // joinedAt приходит как bigint с секундами Unix-времени
      joinedAt: new Date(Number(participant.joinedAt) * 1000).toISOString(),
    };
  }
}
