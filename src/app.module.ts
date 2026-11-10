import { Module } from "@nestjs/common";
import { CartController } from "./cart/cart.controller.js";
import { CartService } from "./cart/cart.service.js";
import { InternalCartController } from "./cart/internal.controller.js";
import { CartSweeper } from "./cart/sweeper.js";
import { Upstream } from "./cart/upstream.js";
import { config, SERVICE_NAME } from "./config.js";
import { AuthGuardModule } from "./lib/auth-guard/index.js";
import { HealthModule } from "./lib/common/index.js";
import { PrismaModule } from "./prisma/prisma.module.js";
import { PrismaService } from "./prisma/prisma.service.js";

@Module({
  imports: [
    PrismaModule,
    AuthGuardModule.forRoot({
      jwksUrl: config.AUTH_JWKS_URL,
      service: { name: SERVICE_NAME, secret: config.SERVICE_TOKEN_SECRET },
    }),
    HealthModule.register({
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => ({ db: () => prisma.$queryRaw`SELECT 1` }),
    }),
  ],
  controllers: [CartController, InternalCartController],
  providers: [CartService, Upstream, CartSweeper],
})
export class AppModule {}
