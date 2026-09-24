import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type {
  GetGuildVoiceParticipantsRequest,
  GetGuildVoiceParticipantsResponse,
  HandleLiveKitWebhookRequest,
  HandleLiveKitWebhookResponse,
  JoinVoiceChannelRequest,
  JoinVoiceChannelResponse,
} from '@voice-chat/contracts/gen/voice';
import { VoiceService } from './voice.service';

@Controller()
export class VoiceController {
  constructor(private readonly voiceService: VoiceService) {}

  @GrpcMethod('VoiceService', 'JoinVoiceChannel')
  async joinVoiceChannel(
    request: JoinVoiceChannelRequest,
  ): Promise<JoinVoiceChannelResponse> {
    return this.voiceService.joinVoiceChannel(request);
  }

  @GrpcMethod('VoiceService', 'GetGuildVoiceParticipants')
  async getGuildVoiceParticipants(
    request: GetGuildVoiceParticipantsRequest,
  ): Promise<GetGuildVoiceParticipantsResponse> {
    const participants =
      await this.voiceService.getGuildVoiceParticipants(request);

    return { participants };
  }

  @GrpcMethod('VoiceService', 'HandleLiveKitWebhook')
  async handleLiveKitWebhook(
    request: HandleLiveKitWebhookRequest,
  ): Promise<HandleLiveKitWebhookResponse> {
    const success = await this.voiceService.handleLiveKitWebhook(request);

    return { success };
  }
}
