import { Global, Module } from '@nestjs/common';
import { LiveKitService } from './livekit.service';

@Global()
@Module({
  providers: [LiveKitService],
  exports: [LiveKitService],
})
export class LiveKitModule {}
