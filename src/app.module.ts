import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CentrifugoModule } from './infrastructure/centrifugo/centrifugo.module';
import { LiveKitModule } from './infrastructure/livekit/livekit.module';
import { GuildModule } from './modules/guild/guild.module';
import { VoiceModule } from './modules/voice/voice.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [`.env.${process.env.NODE_ENV}.local`, '.env'],
    }),
    CentrifugoModule,
    LiveKitModule,
    GuildModule,
    VoiceModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
