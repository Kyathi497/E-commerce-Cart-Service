import { Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { logger } from "../logger.js";
import { CartService } from "./cart.service.js";

const HOUR = 3600 * 1000;

// Deletes abandoned guest carts once an hour. One DELETE, safe in every replica.
@Injectable()
export class CartSweeper implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> = Promise.resolve();

  constructor(private readonly carts: CartService) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => {
      this.running = this.carts.deleteStaleGuestCarts().catch((err) => logger.error({ err }, "guest cart cleanup failed"));
    }, HOUR);
    this.timer.unref();
  }

  async onApplicationShutdown() {
    clearInterval(this.timer);
    await this.running;
  }
}
