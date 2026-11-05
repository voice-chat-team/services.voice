import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import {
  assertGuildMember,
  assertGuildPermission,
  hasGuildPermission,
  RpcStatus,
} from '@voice-chat/common';
import { ChannelType, Permission } from '@voice-chat/contracts';
import type {
  GetGuildVoiceParticipantsRequest,
  HandleLiveKitWebhookRequest,
  JoinVoiceChannelRequest,
  JoinVoiceChannelResponse,
  VoiceParticipant,
} from '@voice-chat/contracts/gen/ts/voice';
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
export class VoiceService implements OnModuleInit, OnModuleDestroy {
  private reconcileTimer?: ReturnType<typeof setInterval>;
  private reconciling = false;

  onModuleInit() {
    this.reconcileTimer = setInterval(() => {
      void this.reconcileRooms();
    }, 10_000);
    this.reconcileTimer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.reconcileTimer);
  }

  private async reconcileRooms() {
    if (this.reconciling) return;
    this.reconciling = true;

    try {
      const rooms = await this.liveKitClient.listRooms();

      for (const room of rooms) {
        try {
          const participants = await this.liveKitClient.listParticipantsStrict(
            room.name,
          );
          const guildId =
            this._readRoomGuildId(room.metadata) ??
            participants.map((p) => this._readGuildId(p)).find(Boolean);

          if (!guildId) continue;

          const { channels } = await this.guildClient.call('getGuildChannels', {
            guildId,
          });

          const channel = channels.find(
            (c) => c.id === room.name && Number(c.type) === ChannelType.VOICE,
          );

          const allowed = channel
            ? await this._allowedVoiceUserIds(
                guildId,
                room.name,
                participants.map((p) => p.identity),
              )
            : new Set<string>();

          for (const participant of participants) {
            if (!allowed.has(participant.identity))
              await this.liveKitClient.removeParticipant(
                room.name,
                participant.identity,
              );
          }
        } catch (error) {
          console.error('Voice room reconciliation failed', room.name, error);
        }
      }
    } catch (error) {
      console.error('Voice access reconciliation failed', error);
    } finally {
      this.reconciling = false;
    }
  }

  constructor(
    private readonly guildClient: GuildClientGrpc,
    private readonly liveKitClient: LiveKitService,
    private readonly centrifugoClient: CentrifugoService,
  ) {}

  async joinVoiceChannel(
    request: JoinVoiceChannelRequest,
  ): Promise<JoinVoiceChannelResponse> {
    const { userId, guildId, channelId } = request;
    const channel = await this._checkVoiceChannel(guildId, channelId);
    const member = await this._checkMember(guildId, userId);

    assertGuildPermission(
      member,
      Permission.VOICE_CONNECT,
      'У вас нет права подключаться к голосовым каналам на этом сервере',
    );

    const { userIds } = await this.guildClient.call('getChannelRecipients', {
      guildId,
      channelId,
    });
    if (!userIds.includes(userId)) {
      throw new RpcException({
        code: RpcStatus.PERMISSION_DENIED,
        details: 'Нет доступа к голосовому каналу',
      });
    }

    const room = await this.liveKitClient.ensureRoom(
      guildId,
      channelId,
      channel.capacity,
    );
    const participants =
      await this.liveKitClient.listParticipantsStrict(channelId);
    const alreadyJoined = participants.some((p) => p.identity === userId);

    if (
      room.maxParticipants > 0 &&
      !alreadyJoined &&
      participants.length >= room.maxParticipants
    ) {
      throw new RpcException({
        code: RpcStatus.RESOURCE_EXHAUSTED,
        details: 'Голосовой канал заполнен',
      });
    }

    try {
      const token = await this.liveKitClient.createJoinToken(
        userId,
        guildId,
        channelId,
        hasGuildPermission(member, Permission.VOICE_SPEAK),
        channel.capacity,
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
      userId,
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

    await this._checkVoiceChannel(guildId, channelId);

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

    assertGuildMember(memberInfo);

    return memberInfo;
  }

  private async _allowedVoiceUserIds(
    guildId: string,
    channelId: string,
    userIds: string[],
  ) {
    const { userIds: recipients } = await this.guildClient.call(
      'getChannelRecipients',
      { guildId, channelId },
    );
    const admitted = new Set(recipients);
    const allowed = new Set<string>();
    for (const userId of userIds) {
      if (!admitted.has(userId)) continue;
      try {
        const member = await this._checkMember(guildId, userId);
        if (hasGuildPermission(member, Permission.VOICE_CONNECT))
          allowed.add(userId);
      } catch (error) {
        if (!(error instanceof RpcException)) throw error;
        const detail = error.getError();
        const code =
          typeof detail === 'object' && detail
            ? (detail as { code?: number }).code
            : undefined;
        if (
          code !== RpcStatus.PERMISSION_DENIED &&
          code !== RpcStatus.NOT_FOUND
        )
          throw error;
      }
    }
    return allowed;
  }

  private _readRoomGuildId(metadata: string): string | null {
    try {
      return (JSON.parse(metadata) as JoinTokenMetadata).guildId ?? null;
    } catch {
      return null;
    }
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
