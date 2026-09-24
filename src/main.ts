import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { PROTO_PATHS } from '@voice-chat/contracts';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: 'voice.v1',
      protoPath: PROTO_PATHS.VOICE,
      url: '0.0.0.0:5058',
      loader: {
        longs: String,
        enums: String,
      },
    },
  });

  await app.startAllMicroservices();
}
bootstrap();
